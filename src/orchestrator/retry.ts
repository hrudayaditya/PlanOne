import type { ExecutionCycle as EscalationExecutionCycle } from '../escalation/index.js'
import type { EnrichedPacket, RankedApproach } from '../panel/synthesis.js'
import type { ExecutionCycle as OrchestratorExecutionCycle } from './plan.js'

/**
 * Serializable retry state for Phase 1 execution cycles.
 */
export interface RetryState {
  taskId: string
  maxCycles: number
  cycles: OrchestratorExecutionCycle[]
  currentCycle: number
}

/**
 * Creates the initial retry state for a task.
 */
export function createRetryState(taskId: string): RetryState {
  return {
    taskId,
    maxCycles: 3,
    cycles: [],
    currentCycle: 1
  }
}

/**
 * Records a completed execution cycle using an immutable state update.
 */
export function recordCycleOutcome(state: RetryState, cycle: OrchestratorExecutionCycle): RetryState {
  return {
    ...state,
    cycles: [...state.cycles, cycle],
    currentCycle: state.currentCycle + 1
  }
}

/**
 * Adapts an orchestrator execution cycle into the escalation package shape.
 */
export function toEscalationCycle(
  cycle: OrchestratorExecutionCycle
): EscalationExecutionCycle {
  return {
    cycle: cycle.cycle,
    approach: cycle.plan.approach,
    steps_taken: cycle.plan.steps.length,
    monitor_interventions: cycle.monitorInterventions,
    verifier_verdict: cycle.outcome,
    blocking_issue: cycle.blockedByIssue ?? 'none'
  }
}

/**
 * Returns whether the task is still eligible for another execution cycle.
 */
export function canRetry(state: RetryState): boolean {
  const lastOutcome = state.cycles[state.cycles.length - 1]?.outcome
  return state.currentCycle <= state.maxCycles && lastOutcome !== 'success'
}

/**
 * Returns the next untried ranked approach or null when none remain.
 */
export function getNextApproach(state: RetryState, enrichedPacket: EnrichedPacket): RankedApproach | null {
  const triedApproaches = new Set(state.cycles.map((cycle) => cycle.plan.approach))

  const implementationApproach = enrichedPacket.rankedApproaches.find((approach) => {
    return triedApproaches.has(approach.approach) === false && isImplementationApproach(approach)
  })

  if (implementationApproach !== undefined) {
    return implementationApproach
  }

  return enrichedPacket.rankedApproaches.find((approach) => triedApproaches.has(approach.approach) === false) ?? null
}

/**
 * Returns whether the retry loop should escalate instead of retrying again.
 */
export function shouldEscalate(state: RetryState, enrichedPacket: EnrichedPacket): boolean {
  return canRetry(state) === false || getNextApproach(state, enrichedPacket) === null
}

function isImplementationApproach(approach: RankedApproach): boolean {
  const text = approach.approach.toLowerCase()
  const testKeywords = [
    'add test', 'add tests',
    'write test', 'write tests',
    'integration test', 'integration tests',
    'unit test', 'unit tests',
    'create test', 'create tests',
    'test coverage', 'test suite', 'testing',
    'add spec', 'add specs',
    'write spec', 'write specs'
  ]
  const implementationKeywords = [
    'implement', 'modify', 'update', 'extend',
    'create option', 'add option', 'add boolean', 'add property',
    'override', 'intercept', 'configure', 'runtime behavior'
  ]
  const hasTestKeyword = testKeywords.some((keyword) => text.includes(keyword))
  const hasImplementationKeyword = implementationKeywords.some((keyword) => text.includes(keyword))

  if (hasTestKeyword && !hasImplementationKeyword) {
    return false
  }

  return true
}
