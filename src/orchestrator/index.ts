import { randomUUID } from 'node:crypto'

import { buildEscalationPackage, escalate, type EscalationRequired } from '../escalation/index.js'
import type { IntakeResult } from '../intake/index.js'
import type { ContextDB } from '../memory/context-db/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { EnrichedPacket, RankedApproach } from '../panel/synthesis.js'
import { logError, logInfo } from '../utils/logger.js'
import type { ExecutionPlan, ExecutionStep } from './plan.js'

export interface OrchestratorInput {
  enrichedPacket: EnrichedPacket
  intake: IntakeResult
  rts: RawTraceStore
  contextDb: ContextDB
  executorModel: string
  verifierModel: string
  continuousLoop?: boolean
}

export async function buildExecutionPlan(input: OrchestratorInput): Promise<ExecutionPlan> {
  try {
    logInfo('orchestrator', '[Orchestrator] Building execution plan', {
      taskId: input.intake.taskId
    })

    const filteredApproaches = filterEscalatedApproaches(input)
    if (filteredApproaches.length === 0) {
      const pkg = buildEscalationPackage(
        'monitor_architectural_decision',
        input.intake.taskId,
        input.intake.enhancedTask.original,
        {
          enriched_packet: input.enrichedPacket,
          suggested_actions: ['Provide a new approach that does not match always_escalate_if constraints.']
        }
      )
      return escalate(pkg, input.rts, input.intake.abMode)
    }

    const rankedApproaches = await rerankApproaches(filteredApproaches, input)
    const chosenApproach = rankedApproaches[0] ?? buildFallbackApproach(input.enrichedPacket)
    const steps = applyNeverTouch(
      buildPhaseOneSteps(chosenApproach, input.enrichedPacket.affectedSymbols, input.continuousLoop === true),
      input.intake.rules.never_touch,
      input
    )

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      taskId: input.intake.taskId,
      approach: chosenApproach.approach,
      approachRank: chosenApproach.rank,
      steps,
      executionMode: input.continuousLoop === true ? 'continuous' : 'phased',
      assignedExecutorModel: input.executorModel,
      assignedVerifierModel: input.verifierModel,
      estimatedStepCount: steps.length,
      createdAt: new Date().toISOString()
    }

    logInfo('orchestrator', '[Orchestrator] Plan produced', {
      taskId: input.intake.taskId,
      executorModel: input.executorModel,
      verifierModel: input.verifierModel,
      stepCount: steps.length,
      approach: chosenApproach.approach
    })

    for (const step of steps) {
      logInfo('orchestrator', `[Orchestrator] Step ${step.stepIndex}`, {
        description: step.description,
        isCheckpoint: step.isCheckpoint,
        estimatedRisk: step.estimatedRisk
      })
    }

    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'orchestrator',
      step_index: null,
      event_type: 'step_output',
      content_json: JSON.stringify(plan),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    return plan
  } catch (error) {
    if (isEscalationError(error)) {
      throw error
    }

    logError('orchestrator', 'Execution planning degraded to fallback plan.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      taskId: input.intake.taskId
    })

    const fallbackApproach = buildFallbackApproach(input.enrichedPacket)
    const fallbackPlan: ExecutionPlan = {
      planId: randomUUID(),
      taskId: input.intake.taskId,
      approach: fallbackApproach.approach,
      approachRank: fallbackApproach.rank,
      steps: buildPhaseOneSteps(fallbackApproach, input.enrichedPacket.affectedSymbols, input.continuousLoop === true),
      executionMode: input.continuousLoop === true ? 'continuous' : 'phased',
      assignedExecutorModel: input.executorModel,
      assignedVerifierModel: input.verifierModel,
      estimatedStepCount: input.continuousLoop === true ? 1 : 4,
      createdAt: new Date().toISOString()
    }

    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'orchestrator',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Execution planning degraded to fallback plan.',
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'orchestrator',
      step_index: null,
      event_type: 'step_output',
      content_json: JSON.stringify(fallbackPlan),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    return fallbackPlan
  }
}

function filterEscalatedApproaches(input: OrchestratorInput): RankedApproach[] {
  const conditions = input.intake.rules.always_escalate_if
  const remaining: RankedApproach[] = []

  for (const approach of input.enrichedPacket.rankedApproaches) {
    const matchedCondition = conditions.find((condition) => matchesCondition(approach.approach, condition))

    if (matchedCondition === undefined) {
      remaining.push(approach)
      continue
    }

    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'orchestrator',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        reason: 'Approach removed by always_escalate_if rule.',
        approach: approach.approach,
        matchedCondition
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
  }

  return remaining
}

