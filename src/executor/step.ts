import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import { buildEscalationPackage, escalate } from '../escalation/index.js'
import { codebaseSearch } from '../basememory/tools.js'
import { compressWorkingContent, type CompressionLlmProvider } from './compression.js'
import { z } from 'zod'
import {
  checkBudget,
  countAnchorTokens,
  enforceBudget,
  getModelLimit,
  logBudgetCheck,
  trimWorkingContent,
  type BudgetCheckResult,
  type PermanentAnchorSet,
  type WorkingContentItem
} from '../pipeline/context-budget.js'
import type { IntakeResult } from '../intake/index.js'
import type { AbMode } from '../ab-test/index.js'
import type { ContextDB } from '../memory/context-db/index.js'
import type { Tier2Memory } from '../memory/tier2/index.js'
import type { BaseMemoryClient } from '../basememory/client.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { countTokens } from '../utils/tokens.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { ExecutionPlan, ExecutionStep } from '../orchestrator/plan.js'
import { createStepActor, type StepOutput } from '../pipeline/state-machine.js'
import { runPostStepMonitor, runPreActionMonitor } from '../monitor/index.js'
import { checkAfterDiff, checkBeforeWrite, checkCommandOutput, type SekContext } from '../sek/index.js'
import { classifyInjection } from '../sek/injection-classifier.js'
import { executeTool, getToolDefinitions, type AnthropicToolDefinition, type ToolExecutionContext } from './tools.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { withLlmTranscriptContext } from '../utils/llm-transcript.js'
import {
  attachRelatedTestFiles,
  buildImplementationSurface,
  classifyApproachFocus,
  classifyFileImplementationRole,
  type ConfirmedSymbol,
  extractMentionsFromApproach,
  getTaskRelevanceBoost,
  type ImplementationSurface,
  type PrioritizedFile,
  type RelatedTestFile
} from './implementation-surface.js'
import { buildCyclePlan, type CyclePlan } from './cycle-plan.js'
import { recoverPseudoToolCall, repairToolArgs } from './tool-repair.js'

/**
 * One chat message sent to the executor provider.
 */
export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmContent[]
  cache_control?: { type: 'ephemeral' }
}

/**
 * One structured content block exchanged with the executor provider.
 */
export interface LlmContent {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

/**
 * Mockable Week 5 executor provider interface.
 */
export interface ExecutorLlmProvider {
  generatePreActionPlan?(
    step: ExecutionStep,
    enrichedPacket: EnrichedPacket,
    model: string
  ): Promise<unknown>

  callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{
    content: LlmContent[]
    tokensUsed: number
    costUsd: number
    reasoningText?: string
  }>
}

/**
 * Full input required to execute one plan step.
 */
export interface StepExecutionInput {
  step: ExecutionStep
  cycleNumber: number
  plan: ExecutionPlan
  cyclePlan?: CyclePlan
  enrichedPacket: EnrichedPacket
  intake: IntakeResult
  tier2: Tier2Memory
  contextDb: ContextDB
  client: BaseMemoryClient
  rts: RawTraceStore
  abMode: AbMode
  repoRoot: string
  seedFiles?: string[]
}

/**
 * Structured outcome of one executed step.
 */
export interface StepExecutionResult {
  outcome: 'success' | 'vetoed' | 'budget_overflow' | 'escalated' | 'error'
  stepOutput: StepOutput | null
  monitorInterventions: number
  vetoReason: string | null
  tokensUsed: number
  costUsd: number
  writeCount: number
  testsPassed: boolean
  typeCheckPassed: boolean
}

const MAX_TOOL_ITERATIONS = 10
const MAX_DISCOVERY_TOOL_CALLS = 5
const ITERATION_WARNING_THRESHOLD = 10
const MAX_IMPLEMENTATION_ADDITIONAL_READS = 2
const DISCOVERY_CONFIRM_AFTER_READS = 3
const DISCOVERY_AUTO_CONFIRM_AFTER_CALLS = 4
const MAX_DISCOVERY_LINES_PER_FILE = 20
const MAX_PRELOADED_FILE_LINES = 400
const DEFAULT_CONTEXT_CAP_RATIO = 0.6
const CONTINUOUS_CONTEXT_CAP_RATIO = 0.75
const USE_MONITOR = false
const POST_WRITE_ALLOWED_TOOLS = new Set(['run_tests', 'run_command', 'git_diff', 'git_status'])
const MAX_FILES_WRITTEN_PER_STEP = 3
type CompressionProviderWithDefaultModel = CompressionLlmProvider & {
  getDefaultModel?: () => string
}

type StepPhase = 'discovery' | 'implementation' | 'testing' | 'verification' | 'continuous'

interface ProgressState {
  filesRead: string[]
  filesWritten: string[]
  iterationCount: number
  blockedActions: string[]
  conversationSummary: string | null
}

interface ConfirmSurfaceInput {
  confirmed_files: string[]
  additional_files: string[]
  ready_to_implement: boolean
}

interface PreloadedImplementationFile {
  path: string
  content: string
  bytes: number
  mtimeMs: number
}

interface RelevantSnippet {
  path: string
  symbolName: string | null
  startLine: number
  endLine: number
  content: string
}

const ConfirmSurfaceInputSchema = z.object({
  confirmed_files: z.array(z.string()).default([]),
  additional_files: z.array(z.string()).default([]),
  ready_to_implement: z.boolean().default(false)
})

/**
 * Executes one orchestrator step through the Week 5 state machine and tool loop.
 *
 * This function only throws when it exits through the structured escalation
 * path. All other failures are returned as structured step outcomes.
 */
export async function executeStep(
  input: StepExecutionInput,
  executorProvider: ExecutorLlmProvider,
  compressionProvider: CompressionLlmProvider = passthroughCompressionProvider
): Promise<StepExecutionResult> {
  const actor = createStepActor({
    taskId: input.plan.taskId,
    stepIndex: input.step.stepIndex,
    model: input.plan.assignedExecutorModel,
    abMode: input.abMode
  })
  actor.start()

  input.rts.append({
    task_id: input.plan.taskId,
    ab_mode: input.abMode,
    agent_role: 'executor',
    step_index: input.step.stepIndex,
    event_type: 'step_start',
    content_json: JSON.stringify({
      planId: input.plan.planId,
      step: input.step
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })

  actor.send({
    type: 'STEP_START',
    taskId: input.plan.taskId,
    stepIndex: input.step.stepIndex,
    model: input.plan.assignedExecutorModel,
    abMode: input.abMode
  })

  const anchors: PermanentAnchorSet = {
    taskDescription: input.enrichedPacket.structuredDescription,
    enrichedPacket: JSON.stringify(input.enrichedPacket),
    userRepoRules: JSON.stringify(input.intake.rules),
    currentStepDescription: input.step.description
  }
  const anchorTokens = countAnchorTokens(anchors, input.plan.assignedExecutorModel)
  actor.send({ type: 'ANCHORS_LOADED', anchors, anchorTokens })

  let tokensUsed = 0
  let costUsd = 0
  let monitorInterventions = 0
  let writeSuccessCount = 0
  let testsPassed = false
  let typeCheckPassed = false

  try {
    return await withLlmTranscriptContext(
      {
        taskId: input.plan.taskId,
        cycleNumber: input.cycleNumber,
        stepIndex: input.step.stepIndex,
        stage: `executor:${getStepPhase(input.step)}`
      },
      async () => {
    const cyclePlan = input.cyclePlan ?? deriveFallbackCyclePlan(input)
    logInfo('executor:step', '[Step1] Using cycle plan — checking monitor veto', {
      stepIndex: input.step.stepIndex,
      intendedAction: cyclePlan.intendedAction,
      affectedSymbols: cyclePlan.targetSymbols,
      estimatedRiskLevel: cyclePlan.estimatedRisk
    })

    const stepHistory = getStepHistory(input.tier2)
    let confirmedFiles = cyclePlan.targetFiles
    const preloadedFileContents = new Map<string, string>()
    for (const filePath of confirmedFiles) {
      try {
        preloadedFileContents.set(filePath, readFileSync(resolve(input.repoRoot, filePath), 'utf8'))
      } catch {
        continue
      }
    }
    const preMonitor = USE_MONITOR
      ? await runPreActionMonitor({
        currentStep: input.step,
        cyclePlan,
        enrichedPacket: input.enrichedPacket,
        confirmedFiles,
        preloadedFileContents,
        rules: input.intake.rules,
        stepHistory,
        taskId: input.plan.taskId,
        abMode: input.abMode,
        rts: input.rts,
        client: input.client,
        repoRoot: input.repoRoot
      })
      : {
        vetoResult: {
          vetoed: false,
          reason: null,
          vetoType: null,
          constraintReminder: null
        },
        constraintReminders: [],
        remindersAsText: ''
      }
    logInfo('executor:step', '[Step1] Monitor veto result', {
      stepIndex: input.step.stepIndex,
      vetoed: preMonitor.vetoResult.vetoed,
      vetoType: preMonitor.vetoResult.vetoType ?? null,
      reason: preMonitor.vetoResult.reason ?? null
    })

    if (preMonitor.vetoResult.vetoed) {
      logWarn('executor:monitor', '[Executor:Monitor] Pre-action vetoed', {
        stepIndex: input.step.stepIndex,
        vetoType: preMonitor.vetoResult.vetoType,
        reason: preMonitor.vetoResult.reason
      })
      actor.send({
        type: 'VETO_RESULT',
        vetoed: true,
        reason: preMonitor.vetoResult.reason ?? undefined,
        constraintReminder: preMonitor.vetoResult.constraintReminder ?? undefined
      })
      input.rts.append({
        task_id: input.plan.taskId,
        ab_mode: input.abMode,
        agent_role: 'monitor',
        step_index: input.step.stepIndex,
        event_type: 'veto',
        content_json: JSON.stringify(preMonitor.vetoResult),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })
      return {
        outcome: 'vetoed',
        stepOutput: null,
        monitorInterventions: 1,
        vetoReason: preMonitor.vetoResult.reason,
        tokensUsed,
        costUsd,
        writeCount: 0,
        testsPassed: false,
        typeCheckPassed: false
      }
    }

    actor.send({ type: 'VETO_RESULT', vetoed: false })
    logInfo('executor:monitor', '[Executor:Monitor] Pre-action approved', {
      stepIndex: input.step.stepIndex,
      reminderCount: preMonitor.constraintReminders.length
    })

    const surfaceWithoutTests = await buildImplementationSurface(
      input.enrichedPacket,
      input.plan,
      input.repoRoot,
      input.client,
      input.seedFiles ?? []
    )
    if (getStepPhase(input.step) === 'continuous' && confirmedFiles.length === 0) {
      confirmedFiles = surfaceWithoutTests.primaryFiles
        .slice(0, 3)
        .map((file) => file.path)
    }
    const implementationSurface = attachRelatedTestFiles(
      surfaceWithoutTests,
      confirmedFiles,
      input.repoRoot
    )
    hydrateSurfaceFromTier2(implementationSurface, input)
    logImplementationSurface(input, implementationSurface)

    const retrievedContext = await input.contextDb.query({
      queryText: input.step.description,
      currentRepo: input.intake.rules.repo_name,
      symbols: input.step.affectedSymbols,
      chunkTypes: ['task', 'symbol', 'approach', 'pattern', 'error', 'test', 'dependency', 'convention'],
      abMode: input.abMode,
      limit: 20
    })
    const contextDbItems = retrievedContext.chunks.map((entry) => {
      const content = JSON.stringify(entry.chunk)
      return {
        chunkId: entry.chunk.chunk_id,
        content,
        source: 'context_db' as const,
        tokens: countTokens(content, input.plan.assignedExecutorModel),
        score: entry.final_score
      }
    })
    const searchResponse = await codebaseSearch({
      query: input.step.description,
      taskType: input.enrichedPacket.taskType === 'bug_fix' ? 'bug' : 'general',
      limit: 8
    }, input.client).catch(() => ({ results: [], total: 0, cursor: null, expandedContext: [] }))
    const baseMemoryItems: WorkingContentItem[] = []

    for (const result of searchResponse.results) {
      if (typeof result.id !== 'string' || typeof result.content !== 'string') {
        continue
      }

      baseMemoryItems.push({
        chunkId: result.id,
        content: result.content,
        source: 'basememory',
        tokens: countTokens(result.content, input.plan.assignedExecutorModel),
        score: result.score
      })
    }
    const tier2Items = input.tier2.toWorkingContentItems()
    const surfaceItems = implementationSurface.searchHits.map((hit, index) => ({
      chunkId: `surface:search:${index}:${hit.file}:${hit.line}`,
      content: `${hit.file}:${hit.line}: ${hit.match}`,
      source: 'tier2' as const,
      tokens: countTokens(`${hit.file}:${hit.line}: ${hit.match}`, input.plan.assignedExecutorModel),
      score: 1
    }))
    const preloadedImplementationFiles = getPreloadedImplementationFiles(input, implementationSurface, confirmedFiles)
    if (preloadedImplementationFiles.length > 0) {
      logInfo('executor:preload', '[Executor:PreLoad] Pre-loading files into step context', {
        stepIndex: input.step.stepIndex,
        phase: getStepPhase(input.step),
        fileCount: preloadedImplementationFiles.length
      })
      for (const file of preloadedImplementationFiles) {
        logInfo('executor:preload', '[Executor:PreLoad] file loaded', {
          stepIndex: input.step.stepIndex,
          path: file.path,
          bytes: file.bytes
        })
      }
    }

    const preloadItems: WorkingContentItem[] = preloadedImplementationFiles.map((file) => ({
      chunkId: `preload:${file.path}`,
      content: file.content,
      source: 'tier2' as const,
      tokens: countTokens(file.content, input.plan.assignedExecutorModel),
      score: 1
    }))

    const workingContent = [...preloadItems, ...surfaceItems, ...contextDbItems, ...baseMemoryItems, ...tier2Items]
      .filter((item) => {
        const injectionResult = classifyInjection(item.content)

        if (injectionResult.clean) {
          return true
        }

        input.rts.append({
          task_id: input.plan.taskId,
          ab_mode: input.abMode,
          agent_role: 'sek',
          step_index: input.step.stepIndex,
          event_type: 'sek_scan',
          content_json: JSON.stringify({
            checkType: 'retrieved_content',
            approved: false,
            injectionPatterns: injectionResult.patterns,
            chunkId: item.chunkId
          }),
          tokens_used: null,
          cost_usd: null,
          created_at: new Date().toISOString()
        })

        return false
      })

    actor.send({ type: 'RETRIEVAL_COMPLETE', items: workingContent })

    const capRatio = getStepPhase(input.step) === 'continuous'
      ? CONTINUOUS_CONTEXT_CAP_RATIO
      : DEFAULT_CONTEXT_CAP_RATIO
    const capTokens = Math.floor(getModelLimit(input.plan.assignedExecutorModel) * capRatio)
    const workingTokensBeforeCompression = workingContent.reduce((sum, item) => sum + item.tokens, 0)
    const targetCompressionBudget = Math.max(0, Math.floor(capTokens * 0.5))
    let compressedItems = workingContent

    if (workingTokensBeforeCompression > targetCompressionBudget) {
      const preloadItemsForCompression = workingContent.filter((item) => item.chunkId.startsWith('preload:'))
      const compressibleItems = workingContent.filter((item) => !item.chunkId.startsWith('preload:'))
      const compressionModel = getCompressionModel(compressionProvider, input.plan.assignedExecutorModel)
      const compressionResult = await compressWorkingContent({
        items: compressibleItems,
        model: compressionModel,
        targetTokenBudget: targetCompressionBudget,
        taskContext: input.step.description
      }, compressionProvider)
      compressedItems = [...preloadItemsForCompression, ...compressionResult.compressed]
      logInfo('executor:compression', '[Executor:Compression] Working content compressed', {
        stepIndex: input.step.stepIndex,
        beforeTokens: compressionResult.originalTokens + preloadItemsForCompression.reduce((sum, item) => sum + item.tokens, 0),
        afterTokens: compressionResult.compressedTokens + preloadItemsForCompression.reduce((sum, item) => sum + item.tokens, 0),
        preservedPreloadItems: preloadItemsForCompression.length,
        reductionPct: compressionResult.originalTokens === 0
          ? 0
          : Number((((compressionResult.originalTokens - compressionResult.compressedTokens) / compressionResult.originalTokens) * 100).toFixed(1))
      })
    }

    actor.send({ type: 'COMPRESSION_COMPLETE', items: compressedItems })

    const budgetAnchors = {
      ...anchors,
      enrichedPacket: appendImplementationContextToAnchor(
        anchors.enrichedPacket,
        preloadedImplementationFiles
      ),
      currentStepDescription: preMonitor.remindersAsText.length > 0
        ? `${anchors.currentStepDescription}\n${preMonitor.remindersAsText}`
        : anchors.currentStepDescription
    }
    const initialAssembly = {
      anchors: budgetAnchors,
      workingContent: compressedItems
    }

    const budgetResult = approveOrTrimBudget(initialAssembly, input)
    logBudgetCheck(budgetResult.result, input.rts, input.plan.taskId, input.step.stepIndex, input.abMode)
    logInfo('executor:budget', '[Executor:Budget] Budget check complete', {
      stepIndex: input.step.stepIndex,
      approved: budgetResult.result.approved,
      totalTokens: budgetResult.result.totalTokens,
      utilizationPct: budgetResult.result.utilizationPct
    })

    if (budgetResult.result.approved === false) {
      actor.send({ type: 'BUDGET_REJECTED', result: budgetResult.result })
      return {
        outcome: 'budget_overflow',
        stepOutput: null,
        monitorInterventions,
        vetoReason: budgetResult.result.rejectionReason ?? null,
        tokensUsed,
        costUsd,
        writeCount: writeSuccessCount,
        testsPassed,
        typeCheckPassed
      }
    }

    let activeWorkingContent = budgetResult.workingContent
    actor.send({ type: 'BUDGET_APPROVED', result: budgetResult.result })
    logInfo('executor:step', '[Step1] Ready to start tool loop', {
      stepIndex: input.step.stepIndex,
      phase: getStepPhase(input.step),
      workingContentItems: activeWorkingContent.length,
      preloadedFiles: preloadedImplementationFiles.map((file) => file.path)
    })

    const toolContext: ToolExecutionContext = {
      repoRoot: input.repoRoot,
      taskId: input.plan.taskId,
      stepIndex: input.step.stepIndex,
      rts: input.rts,
      abMode: input.abMode,
      repoContext: input.intake.repoContext,
      rulesTestCommand: input.intake.rules.test_command ?? null,
      commandMode: 'pre_write'
    }
    const sekContext: SekContext = {
      taskId: input.plan.taskId,
      stepIndex: input.step.stepIndex,
      rts: input.rts,
      abMode: input.abMode
    }
    const tools = getStepToolDefinitions(input.step, implementationSurface)
    const progressState: ProgressState = {
      filesRead: [],
      filesWritten: [],
      iterationCount: 0,
      blockedActions: [],
      conversationSummary: null
    }
    const initialUserMessage = buildConversationMessages(
      { ...input, cyclePlan },
      preMonitor.remindersAsText,
      implementationSurface,
      preloadedImplementationFiles,
      confirmedFiles
    )
    const staticSystemPrompt = buildExecutorSystemPrompt(input.intake.repoContext, input.intake.rules.test_command ?? null)
    const eventMessages: LlmMessage[] = buildSyntheticPreloadMessages(
      preloadedImplementationFiles
    )
    const historySummaries: string[] = []
    let finalText = ''
    let toolIterations = 0
    let earlyExitReason: string | null = null
    let postWriteMode = false
    let validationPassed = false
    let validationFailed = false
    let applyPatchFailCount = 0
    const touchedFiles = new Set<string>()
    const repoChangedFiles = new Set<string>()
    const writtenFiles = new Set<string>()
    const failedWriteTargets = new Set<string>()
    const failedValidationFiles = new Set<string>()
    const recoveryReadsUsed = new Set<string>()
    const readFileCache = new Map<string, string>()
    const readFileVersions = new Map<string, number>()
    const filesReadThisStep = new Set<string>()
    const preloadedFilePaths = new Set(preloadedImplementationFiles.map((file) => file.path))
    for (const file of preloadedImplementationFiles) {
      readFileCache.set(file.path, buildSyntheticPreloadReadResult(file.content))
      readFileVersions.set(file.path, file.mtimeMs)
      filesReadThisStep.add(file.path)
    }
    let discoveryToolCalls = 0
    let implementationAdditionalReads = 0
    let consecutiveSearchMisses = 0
    let verifiedFileReadCount = 0
    let hasReadVerifiedFile = false
    let hasReadHelperInSameFile = false
    let surfaceConfirmedFiles: string[] = []
    let repeatedRepairFailure: { toolName: string; count: number } | null = null
    const filesReadInDiscovery = new Set<string>()
    const consecutiveSameToolErrors = new Map<string, number>()
    const primaryVerifiedChunk = input.enrichedPacket.verifiedChunkIds[0] ?? ''
    const primaryVerifiedChunkSeparator = primaryVerifiedChunk.lastIndexOf(':')
    const primaryVerifiedFilePath = primaryVerifiedChunkSeparator >= 0
      ? primaryVerifiedChunk.slice(0, primaryVerifiedChunkSeparator)
      : ''
    const primaryVerifiedRange = primaryVerifiedChunkSeparator >= 0
      ? primaryVerifiedChunk.slice(primaryVerifiedChunkSeparator + 1)
      : ''
    const primaryVerifiedStartLine = Number.parseInt((primaryVerifiedRange.split('-')[0] ?? ''), 10)

    while (toolIterations < MAX_TOOL_ITERATIONS) {
      progressState.iterationCount = toolIterations + 1

      if (toolIterations + 1 >= ITERATION_WARNING_THRESHOLD && writeSuccessCount === 0) {
        logWarn('executor:tool-loop', `[Executor:ToolLoop] WARNING — ${toolIterations + 1}/${MAX_TOOL_ITERATIONS} iterations used with 0 writes`, {
          stepIndex: input.step.stepIndex
        })
      }

      logInfo('executor:tool-loop', `[Executor:ToolLoop] Iteration ${toolIterations + 1}/${MAX_TOOL_ITERATIONS}`, {
        stepIndex: input.step.stepIndex
      })
      const compactedEventMessages = compactIfNeeded(eventMessages, input.plan.assignedExecutorModel)
      const llmResponse = await executorProvider.callWithTools(
        [initialUserMessage, ...compactedEventMessages],
        tools,
        input.plan.assignedExecutorModel,
        staticSystemPrompt
      )
      tokensUsed += llmResponse.tokensUsed
      costUsd += llmResponse.costUsd
      input.rts.append({
        task_id: input.plan.taskId,
        ab_mode: input.abMode,
        agent_role: 'executor',
        step_index: input.step.stepIndex,
        event_type: 'llm_call',
        content_json: JSON.stringify({
          model: input.plan.assignedExecutorModel,
          tokensUsed: llmResponse.tokensUsed,
          costUsd: llmResponse.costUsd,
          contentTypes: llmResponse.content.map((block) => block.type)
        }),
        tokens_used: llmResponse.tokensUsed,
        cost_usd: llmResponse.costUsd,
        created_at: new Date().toISOString()
      })
      logInfo('executor:llm', '[Executor:LLM] Response received', {
        stepIndex: input.step.stepIndex,
        model: input.plan.assignedExecutorModel,
        tokensUsed: llmResponse.tokensUsed,
        costUsd: llmResponse.costUsd,
        contentTypes: llmResponse.content.map((block) => block.type)
      })

      const responseText = llmResponse.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
      const recoveredToolCall = llmResponse.content.some((block) => block.type === 'tool_use')
        ? null
        : recoverPseudoToolCall(responseText)
      const responseBlocks = recoveredToolCall === null
        ? llmResponse.content
        : [{
          type: 'tool_use' as const,
          id: `recovered-${toolIterations + 1}`,
          name: recoveredToolCall.name,
          input: recoveredToolCall.input
        }]

      if (recoveredToolCall !== null) {
        logWarn('executor:repair', '[Repair] Recovered pseudo-tool-call from text', {
          stepIndex: input.step.stepIndex,
          toolName: recoveredToolCall.name,
          input: recoveredToolCall.input
        })
      }

      let sawToolUse = false

      for (const block of responseBlocks) {
        if (block.type === 'text') {
          finalText += block.text ?? ''
        }

        if (block.type !== 'tool_use') {
          continue
        }

        sawToolUse = true
        let toolName = block.name ?? 'unknown'
        const toolUseId = block.id ?? `tool-${input.step.stepIndex}-${toolIterations + 1}-${Date.now()}`
        let toolInput = block.input ?? {}

        try {
        const repairedInput = repairToolArgs(toolName, toolInput, llmResponse.reasoningText ?? responseText)

        if (!sameRecord(toolInput, repairedInput)) {
          logWarn('executor:repair', '[Repair] Repaired tool args', {
            stepIndex: input.step.stepIndex,
            toolName,
            before: summarizeToolInput(toolInput),
            after: summarizeToolInput(repairedInput)
          })
          toolInput = repairedInput
        }

        if (requiresStructuredToolArgs(toolName) && Object.keys(toolInput).length === 0) {
          const previousRepairCount: number = repeatedRepairFailure?.toolName === toolName
            ? repeatedRepairFailure.count
            : 0
          repeatedRepairFailure = previousRepairCount > 0
            ? { toolName, count: previousRepairCount + 1 }
            : { toolName, count: 1 }
          const repairError = `ERROR: Could not repair tool args for ${toolName}. Try a more specific tool call.`
          eventMessages.push({
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: toolName,
              input: toolInput
            }]
          })
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: repairError
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            repairError,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          logWarn('executor:repair', '[Repair] WARNING: Could not repair tool args', {
            stepIndex: input.step.stepIndex,
            toolName,
            attempts: repeatedRepairFailure.count
          })
          if (repeatedRepairFailure.count >= 2) {
            return {
              outcome: 'error',
              stepOutput: null,
              monitorInterventions,
              vetoReason: `Repeated unrepairable tool args for ${toolName}`,
              tokensUsed,
              costUsd,
              writeCount: writeSuccessCount,
              testsPassed,
              typeCheckPassed
            }
          }
          continue
        }

        repeatedRepairFailure = null
        eventMessages.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: toolInput
          }]
        })

        if (getStepPhase(input.step) === 'discovery') {
          discoveryToolCalls += 1
        }

        if (toolName === 'confirm_surface') {
          const confirmation = ConfirmSurfaceInputSchema.parse(toolInput)

          if (confirmation.ready_to_implement === false && discoveryToolCalls < MAX_DISCOVERY_TOOL_CALLS) {
            const loadedFiles = confirmImplementationSurface(input, implementationSurface, {
              confirmed_files: [],
              additional_files: confirmation.additional_files,
              ready_to_implement: false
            }, [...filesReadInDiscovery])
            const notReadyText = [
              'Surface updated, but discovery will continue.',
              loadedFiles.length > 0 ? `Loaded additional files: ${loadedFiles.join(', ')}` : 'No additional files were loaded.'
            ].join(' ')
            eventMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: notReadyText
              }],
              cache_control: { type: 'ephemeral' }
            })
            activeWorkingContent = appendToolResult(
              activeWorkingContent,
              toolUseId,
              notReadyText,
              input.plan.assignedExecutorModel,
              budgetAnchors
            )
            historySummaries.push(`updated surface without confirming implementation (${loadedFiles.join(', ') || 'no additional files'})`)
            logInfo('executor:discovery', '[Discovery] Surface updated but model is not ready to implement', {
              stepIndex: input.step.stepIndex,
              additionalFiles: confirmation.additional_files
            })
            continue
          }

