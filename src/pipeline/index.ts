import { assignAbMode, type AbMode } from '../ab-test/index.js'
import { createClient, type BaseMemoryClient } from '../basememory/client.js'
import { indexHealthCheck } from '../basememory/tools.js'
import { EscalationRequired, type EscalationPackage } from '../escalation/index.js'
import { runExecutor, type ExecutorResult } from '../executor/index.js'
import { runIntake, type IntakeResult } from '../intake/index.js'
import { setIntakeLlmProviderForTesting } from '../intake/llm.js'
import { DEFAULT_EXECUTOR_MODEL, DEFAULT_PANEL_MODEL, DEFAULT_VERIFIER_MODEL } from '../llm/models.js'
import { GroqProvider } from '../llm/groq.js'
import { createProviders, type ProviderBundle, type ProviderConfig } from '../llm/router.js'
import { OpenRouterProvider } from '../llm/openrouter.js'
import { ContextDB } from '../memory/context-db/index.js'
import { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { buildExecutionPlan } from '../orchestrator/index.js'
import type { PanelOutput } from '../panel/index.js'
import { runDeterministicLocalization, type LocalizationResult } from '../panel/deterministic-localizer.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { CompressionLlmProvider } from '../executor/compression.js'
import type { PanelMemberLlmProvider } from '../panel/member.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import type { VerifierResult } from '../verifier/index.js'

const USE_PANEL = false
const GROQ_EXECUTOR_MODEL = 'llama-3.3-70b-versatile'
const GROQ_INTAKE_MODEL = 'llama-3.1-8b-instant'
const GROQ_VERIFIER_MODEL = 'llama-3.1-8b-instant'
const passthroughCompressionProvider: CompressionLlmProvider = {
  async distill(content: string) {
    return content
  }
}

/**
 * Static configuration for one top-level PlanOne pipeline run.
 */
export interface PipelineConfig {
  repoRoot: string
  configPath?: string
  providerConfig: ProviderConfig
  rulesPath?: string
  continuousLoop?: boolean
}

/**
 * Full input payload for the Week 6 top-level pipeline.
 */
export interface PipelineInput {
  taskId: string
  rawTask: string
  config: PipelineConfig
  taskSequenceNumber: number
}

/**
 * Serializable result returned by the top-level pipeline boundary.
 */
export interface PipelineResult {
  taskId: string
  abMode: AbMode
  outcome: 'success' | 'escalated' | 'all_cycles_exhausted' | 'error'
  enrichedPacket: EnrichedPacket | null
  executorResult: ExecutorResult | null
  verifierResult: VerifierResult | null
  totalTokensUsed: number
  totalCostUsd: number
  durationMs: number
  errorMessage: string | null
}

/**
 * Runs the entire Phase 1 PlanOne pipeline behind one catch-all boundary.
 *
 * No error or escalation is allowed to propagate beyond this function.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const startMs = Date.now()
  const abMode = assignAbMode(input.taskSequenceNumber)
  const rts = new RawTraceStore()
  let client: Awaited<ReturnType<typeof createClient>> | null = null
  logInfo('pipeline', '[Pipeline] Starting pipeline run', {
    taskId: input.taskId,
    repoRoot: input.config.repoRoot,
    abMode
  })

  rts.append({
    task_id: input.taskId,
    ab_mode: abMode,
    agent_role: 'intake',
    step_index: null,
    event_type: 'task_start',
    content_json: JSON.stringify({
      rawTask: input.rawTask,
      repoRoot: input.config.repoRoot
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })

  try {
    client = await createClient({
      projectRoot: input.config.repoRoot,
      configPath: input.config.configPath
    })
    const contextDb = new ContextDB(client)

    try {
      const health = await indexHealthCheck(client)
      logInfo('pipeline', '[Pipeline] BaseMemory health check completed', {
        taskId: input.taskId,
        health
      })
      rts.append({
        task_id: input.taskId,
        ab_mode: abMode,
        agent_role: 'intake',
        step_index: null,
        event_type: 'tool_call',
        content_json: JSON.stringify({
          tool: 'index_health_check',
          health
        }),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })
    } catch (error) {
      logWarn('pipeline', '[Pipeline] BaseMemory health check failed; continuing', {
        taskId: input.taskId,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
      rts.append({
        task_id: input.taskId,
        ab_mode: abMode,
        agent_role: 'intake',
        step_index: null,
        event_type: 'error',
        content_json: JSON.stringify({
          message: 'BaseMemory health check failed; continuing.',
          error: error instanceof Error ? error.message : 'Unknown error'
        }),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })
    }

    const resolvedProviderConfig = resolveProviderConfig(input.config.providerConfig)
    const openrouterKey = resolvedProviderConfig.openrouterApiKey ?? ''
    const geminiKey = resolvedProviderConfig.geminiApiKey ?? ''
    const groqKey = resolvedProviderConfig.groqApiKey ?? ''
    const nvidiaKey = resolvedProviderConfig.nvidiaApiKey ?? ''

    rts.append({
      task_id: input.taskId,
      ab_mode: abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'task_start',
      content_json: JSON.stringify({
        operation: 'provider_key_fingerprint',
        openrouter: formatKeyFingerprint(openrouterKey),
        gemini: formatKeyFingerprint(geminiKey),
        groq: formatKeyFingerprint(groqKey),
        nvidia: formatKeyFingerprint(nvidiaKey)
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    const providers = createProviders(resolvedProviderConfig)
    const localizationFallbackProvider = openrouterKey.length === 0
      ? undefined
      : new OpenRouterProvider({
        apiKey: openrouterKey,
        path: 'paid',
        modelId: 'google/gemini-2.5-flash',
        siteUrl: resolvedProviderConfig.openrouterSiteUrl,
        siteName: resolvedProviderConfig.openrouterSiteName
      })
    await validateProviderModelAlignment(providers, resolvedProviderConfig)
    setIntakeLlmProviderForTesting(providers.intakeProvider)

    if (groqKey.length > 0) {
      await runGroqPreflight({
        provider: new GroqProvider(groqKey),
        rts,
        taskId: input.taskId,
        abMode
      })
    }

    if (localizationFallbackProvider !== undefined) {
      await runOpenRouterPreflight({
        provider: localizationFallbackProvider,
        rts,
        taskId: input.taskId,
        abMode
      })
    }

    logInfo('pipeline', '[Pipeline] Provider preflight complete', {
      executorModel: resolvedProviderConfig.executorModel,
      panelModel: resolvedProviderConfig.panelModel,
      verifierModel: resolvedProviderConfig.verifierModel,
      intakeModel: resolvedProviderConfig.intakeModel
    })

    const intakeResult = await runIntake({
      taskId: input.taskId,
      rawTask: input.rawTask,
      repoRoot: input.config.repoRoot,
      abMode,
      rts
    })
    const panelOutput = USE_PANEL
      ? await import('../panel/index.js').then(({ runPanel }) => runPanel(
        {
          intake: intakeResult,
          rts,
          client: client as BaseMemoryClient,
          contextDb,
          fallbackModel: resolvedProviderConfig.intakeModel,
          localizationFallbackProvider
        },
        [],
        providers.panelProvider
      ))
      : await buildPanelOutputFromLocalization({
        intake: intakeResult,
        rts,
        provider: providers.intakeProvider as unknown as PanelMemberLlmProvider,
        fallbackProvider: localizationFallbackProvider
      })
    const plan = await buildExecutionPlan({
      enrichedPacket: panelOutput.enrichedPacket,
      intake: intakeResult,
      rts,
      contextDb,
      executorModel: resolvedProviderConfig.executorModel ?? DEFAULT_EXECUTOR_MODEL,
      verifierModel: resolvedProviderConfig.verifierModel ?? DEFAULT_VERIFIER_MODEL,
      continuousLoop: input.config.continuousLoop === true
    })
    const executorResult = await runExecutor(
      {
        plan,
        enrichedPacket: panelOutput.enrichedPacket,
        intake: intakeResult,
        contextDb,
        client,
        rts,
        repoRoot: input.config.repoRoot
      },
      providers.executorProvider,
      passthroughCompressionProvider
    )

    if (executorResult.outcome === 'escalated') {
      logWarn('pipeline', '[Pipeline] Executor escalated', {
        taskId: input.taskId
      })
      return {
        taskId: input.taskId,
        abMode,
        outcome: 'escalated',
        enrichedPacket: panelOutput.enrichedPacket,
        executorResult,
        verifierResult: null,
        totalTokensUsed: executorResult.totalTokensUsed,
        totalCostUsd: executorResult.totalCostUsd,
        durationMs: Date.now() - startMs,
        errorMessage: 'Executor reported an escalation outcome.'
      }
    }

    if (executorResult.outcome !== 'success') {
      logWarn('pipeline', '[Pipeline] Executor ended without success', {
        taskId: input.taskId,
        outcome: executorResult.outcome
      })
      return buildPipelineResult({
        taskId: input.taskId,
        abMode,
        outcome: executorResult.outcome,
        enrichedPacket: panelOutput.enrichedPacket,
        executorResult,
        verifierResult: null,
        startMs,
        errorMessage: null
      })
    }

    const changedFiles = getChangedFiles(executorResult.finalStepOutputs)

    if (changedFiles.length === 0) {
      logError('pipeline', '[Pipeline] Executor reported success without changed files', {
        taskId: input.taskId
      })
      rts.append({
        task_id: input.taskId,
        ab_mode: abMode,
        agent_role: 'executor',
        step_index: null,
        event_type: 'error',
        content_json: JSON.stringify({
          message: 'Executor reported success without changing any files.',
          outcome: executorResult.outcome
        }),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })

      return {
        taskId: input.taskId,
        abMode,
        outcome: 'error',
        enrichedPacket: panelOutput.enrichedPacket,
        executorResult,
        verifierResult: null,
        totalTokensUsed: executorResult.totalTokensUsed,
        totalCostUsd: executorResult.totalCostUsd,
        durationMs: Date.now() - startMs,
        errorMessage: 'Executor reported success without changing any files.'
      }
    }

    const verifierResult = executorResult.verifierResult

    if (verifierResult === null) {
      logError('pipeline', '[Pipeline] Executor reported success without verifier result', {
        taskId: input.taskId
      })
      return {
        taskId: input.taskId,
        abMode,
        outcome: 'error',
        enrichedPacket: panelOutput.enrichedPacket,
        executorResult,
        verifierResult: null,
        totalTokensUsed: executorResult.totalTokensUsed,
        totalCostUsd: executorResult.totalCostUsd,
        durationMs: Date.now() - startMs,
        errorMessage: 'Executor reported success without verifier result.'
      }
    }

    logInfo('pipeline', '[Pipeline] Pipeline completed successfully', {
      taskId: input.taskId,
      verdict: verifierResult.verdict,
      changedFiles
    })
    return buildPipelineResult({
      taskId: input.taskId,
      abMode,
      outcome: executorResult.outcome,
      enrichedPacket: panelOutput.enrichedPacket,
      executorResult,
      verifierResult,
      startMs,
      errorMessage: null
    })
  } catch (error) {
    logError('pipeline', '[Pipeline] Pipeline failed', {
      taskId: input.taskId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    rts.append({
      task_id: input.taskId,
      ab_mode: abMode,
      agent_role: 'escalation',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Pipeline failed.',
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    if (error instanceof EscalationRequired) {
      return {
        taskId: input.taskId,
        abMode,
        outcome: 'escalated',
        enrichedPacket: null,
        executorResult: null,
        verifierResult: null,
        totalTokensUsed: 0,
        totalCostUsd: 0,
        durationMs: Date.now() - startMs,
        errorMessage: buildEscalationMessage(error.package)
      }
    }

    return {
      taskId: input.taskId,
      abMode,
      outcome: 'error',
      enrichedPacket: null,
      executorResult: null,
      verifierResult: null,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      durationMs: Date.now() - startMs,
      errorMessage: error instanceof Error ? error.message : 'Unknown error'
    }
  } finally {
    setIntakeLlmProviderForTesting(null)

    if (client !== null) {
      try {
        await client.disconnect()
      } catch {
        // Disconnect failures are non-fatal at the pipeline boundary.
      }
    }
  }
}

function formatKeyFingerprint(apiKey: string): string {
  if (apiKey.length === 0) {
    return 'MISSING'
  }

  const prefixLength = Math.min(12, apiKey.length)
  const suffixLength = Math.min(4, apiKey.length)
  return `len=${apiKey.length} prefix=${apiKey.slice(0, prefixLength)} suffix=${apiKey.slice(-suffixLength)}`
}

async function buildPanelOutputFromLocalization(input: {
  intake: IntakeResult
  rts: RawTraceStore
  provider: PanelMemberLlmProvider
  fallbackProvider?: PanelMemberLlmProvider
}): Promise<PanelOutput> {
  const startedAt = Date.now()
  let localization: LocalizationResult
  try {
    localization = await runDeterministicLocalization({
      intake: input.intake,
      provider: input.provider,
      fallbackProvider: input.fallbackProvider,
      rts: input.rts
    })
  } catch (error) {
    logWarn('pipeline', '[Pipeline] Deterministic localization failed in panel-bypass mode; using empty packet', {
      error: error instanceof Error ? error.message : String(error)
    })
    localization = {
      files: [],
      symbols: [],
      implementationContext: new Map(),
      localizationMethod: 'fallback',
      traceback: input.intake.reproductionResult?.traceback ?? null
    }
  }

  return {
    enrichedPacket: buildEnrichedPacketFromLocalization(localization, input.intake),
    memberAnalyses: [],
    citationResults: [],
    panelDurationMs: Date.now() - startedAt
  }
}

function buildEnrichedPacketFromLocalization(
  localization: LocalizationResult,
  intake: IntakeResult
): EnrichedPacket {
  const firstFile = localization.symbols[0]?.file ?? localization.files[0]?.path ?? ''
  const firstSymbol = localization.symbols[0]?.name ?? ''
  const approachText = intake.enhancedTask.structured_description
  const verifiedChunkIds = localization.symbols.length > 0
    ? localization.symbols.map((symbol) => `${symbol.file}:${symbol.lineNumber}-${symbol.lineNumber}`)
    : localization.files.map((file) => `${file.path}:0-0`)

  return {
    taskId: intake.taskId,
    originalTask: intake.enhancedTask.original,
    structuredDescription: intake.enhancedTask.structured_description,
    taskType: intake.enhancedTask.task_type,
    affectedArea: intake.enhancedTask.affected_area,
    affectedSymbols: localization.symbols.map((symbol) => symbol.name),
    primaryRootCause: firstSymbol.length > 0
      ? `Investigate ${firstSymbol} in ${firstFile}`
      : `Investigate ${firstFile}`,
    alternativeRootCauses: [],
    rankedApproaches: [{
      approach: approachText,
      confidence: localization.localizationMethod === 'deterministic' ? 0.8 : 0.2,
      rank: 1,
      supportingChunkIds: verifiedChunkIds,
      estimatedRisk: intake.classification.complexity === 'COMPLEX' ? 'high' : 'medium'
    }],
    identifiedRisks: [],
    activeConstraints: [...intake.rules.always_escalate_if],
    memberCount: 0,
    consensusConfidence: localization.localizationMethod === 'deterministic' ? 0.8 : 0.2,
    verifiedChunkIds,
    citationVerificationDegraded: false,
    implementationContext: Object.fromEntries(localization.implementationContext.entries()),
    rules: intake.rules,
    synthesizedAt: new Date().toISOString()
  }
}

async function runOpenRouterPreflight(input: {
  provider: OpenRouterProvider
  rts: RawTraceStore
  taskId: string
  abMode: AbMode
}): Promise<void> {
  try {
    await input.provider.analyze('Reply with the single word: ready', 'google/gemini-2.5-flash')
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'step_output',
      content_json: JSON.stringify({
        operation: 'openrouter_preflight',
        status: 'ok',
        model: 'google/gemini-2.5-flash'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        operation: 'openrouter_preflight',
        status: 'failed',
        model: 'google/gemini-2.5-flash',
        error: message
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    logWarn('pipeline', '[Pipeline] OpenRouter preflight failed. Localization fallback unavailable.', {
      error: message
    })
  }
}

function buildPipelineResult(args: {
  taskId: string
  abMode: AbMode
  outcome: 'success' | 'all_cycles_exhausted'
  enrichedPacket: EnrichedPacket
  executorResult: ExecutorResult
  verifierResult: VerifierResult | null
  startMs: number
  errorMessage: string | null
}): PipelineResult {
  return {
    taskId: args.taskId,
    abMode: args.abMode,
    outcome: args.outcome,
    enrichedPacket: args.enrichedPacket,
    executorResult: args.executorResult,
    verifierResult: args.verifierResult,
    totalTokensUsed: args.executorResult.totalTokensUsed,
    totalCostUsd: args.executorResult.totalCostUsd,
    durationMs: Date.now() - args.startMs,
    errorMessage: args.errorMessage
  }
}

function buildEscalationMessage(pkg: EscalationPackage): string {
  return `Escalation required: ${pkg.trigger}`
}

function getChangedFiles(stepOutputs: ExecutorResult['finalStepOutputs']): string[] {
  return [...new Set(stepOutputs.flatMap((stepOutput) => stepOutput.affectedFiles).filter((filePath) => filePath.length > 0))]
}

export async function validateProviderModelAlignment(
  providers: ProviderBundle,
  config: ProviderConfig
): Promise<void> {
  const checks = [
    { role: 'executor', modelId: config.executorModel, provider: providers.executorProvider },
    { role: 'panel', modelId: config.panelModel, provider: providers.panelProvider },
    { role: 'intake', modelId: config.intakeModel, provider: providers.intakeProvider },
    { role: 'compression', modelId: config.compressionModel, provider: providers.compressionProvider }
  ]

  for (const check of checks) {
    if (check.modelId === undefined) {
      continue
    }

    const modelFamily = inferModelFamily(check.modelId)
    const providerName = getProviderRuntimeName(check.provider)
    const providerFamily = inferProviderFamily(providerName)

    if (modelFamily === 'unknown' || providerFamily === 'unknown') {
      continue
    }

    if (providerFamily === 'openrouter' && modelFamily === 'google') {
      console.warn(
        `Provider mismatch warning: ${check.role}Model is '${check.modelId}' and the configured ${check.role} provider is ${providerName}. This is valid, but direct GeminiProvider usage is usually preferable for Google models.`
      )
      continue
    }

    if (providerFamily === 'google' && modelFamily !== 'google') {
      throw new Error(buildProviderMismatchMessage(check.role, check.modelId, providerName))
    }

    if (providerFamily === 'anthropic' && modelFamily !== 'anthropic') {
      throw new Error(buildProviderMismatchMessage(check.role, check.modelId, providerName))
    }
  }
}

function inferModelFamily(modelId: string): 'anthropic' | 'google' | 'groq' | 'openrouter' | 'nvidia' | 'unknown' {
  const normalizedModelId = modelId.replace(/:free$/, '')

  if (normalizedModelId.startsWith('minimaxai/') || normalizedModelId.startsWith('z-ai/')) {
    return 'nvidia'
  }

  if (normalizedModelId.startsWith('claude-')) {
    return 'anthropic'
  }

  if (normalizedModelId.startsWith('gemini-') || normalizedModelId.startsWith('gemma-')) {
    return 'google'
  }

  if (normalizedModelId.startsWith('llama-') || normalizedModelId.startsWith('mixtral-') || normalizedModelId.startsWith('qwen-')) {
    return 'groq'
  }

  if (normalizedModelId.includes('/')) {
    return 'openrouter'
  }

  return 'unknown'
}

function inferProviderFamily(providerName: string): 'anthropic' | 'google' | 'groq' | 'openrouter' | 'nvidia' | 'unknown' {
  if (providerName === 'AnthropicProvider') {
    return 'anthropic'
  }

  if (providerName === 'GeminiProvider') {
    return 'google'
  }

  if (providerName === 'OpenRouterProvider') {
    return 'openrouter'
  }

  if (providerName === 'GroqProvider') {
    return 'groq'
  }

  if (providerName === 'NvidiaProvider') {
    return 'nvidia'
  }

  return 'unknown'
}

function getProviderRuntimeName(provider: unknown): string {
  if (typeof provider !== 'object' || provider === null) {
    return 'UnknownProvider'
  }

  const constructorName = provider.constructor?.name

  return typeof constructorName === 'string' && constructorName.length > 0
    ? constructorName
    : 'UnknownProvider'
}

function buildProviderMismatchMessage(role: string, modelId: string, providerName: string): string {
  return [
    `Provider mismatch: ${role}Model is '${modelId}' but the configured ${role} provider is ${providerName}.`,
    `Either change ${role}Model to a compatible model ID (e.g. '${DEFAULT_PANEL_MODEL}') or change the ${role} provider configuration.`,
    'Check your API keys and provider config.'
  ].join(' ')
}

function resolveProviderConfig(config: ProviderConfig): ProviderConfig {
  const useGroq = typeof config.groqApiKey === 'string' && config.groqApiKey.length > 0

  if (!useGroq) {
    return config
  }

  return {
    ...config,
    executorModel: GROQ_EXECUTOR_MODEL,
    intakeModel: GROQ_INTAKE_MODEL,
    panelModel: GROQ_INTAKE_MODEL,
    verifierModel: GROQ_VERIFIER_MODEL
  }
}

async function runGroqPreflight(args: {
  provider: GroqProvider
  rts: RawTraceStore
  taskId: string
  abMode: AbMode
}): Promise<void> {
  try {
    await args.provider.analyze('Reply with the single word: ready', GROQ_INTAKE_MODEL)
    args.rts.append({
      task_id: args.taskId,
      ab_mode: args.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'step_output',
      content_json: JSON.stringify({
        operation: 'groq_preflight',
        status: 'ok',
        model: GROQ_INTAKE_MODEL
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.rts.append({
      task_id: args.taskId,
      ab_mode: args.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        operation: 'groq_preflight',
        status: 'failed',
        model: GROQ_INTAKE_MODEL,
        error: message
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    logWarn('pipeline', '[Pipeline] Groq preflight failed.', { error: message })
  }
}
