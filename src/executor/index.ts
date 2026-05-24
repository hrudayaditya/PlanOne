import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { buildEscalationPackage, escalate } from '../escalation/index.js'
import { createRetryState, canRetry, getNextApproach, recordCycleOutcome, shouldEscalate, toEscalationCycle } from '../orchestrator/retry.js'
import type { IntakeResult } from '../intake/index.js'
import type { ContextDB } from '../memory/context-db/index.js'
import { Tier2Memory } from '../memory/tier2/index.js'
import type { BaseMemoryClient } from '../basememory/client.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { EnrichedPacket, RankedApproach } from '../panel/synthesis.js'
import type { ExecutionCycle, ExecutionPlan, ExecutionStep } from '../orchestrator/plan.js'
import { buildCyclePlan, loadConfirmedFileContents } from './cycle-plan.js'
import { executeStep, type ExecutorLlmProvider } from './step.js'
import type { CompressionLlmProvider } from './compression.js'
import { runVerifier, type VerifierResult } from '../verifier/index.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'

/**
 * Full input required to run the Week 5 executor loop.
 */
export interface ExecutorInput {
  plan: ExecutionPlan
  enrichedPacket: EnrichedPacket
  intake: IntakeResult
  contextDb: ContextDB
  client: BaseMemoryClient
  rts: RawTraceStore
  repoRoot: string
}

/**
 * Structured output of the Week 5 executor loop.
 */
export interface ExecutorResult {
  outcome: 'success' | 'escalated' | 'all_cycles_exhausted'
  completedCycles: ExecutionCycle[]
  finalStepOutputs: StepOutput[]
  totalTokensUsed: number
  totalCostUsd: number
  verifierResult: VerifierResult | null
}

import type { StepOutput } from '../pipeline/state-machine.js'
import type { ToolExecutionContext } from './tools.js'

/**
 * Runs the multi-cycle executor loop for one task.
 *
 * Structured escalation exits still throw; all normal completions return a
 * structured `ExecutorResult`.
 */