          const confirmed = confirmImplementationSurface(input, implementationSurface, confirmation, [...filesReadInDiscovery])
          surfaceConfirmedFiles = confirmed
          finalText = buildSurfaceConfirmationText(confirmed, confirmation.additional_files)
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `Surface confirmed. Confirmed: ${confirmed.join(', ') || 'none'}.`
            }],
            cache_control: { type: 'ephemeral' }
          })
          historySummaries.push(`confirmed surface (${confirmed.join(', ') || 'none'})`)
          logInfo('executor:discovery', '[Discovery] Surface confirmed by model', {
            stepIndex: input.step.stepIndex,
            confirmedFiles: confirmed,
            additionalFiles: confirmation.additional_files
          })
          break
        }

        if (postWriteMode) {
          const isContinuousStep = input.step.phaseHint === 'continuous'
          const isRepairContext = validationFailed && failedValidationFiles.size > 0

          if (isWriteToolName(toolName)) {
            const targetFile = extractWriteTarget(input.repoRoot, toolName, toolInput)
            const alreadyWritten = targetFile !== null && writtenFiles.has(targetFile)
            const inScope = targetFile !== null && confirmedFiles.some((filePath) => {
              return filePath === targetFile
                || filePath.endsWith(`/${targetFile}`)
                || targetFile.endsWith(`/${filePath}`)
            })
            const underWriteLimit = writtenFiles.size < MAX_FILES_WRITTEN_PER_STEP

            const isConfirmedRepair =
              isRepairContext
              && targetFile !== null
              && failedValidationFiles.has(targetFile)
              && inScope
              && alreadyWritten
              && (toolName === 'replace_in_file' || toolName === 'apply_patch')

            if (!isConfirmedRepair && (alreadyWritten || !inScope || !underWriteLimit)) {
              const blockedResultText = buildPostWriteBlockedResult(toolName, {
                reason: alreadyWritten
                  ? validationFailed
                    ? `File "${targetFile}" was already written in this step. Only confirmed files that failed validation can be repaired.`
                    : validationPassed
                      ? `File "${targetFile}" was already written in this step and the latest validation passed. Do not rewrite the same file twice.`
                      : `File "${targetFile}" was already written in this step. Do not rewrite the same file twice.`
                  : !inScope
                    ? `File "${targetFile ?? 'unknown'}" is not in the confirmed implementation surface.`
                    : `You have already written ${writtenFiles.size} confirmed file(s) in this step.`
              })
              eventMessages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: blockedResultText
                }],
                cache_control: { type: 'ephemeral' }
              })
              activeWorkingContent = appendToolResult(
                activeWorkingContent,
                toolUseId,
                blockedResultText,
                input.plan.assignedExecutorModel,
                budgetAnchors
              )
              historySummaries.push(`${toolName} blocked (post-write mode)`)
              continue
            }
          } else if (toolName === 'read_file' && typeof toolInput.path === 'string') {
            const normalizedReadTarget = toRepoRelativePath(input.repoRoot, toolInput.path)
            const isConfirmedReadTarget = confirmedFiles.some((filePath) => {
              return filePath === normalizedReadTarget
                || filePath.endsWith(`/${normalizedReadTarget}`)
                || normalizedReadTarget.endsWith(`/${filePath}`)
                || basename(filePath) === basename(normalizedReadTarget)
            })
            const isWrittenReadTarget = [...writtenFiles].some((filePath) => {
              return filePath === normalizedReadTarget
                || filePath.endsWith(`/${normalizedReadTarget}`)
                || normalizedReadTarget.endsWith(`/${filePath}`)
            })

            if (isRepairContext && isWrittenReadTarget) {
              // Allow re-reading the written file after failed validation.
            } else if (isContinuousStep && !validationPassed) {
              if (!isConfirmedReadTarget) {
                const blockedResultText = `[Post-write: reads are limited to confirmed implementation files. ${normalizedReadTarget} is not in the confirmed surface.]`
                eventMessages.push({
                  role: 'user',
                  content: [{
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: blockedResultText
                  }],
                  cache_control: { type: 'ephemeral' }
                })
                activeWorkingContent = appendToolResult(
                  activeWorkingContent,
                  toolUseId,
                  blockedResultText,
                  input.plan.assignedExecutorModel,
                  budgetAnchors
                )
                historySummaries.push(`${toolName} blocked (post-write unconfirmed read)`)
                continue
              }
            } else if (!isAllowedRecoveryRead(
              input.repoRoot,
              toolInput.path,
              confirmedFiles,
              failedWriteTargets,
              recoveryReadsUsed
            )) {
              const blockedResultText = buildPostWriteBlockedResult(toolName)
              eventMessages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: blockedResultText
                }],
                cache_control: { type: 'ephemeral' }
              })
              activeWorkingContent = appendToolResult(
                activeWorkingContent,
                toolUseId,
                blockedResultText,
                input.plan.assignedExecutorModel,
                budgetAnchors
              )
              historySummaries.push(`${toolName} blocked (post-write mode)`)
              continue
            }
          } else if (!POST_WRITE_ALLOWED_TOOLS.has(toolName)) {
            const blockedResultText = buildPostWriteBlockedResult(toolName)
            eventMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: blockedResultText
              }],
              cache_control: { type: 'ephemeral' }
            })
            activeWorkingContent = appendToolResult(
              activeWorkingContent,
              toolUseId,
              blockedResultText,
              input.plan.assignedExecutorModel,
              budgetAnchors
            )
            historySummaries.push(`${toolName} blocked (post-write mode)`)
            continue
          }

          if (toolName === 'run_command') {
            const command = typeof toolInput.command === 'string' ? toolInput.command : ''
            if (!isAllowedPostWriteCommand(command)) {
              const blockedResultText = `[BLOCKED: Only test commands and type-check commands are allowed after implementation. Command "${command}" is not permitted.]`
              eventMessages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: blockedResultText
                }],
                cache_control: { type: 'ephemeral' }
              })
              activeWorkingContent = appendToolResult(
                activeWorkingContent,
                toolUseId,
                blockedResultText,
                input.plan.assignedExecutorModel,
                budgetAnchors
              )
              historySummaries.push(`run_command blocked (${command || 'empty command'})`)
              continue
            }
          }
        }

        const hardBlockedReason = getHardBlockedToolReason(input.step, toolName, toolInput)
        if (hardBlockedReason !== null) {
          progressState.blockedActions.push(`${toolName}: ${hardBlockedReason}`)
          const blockedResultText = `Blocked by policy: ${hardBlockedReason}. Available tools: write_file, apply_patch, replace_in_file, read_file, run_tests, search_in_files.`
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: blockedResultText
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            blockedResultText,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          logWarn('executor:tool-loop', '[Executor:ToolLoop] Hard-blocked tool', {
            stepIndex: input.step.stepIndex,
            toolName,
            reason: hardBlockedReason
          })
          historySummaries.push(`${toolName} blocked (${hardBlockedReason})`)
          continue
        }

        const hasVerifiedWindow = input.enrichedPacket.verifiedChunkIds.length > 0
        if (
          hasReadVerifiedFile
          && hasReadHelperInSameFile
          && writeSuccessCount === 0
          && toolName !== 'replace_in_file'
          && toolName !== 'apply_patch'
        ) {
          const forceWriteMsg = '[PlanOne] You have read the verified function and at least one related helper. No more reading is allowed. Call replace_in_file or apply_patch now with your change.'
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: forceWriteMsg
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            forceWriteMsg,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          historySummaries.push('forced write after reading verified function and helper')
          continue
        }

        if (toolName === 'search_in_files' && writeSuccessCount === 0 && hasVerifiedWindow) {
          const blockedResultText = [
            '[BLOCKED] The relevant code is already shown in the initial message.',
            'Read the preloaded section and make your change directly.',
            'Do not search for code that is already visible.'
          ].join(' ')
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: blockedResultText
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            blockedResultText,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          historySummaries.push(`${toolName} blocked (verified code window already provided)`)
          continue
        }

        if (isImplementationSearchTool(toolName) && getStepPhase(input.step) === 'implementation' && consecutiveSearchMisses >= 2 && writeSuccessCount === 0) {
          const blockedResultText = [
            '[BLOCKED: Third consecutive empty search. Searching is no longer permitted.',
            'The symbol or pattern you are searching for does not exist with that name.',
            'Your preloaded files are already in context. Use their content to write your change.',
            'Call write_file, replace_in_file, or apply_patch now. Do not search again.]'
          ].join('\n')
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: blockedResultText
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            blockedResultText,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          consecutiveSearchMisses = 0
          historySummaries.push(`${toolName} blocked (third consecutive empty search)`)
          continue
        }

        const duplicateReadMessage = buildReadPolicyMessage(
          input,
          toolName,
          toolInput,
          readFileCache,
          preloadedFilePaths,
          implementationAdditionalReads,
          filesReadInDiscovery,
          failedWriteTargets,
          recoveryReadsUsed,
          validationFailed ? failedValidationFiles : new Set<string>()
        )

        if (getStepPhase(input.step) === 'implementation' && !isImplementationSearchTool(toolName)) {
          consecutiveSearchMisses = 0
        }

        if (duplicateReadMessage !== null) {
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: duplicateReadMessage
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(
            activeWorkingContent,
            toolUseId,
            duplicateReadMessage,
            input.plan.assignedExecutorModel,
            budgetAnchors
          )
          logWarn('executor:tool-loop', '[Executor:ToolLoop] Duplicate read served from cache', {
            stepIndex: input.step.stepIndex,
            toolName,
            path: summarizeToolInput(toolInput).path ?? null
          })
          historySummaries.push(`reused cached ${summarizeToolInput(toolInput).path ?? 'file'}`)
          continue
        }

        input.rts.append({
          task_id: input.plan.taskId,
          ab_mode: input.abMode,
          agent_role: 'executor',
          step_index: input.step.stepIndex,
          event_type: 'tool_call',
          content_json: JSON.stringify({
            name: toolName,
            input: summarizeToolInput(toolInput)
          }),
          tokens_used: null,
          cost_usd: null,
          created_at: new Date().toISOString()
        })
        logInfo('executor:tool', `[Executor:Tool] ${toolName}`, {
          stepIndex: input.step.stepIndex,
          input: summarizeToolInput(toolInput)
        })
        let blockedToolResultText: string | null = null

        if (toolName === 'write_file' && typeof toolInput.content === 'string' && typeof toolInput.path === 'string') {
          const sekResult = await checkBeforeWrite(toolInput.content, toolInput.path, sekContext)

          if (sekResult.approved === false) {
            blockedToolResultText = 'BLOCKED: injection pattern detected'
          }
        }

        if (toolName === 'apply_patch' && typeof toolInput.patch === 'string') {
          const sekResult = await checkBeforeWrite(toolInput.patch, 'patch', sekContext)

          if (sekResult.approved === false) {
            blockedToolResultText = 'BLOCKED: injection pattern in patch'
          }
        }

        if (toolName === 'replace_in_file'
          && typeof toolInput.new_string === 'string'
          && typeof toolInput.path === 'string') {
          const sekResult = await checkBeforeWrite(toolInput.new_string, toolInput.path, sekContext)

          if (sekResult.approved === false) {
            blockedToolResultText = 'BLOCKED: injection pattern detected'
          }
        }

        if (blockedToolResultText === null
          && toolName === 'replace_in_file'
          && typeof toolInput.path === 'string'
          && typeof toolInput.old_string === 'string') {
          const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          const fileVersionChanged = hasFileVersionChangedSinceRead(input.repoRoot, normalizedPath, readFileVersions)

          if (fileVersionChanged) {
            blockedToolResultText = buildStaleReadBlockedMessage('replace_in_file', normalizedPath)
          }
        }

        if (blockedToolResultText === null
          && toolName === 'replace_in_file'
          && typeof toolInput.path === 'string'
          && typeof toolInput.old_string === 'string') {
          const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          const fileWasReadThisStep = filesReadThisStep.has(normalizedPath)

          if (!fileWasReadThisStep) {
            blockedToolResultText = [
              '[BLOCKED] replace_in_file requires reading the file first.',
              '',
              'This file was not read this step.',
              'Read the exact file or range first so the replacement is based on current file content.',
              '',
              `Read the file first: read_file({ path: "${toolInput.path}", startLine: 1, endLine: 80 })`
            ].join('\n')
          }
        }

        if (blockedToolResultText === null
          && toolName === 'apply_patch'
          && typeof toolInput.patch === 'string') {
          const normalizedTarget = extractPatchTarget(toolInput.patch)

          if (normalizedTarget === null) {
            blockedToolResultText = [
              '[BLOCKED] apply_patch requires reading the file first.',
              '',
              'Your patch did not identify a target file that can be validated against prior file reads.',
              'Read the file first, then generate a patch from the exact text you received this step.'
            ].join('\n')
          } else {
            const fileVersionChanged = hasFileVersionChangedSinceRead(input.repoRoot, normalizedTarget, readFileVersions)

            if (fileVersionChanged) {
              blockedToolResultText = buildStaleReadBlockedMessage('apply_patch', normalizedTarget)
            } else if (!wasPatchReadThisStep(eventMessages, toolInput.patch)) {
              blockedToolResultText = [
                '[BLOCKED] apply_patch requires the exact text from a file read.',
                '',
                'The removal/context lines in your patch were not found in any file content received this step.',
                'Read the exact section you want to modify first, then build the patch from that exact text.',
                '',
                'Do not retype patch context from memory. Copy the lines exactly from the file content you received this step.'
              ].join('\n')
            }
          }
        }

        if (blockedToolResultText !== null) {
          eventMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: blockedToolResultText
            }],
            cache_control: { type: 'ephemeral' }
          })
          activeWorkingContent = appendToolResult(activeWorkingContent, toolUseId, blockedToolResultText, input.plan.assignedExecutorModel, budgetAnchors)
          historySummaries.push(`${toolName} blocked (${blockedToolResultText})`)
          continue
        }

        toolContext.commandMode = postWriteMode ? 'post_write' : 'pre_write'
        const toolResult = await executeTool(toolName, toolInput, toolContext)
        input.rts.append({
          task_id: input.plan.taskId,
          ab_mode: input.abMode,
          agent_role: 'executor',
          step_index: input.step.stepIndex,
          event_type: 'tool_execution',
          content_json: JSON.stringify({
            name: toolName,
            success: toolResult.success,
            ...(toolResult.metadata ?? {})
          }),
          tokens_used: null,
          cost_usd: null,
          created_at: new Date().toISOString()
        })
        logInfo('executor:tool', `[Executor:Tool] ${toolName} result`, {
          stepIndex: input.step.stepIndex,
          success: toolResult.success,
          outputLength: toolResult.output.length,
          error: toolResult.error ?? null
        })
        if (toolResult.success) {
          consecutiveSameToolErrors.set(toolName, 0)
        } else {
          const nextCount = (consecutiveSameToolErrors.get(toolName) ?? 0) + 1
          consecutiveSameToolErrors.set(toolName, nextCount)

          if (nextCount >= 3) {
            const guidanceNote = `[PlanOne: ${toolName} has failed 3 times in a row. Read the relevant file section and try a completely different approach.]`
            appendGuidanceNote(eventMessages, guidanceNote)
            activeWorkingContent = appendToolResult(
              activeWorkingContent,
              `guidance:${toolName}:${toolIterations + 1}`,
              guidanceNote,
              input.plan.assignedExecutorModel,
              budgetAnchors
            )
            historySummaries.push(`${toolName} guidance injected after repeated failures`)
            consecutiveSameToolErrors.set(toolName, 0)
          }
        }

        if (postWriteMode && isValidationToolInvocation(toolName, toolInput)) {
          if (didValidationFail(toolName, toolInput, toolResult)) {
            validationFailed = true
            validationPassed = false
            for (const filePath of writtenFiles) {
              failedValidationFiles.add(filePath)
            }
          } else {
            validationPassed = true
            validationFailed = false
            failedValidationFiles.clear()
          }
        }

        if (toolName === 'read_file' && toolResult.success && typeof toolInput.path === 'string') {
          const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          readFileCache.set(normalizedPath, toolResult.output)
          filesReadThisStep.add(normalizedPath)
          const currentMtimeMs = getFileMtimeMs(input.repoRoot, normalizedPath)
          if (currentMtimeMs !== null) {
            readFileVersions.set(normalizedPath, currentMtimeMs)
          }
          pushUnique(progressState.filesRead, normalizedPath)
          if (failedWriteTargets.has(normalizedPath)) {
            recoveryReadsUsed.add(normalizedPath)
          }
          if (getStepPhase(input.step) === 'discovery') {
            filesReadInDiscovery.add(normalizedPath)
          }
          if (getStepPhase(input.step) === 'implementation' && !preloadedFilePaths.has(normalizedPath)) {
            implementationAdditionalReads += 1
          }

          if (
            primaryVerifiedFilePath.length > 0
            && (
              normalizedPath === primaryVerifiedFilePath
              || normalizedPath.endsWith(`/${primaryVerifiedFilePath}`)
              || primaryVerifiedFilePath.endsWith(`/${normalizedPath}`)
            )
          ) {
            const requestedStartLine = typeof toolInput.startLine === 'number' ? toolInput.startLine : 1
            const requestedEndLine = typeof toolInput.endLine === 'number' ? toolInput.endLine : requestedStartLine
            const coversVerifiedLine = Number.isFinite(primaryVerifiedStartLine)
              && primaryVerifiedStartLine > 0
              && requestedStartLine <= primaryVerifiedStartLine
              && requestedEndLine >= primaryVerifiedStartLine

            if (coversVerifiedLine) {
              hasReadVerifiedFile = true
            } else if (hasReadVerifiedFile) {
              hasReadHelperInSameFile = true
            }
          }
        }

        if (toolName === 'write_file' && typeof toolInput.path === 'string') {
          const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          const wasAlreadyWritten = writtenFiles.has(normalizedPath)
          if (typeof toolInput.content === 'string') {
            const lineCount = toolInput.content.split('\n').length
            if (lineCount > 100) {
              logWarn('executor:step', '[WARNING] Full file rewrite detected (>100 lines). Prefer apply_patch for targeted edits.', {
                stepIndex: input.step.stepIndex,
                path: toolInput.path,
                lineCount
              })
            }
          }
          touchedFiles.add(normalizedPath)
          pushUnique(progressState.filesWritten, normalizedPath)
          if (toolResult.success) {
            if (!wasAlreadyWritten) {
              writeSuccessCount += 1
            }
            postWriteMode = true
            writtenFiles.add(normalizedPath)
            failedWriteTargets.delete(normalizedPath)
            recoveryReadsUsed.delete(normalizedPath)
          } else {
            failedWriteTargets.add(normalizedPath)
            recoveryReadsUsed.delete(normalizedPath)
          }

          for (const filePath of getRepoChangedFiles(input.repoRoot)) {
            repoChangedFiles.add(filePath)
          }

          logInfo('executor:tool', '[Executor:Tool] repository diff after write', {
            stepIndex: input.step.stepIndex,
            changedFiles: [...repoChangedFiles]
          })
        }

        if (toolName === 'replace_in_file' && typeof toolInput.path === 'string') {
          const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          const wasAlreadyWritten = writtenFiles.has(normalizedPath)
          touchedFiles.add(normalizedPath)
          pushUnique(progressState.filesWritten, normalizedPath)
          if (toolResult.success) {
            if (!wasAlreadyWritten) {
              writeSuccessCount += 1
            }
            postWriteMode = true
            writtenFiles.add(normalizedPath)
            failedWriteTargets.delete(normalizedPath)
            recoveryReadsUsed.delete(normalizedPath)
          } else {
            failedWriteTargets.add(normalizedPath)
            recoveryReadsUsed.delete(normalizedPath)
          }

          for (const filePath of getRepoChangedFiles(input.repoRoot)) {
            repoChangedFiles.add(filePath)
          }

          logInfo('executor:tool', '[Executor:Tool] repository diff after replace', {
            stepIndex: input.step.stepIndex,
            changedFiles: [...repoChangedFiles]
          })
        }

        if (toolName === 'apply_patch') {
          const patchTarget = extractWriteTarget(input.repoRoot, toolName, toolInput)
          const wasAlreadyWritten = patchTarget !== null && writtenFiles.has(patchTarget)
          if (!toolResult.success) {
            if (patchTarget !== null) {
              failedWriteTargets.add(patchTarget)
              recoveryReadsUsed.delete(patchTarget)
            }
            applyPatchFailCount += 1
            if (applyPatchFailCount >= 2) {
              const normalizedTarget = patchTarget
              const isConfirmedPatchTarget = normalizedTarget !== null && confirmedFiles.some((filePath) => {
                return filePath === normalizedTarget
                  || filePath.endsWith(`/${normalizedTarget}`)
                  || normalizedTarget.endsWith(`/${filePath}`)
                  || basename(filePath) === basename(normalizedTarget)
              })

              if (!isConfirmedPatchTarget || normalizedTarget === null) {
                return {
                  outcome: 'error',
                  stepOutput: null,
                  monitorInterventions,
                  vetoReason: 'apply_patch failed twice — refusing write_file fallback to prevent off-target full file rewrite',
                  tokensUsed,
                  costUsd,
                  writeCount: writeSuccessCount,
                  testsPassed,
                  typeCheckPassed
                }
              }

              const currentFile = loadImplementationFile(input.repoRoot, normalizedTarget)
              const recoveryText = currentFile === null
                ? 'apply_patch failed twice on a confirmed file, but the current file could not be loaded. Use write_file only if you can make the minimal targeted change safely.'
                : [
                    `apply_patch failed twice on confirmed file ${normalizedTarget}.`,
                    '',
                    'Current file content:',
                    currentFile.content,
                    '',
                    '[Use write_file to make ONLY the targeted change described in your plan. Do not rewrite unrelated sections.]'
                  ].join('\n')

              eventMessages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: recoveryText
                }],
                cache_control: { type: 'ephemeral' }
              })
              activeWorkingContent = appendToolResult(
                activeWorkingContent,
                toolUseId,
                recoveryText,
                input.plan.assignedExecutorModel,
                budgetAnchors
              )
              historySummaries.push(`apply_patch failed twice on ${normalizedTarget}; issued confirmed-file write fallback guidance`)
              applyPatchFailCount = 0
              continue
            }
          } else {
            if (!wasAlreadyWritten) {
              writeSuccessCount += 1
            }
            postWriteMode = true
            applyPatchFailCount = 0
            if (patchTarget !== null) {
              writtenFiles.add(patchTarget)
              failedWriteTargets.delete(patchTarget)
              recoveryReadsUsed.delete(patchTarget)
            }
          }
          for (const filePath of getRepoChangedFiles(input.repoRoot)) {
            repoChangedFiles.add(filePath)
          }
          for (const filePath of repoChangedFiles) {
            pushUnique(progressState.filesWritten, filePath)
          }

          logInfo('executor:tool', '[Executor:Tool] repository diff after patch', {
            stepIndex: input.step.stepIndex,
            changedFiles: [...repoChangedFiles]
          })
        }

        if (toolName === 'run_tests' && toolResult.success) {
          testsPassed = true
        }

        if (toolName === 'run_command' && toolResult.success) {
          const command = typeof toolInput.command === 'string' ? toolInput.command.toLowerCase() : ''
          const isTypeCheck = command.includes('tsc') && command.includes('noemit')
          if (isTypeCheck && !toolResult.output.includes('error TS')) {
            typeCheckPassed = true
          }
          const mutatedFiles = Array.isArray(toolResult.metadata?.mutatedFiles)
            ? toolResult.metadata.mutatedFiles.filter((filePath): filePath is string => typeof filePath === 'string')
            : []
          for (const filePath of mutatedFiles) {
            repoChangedFiles.add(filePath)
            pushUnique(progressState.filesWritten, filePath)
          }
        }

        if (toolName === 'run_command' || toolName === 'apply_patch' || toolName === 'replace_in_file') {
          const diffResult = await executeTool('git_diff', {}, toolContext)
          const afterDiffResult = await checkAfterDiff(diffResult.output, sekContext)

          if (afterDiffResult.approved === false && afterDiffResult.violations.some((violation) => violation.severity === 'block')) {
            return escalateForSek(input, afterDiffResult.violations.map((violation) => violation.description).join('; '))
          }
        }

        if (toolName === 'run_command') {
          const commandOutputResult = await checkCommandOutput(
            typeof toolInput.command === 'string' ? toolInput.command : '',
            toolResult.output,
            toolResult.error ?? '',
            sekContext
          )

          if (commandOutputResult.approved === false && commandOutputResult.violations.some((violation) => violation.severity === 'block')) {
            return escalateForSek(input, commandOutputResult.violations.map((violation) => violation.description).join('; '))
          }
        }

        if (isImplementationSearchTool(toolName) && getStepPhase(input.step) === 'implementation') {
          if (isEmptySearchResult(toolResult)) {
            consecutiveSearchMisses += 1
          } else {
            consecutiveSearchMisses = 0
          }
        }

        let toolResultText = decorateToolResult(
          toolResult.success
            ? toolResult.output
            : `ERROR: ${toolResult.error ?? 'Tool failed'}`,
          input,
          toolName,
          toolInput,
          progressState,
          filesReadInDiscovery,
          implementationSurface,
          consecutiveSearchMisses
        )

        if (toolName === 'read_file' && toolResult.success && typeof toolInput.path === 'string') {
          const readPath = toRepoRelativePath(input.repoRoot, toolInput.path)
          const verifiedFilePath = input.enrichedPacket.verifiedChunkIds[0]?.split(':')[0] ?? ''

          if (verifiedFilePath.length > 0 && (
            readPath === verifiedFilePath
            || readPath.endsWith(`/${verifiedFilePath}`)
            || verifiedFilePath.endsWith(`/${readPath}`)
          )) {
            verifiedFileReadCount += 1

            if (verifiedFileReadCount >= 2 && writeSuccessCount === 0) {
              toolResultText += '\n\n[PlanOne] You have read the target function and its helpers. You have enough context to make the fix. Call replace_in_file with the exact change now. Do not read more files.'
            }
          }
        }

        eventMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: toolResultText
          }],
          cache_control: { type: 'ephemeral' }
        })
        const readThisStepChunkId = toolName === 'read_file'
          && toolResult.success
          && typeof toolInput.path === 'string'
          && getStepPhase(input.step) === 'implementation'
          ? `read_this_step:${toRepoRelativePath(input.repoRoot, toolInput.path)}`
          : undefined
        activeWorkingContent = appendToolResult(
          activeWorkingContent,
          toolUseId,
          toolResultText,
          input.plan.assignedExecutorModel,
          budgetAnchors,
          readThisStepChunkId
        )
        historySummaries.push(summarizeHistoryEvent(toolName, toolInput, toolResult, progressState))

        if (getStepPhase(input.step) === 'discovery' && filesReadInDiscovery.size >= DISCOVERY_CONFIRM_AFTER_READS) {
          trimDiscoveryReadResults(eventMessages, MAX_DISCOVERY_LINES_PER_FILE)
        }

        } catch (err) {
          input.rts.append({
            task_id: input.plan.taskId,
            ab_mode: input.abMode,
            agent_role: 'executor',
            step_index: input.step.stepIndex,
            event_type: 'error',
            content_json: JSON.stringify({
              location: 'tool_dispatch',
              tool_name: toolName,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined
            }),
            tokens_used: null,
            cost_usd: null,
            created_at: new Date().toISOString()
          })
          throw err
        }
      }

      if (getStepPhase(input.step) === 'discovery' && discoveryToolCalls >= DISCOVERY_AUTO_CONFIRM_AFTER_CALLS && surfaceConfirmedFiles.length === 0 && filesReadInDiscovery.size >= DISCOVERY_CONFIRM_AFTER_READS) {
        surfaceConfirmedFiles = autoConfirmImplementationSurface(implementationSurface, [...filesReadInDiscovery])
        finalText = buildSurfaceConfirmationText(surfaceConfirmedFiles, [])
        logInfo('executor:discovery', '[Discovery] Auto-confirmed shortlist after sufficient reads without confirm_surface', {
          stepIndex: input.step.stepIndex,
          confirmedFiles: surfaceConfirmedFiles
        })
        break
      }

      if (getStepPhase(input.step) === 'discovery' && discoveryToolCalls >= MAX_DISCOVERY_TOOL_CALLS && surfaceConfirmedFiles.length === 0) {
        surfaceConfirmedFiles = autoConfirmImplementationSurface(implementationSurface, [...filesReadInDiscovery])
        finalText = buildSurfaceConfirmationText(surfaceConfirmedFiles, [])
        logInfo('executor:discovery', '[Discovery] Auto-confirmed high-confidence files after tool limit', {
          stepIndex: input.step.stepIndex,
          confirmedFiles: surfaceConfirmedFiles
        })
        break
      }

      if (getStepPhase(input.step) === 'discovery' && surfaceConfirmedFiles.length > 0) {
        break
      }

      if (finalText.trim().length > 0 && sawToolUse === false) {
        break
      }

      if (toolIterations + 1 >= 10 && writeSuccessCount === 0) {
        earlyExitReason = 'No writes after 10 tool calls. Localization likely incorrect.'
        logWarn('executor:step', '[Executor:Step] Fail-fast no-write exit', {
          stepIndex: input.step.stepIndex,
          toolIterations: toolIterations + 1
        })
        break
      }

      activeWorkingContent = trimWorkingContent(activeWorkingContent, budgetAnchors, input.plan.assignedExecutorModel, 'drop_last')
      toolIterations += 1
    }

    if (earlyExitReason !== null && finalText.trim().length === 0) {
      actor.send({ type: 'ERROR_OCCURRED', error: new Error(earlyExitReason) })
      return {
        outcome: 'error',
        stepOutput: null,
        monitorInterventions,
        vetoReason: earlyExitReason,
        tokensUsed,
        costUsd,
        writeCount: writeSuccessCount,
        testsPassed,
        typeCheckPassed
      }
    }

    if (toolIterations >= MAX_TOOL_ITERATIONS && finalText.trim().length === 0) {
      actor.send({ type: 'ERROR_OCCURRED', error: new Error('Max tool iterations exceeded') })
      if (writeSuccessCount === 0) {
        logWarn('executor:step', `[Executor:Step] FAIL-FAST — ${MAX_TOOL_ITERATIONS} calls, 0 writes`, {
          stepIndex: input.step.stepIndex
        })
      }
      return {
        outcome: 'error',
        stepOutput: null,
        monitorInterventions,
        vetoReason: writeSuccessCount === 0
          ? `Step hit ${MAX_TOOL_ITERATIONS}-call limit with no writes`
          : 'Max tool iterations exceeded',
        tokensUsed,
        costUsd,
        writeCount: writeSuccessCount,
        testsPassed,
        typeCheckPassed
      }
    }

    const stepOutput: StepOutput = {
      stepIndex: input.step.stepIndex,
      producedContent: finalText.trim(),
      affectedFiles: resolveAffectedFiles(
        surfaceConfirmedFiles,
        [...repoChangedFiles],
        inferAffectedFiles(
          activeWorkingContent,
          input.step.affectedFiles,
          touchedFiles,
          repoChangedFiles
        )
      ),
      causalDependencies: input.step.dependsOn,
      baseMemoryChunksUsed: searchResponse.results
        .flatMap((result) => typeof result.id === 'string' ? [result.id] : [])
    }

    input.tier2.record(stepOutput)
    actor.send({ type: 'EXECUTION_COMPLETE', output: stepOutput })
    actor.send({ type: 'OUTPUT_WRITTEN' })

    const postMonitor = USE_MONITOR
      ? await runPostStepMonitor({
        currentStep: input.step,
        cyclePlan,
        enrichedPacket: input.enrichedPacket,
        confirmedFiles,
        preloadedFileContents,
        rules: input.intake.rules,
        stepHistory,
        taskId: input.plan.taskId,
        abMode: input.abMode,
        rts: input.rts,
        client: input.client,
        repoRoot: input.repoRoot
      }, stepOutput)
      : {
        approved: true,
        concerns: []
      }

    if (postMonitor.approved === false) {
      monitorInterventions += 1
    }
    logInfo('executor:monitor', '[Executor:Monitor] Post-step review complete', {
      stepIndex: input.step.stepIndex,
      approved: postMonitor.approved,
      concerns: postMonitor.concerns
    })

    actor.send({ type: 'EVICTION_COMPLETE' })
    input.rts.append({
      task_id: input.plan.taskId,
      ab_mode: input.abMode,
      agent_role: 'executor',
      step_index: input.step.stepIndex,
      event_type: 'step_output',
      content_json: JSON.stringify(stepOutput),
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      created_at: new Date().toISOString()
    })

        return {
          outcome: 'success',
          stepOutput,
          monitorInterventions,
          vetoReason: null,
          tokensUsed,
          costUsd,
          writeCount: writeSuccessCount,
          testsPassed,
          typeCheckPassed
        }
      }
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'EscalationRequired') {
      throw error
    }

    logError('executor:step', '[Executor] Step execution failed', {
      stepIndex: input.step.stepIndex,
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    actor.send({
      type: 'ERROR_OCCURRED',
      error: error instanceof Error ? error : new Error('Unknown step execution error')
    })

    return {
      outcome: 'error',
      stepOutput: null,
      monitorInterventions,
      vetoReason: error instanceof Error ? error.message : 'Unknown error',
      tokensUsed,
      costUsd,
      writeCount: writeSuccessCount,
      testsPassed,
      typeCheckPassed
    }
  }
}

function summarizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      summary[key] = value.length > 120 ? `${value.slice(0, 120)}...` : value
    } else if (Array.isArray(value)) {
      summary[key] = { type: 'array', length: value.length }
    } else {
      summary[key] = value
    }
  }

  return summary
}

const passthroughCompressionProvider: CompressionLlmProvider = {
  async distill(content: string): Promise<string> {
    return content
  }
}

function deriveFallbackCyclePlan(input: StepExecutionInput): CyclePlan {
  const historicalFiles = getStepHistory(input.tier2).flatMap((entry) => entry.affectedFiles)
  const confirmedFiles = [...new Set([
    ...input.step.affectedFiles,
    ...historicalFiles
  ])]
  const preloadedFileContents = new Map<string, string>()

  for (const filePath of confirmedFiles) {
    try {
      preloadedFileContents.set(filePath, readFileSync(resolve(input.repoRoot, filePath), 'utf8'))
    } catch {
      continue
    }
  }

  return buildCyclePlan(input.plan, input.enrichedPacket, confirmedFiles, preloadedFileContents)
}

function buildConversationMessages(
  input: StepExecutionInput,
  remindersAsText: string,
  implementationSurface: ImplementationSurface,
  preloadedImplementationFiles: PreloadedImplementationFile[],
  confirmedFiles: string[]
): LlmMessage {
  const cyclePlan = input.cyclePlan ?? deriveFallbackCyclePlan(input)
  const phase = getStepPhase(input.step)
  const taskText = compressStructuredTaskDescription(input.enrichedPacket.structuredDescription)
  const approachText = cyclePlan.intendedAction.length > 0 ? cyclePlan.intendedAction : input.step.description
  const symbols = sanitizeSymbols([
    ...input.step.affectedSymbols,
    ...implementationSurface.symbols.map((symbol) => symbol.name)
  ])

  if (phase === 'implementation') {
    const primaryTarget = getPrimaryImplementationTarget(implementationSurface, preloadedImplementationFiles, input.step.approach)
    const snippets = buildTargetCodeSections(
      implementationSurface,
      preloadedImplementationFiles,
      confirmedFiles,
      input.step.approach
    )
    const lines = [
      'WRITE NOW. Call write_file with your change. This is the implementation step.',
      '',
      `Task: ${taskText}`,
      `Step: ${input.step.description}`,
      `Approach: ${approachText}`,
      `Why: ${cyclePlan.reasoning}`
    ]

    const filesToDescribe = preloadedImplementationFiles
      .map((file) => file.path)
      .filter((filePath, index, items) => items.indexOf(filePath) === index)
      .slice(0, 3)

    if (filesToDescribe.length > 0) {
      lines.push('')
      lines.push('## Files to modify')
      lines.push('The following files were confirmed during discovery and are preloaded:')
      for (const filePath of filesToDescribe) {
        const snippet = snippets.find((candidate) => candidate.path === filePath)
        const snippetLabel = snippet?.symbolName ?? 'confirmed context'
        lines.push(`- ${filePath}: use the preloaded code and the approach to decide whether this file needs changes (${snippetLabel}).`)
      }
    }

    if (primaryTarget.symbolName !== null) {
      lines.push(`Symbol to modify: ${primaryTarget.symbolName}`)
    }

    if (snippets.length > 0) {
      lines.push('')
      lines.push('Relevant code:')
      for (const snippet of snippets) {
        lines.push(`### ${snippet.path}${snippet.symbolName !== null ? ` — ${snippet.symbolName}` : ''}`)
        lines.push('```typescript')
        lines.push(snippet.content)
        lines.push('```')
      }
    }

    lines.push('')
    lines.push(buildDefinitionOfDone())

    if (remindersAsText.length > 0) {
      lines.push('')
      lines.push(`Keep in mind: ${compressConstraintReminders(remindersAsText)}`)
    }

    return {
      role: 'user',
      content: lines.join('\n'),
      cache_control: { type: 'ephemeral' }
    }
  }

  if (phase === 'continuous') {
    const snippets = buildTargetCodeSections(
      implementationSurface,
      preloadedImplementationFiles,
      confirmedFiles,
      input.step.approach
    )
    const verifiedCodeWindow = buildVerifiedCodeWindow(input.repoRoot, input.enrichedPacket)
    const relatedTests = implementationSurface.relatedTestFiles
      .filter((file) => confirmedFiles.includes(file.sourceFile))
      .map((file) => `${file.path} (${file.confidence} confidence; source ${file.sourceFile})`)
    const lines = [
      'This is a continuous session. You decide when you are done.',
      'Work in order: understand -> fix -> test -> verify.',
      'When all tests pass and the fix is complete, respond with plain text describing what you changed.',
      '',
      `Task: ${taskText}`,
      `Step: ${input.step.description}`,
      `Approach: ${approachText}`,
      `Why: ${cyclePlan.reasoning}`
    ]

    if (symbols.length > 0) {
      lines.push(`Focus symbols: ${symbols.join(', ')}`)
    }

    const preloadedPaths = preloadedImplementationFiles.map((file) => file.path)
    if (preloadedPaths.length > 0) {
      lines.push('')
      lines.push('## Preloaded files')
      for (const filePath of preloadedPaths) {
        lines.push(`- ${filePath}`)
      }
    }

    if (relatedTests.length > 0) {
      lines.push('')
      lines.push('## Related test files')
      for (const relatedTest of relatedTests) {
      lines.push(`- ${relatedTest}`)
      }
    }

    if (verifiedCodeWindow !== null) {
      lines.push('')
      lines.push(`## Relevant code (${verifiedCodeWindow.filePath} lines ${verifiedCodeWindow.startLine}-${verifiedCodeWindow.endLine})`)
      lines.push('[Line numbers are display-only. Do not include the N | prefix in old_string.]')
      lines.push('```text')
      lines.push(verifiedCodeWindow.content)
      lines.push('```')
      lines.push('')
      lines.push('The fix is in the code shown above. Read it, find the bug, write the fix.')
      lines.push('Do NOT call search_in_files or read_file for code already shown here unless validation fails and you need repair context.')
    }

    if (snippets.length > 0) {
      lines.push('')
      lines.push('Relevant code:')
      for (const snippet of snippets) {
        lines.push(`### ${snippet.path}${snippet.symbolName !== null ? ` — ${snippet.symbolName}` : ''}`)
        lines.push('```typescript')
        lines.push(snippet.content)
        lines.push('```')
      }
    }

    lines.push('')
    lines.push(buildDefinitionOfDone())
    if (remindersAsText.length > 0) {
      lines.push('')
      lines.push(`Keep in mind: ${compressConstraintReminders(remindersAsText)}`)
    }

    return {
      role: 'user',
      content: lines.join('\n'),
      cache_control: { type: 'ephemeral' }
    }
  }

  if (phase === 'testing') {
    const lines = [
      'WRITE NOW. Call write_file, replace_in_file, or apply_patch to add or update the regression test.',
      '',
      `Task: ${taskText}`,
      `Step: ${input.step.description}`,
      `Approach: ${approachText}`,
      `Why: ${cyclePlan.reasoning}`
    ]

    const relatedTests = implementationSurface.relatedTestFiles
      .filter((file) => confirmedFiles.includes(file.sourceFile))
      .map((file) => `${file.path} (${file.confidence} confidence; source ${file.sourceFile})`)

    const preloadedPaths = preloadedImplementationFiles.map((file) => file.path)

    if (relatedTests.length > 0) {
      lines.push('')
      lines.push('## Related test files')
      for (const relatedTest of relatedTests) {
        lines.push(`- ${relatedTest}`)
      }
    }

    if (preloadedPaths.length > 0) {
      lines.push('')
      lines.push('## Preloaded files')
      for (const filePath of preloadedPaths) {
        lines.push(`- ${filePath}`)
      }
    }

    lines.push('')
    lines.push('Update the most relevant existing test file when possible. Use the preloaded test files first before searching elsewhere.')

    if (remindersAsText.length > 0) {
      lines.push('')
      lines.push(`Keep in mind: ${compressConstraintReminders(remindersAsText)}`)
    }

    return {
      role: 'user',
      content: lines.join('\n'),
      cache_control: { type: 'ephemeral' }
    }
  }

  const candidateFiles = implementationSurface.primaryFiles
    .slice(0, 5)
    .map((file) => `- [${file.confidence}] ${file.path}`)
  const lines = [
    `Task: ${taskText}`,
    `Step: ${input.step.description}`,
    `Approach: ${approachText}`,
    symbols.length > 0 ? `Focus symbols: ${symbols.join(', ')}` : '',
    remindersAsText.length > 0 ? `Keep in mind: ${compressConstraintReminders(remindersAsText)}` : '',
    '',
    'Discovery task: confirm the implementation target from these candidate files.',
    'Read only what you need, then call confirm_surface.',
    candidateFiles.length > 0 ? 'Candidate files:' : '',
    ...candidateFiles
  ].filter((value) => value.length > 0)

  return {
    role: 'user',
    content: lines.join('\n'),
    cache_control: { type: 'ephemeral' }
  }
}

