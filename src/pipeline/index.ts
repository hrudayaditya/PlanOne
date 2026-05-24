import { assignAbMode, type AbMode } from '../ab-test/index.js'
import { createClient } from '../basememory/client.js'
import { indexHealthCheck } from '../basememory/tools.js'
import { EscalationRequired, type EscalationPackage } from '../escalation/index.js'
import { runExecutor, type ExecutorResult } from '../executor/index.js'
import { runIntake, type IntakeResult } from '../intake/index.js'
import { setIntakeLlmProviderForTesting } from '../intake/llm.js'
import { DEFAULT_EXECUTOR_MODEL, DEFAULT_PANEL_MODEL, DEFAULT_VERIFIER_MODEL } from '../llm/models.js'
import { createProviders, type ProviderBundle, type ProviderConfig } from '../llm/router.js'
import { OpenRouterProvider } from '../llm/openrouter.js'
import { ContextDB } from '../memory/context-db/index.js'
import { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { buildExecutionPlan } from '../orchestrator/index.js'
import { runPanel, type PanelOutput } from '../panel/index.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import type { VerifierResult } from '../verifier/index.js'

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

    const openrouterKey = input.config.providerConfig.openrouterApiKey ?? ''
    const geminiKey = input.config.providerConfig.geminiApiKey ?? ''
    const nvidiaKey = input.config.providerConfig.nvidiaApiKey ?? ''

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
        nvidia: formatKeyFingerprint(nvidiaKey)
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    const providers = createProviders(input.config.providerConfig)
    const localizationFallbackProvider = openrouterKey.length === 0
      ? undefined
      : new OpenRouterProvider({
        apiKey: openrouterKey,
        path: 'paid',
        modelId: 'google/gemini-2.5-flash',
        siteUrl: input.config.providerConfig.openrouterSiteUrl,
        siteName: input.config.providerConfig.openrouterSiteName
      })
    await validateProviderModelAlignment(providers, input.config.providerConfig)
    setIntakeLlmProviderForTesting(providers.intakeProvider)

    if (localizationFallbackProvider !== undefined) {
      await runOpenRouterPreflight({
        provider: localizationFallbackProvider,
        rts,
        taskId: input.taskId,
        abMode
      })
    }

    logInfo('pipeline', '[Pipeline] Provider preflight complete', {
      executorModel: input.config.providerConfig.executorModel,
      panelModel: input.config.providerConfig.panelModel,
      verifierModel: input.config.providerConfig.verifierModel,
      intakeModel: input.config.providerConfig.intakeModel
    })

    const intakeResult = await runIntake({
      taskId: input.taskId,
      rawTask: input.rawTask,
      repoRoot: input.config.repoRoot,
      abMode,
      rts
    })
    const panelOutput = await runPanel(
      {
        intake: intakeResult,
        rts,
        client,
        contextDb,
        fallbackModel: input.config.providerConfig.intakeModel,
        localizationFallbackProvider
      },
      [],
      providers.panelProvider
    )
    const plan = await buildExecutionPlan({
      enrichedPacket: panelOutput.enrichedPacket,
      intake: intakeResult,
      rts,
      contextDb,
      executorModel: input.config.providerConfig.executorModel ?? DEFAULT_EXECUTOR_MODEL,
      verifierModel: input.config.providerConfig.verifierModel ?? DEFAULT_VERIFIER_MODEL,
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
      providers.compressionProvider
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
    { role: 'verifier', modelId: config.verifierModel, provider: providers.verifierProvider },
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

function inferModelFamily(modelId: string): 'anthropic' | 'google' | 'openrouter' | 'nvidia' | 'unknown' {
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

  if (normalizedModelId.includes('/')) {
    return 'openrouter'
  }

  return 'unknown'
}

function inferProviderFamily(providerName: string): 'anthropic' | 'google' | 'openrouter' | 'nvidia' | 'unknown' {
  if (providerName === 'AnthropicProvider') {
    return 'anthropic'
  }

  if (providerName === 'GeminiProvider') {
    return 'google'
  }

  if (providerName === 'OpenRouterProvider') {
    return 'openrouter'
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