export async function runExecutor(
  input: ExecutorInput,
  provider: ExecutorLlmProvider,
  compressionProvider: CompressionLlmProvider
): Promise<ExecutorResult> {
  const retryState0 = createRetryState(input.plan.taskId)
  let retryState = retryState0
  const tier2 = new Tier2Memory(input.plan.taskId)
  const completedCycles: ExecutionCycle[] = []
  const finalStepOutputs: StepOutput[] = []
  let totalTokensUsed = 0
  let totalCostUsd = 0
  let finalVerifierResult: VerifierResult | null = null
  let seedFilesForNextCycle: string[] = []
  let activeCycle:
    | {
      cycleNumber: number
      plan: ExecutionPlan
      startedAt: string
      monitorInterventions: number
      blockedByIssue: string | null
    }
    | null = null

  try {
    while (canRetry(retryState)) {
      const cycleNumber = retryState.currentCycle
      logInfo('executor', `[Executor] === CYCLE ${cycleNumber} START ===`, {
        taskId: input.plan.taskId
      })
      input.rts.append({
        task_id: input.plan.taskId,
        ab_mode: input.intake.abMode,
        agent_role: 'executor',
        step_index: null,
        event_type: 'cycle_start',
        content_json: JSON.stringify({ cycle: cycleNumber }),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })

      const currentPlan = cycleNumber === 1
        ? input.plan
        : buildPlanForApproach(
          input.plan.taskId,
          getNextApproach(retryState, input.enrichedPacket),
          input.enrichedPacket.affectedSymbols,
          input.plan.executionMode ?? 'phased',
          input.plan.assignedExecutorModel,
          input.plan.assignedVerifierModel
        )

      if (currentPlan === null) {
        const escalationPackage = buildEscalationPackage(
          'retry_exhaustion',
          input.plan.taskId,
          input.intake.enhancedTask.original,
          {
            enriched_packet: input.enrichedPacket,
            execution_history: completedCycles.map(toEscalationCycle),
            suggested_actions: ['All ranked approaches were exhausted without success.']
          }
        )
        return escalate(escalationPackage, input.rts, input.intake.abMode)
      }

      const cycleStartedAt = new Date().toISOString()
      const cycleStepOutputs: StepOutput[] = []
      let blockedByIssue: string | null = null
      let monitorInterventions = 0
      let cyclePlan = buildCyclePlan(currentPlan, input.enrichedPacket, [], new Map())
      const cycleBaselineChangedFiles = new Set(getRepoChangedFiles(input.repoRoot))
      activeCycle = {
        cycleNumber,
        plan: currentPlan,
        startedAt: cycleStartedAt,
        monitorInterventions,
        blockedByIssue
      }

      for (const step of currentPlan.steps) {
        if (shouldBlockStepBecauseNoMutations(step, cycleStepOutputs)) {
          blockedByIssue = 'cannot_advance_without_file_changes'
          activeCycle.blockedByIssue = blockedByIssue
          logWarn('executor', `[Executor] Step ${step.stepIndex} blocked before execution`, {
            reason: 'Cannot advance to later phases because no file changes were produced in the implementation cycle yet.'
          })
          break
        }

        logInfo('executor', `[Executor] Step ${step.stepIndex} — "${step.description}"`, {
          risk: step.estimatedRisk,
          approach: currentPlan.approach
        })
        const stepResult = await executeStep({
          step,
          cycleNumber,
          plan: currentPlan,
          cyclePlan,
          enrichedPacket: input.enrichedPacket,
          intake: input.intake,
          tier2,
          contextDb: input.contextDb,
          client: input.client,
          rts: input.rts,
          abMode: input.intake.abMode,
          repoRoot: input.repoRoot,
          seedFiles: seedFilesForNextCycle
        }, provider, compressionProvider)

        totalTokensUsed += stepResult.tokensUsed
        totalCostUsd += stepResult.costUsd
        monitorInterventions += stepResult.monitorInterventions
        activeCycle.monitorInterventions = monitorInterventions

        if (stepResult.stepOutput !== null) {
          cycleStepOutputs.push(stepResult.stepOutput)
          finalStepOutputs.push(stepResult.stepOutput)
          if (step.stepIndex === 0) {
            const confirmedFiles = stepResult.stepOutput.affectedFiles.map((filePath) => normalizeRepoRelativePath(input.repoRoot, filePath))
            cyclePlan = buildCyclePlan(
              currentPlan,
              input.enrichedPacket,
              confirmedFiles,
              loadConfirmedFileContents(input.repoRoot, confirmedFiles)
            )
          }
          logInfo('executor', `[Executor] Step ${step.stepIndex} COMPLETE`, {
            affectedFiles: stepResult.stepOutput.affectedFiles,
            producedContentLength: stepResult.stepOutput.producedContent.length
          })
        }

        if (stepResult.outcome === 'vetoed' || stepResult.outcome === 'budget_overflow' || stepResult.outcome === 'error') {
          blockedByIssue = stepResult.vetoReason ?? stepResult.outcome
          activeCycle.blockedByIssue = blockedByIssue
          logWarn('executor', `[Executor] Step ${step.stepIndex} blocked`, {
            outcome: stepResult.outcome,
            reason: blockedByIssue
          })
          break
        }

        if (step.stepIndex >= 1) {
          const repoChangedFiles = getRepoChangedFiles(input.repoRoot)
            .filter((filePath) => !cycleBaselineChangedFiles.has(filePath))

          if (repoChangedFiles.length === 0) {
            blockedByIssue = `step_${step.stepIndex}_completed_without_repo_changes`
            activeCycle.blockedByIssue = blockedByIssue
            logWarn('executor', `[Executor] Step ${step.stepIndex} produced no repository changes`, {
              reason: blockedByIssue
            })
            break
          }

          if (stepResult.outcome === 'success'
            && stepResult.writeCount > 0
            && (stepResult.testsPassed || stepResult.typeCheckPassed)
            && stepResult.stepOutput?.affectedFiles.length) {
            logInfo('executor', '[Executor] Validation passed after write — running verifier immediately', {
              stepIndex: step.stepIndex,
              affectedFiles: stepResult.stepOutput.affectedFiles
            })
            break
          }
        }
      }

      const changedFiles = [...new Set([
        ...getChangedFiles(cycleStepOutputs),
        ...getRepoChangedFiles(input.repoRoot)
          .filter((filePath) => !cycleBaselineChangedFiles.has(filePath))
      ])]

      if (blockedByIssue !== null || changedFiles.length === 0) {
        seedFilesForNextCycle = extractConfirmedFilesFromStepOutputs(cycleStepOutputs)
        const cycleOutcome: ExecutionCycle = {
          cycle: cycleNumber,
          plan: currentPlan,
          startedAt: cycleStartedAt,
          completedAt: new Date().toISOString(),
          outcome: 'verifier_rejected',
          blockedByIssue: blockedByIssue ?? 'no_files_changed',
          monitorInterventions
        }

        retryState = recordCycleOutcome(retryState, cycleOutcome)
        completedCycles.push(cycleOutcome)
        activeCycle = null
        logWarn('executor', `[Executor] Cycle ${cycleNumber} ended without a verifier-ready diff`, {
          blockedByIssue: cycleOutcome.blockedByIssue
        })
        input.rts.append({
          task_id: input.plan.taskId,
          ab_mode: input.intake.abMode,
          agent_role: 'executor',
          step_index: null,
          event_type: 'cycle_end',
          content_json: JSON.stringify(cycleOutcome),
          tokens_used: null,
          cost_usd: null,
          created_at: new Date().toISOString()
        })
        continue
      }

      const verifierContext: ToolExecutionContext = {
        repoRoot: input.repoRoot,
        taskId: input.plan.taskId,
        stepIndex: -1,
        rts: input.rts,
        abMode: input.intake.abMode,
        repoContext: input.intake.repoContext,
        rulesTestCommand: input.intake.rules.test_command ?? null
      }
      const verifierResult = await runVerifier({
        repoRoot: input.repoRoot,
        plan: currentPlan,
        rules: input.intake.rules,
        taskId: input.plan.taskId,
        abMode: input.intake.abMode,
        rts: input.rts,
        stepOutputs: cycleStepOutputs
      }, verifierContext)
      const cycleOutcome: ExecutionCycle = {
        cycle: cycleNumber,
        plan: currentPlan,
        startedAt: cycleStartedAt,
        completedAt: new Date().toISOString(),
        outcome: blockedByIssue !== null
          ? 'verifier_rejected'
          : verifierResult.passed
            ? 'success'
            : 'verifier_rejected',
        blockedByIssue: blockedByIssue ?? (verifierResult.passed ? null : verifierResult.verdict),
        monitorInterventions
      }

      retryState = recordCycleOutcome(retryState, cycleOutcome)
      completedCycles.push(cycleOutcome)
      seedFilesForNextCycle = extractConfirmedFilesFromStepOutputs(cycleStepOutputs)
      finalVerifierResult = verifierResult
      activeCycle = null
      logInfo('executor', `[Executor] Cycle ${cycleNumber} END`, {
        outcome: cycleOutcome.outcome,
        verifierVerdict: verifierResult.verdict,
        changedFiles
      })
      input.rts.append({
        task_id: input.plan.taskId,
        ab_mode: input.intake.abMode,
        agent_role: 'executor',
        step_index: null,
        event_type: 'cycle_end',
        content_json: JSON.stringify(cycleOutcome),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })

      if (cycleOutcome.outcome === 'success' && verifierResult.passed) {
        await admitCycleToContextDb(
          cycleOutcome,
          input.enrichedPacket,
          input.intake,
          cycleStepOutputs,
          verifierResult,
          input.contextDb
        )
        tier2.flush(input.rts, input.intake.abMode)
        tier2.clear()
        return {
          outcome: 'success',
          completedCycles,
          finalStepOutputs,
          totalTokensUsed,
          totalCostUsd,
          verifierResult: verifierResult
        }
      }
    }

    if (shouldEscalate(retryState, input.enrichedPacket)) {
      const escalationPackage = buildEscalationPackage(
        'retry_exhaustion',
        input.plan.taskId,
        input.intake.enhancedTask.original,
        {
          enriched_packet: input.enrichedPacket,
          execution_history: completedCycles.map(toEscalationCycle),
          suggested_actions: ['Verifier rejected every available approach.']
        }
      )
      return escalate(escalationPackage, input.rts, input.intake.abMode)
    }

    tier2.flush(input.rts, input.intake.abMode)
    tier2.clear()
    return {
      outcome: 'all_cycles_exhausted',
      completedCycles,
      finalStepOutputs,
      totalTokensUsed,
      totalCostUsd,
      verifierResult: finalVerifierResult
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logError('executor', '[Executor] Unhandled executor failure', {
      taskId: input.plan.taskId,
      error: message,
      activeCycle: activeCycle?.cycleNumber ?? null
    })
    input.rts.append({
      task_id: input.plan.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'executor',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Unhandled executor failure.',
        error: message,
        activeCycle: activeCycle?.cycleNumber ?? null
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    if (activeCycle !== null) {
      const cycleOutcome: ExecutionCycle = {
        cycle: activeCycle.cycleNumber,
        plan: activeCycle.plan,
        startedAt: activeCycle.startedAt,
        completedAt: new Date().toISOString(),
        outcome: 'verifier_rejected',
        blockedByIssue: activeCycle.blockedByIssue ?? message,
        monitorInterventions: activeCycle.monitorInterventions
      }
      input.rts.append({
        task_id: input.plan.taskId,
        ab_mode: input.intake.abMode,
        agent_role: 'executor',
        step_index: null,
        event_type: 'cycle_end',
        content_json: JSON.stringify(cycleOutcome),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })
    }

    if (error instanceof Error && error.name === 'EscalationRequired') {
      throw error
    }

    tier2.flush(input.rts, input.intake.abMode)
    tier2.clear()
    throw (error instanceof Error ? error : new Error(message))
  }
}

function normalizeRepoRelativePath(repoRoot: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const repoNormalized = repoRoot.replace(/\\/g, '/')
  if (normalized.startsWith(repoNormalized)) {
    return path.relative(repoRoot, filePath).replace(/\\/g, '/')
  }

  return normalized.replace(/^\/+/, '')
}

function extractConfirmedFilesFromStepOutputs(stepOutputs: StepOutput[]): string[] {
  return [...new Set(
    stepOutputs.flatMap((output) => output.affectedFiles).filter((filePath) => filePath.length > 0)
  )]
}

function getChangedFiles(stepOutputs: StepOutput[]): string[] {
  return [...new Set(stepOutputs.flatMap((stepOutput) => stepOutput.affectedFiles).filter((filePath) => filePath.length > 0))]
}

function shouldBlockStepBecauseNoMutations(step: ExecutionStep, cycleStepOutputs: StepOutput[]): boolean {
  if (step.stepIndex <= 1) {
    return false
  }

  return getChangedFiles(cycleStepOutputs).length === 0
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

/**
 * Admits the most useful cycle artifacts into ContextDB after a successful verifier pass.
 *
 * This function is best-effort only. Admission failures are logged and ignored
 * so the executor never crashes because memory capture was degraded.
 */
export async function admitCycleToContextDb(
  cycle: ExecutionCycle,
  enrichedPacket: EnrichedPacket,
  intake: IntakeResult,
  stepOutputs: StepOutput[],
  verifierResult: VerifierResult,
  contextDb: ContextDB
): Promise<void> {
  try {
    const now = new Date().toISOString()
    const memoryQualityScore = verifierResult.verdict === 'PASS' ? 0.85 : 0.65
    const repo = intake.rules.repo_name
    const affectedSymbols = enrichedPacket.affectedSymbols

    const taskChunk = {
      chunk_id: randomUUID(),
      chunk_type: 'task' as const,
      task_id_origin: intake.taskId,
      repo,
      created_at: now,
      last_validated_at: now,
      memory_quality_score: memoryQualityScore,
      symbols: affectedSymbols,
      base_memory_snapshot: {
        chunk_ids: enrichedPacket.verifiedChunkIds,
        symbol_ids: [],
        call_graph_hash: ''
      },
      invalid_if: [
        {
          type: 'symbol_deleted' as const,
          symbol: affectedSymbols[0] ?? 'unknown',
          description: 'Primary affected symbol was deleted'
        },
        {
          type: 'age_exceeded' as const,
          max_age_days: 90,
          description: 'Entry older than 90 days'
        }
      ],
      task_description: enrichedPacket.structuredDescription,
      outcome: 'success' as const,
      approach_used: cycle.plan.approach,
      steps_taken: cycle.plan.steps.length,
      verifier_verdict: verifierResult.verdict,
      cycles_used: cycle.cycle,
      tokens_total: 0,
      cost_usd: 0
    }
    const taskDecision = await contextDb.admit(taskChunk, true)
    console.log('[ContextDB]', taskDecision)

    const approachChunk = {
      chunk_id: randomUUID(),
      chunk_type: 'approach' as const,
      task_id_origin: intake.taskId,
      repo,
      created_at: now,
      last_validated_at: now,
      memory_quality_score: memoryQualityScore,
      symbols: affectedSymbols,
      base_memory_snapshot: {
        chunk_ids: enrichedPacket.verifiedChunkIds,
        symbol_ids: [],
        call_graph_hash: ''
      },
      invalid_if: [
        {
          type: 'call_graph_changed' as const,
          description: 'Call graph changed significantly since this approach was recorded'
        },
        {
          type: 'age_exceeded' as const,
          max_age_days: 60,
          description: 'Approach entry older than 60 days'
        }
      ],
      approach_description: cycle.plan.approach,
      worked_for: [enrichedPacket.structuredDescription],
      failed_for: [],
      prerequisites: [],
      contraindications: []
    }
    const approachDecision = await contextDb.admit(approachChunk, true)
    console.log('[ContextDB]', approachDecision)

    for (const symbol of affectedSymbols.slice(0, 5)) {
      const symbolChunk = {
        chunk_id: randomUUID(),
        chunk_type: 'symbol' as const,
        task_id_origin: intake.taskId,
        repo,
        created_at: now,
        last_validated_at: now,
        memory_quality_score: 0.7,
        symbols: [symbol],
        base_memory_snapshot: {
          chunk_ids: enrichedPacket.verifiedChunkIds,
          symbol_ids: [],
          call_graph_hash: ''
        },
        invalid_if: [
          {
            type: 'symbol_deleted' as const,
            symbol,
            description: `${symbol} was deleted from the codebase`
          },
          {
            type: 'symbol_moved' as const,
            symbol,
            description: `${symbol} was moved to a different file`
          }
        ],
        symbol_name: symbol,
        symbol_id: '',
        file_path: '',
        kind: 'unknown',
        approach_notes: cycle.plan.approach,
        test_coverage: []
      }
      const symbolDecision = await contextDb.admit(symbolChunk, true)
      console.log('[ContextDB]', symbolDecision)
    }

    const testFiles = stepOutputs
      .flatMap((stepOutput) => stepOutput.affectedFiles)
      .filter((filePath) => filePath.includes('.test.') || filePath.includes('.spec.'))
      .slice(0, 3)

    for (const testFile of testFiles) {
      const testChunk = {
        chunk_id: randomUUID(),
        chunk_type: 'test' as const,
        task_id_origin: intake.taskId,
        repo,
        created_at: now,
        last_validated_at: now,
        memory_quality_score: 0.75,
        symbols: affectedSymbols,
        base_memory_snapshot: {
          chunk_ids: enrichedPacket.verifiedChunkIds,
          symbol_ids: [],
          call_graph_hash: ''
        },
        invalid_if: [
          {
            type: 'file_deleted' as const,
            file: testFile,
            description: `Test file ${testFile} was deleted`
          },
          {
            type: 'age_exceeded' as const,
            max_age_days: 90,
            description: 'Test entry expired'
          }
        ],
        test_name: path.basename(testFile),
        test_file: testFile,
        covers_symbols: affectedSymbols,
        last_passed_at: now,
        flaky: false,
        flakiness_notes: ''
      }
      const testDecision = await contextDb.admit(testChunk, true)
      console.log('[ContextDB]', testDecision)
    }
  } catch (error) {
    console.error('[ContextDB]', error)
    return
  }
}

function buildPlanForApproach(
  taskId: string,
  approach: RankedApproach | null,
  affectedSymbols: string[],
  executionMode: 'phased' | 'continuous',
  executorModel: string,
  verifierModel: string
): ExecutionPlan | null {
  if (approach === null) {
    return null
  }

  if (executionMode === 'continuous') {
    const steps: ExecutionStep[] = [{
      stepIndex: 0,
      description: [
        'Understand the codebase, implement the fix, run tests, and verify.',
        'Work in this order:',
        '1. Find the relevant files and understand the bug.',
        '2. Make the targeted fix.',
        '3. Run tests to verify.',
        '4. When tests pass, respond with a plain text summary of what you changed.'
      ].join('\n'),
      approach: approach.approach,
      affectedSymbols,
      affectedFiles: [],
      estimatedRisk: approach.estimatedRisk,
      dependsOn: [],
      isCheckpoint: true,
      phaseHint: 'continuous'
    }]

    return {
      planId: `${taskId}-cycle-${approach.rank}`,
      taskId,
      approach: approach.approach,
      approachRank: approach.rank,
      steps,
      executionMode,
      assignedExecutorModel: executorModel,
      assignedVerifierModel: verifierModel,
      estimatedStepCount: steps.length,
      createdAt: new Date().toISOString()
    }
  }

  const steps: ExecutionStep[] = [
    {
      stepIndex: 0,
      description: 'Understand and locate the relevant code',
      approach: approach.approach,
      affectedSymbols,
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [],
      isCheckpoint: false,
      phaseHint: 'discovery'
    },
    {
      stepIndex: 1,
      description: 'Implement the fix or feature',
      approach: approach.approach,
      affectedSymbols,
      affectedFiles: [],
      estimatedRisk: approach.estimatedRisk,
      dependsOn: [0],
      isCheckpoint: true,
      phaseHint: 'implementation'
    },
    {
      stepIndex: 2,
      description: 'Add or update tests',
      approach: approach.approach,
      affectedSymbols,
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [1],
      isCheckpoint: false,
      phaseHint: 'testing'
    },
    {
      stepIndex: 3,
      description: 'Verify the implementation compiles and passes existing tests',
      approach: approach.approach,
      affectedSymbols,
      affectedFiles: [],
      estimatedRisk: 'low',
      dependsOn: [2],
      isCheckpoint: true,
      phaseHint: 'verification'
    }
  ]

  return {
    planId: `${taskId}-cycle-${approach.rank}`,
    taskId,
    approach: approach.approach,
    approachRank: approach.rank,
    steps,
    executionMode,
    assignedExecutorModel: executorModel,
    assignedVerifierModel: verifierModel,
    estimatedStepCount: steps.length,
    createdAt: new Date().toISOString()
  }
}