function buildExecutorSystemPrompt(
  repoContext: StepExecutionInput['intake']['repoContext'],
  rulesTestCommand: string | null
): string {
  return [
    'You are an autonomous software engineer implementing a specific change.',
    '',
    'Your tools: read_file, write_file, apply_patch, replace_in_file, run_command, run_tests, list_directory, search_in_files, git_diff, git_status.',
    '',
    `Repository language: ${repoContext.language}`,
    `Test runner: ${repoContext.testRunner ?? 'unknown'}`,
    `Python binary: ${repoContext.pythonBinary ?? 'n/a'}`,
    `Run tests with: ${rulesTestCommand ?? repoContext.testCommand ?? 'unknown'}`,
    '',
    'Rules:',
    '- Read a file before writing it. Never write blind.',
    '- Make targeted edits. Do not rewrite entire files unless necessary.',
    '- This is a continuous session. You decide when you are done.',
    '- Work in order: understand -> fix -> test -> verify.',
    '- You do NOT need to optimize for turn count. Take the turns you need.',
    '- When you have made the required change, run the tests to verify.',
    '- When tests pass, respond with text (no tool call) describing what you changed.',
    '- Do NOT stop early because you are unsure. Keep working.',
    '- Do NOT stop because you have made one change. Verify it works.',
    '- Do not read the same file twice. Trust what you have already seen.'
  ].join('\n')
}

function buildDefinitionOfDone(): string {
  return [
    '## You are done when:',
    '- The change described in the approach exists in the target file.',
    '- TypeScript compiles without errors (run: npx tsc --noEmit).',
    '- Existing tests still pass.',
    '',
    '## You do NOT need to:',
    '- Update every type that transitively references the changed interface.',
    '- Add new test files unless the approach explicitly requires it.',
    '- Propagate the option through unrelated code paths.',
    '- Re-open implementation research once the change is written.',
  ].join('\n')
}