async function rerankApproaches(approaches: RankedApproach[], input: OrchestratorInput): Promise<RankedApproach[]> {
  const queryResult = await safeContextDbQuery(input.contextDb, {
    queryText: input.enrichedPacket.structuredDescription,
    currentRepo: input.intake.rules.repo_name,
    symbols: input.enrichedPacket.affectedSymbols,
    chunkTypes: ['approach'],
    abMode: input.intake.abMode,
    limit: 20
  })
  const approachChunks = queryResult.chunks
    .map((scored) => scored.chunk)
    .filter((chunk) => chunk.chunk_type === 'approach')

  logInfo('orchestrator', '[Orchestrator] ContextDB query complete', {
    tierUsed: queryResult.tier_used,
    approachChunks: approachChunks.length
  })

  return approaches
    .map((approach) => {
      let adjustedScore = approach.confidence

      for (const chunk of approachChunks) {
        if (chunk.worked_for.some((entry) => matchesCondition(approach.approach, entry))) {
          adjustedScore += 0.1
        }
        if (chunk.failed_for.some((entry) => matchesCondition(approach.approach, entry))) {
          adjustedScore -= 0.15
        }
      }

      return {
        ...approach,
        confidence: Number(Math.max(0, Math.min(1, adjustedScore)).toFixed(4))
      }
    })
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence
      }
      return left.rank - right.rank
    })
    .map((approach, index) => ({
      ...approach,
      rank: index + 1
    }))
}

async function safeContextDbQuery(contextDb: ContextDB, query: Parameters<ContextDB['query']>[0]): ReturnType<ContextDB['query']> {
  try {
    return await contextDb.query(query)
  } catch {
    return {
      chunks: [],
      tier_used: 'fallback',
      gate_results: [],
      bypassed: query.abMode === 'A'
    }
  }
}

function buildPhaseOneSteps(
  approach: RankedApproach,
  affectedSymbols: string[],
  continuousLoop: boolean
): ExecutionStep[] {
  if (continuousLoop) {
    return [{
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
  }

  return [
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
}

function applyNeverTouch(steps: ExecutionStep[], neverTouchGlobs: string[], input: OrchestratorInput): ExecutionStep[] {
  return steps.map((step) => {
    const filteredFiles = step.affectedFiles.filter((filePath) => {
      const blocked = neverTouchGlobs.some((pattern) => matchesGlob(filePath, pattern))

      if (blocked) {
        input.rts.append({
          task_id: input.intake.taskId,
          ab_mode: input.intake.abMode,
          agent_role: 'orchestrator',
          step_index: step.stepIndex,
          event_type: 'error',
          content_json: JSON.stringify({
            reason: 'Removed affected file because it matched never_touch.',
            filePath
          }),
          tokens_used: null,
          cost_usd: null,
          created_at: new Date().toISOString()
        })
      }

      return blocked === false
    })

    return {
      ...step,
      affectedFiles: filteredFiles
    }
  })
}

function buildFallbackApproach(packet: EnrichedPacket): RankedApproach {
  return packet.rankedApproaches[0] ?? {
    approach: packet.primaryRootCause || 'Apply the safest available implementation approach.',
    confidence: packet.consensusConfidence,
    rank: 1,
    supportingChunkIds: packet.verifiedChunkIds,
    estimatedRisk: 'medium'
  }
}

function matchesCondition(text: string, condition: string): boolean {
  const normalizedText = normalizeForMatch(text)
  const normalizedCondition = normalizeForMatch(condition)

  if (normalizedText.includes(normalizedCondition)) {
    return true
  }

  return normalizedCondition
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .every((token) => normalizedText.includes(token))
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function matchesGlob(filePath: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')

  return new RegExp(`^${escaped}$`).test(filePath)
}

function isEscalationError(error: unknown): error is EscalationRequired {
  return error instanceof Error && error.name === 'EscalationRequired'
}

export type { ExecutionPlan, ExecutionStep } from './plan.js'
export {
  canRetry,
  createRetryState,
  getNextApproach,
  recordCycleOutcome,
  shouldEscalate,
  toEscalationCycle
} from './retry.js'