function buildSyntheticPreloadMessages(
  preloadedImplementationFiles: PreloadedImplementationFile[]
): LlmMessage[] {
  const messages: LlmMessage[] = []

  for (const [index, file] of preloadedImplementationFiles.entries()) {
    const toolUseId = `preload-${index + 1}-${file.path.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'read_file',
        input: { path: file.path }
      }]
    })
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: buildSyntheticPreloadReadResult(file.content)
      }],
      cache_control: { type: 'ephemeral' }
    })
  }

  return messages
}

function compressConstraintReminders(remindersAsText: string): string {
  const firstLine = remindersAsText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstLine ?? remindersAsText
}

export function getStepPhase(step: ExecutionStep): StepPhase {
  if (step.phaseHint !== undefined) {
    return step.phaseHint
  }

  const description = step.description.toLowerCase()

  if (description.includes('discover') || description.includes('understand') || step.stepIndex === 0) {
    return 'discovery'
  }

  if (description.includes('add or update tests') || description.includes('regression test')) {
    return 'testing'
  }

  if (description.includes('implement') || step.stepIndex === 1) {
    return 'implementation'
  }

  if (description.includes('test') || step.stepIndex === 2) {
    return 'testing'
  }

  return 'verification'
}

export function getPreloadCandidatePathsForStep(
  step: ExecutionStep,
  implementationSurface: ImplementationSurface,
  confirmedFiles: string[]
): string[] {
  const phase = getStepPhase(step)

  if (phase === 'implementation') {
    return [...new Set([
      ...confirmedFiles,
      ...implementationSurface.primaryFiles.map((file) => file.path)
    ])]
  }

  if (phase === 'testing') {
    const relatedTestPaths = implementationSurface.relatedTestFiles
      .filter((file) => confirmedFiles.includes(file.sourceFile))
      .sort(compareRelatedTestFiles)
      .map((file) => file.path)
    const implementationReference = confirmedFiles[0] ?? implementationSurface.primaryFiles[0]?.path

    return [...new Set([
      ...relatedTestPaths,
      ...(implementationReference !== undefined ? [implementationReference] : [])
    ])]
  }

  if (phase === 'continuous') {
    const relatedTestPaths = implementationSurface.relatedTestFiles
      .filter((file) => confirmedFiles.includes(file.sourceFile))
      .sort(compareRelatedTestFiles)
      .map((file) => file.path)

    return [...new Set([
      ...confirmedFiles,
      ...implementationSurface.primaryFiles.map((file) => file.path),
      ...relatedTestPaths
    ])]
  }

  return []
}

function compareRelatedTestFiles(left: RelatedTestFile, right: RelatedTestFile): number {
  const confidenceDelta = compareRelatedTestFileConfidence(right.confidence) - compareRelatedTestFileConfidence(left.confidence)
  if (confidenceDelta !== 0) {
    return confidenceDelta
  }

  return left.path.localeCompare(right.path)
}

function compareRelatedTestFileConfidence(confidence: RelatedTestFile['confidence']): number {
  return confidence === 'high' ? 2 : 1
}

function isDiscoveryPhase(phase: StepPhase): boolean {
  return phase === 'discovery'
}

function isImplementationPhase(phase: StepPhase): boolean {
  return phase === 'implementation'
}

function isWriteToolName(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'apply_patch' || toolName === 'replace_in_file'
}

function getHardBlockedToolReason(
  step: ExecutionStep,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (isDiscoveryPhase(getStepPhase(step)) && isWriteToolName(toolName)) {
    return 'writes are disabled during discovery'
  }

  if (toolName === 'run_command' && typeof toolInput.command === 'string') {
    const normalized = toolInput.command.toLowerCase()
    if (normalized.includes('rm -rf') || normalized.includes('git reset --hard') || normalized.includes('git checkout --')) {
      return 'dangerous shell command rejected'
    }
  }

  return null
}

function buildReadPolicyMessage(
  input: StepExecutionInput,
  toolName: string,
  toolInput: Record<string, unknown>,
  readFileCache: Map<string, string>,
  preloadedFilePaths: Set<string>,
  implementationAdditionalReads: number,
  filesReadInDiscovery: Set<string>,
  failedWriteTargets: Set<string>,
  recoveryReadsUsed: Set<string>,
  failedValidationFiles: Set<string>
): string | null {
  if (toolName !== 'read_file' || typeof toolInput.path !== 'string') {
    return null
  }

  if (typeof toolInput.startLine === 'number' || typeof toolInput.endLine === 'number') {
    return null
  }

  const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
  if (failedWriteTargets.has(normalizedPath) && !recoveryReadsUsed.has(normalizedPath)) {
    return null
  }
  if (failedValidationFiles.has(normalizedPath)) {
    return null
  }
  const cachedContent = readFileCache.get(normalizedPath)

  if (preloadedFilePaths.has(normalizedPath) && cachedContent !== undefined) {
    return `${cachedContent}\n\n[PlanOne note: This file is already in your context above. Write your change now.]`
  }

  if (cachedContent !== undefined) {
    return `${cachedContent}\n\n[PlanOne note: ${normalizedPath} was already read earlier in this step. Reuse it and write your change now.]`
  }

  const phase = getStepPhase(input.step)

  if (isDiscoveryPhase(phase) && filesReadInDiscovery.size >= DISCOVERY_CONFIRM_AFTER_READS) {
    return '[PlanOne: You have read enough files for discovery. Call confirm_surface now or discovery will auto-confirm and proceed.]'
  }

  if (isImplementationPhase(phase) && implementationAdditionalReads >= MAX_IMPLEMENTATION_ADDITIONAL_READS) {
    return 'READ LIMIT: You have already read the maximum number of additional files during implementation. Use the files already in context and write the change now.'
  }

  return null
}

function isAllowedRecoveryRead(
  repoRoot: string,
  filePath: string,
  confirmedFiles: string[],
  failedWriteTargets: Set<string>,
  recoveryReadsUsed: Set<string>
): boolean {
  const normalizedPath = toRepoRelativePath(repoRoot, filePath)
  if (!failedWriteTargets.has(normalizedPath) || recoveryReadsUsed.has(normalizedPath)) {
    return false
  }

  return confirmedFiles.some((confirmedFile) => {
    return confirmedFile === normalizedPath
      || confirmedFile.endsWith(`/${normalizedPath}`)
      || normalizedPath.endsWith(`/${confirmedFile}`)
  })
}

function decorateToolResult(
  toolResultText: string,
  input: StepExecutionInput,
  toolName: string,
  toolInput: Record<string, unknown>,
  progressState: ProgressState,
  filesReadInDiscovery: Set<string>,
  implementationSurface: ImplementationSurface,
  consecutiveSearchMisses: number
): string {
  const notes: string[] = []
  let content = toolResultText
  const phase = getStepPhase(input.step)

  if ((toolName === 'write_file' || toolName === 'apply_patch' || toolName === 'replace_in_file') && !toolResultText.startsWith('ERROR:')) {
    return `${toolResultText}\n\n[Write successful. Now validate the change:\n1. Run tests: run_tests or run_command with your test command\n2. If validation PASSES: respond with plain text describing what you changed\n3. If validation FAILS: you may re-read and repair the same file\n\nDo not write to new files until the current write is validated.]`
  }

  if (toolName === 'read_file' && typeof toolInput.path === 'string') {
    const normalizedPath = toRepoRelativePath(input.repoRoot, toolInput.path)
    const readCount = progressState.filesRead.filter((filePath) => filePath === normalizedPath).length
    if (readCount >= 2) {
      notes.push(`you have now read this file ${readCount} times. You likely have enough context to write the change now.`)
    }

    const exactContent = stripDisplayedReadFilePrefixes(toolResultText)
    content = [
      toolResultText,
      '',
      '[Exact content for editing — no line number prefix, copy as-is for old_string:]',
      '```typescript',
      exactContent,
      '```'
    ].join('\n')
  }

  if ((toolName === 'search_in_files' || toolName === 'list_directory') && isImplementationPhase(phase) && progressState.filesWritten.length === 0) {
    notes.push('Writes: 0. Call write_file now.')
    content = trimFileLikeContent(toolResultText, 12)
  }

  if (isImplementationSearchTool(toolName) && isImplementationPhase(phase) && progressState.filesWritten.length === 0 && consecutiveSearchMisses >= 2) {
    notes.push(`${consecutiveSearchMisses} consecutive searches returned no results. The symbol or pattern may not exist with that exact name. Look at the preloaded file contents already in your context and write your change now. Call write_file, replace_in_file, or apply_patch.`)
  }

  if (isDiscoveryPhase(phase) && toolName === 'read_file' && filesReadInDiscovery.size >= DISCOVERY_CONFIRM_AFTER_READS) {
    notes.push(`PlanOne: You have read ${filesReadInDiscovery.size} files. You now have sufficient context for the shortlist. Your next action MUST be confirm_surface. Any other tool call will be blocked after this point.`)
  }

  if (isDiscoveryPhase(phase) && filesReadInDiscovery.size >= DISCOVERY_CONFIRM_AFTER_READS && toolName !== 'confirm_surface' && toolName !== 'read_file') {
    notes.push('PlanOne: This was your last permitted exploratory action. Call confirm_surface now or discovery will auto-confirm and proceed.')
  }

  return notes.length === 0
    ? content
    : `${content}\n\n[PlanOne note: ${notes.join(' ')}]`
}

function isImplementationSearchTool(toolName: string): boolean {
  return toolName === 'search_in_files' || toolName === 'implementation_lookup'
}

function isEmptySearchResult(toolResult: { success: boolean; output: string; error?: string | null }): boolean {
  const combined = `${toolResult.output}\n${toolResult.error ?? ''}`.trim().toLowerCase()
  return combined.length < 30
    || combined.includes('no matches')
    || combined.includes('0 results')
}

function summarizeHistoryEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: { success: boolean; output: string; error?: string | null },
  progressState: ProgressState
): string {
  if (toolName === 'read_file' && typeof toolInput.path === 'string') {
    return `read ${toolInput.path} (${toolResult.output.length} bytes)`
  }

  if (toolName === 'write_file' && typeof toolInput.path === 'string') {
    return `wrote ${toolInput.path}`
  }

  if (toolName === 'apply_patch') {
    return progressState.filesWritten.length > 0
      ? `applied patch touching ${progressState.filesWritten.join(', ')}`
      : 'applied patch'
  }

  if (toolName === 'replace_in_file' && typeof toolInput.path === 'string') {
    return `replaced text in ${toolInput.path}`
  }

  return `${toolName} (${toolResult.success ? 'ok' : 'error'})`
}

function trimDiscoveryReadResults(eventMessages: LlmMessage[], maxLinesPerFile: number): void {
  for (const message of eventMessages) {
    if (!Array.isArray(message.content) || message.role !== 'user') {
      continue
    }

    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') {
        continue
      }

      const trimmed = trimFileLikeContent(block.content, maxLinesPerFile)
      block.content = trimmed
    }
  }
}

function trimFileLikeContent(content: string, maxLines: number): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) {
    return content
  }

  return `${lines.slice(0, maxLines).join('\n')}\n[PlanOne note: discovery context trimmed after ${maxLines} lines.]`
}

function countMessageTokens(messages: LlmMessage[], model: string): number {
  return messages.reduce((sum, message) => sum + countTokens(stringifyMessageContent(message.content), model), 0)
}

function stringifyMessageContent(content: LlmMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  return content.map((block) => {
    if (block.type === 'text') {
      return block.text ?? ''
    }
    if (block.type === 'tool_use') {
      return JSON.stringify({
        type: block.type,
        id: block.id,
        name: block.name,
        input: block.input
      })
    }

    return block.content ?? ''
  }).join('\n')
}

function extractToolResultContent(message: LlmMessage): string | null {
  if (typeof message.content === 'string') {
    return null
  }

  const block = message.content.find((candidate) => candidate.type === 'tool_result')
  return typeof block?.content === 'string' ? block.content : null
}

function replaceToolResultContent(message: LlmMessage, nextContent: string): LlmMessage {
  if (typeof message.content === 'string') {
    return message
  }

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result') {
        return block
      }

      return {
        ...block,
        content: nextContent
      }
    })
  }
}

export function compactIfNeeded(
  eventMessages: LlmMessage[],
  model: string,
  preserveLastN: number = 6
): LlmMessage[] {
  const modelLimit = getModelLimit(model)
  const totalTokens = countMessageTokens(eventMessages, model)

  if (totalTokens < modelLimit * 0.6 || eventMessages.length <= 2 + preserveLastN) {
    return eventMessages
  }

  const preservedPrefix = eventMessages.slice(0, 2)
  const preservedSuffix = preserveLastN > 0 ? eventMessages.slice(-preserveLastN) : []
  const middle = eventMessages.slice(2, Math.max(2, eventMessages.length - preserveLastN))
  const compacted = middle.map((message) => {
    const content = extractToolResultContent(message)
    if (content === null || content.length < 500) {
      return message
    }

    const lines = content.split('\n')
    if (lines.length <= 40) {
      return message
    }

    const truncated = [
      ...lines.slice(0, 20),
      `[... ${lines.length - 40} lines truncated ...]`,
      ...lines.slice(-20)
    ].join('\n')
    return replaceToolResultContent(message, truncated)
  })

  return [...preservedPrefix, ...compacted, ...preservedSuffix]
}

function appendGuidanceNote(eventMessages: LlmMessage[], note: string): void {
  eventMessages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: `planone-guidance-${Date.now()}`,
      content: note
    }],
    cache_control: { type: 'ephemeral' }
  })
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value)
  }
}

function getStepToolDefinitions(step: ExecutionStep, implementationSurface: ImplementationSurface): AnthropicToolDefinition[] {
  const tools = [...getToolDefinitions()]

  if (isDiscoveryPhase(getStepPhase(step))) {
    tools.push({
      name: 'confirm_surface',
      description: 'Confirm which files you will modify and any additional files needed',
      input_schema: {
        type: 'object',
        properties: {
          confirmed_files: { type: 'array', items: { type: 'string' } },
          additional_files: { type: 'array', items: { type: 'string' } },
          ready_to_implement: { type: 'boolean' }
        },
        required: ['confirmed_files', 'additional_files', 'ready_to_implement']
      }
    })
  }

  return tools
}

function logImplementationSurface(input: StepExecutionInput, implementationSurface: ImplementationSurface): void {
  logInfo('executor:surface', '[Surface] Built ImplementationSurface', {
    stepIndex: input.step.stepIndex,
    candidateFiles: implementationSurface.primaryFiles.length,
    confirmedSymbols: implementationSurface.symbols.length,
    preloadedFiles: [...implementationSurface.fileContents.keys()]
  })

  for (const file of implementationSurface.primaryFiles) {
    logInfo('executor:surface', '[Surface] candidate file', {
      stepIndex: input.step.stepIndex,
      confidence: file.confidence,
      path: file.path,
      reason: file.reason,
      lineCount: file.lineCount
    })
  }

  for (const symbol of implementationSurface.symbols) {
    logInfo('executor:surface', '[Surface] confirmed symbol', {
      stepIndex: input.step.stepIndex,
      symbol: symbol.name,
      filePath: symbol.filePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine
    })
  }
}

function hydrateSurfaceFromTier2(surface: ImplementationSurface, input: StepExecutionInput): void {
  const stepZero = input.tier2.get(0)

  if (stepZero === null) {
    return
  }

  for (const filePath of stepZero.affectedFiles) {
    const normalizedPath = toRepoRelativePath(input.repoRoot, filePath)
    if (!surface.primaryFiles.some((candidate) => candidate.path === normalizedPath)) {
      surface.primaryFiles.unshift({
        path: normalizedPath,
        confidence: 'high',
        reason: 'confirmed by discovery step output',
        lineCount: safeCountLines(input.repoRoot, normalizedPath)
      })
    }

    if (!surface.fileContents.has(normalizedPath)) {
      const loaded = loadImplementationFile(input.repoRoot, normalizedPath)
      if (loaded !== null) {
        surface.fileContents.set(normalizedPath, loaded.content)
      }
    }
  }

  surface.primaryFiles = dedupePrimaryFiles(surface.primaryFiles).slice(0, 5)
}

function confirmImplementationSurface(
  input: StepExecutionInput,
  implementationSurface: ImplementationSurface,
  confirmation: ConfirmSurfaceInput,
  filesReadInDiscovery: string[] = []
): string[] {
  const confirmed = [...new Set([
    ...confirmation.confirmed_files,
    ...confirmation.additional_files,
    ...filesReadInDiscovery
  ])]
    .map((filePath) => toRepoRelativePath(input.repoRoot, filePath))

  for (const filePath of confirmed) {
    if (!implementationSurface.primaryFiles.some((candidate) => candidate.path === filePath)) {
      implementationSurface.primaryFiles.push({
        path: filePath,
        confidence: 'medium',
        reason: 'confirmed by discovery model',
        lineCount: safeCountLines(input.repoRoot, filePath)
      })
    }

    if (!implementationSurface.fileContents.has(filePath)) {
      const loaded = loadImplementationFile(input.repoRoot, filePath)
      if (loaded !== null) {
        implementationSurface.fileContents.set(filePath, loaded.content)
      }
    }
  }

  implementationSurface.primaryFiles = dedupePrimaryFiles(implementationSurface.primaryFiles).slice(0, 5)
  return confirmed
}

function autoConfirmImplementationSurface(
  implementationSurface: ImplementationSurface,
  filesReadInDiscovery: string[] = []
): string[] {
  const highConfidence = implementationSurface.primaryFiles
    .filter((file) => file.confidence === 'high')
    .map((file) => file.path)

  const confirmedFiles = [...new Set([...highConfidence, ...filesReadInDiscovery])]

  if (confirmedFiles.length > 0) {
    return confirmedFiles
  }

  return implementationSurface.primaryFiles.slice(0, 3).map((file) => file.path)
}

function buildSurfaceConfirmationText(confirmedFiles: string[], additionalFiles: string[]): string {
  return [
    'Implementation surface confirmed.',
    confirmedFiles.length > 0 ? `Confirmed files: ${confirmedFiles.join(', ')}` : 'Confirmed files: none',
    additionalFiles.length > 0 ? `Additional files: ${additionalFiles.join(', ')}` : ''
  ].filter((line) => line.length > 0).join('\n')
}

function loadImplementationFile(repoRoot: string, filePath: string): PreloadedImplementationFile | null {
  try {
    const absolutePath = resolve(repoRoot, filePath)
    const content = readFileSync(absolutePath, 'utf8')
    const mtimeMs = statSync(absolutePath).mtimeMs
    return {
      path: filePath,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs
    }
  } catch {
    return null
  }
}

function dedupePrimaryFiles(files: PrioritizedFile[]): PrioritizedFile[] {
  const seen = new Set<string>()
  const results: PrioritizedFile[] = []

  for (const file of files) {
    if (seen.has(file.path)) {
      continue
    }

    seen.add(file.path)
    results.push(file)
  }

  return results
}

function safeCountLines(repoRoot: string, filePath: string): number {
  try {
    return readFileSync(resolve(repoRoot, filePath), 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function requiresStructuredToolArgs(toolName: string): boolean {
  return ['read_file', 'write_file', 'apply_patch', 'replace_in_file', 'list_directory', 'search_in_files', 'run_command', 'confirm_surface'].includes(toolName)
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function getPreloadedImplementationFiles(
  input: StepExecutionInput,
  implementationSurface: ImplementationSurface,
  confirmedFiles: string[]
): PreloadedImplementationFile[] {
  const candidatePaths = getPreloadCandidatePathsForStep(
    input.step,
    implementationSurface,
    confirmedFiles
  )

  if (candidatePaths.length === 0) {
    return []
  }

  const loadedFiles = candidatePaths.flatMap((filePath) => {
    const preloadedContent = implementationSurface.fileContents.get(filePath)
    const loadedFile = preloadedContent === undefined
      ? loadImplementationFile(input.repoRoot, filePath)
      : null
    const content = preloadedContent ?? loadedFile?.content
    if (content === undefined) {
      return []
    }

    return [{
      path: filePath,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs: loadedFile?.mtimeMs ?? getFileMtimeMs(input.repoRoot, filePath) ?? 0
    }]
  })

  return prioritizeLoadedImplementationFiles(
    loadedFiles,
    input.step.approach,
    input.enrichedPacket.structuredDescription
  ).slice(0, getStepPhase(input.step) === 'testing' ? 4 : getStepPhase(input.step) === 'continuous' ? 5 : 3)
}

function appendImplementationContextToAnchor(
  enrichedPacketAnchor: string,
  files: PreloadedImplementationFile[]
): string {
  if (files.length === 0) {
    return enrichedPacketAnchor
  }

  return [
    enrichedPacketAnchor,
    '## Files Available for This Step',
    ...files.flatMap((file) => [`### ${file.path}`, trimFileLikeContent(file.content, 40)])
  ].join('\n\n')
}

function compressStructuredTaskDescription(description: string): string {
  const sentences = description
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)

  return sentences.slice(0, 3).join(' ')
}

export function sanitizeSymbols(symbols: string[]): string[] {
  const noise = new Set([
    'Local', 'File', 'Module', 'Global', 'Class', 'Function',
    'Client', 'Server', 'Handler', 'Router', 'Request', 'Response',
    'Manager', 'Service', 'Provider', 'Factory', 'Builder', 'Helper', 'Utils', 'Util',
    'Context', 'Options', 'Config', 'Props', 'State', 'Store',
    'Event', 'Error', 'Result', 'Data', 'Type', 'Interface',
    'T', 'K', 'V', 'E', 'R', 'U', 'P', 'S', 'N'
  ])
  const keywords = new Set([
    'from', 'import', 'export', 'const', 'let', 'var', 'type',
    'interface', 'class', 'function', 'return', 'async', 'await',
    'true', 'false', 'null', 'undefined'
  ])

  return symbols.filter((symbol) => {
    if (symbol.length < 4) {
      return false
    }

    if (noise.has(symbol) || keywords.has(symbol)) {
      return false
    }

    return true
  })
}

export function isAllowedPostWriteCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  const typeCheckMarkers = ['tsc', 'type-check', 'typecheck']
  const testMarkers = [' test', 'vitest', 'jest', 'mocha', 'pytest', 'pnpm test', 'npm test', 'yarn test']

  return typeCheckMarkers.some((marker) => normalized.includes(marker))
    || testMarkers.some((marker) => normalized.includes(marker))
}

function isTypeCheckCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  return normalized.includes('tsc')
    || normalized.includes('type-check')
    || normalized.includes('typecheck')
}

function isValidationToolInvocation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'run_tests') {
    return true
  }

  return toolName === 'run_command'
    && typeof toolInput.command === 'string'
    && isTypeCheckCommand(toolInput.command)
}

function didValidationFail(
  toolName: string,
  _toolInput: Record<string, unknown>,
  toolResult: Awaited<ReturnType<typeof executeTool>>
): boolean {
  if (!toolResult.success) {
    return true
  }

  const output = `${toolResult.output}\n${toolResult.error ?? ''}`
  if (output.includes('SyntaxError') || output.includes('IndentationError') || output.includes('error TS')) {
    return true
  }

  if (toolName === 'run_tests') {
    return false
  }

  return false
}

export function buildPostWriteBlockedResult(
  toolName: string,
  options?: { reason?: string }
): string {
  return `[BLOCKED: ${toolName} is not permitted after implementation.\n` +
    `${options?.reason === undefined ? '' : `${options.reason}\n`}` +
    'You have already written your change. You must now:\n' +
    '1. Call run_tests to verify\n' +
    '2. Call run_command with "npx tsc --noEmit" to check compilation\n' +
    '3. Or respond with text to declare the implementation complete.\n' +
    'The implementation cannot be expanded further in this step.]'
}

function extractWriteTarget(
  repoRoot: string,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if ((toolName === 'write_file' || toolName === 'replace_in_file') && typeof toolInput.path === 'string') {
    return toRepoRelativePath(repoRoot, toolInput.path)
  }

  if (toolName === 'apply_patch') {
    if (typeof toolInput.path === 'string') {
      return toRepoRelativePath(repoRoot, toolInput.path)
    }

    if (typeof toolInput.patch === 'string') {
      const patchTarget = extractPatchTarget(toolInput.patch)
      return patchTarget === null ? null : toRepoRelativePath(repoRoot, patchTarget)
    }
  }

  return null
}

function buildRelevantSnippets(
  implementationSurface: ImplementationSurface,
  preloadedImplementationFiles: PreloadedImplementationFile[],
  approachText: string
): RelevantSnippet[] {
  const fileContentMap = new Map(preloadedImplementationFiles.map((file) => [file.path, file.content]))
  const approachMentions = extractMentionsFromApproach(approachText)
  const hintedSymbolNames = [...new Set(approachMentions.symbols)]
  const snippets: RelevantSnippet[] = []
  let usedLines = 0
  const maxTotalLines = 80
  const targetSymbols = [
    ...hintedSymbolNames.flatMap((name) => implementationSurface.symbols.filter((symbol) => symbol.name === name)),
    ...implementationSurface.symbols
  ]

  for (const symbol of dedupeSnippetSymbols(targetSymbols)) {
    const fileContent = fileContentMap.get(symbol.filePath)
    if (fileContent === undefined) {
      continue
    }

    const rawLines = fileContent.split('\n')
    const startLine = Math.max(1, symbol.startLine)
    const endLine = Math.max(startLine, symbol.endLine)
    const snippetLines = rawLines.slice(startLine - 1, endLine)

    if (snippetLines.length === 0) {
      continue
    }

    const remaining = maxTotalLines - usedLines
    if (remaining <= 0) {
      break
    }

    const sliced = snippetLines.slice(0, remaining)
    snippets.push({
      path: symbol.filePath,
      symbolName: symbol.name,
      startLine,
      endLine: startLine + sliced.length - 1,
      content: sliced.join('\n')
    })
    usedLines += sliced.length
  }

  if (snippets.length > 0) {
    return snippets
  }

  for (const hintedSymbol of hintedSymbolNames) {
    for (const [filePath, fileContent] of fileContentMap.entries()) {
      const matchedSnippet = extractSnippetAroundSymbol(filePath, fileContent, hintedSymbol, 30)
      if (matchedSnippet !== null) {
        return [matchedSnippet]
      }
    }
  }

  const fallback = implementationSurface.primaryFiles[0]
  if (fallback === undefined) {
    return []
  }

  const fileContent = fileContentMap.get(fallback.path)
  if (fileContent === undefined) {
    return []
  }

  const lines = fileContent.split('\n').slice(0, maxTotalLines)
  return [{
    path: fallback.path,
    symbolName: null,
    startLine: 1,
    endLine: lines.length,
    content: lines.join('\n')
  }]
}

function buildTargetCodeSections(
  implementationSurface: ImplementationSurface,
  preloadedImplementationFiles: PreloadedImplementationFile[],
  confirmedFiles: string[],
  approachText: string
): RelevantSnippet[] {
  const directSnippets = buildRelevantSnippets(implementationSurface, preloadedImplementationFiles, approachText)
  const snippets: RelevantSnippet[] = []
  const seenPaths = new Set<string>()

  for (const snippet of directSnippets) {
    snippets.push(snippet)
    seenPaths.add(snippet.path)
  }

  const fileContentMap = new Map(preloadedImplementationFiles.map((file) => [file.path, file.content]))
  const orderedConfirmedFiles = prioritizeImplementationPaths(
    confirmedFiles,
    implementationSurface,
    approachText,
    approachText
  )
    .filter((filePath, index, items) => fileContentMap.has(filePath) && items.indexOf(filePath) === index)

  for (const filePath of orderedConfirmedFiles) {
    if (seenPaths.has(filePath)) {
      continue
    }

    const fileContent = fileContentMap.get(filePath)
    if (fileContent === undefined) {
      continue
    }

    const contextualSnippet = extractContextualSnippet(filePath, fileContent, 60)
    if (contextualSnippet === null) {
      continue
    }

    snippets.push(contextualSnippet)
    seenPaths.add(filePath)

    if (snippets.length >= 3) {
      break
    }
  }

  return snippets.slice(0, 3)
}

function getPrimaryImplementationTarget(
  implementationSurface: ImplementationSurface,
  preloadedImplementationFiles: PreloadedImplementationFile[],
  approachText: string
): { filePath: string; symbolName: string | null } {
  const approachMentions = extractMentionsFromApproach(approachText)
  const preloadedPaths = new Set(preloadedImplementationFiles.map((file) => file.path))
  const orderedPaths = prioritizeImplementationPaths(
    preloadedImplementationFiles.map((file) => file.path),
    implementationSurface,
    approachText,
    approachText
  )
  const findPreloadedContent = (filePath: string): string => {
    return preloadedImplementationFiles.find((file) => file.path === filePath)?.content ?? ''
  }
  const symbolAppearsInFile = (symbolName: string | null, filePath: string): boolean => {
    if (symbolName === null) {
      return false
    }
    return findPreloadedContent(filePath).includes(symbolName)
  }
  const mentionedPathScores = new Map<string, number>()
  for (const mentionedFile of approachMentions.files) {
    const basename = mentionedFile.split('/').at(-1) ?? mentionedFile
    for (const filePath of preloadedPaths) {
      if (filePath.endsWith(`/${basename}`) || filePath === basename) {
        mentionedPathScores.set(filePath, (mentionedPathScores.get(filePath) ?? 0) + 1)
      }
    }
  }

  let bestTarget: { filePath: string; symbolName: string | null; score: number } | null = null

  for (const filePath of orderedPaths) {
    if (!preloadedPaths.has(filePath)) {
      continue
    }

    const symbolsInFile = implementationSurface.symbols.filter((symbol) => symbol.filePath === filePath)
    const matchingMentionedSymbol = symbolsInFile.find((symbol) => approachMentions.symbols.includes(symbol.name))
    const candidateSymbol = matchingMentionedSymbol?.name
      ?? symbolsInFile.find((symbol) => symbolAppearsInFile(symbol.name, filePath))?.name
      ?? (() => {
        const hinted = approachMentions.symbols[0] ?? null
        return symbolAppearsInFile(hinted, filePath) ? hinted : null
      })()

    let score = 0
    score += (mentionedPathScores.get(filePath) ?? 0) * 10
    if (candidateSymbol !== null && approachMentions.symbols.includes(candidateSymbol)) {
      score += 8
    } else if (candidateSymbol !== null) {
      score += 4
    }
    score += Math.max(0, orderedPaths.length - orderedPaths.indexOf(filePath))

    if (bestTarget === null || score > bestTarget.score) {
      bestTarget = {
        filePath,
        symbolName: candidateSymbol,
        score
      }
    }
  }

  if (bestTarget !== null) {
    return {
      filePath: bestTarget.filePath,
      symbolName: bestTarget.symbolName
    }
  }

  return {
    filePath: preloadedImplementationFiles[0]?.path ?? implementationSurface.primaryFiles[0]?.path ?? '',
    symbolName: null
  }
}

function buildVerifiedCodeWindow(
  repoRoot: string,
  enrichedPacket: EnrichedPacket
): { filePath: string; startLine: number; endLine: number; content: string } | null {
  const primaryChunk = enrichedPacket.verifiedChunkIds[0]
  if (primaryChunk === undefined) {
    return null
  }

  const parsed = parseVerifiedChunkId(primaryChunk)
  if (parsed === null || parsed.startLine <= 0) {
    return null
  }

  const absolutePath = resolve(repoRoot, parsed.filePath)
  let content: string
  try {
    content = readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }

  const lines = content.split('\n')
  const windowStart = Math.max(1, parsed.startLine - 3)
  const windowEnd = Math.min(lines.length, Math.max(parsed.endLine, parsed.startLine + 80))
  const selectedLines = lines.slice(windowStart - 1, windowEnd)
  if (selectedLines.length === 0) {
    return null
  }

  return {
    filePath: parsed.filePath,
    startLine: windowStart,
    endLine: windowEnd,
    content: selectedLines
      .map((line, index) => `${String(windowStart + index).padStart(4, ' ')} | ${line}`)
      .join('\n')
  }
}

function parseVerifiedChunkId(chunkId: string): { filePath: string; startLine: number; endLine: number } | null {
  const separatorIndex = chunkId.lastIndexOf(':')
  if (separatorIndex <= 0) {
    return null
  }

  const filePath = chunkId.slice(0, separatorIndex)
  const range = chunkId.slice(separatorIndex + 1)
  const [startRaw, endRaw] = range.split('-')
  const startLine = Number.parseInt(startRaw ?? '', 10)
  const endLine = Number.parseInt(endRaw ?? startRaw ?? '', 10)

  if (!Number.isFinite(startLine) || startLine <= 0 || !Number.isFinite(endLine) || endLine <= 0) {
    return null
  }

  return {
    filePath,
    startLine,
    endLine
  }
}

function prioritizeImplementationPaths(
  filePaths: string[],
  implementationSurface: ImplementationSurface,
  approachText: string,
  taskDescription: string
): string[] {
  const uniquePaths = filePaths.filter((filePath, index, items) => items.indexOf(filePath) === index)
  const fileContentMap = new Map<string, string>(implementationSurface.fileContents.entries())
  const focus = classifyApproachFocus(approachText)

  return uniquePaths
    .map((filePath, index) => {
      const content = fileContentMap.get(filePath) ?? ''
      const role = content.length === 0 ? 'mixed' : classifyFileImplementationRole(content)
      const relevance = getTaskRelevanceBoost(filePath, `${taskDescription} ${approachText}`)
      let focusScore = 0

      if (focus === 'runtime') {
        focusScore = role === 'runtime' ? 3 : role === 'type' ? -3 : 0
      } else if (focus === 'type') {
        focusScore = role === 'type' ? 3 : role === 'runtime' ? -1 : 0
      }

      return {
        filePath,
        index,
        score: focusScore * 10 + relevance
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return left.index - right.index
    })
    .map((entry) => entry.filePath)
}

function prioritizeLoadedImplementationFiles(
  files: PreloadedImplementationFile[],
  approachText: string,
  taskDescription: string
): PreloadedImplementationFile[] {
  const focus = classifyApproachFocus(approachText)

  return [...files].sort((left, right) => {
    const leftRole = classifyFileImplementationRole(left.content)
    const rightRole = classifyFileImplementationRole(right.content)
    const leftRelevance = getTaskRelevanceBoost(left.path, `${taskDescription} ${approachText}`)
    const rightRelevance = getTaskRelevanceBoost(right.path, `${taskDescription} ${approachText}`)
    const leftScore = getFocusScore(focus, leftRole) * 10 + leftRelevance
    const rightScore = getFocusScore(focus, rightRole) * 10 + rightRelevance

    if (rightScore !== leftScore) {
      return rightScore - leftScore
    }

    return files.indexOf(left) - files.indexOf(right)
  })
}

function getFocusScore(
  focus: ReturnType<typeof classifyApproachFocus>,
  role: ReturnType<typeof classifyFileImplementationRole>
): number {
  if (focus === 'runtime') {
    return role === 'runtime' ? 3 : role === 'type' ? -3 : 0
  }

  if (focus === 'type') {
    return role === 'type' ? 3 : role === 'runtime' ? -1 : 0
  }

  return 0
}

function dedupeSnippetSymbols(symbols: ConfirmedSymbol[]): ConfirmedSymbol[] {
  const seen = new Set<string>()
  const results: ConfirmedSymbol[] = []

  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.filePath}:${symbol.startLine}:${symbol.endLine}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(symbol)
  }

  return results
}

function extractSnippetAroundSymbol(
  filePath: string,
  fileContent: string,
  symbolName: string,
  maxLines: number
): RelevantSnippet | null {
  const lines = fileContent.split('\n')
  const index = lines.findIndex((line) => line.includes(symbolName))

  if (index === -1) {
    return null
  }

  const startLine = Math.max(1, index + 1)
  const endLine = Math.min(lines.length, startLine + maxLines - 1)
  return {
    path: filePath,
    symbolName,
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join('\n')
  }
}

function extractContextualSnippet(
  filePath: string,
  fileContent: string,
  maxLines: number
): RelevantSnippet | null {
  const lines = fileContent.split('\n')

  if (lines.length === 0) {
    return null
  }

  const endLine = Math.min(lines.length, maxLines)
  return {
    path: filePath,
    symbolName: null,
    startLine: 1,
    endLine,
    content: lines.slice(0, endLine).join('\n')
  }
}

function compactImplementationReadResult(
  normalizedPath: string,
  content: string,
  implementationSurface: ImplementationSurface
): string {
  const symbol = implementationSurface.symbols.find((entry) => entry.filePath === normalizedPath)

  if (symbol === undefined) {
    return trimFileLikeContent(content, 40)
  }

  const lines = content.split('\n')
  const start = Math.max(0, symbol.startLine - 1)
  const end = Math.max(start + 1, symbol.endLine)
  const snippet = lines.slice(start, end).join('\n')

  if (snippet.trim().length === 0) {
    return trimFileLikeContent(content, 40)
  }

  return snippet
}

function buildSyntheticPreloadReadResult(content: string): string {
  const lines = content.endsWith('\n')
    ? content.slice(0, -1).split('\n')
    : content.split('\n')
  const displayedLines = lines.slice(0, MAX_PRELOADED_FILE_LINES)
  const numberedLines = displayedLines
    .map((line, index) => `${index + 1} | ${line}`)
    .join('\n')
  const parts = [
    '[PlanOne read_file: line numbers are display-only. Do not include the "N | " prefix in replace_in_file old_string.]',
    numberedLines
  ]

  if (lines.length > MAX_PRELOADED_FILE_LINES) {
    parts.push(`[Note: large file — showing first ${MAX_PRELOADED_FILE_LINES} lines. File continues — use read_file with startLine/endLine for the rest.]`)
  }

  return parts.filter((part) => part.length > 0).join('\n')
}

function wasOldStringReadThisStep(eventMessages: LlmMessage[], oldString: string): boolean {
  if (oldString.length === 0) {
    return false
  }

  return getSearchableToolResultContent(eventMessages).includes(oldString)
}

function wasPatchReadThisStep(eventMessages: LlmMessage[], patch: string): boolean {
  const expectedOldText = extractPatchExpectedOldText(patch)

  if (expectedOldText === null) {
    return false
  }

  return getSearchableToolResultContent(eventMessages).includes(expectedOldText)
}

function getSearchableToolResultContent(eventMessages: LlmMessage[]): string {
  const parts: string[] = []

  for (const message of eventMessages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') {
        continue
      }

      parts.push(stripDisplayedReadFilePrefixes(block.content))
    }
  }

  return parts.join('\n')
}

function stripDisplayedReadFilePrefixes(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.startsWith('[PlanOne read_file:') && !line.startsWith('[Note: large file'))
    .map((line) => line.replace(/^\d+\s\|\s?/, ''))
    .join('\n')
}

function extractPatchExpectedOldText(patch: string): string | null {
  const relevantLines: string[] = []

  for (const line of patch.split('\n')) {
    if (line.startsWith('*** ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) {
      continue
    }

    if (line.startsWith('-') || line.startsWith(' ')) {
      relevantLines.push(line.slice(1))
    }
  }

  const expectedText = relevantLines.join('\n').trimEnd()
  return expectedText.length > 0 ? expectedText : null
}

function getFileMtimeMs(repoRoot: string, filePath: string): number | null {
  try {
    return statSync(resolve(repoRoot, filePath)).mtimeMs
  } catch {
    return null
  }
}

function hasFileVersionChangedSinceRead(
  repoRoot: string,
  filePath: string,
  readFileVersions: Map<string, number>
): boolean {
  const previousVersion = readFileVersions.get(filePath)

  if (previousVersion === undefined) {
    return false
  }

  const currentVersion = getFileMtimeMs(repoRoot, filePath)

  if (currentVersion === null) {
    return false
  }

  return currentVersion !== previousVersion
}

function buildStaleReadBlockedMessage(toolName: 'replace_in_file' | 'apply_patch', filePath: string): string {
  return [
    `[BLOCKED] ${toolName} requires a fresh read of ${filePath}.`,
    '',
    'The file has changed since it was last preloaded or read in this step.',
    'Read the exact current contents again before editing so your change is based on the latest file version.',
    '',
    `Use: read_file({ path: "${filePath}", startLine: 1, endLine: 80 })`
  ].join('\n')
}

function extractPatchTarget(patchInput: unknown): string | null {
  if (typeof patchInput !== 'string' || patchInput.trim().length === 0) {
    return null
  }

  const structuredMatch = patchInput.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)
  if (structuredMatch?.[1] !== undefined) {
    return structuredMatch[1].trim()
  }

  const gitStyleMatch = patchInput.match(/^\+\+\+ b\/(.+)$/m)
  if (gitStyleMatch?.[1] !== undefined) {
    return gitStyleMatch[1].trim()
  }

  return null
}

function approveOrTrimBudget(
  assembly: { anchors: PermanentAnchorSet; workingContent: WorkingContentItem[] },
  input: StepExecutionInput
): { result: BudgetCheckResult; workingContent: WorkingContentItem[] } {
  const budgetOptions = {
    capMultiplier: getStepPhase(input.step) === 'continuous'
      ? CONTINUOUS_CONTEXT_CAP_RATIO
      : DEFAULT_CONTEXT_CAP_RATIO
  }

  try {
    const result = enforceBudget(assembly, input.plan.assignedExecutorModel, budgetOptions)
    return {
      result,
      workingContent: assembly.workingContent
    }
  } catch (error) {
    const trimmed = trimWorkingContent(
      assembly.workingContent,
      assembly.anchors,
      input.plan.assignedExecutorModel,
      'drop_lowest_score',
      budgetOptions
    )
    const retryResult = checkBudget({
      anchors: assembly.anchors,
      workingContent: trimmed
    }, input.plan.assignedExecutorModel, budgetOptions)

    return {
      result: retryResult,
      workingContent: retryResult.approved ? trimmed : assembly.workingContent
    }
  }
}

function appendToolResult(
  workingContent: WorkingContentItem[],
  toolUseId: string,
  content: string,
  model: string,
  anchors: PermanentAnchorSet,
  chunkIdOverride?: string
): WorkingContentItem[] {
  const nextWorkingContent = [
    ...workingContent,
    {
      chunkId: chunkIdOverride ?? `tier2:tool-result:${toolUseId}`,
      content,
      source: 'tier2' as const,
      tokens: countTokens(content, model)
    }
  ]

  return trimWorkingContent(nextWorkingContent, anchors, model, 'drop_last')
}

function inferAffectedFiles(
  workingContent: WorkingContentItem[],
  fallback: string[],
  touchedFiles: Set<string> = new Set<string>(),
  repoChangedFiles: Set<string> = new Set<string>()
): string[] {
  const files = new Set<string>([...fallback, ...touchedFiles, ...repoChangedFiles])

  for (const item of workingContent) {
    if (item.chunkId.includes(':')) {
      const parts = item.chunkId.split(':')
      const filePath = parts.length >= 2 ? parts[1] : null

      if (filePath !== null && filePath.includes('.')) {
        files.add(filePath)
      }
    }
  }

  return [...files]
}

function getCompressionModel(
  provider: CompressionProviderWithDefaultModel,
  fallbackModel: string
): string {
  if (typeof provider.getDefaultModel === 'function') {
    return provider.getDefaultModel()
  }

  return fallbackModel
}

function getRepoChangedFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    return output
      .split('\n')
      .map(parseGitStatusPath)
      .filter((line): line is string => line !== null && line.length > 0)
  } catch {
    return []
  }
}

function parseGitStatusPath(line: string): string | null {
  const trimmedLine = line.trimEnd()

  if (trimmedLine.length < 4) {
    return null
  }

  const rawPath = trimmedLine.slice(3).trim()

  if (rawPath.length === 0) {
    return null
  }

  const renamedPath = rawPath.includes(' -> ')
    ? rawPath.split(' -> ').at(-1) ?? rawPath
    : rawPath

  return renamedPath.replace(/^"(.*)"$/, '$1')
}

export function resolveAffectedFiles(
  surfaceConfirmedFiles: string[],
  repoChangedFiles: string[],
  inferredAffectedFiles: string[]
): string[] {
  return [...new Set([
    ...surfaceConfirmedFiles,
    ...repoChangedFiles,
    ...(surfaceConfirmedFiles.length === 0 && repoChangedFiles.length === 0
      ? inferredAffectedFiles
      : [])
  ])]
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  const repoRootAbsolute = resolve(repoRoot)
  const targetAbsolute = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(repoRootAbsolute, filePath)
  const relativeTarget = relative(repoRootAbsolute, targetAbsolute)

  if (relativeTarget.length === 0) {
    return '.'
  }

  if (!relativeTarget.startsWith('..') && !isAbsolute(relativeTarget)) {
    return relativeTarget
  }

  return filePath.replace(/^\/+/, '')
}

function getStepHistory(tier2: Tier2Memory): StepOutput[] {
  const StepRecordSchema = z.string().transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid Tier2 step JSON.'
      })
      return z.NEVER
    }
  }).pipe(z.object({
    stepIndex: z.number().int(),
    producedContent: z.string(),
    affectedFiles: z.array(z.string()),
    causalDependencies: z.array(z.number().int()),
    baseMemoryChunksUsed: z.array(z.string())
  }))

  return tier2.toWorkingContentItems().flatMap((item) => {
    const parsed = StepRecordSchema.safeParse(item.content)

    if (!parsed.success) {
      return []
    }

    return {
      stepIndex: parsed.data.stepIndex,
      producedContent: parsed.data.producedContent,
      affectedFiles: parsed.data.affectedFiles,
      causalDependencies: parsed.data.causalDependencies,
      baseMemoryChunksUsed: parsed.data.baseMemoryChunksUsed
    }
  })
}

function escalateForSek(input: StepExecutionInput, blockingIssue: string): never {
  const escalationPackage = buildEscalationPackage(
    'sek_diff_policy_violation',
    input.plan.taskId,
    input.intake.enhancedTask.original,
    {
      enriched_packet: input.enrichedPacket,
      suggested_actions: [blockingIssue]
    }
  )

  return escalate(escalationPackage, input.rts, input.abMode)
}
