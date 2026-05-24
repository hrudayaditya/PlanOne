import { describe, expect, it } from 'vitest'

import { canRetry, createRetryState, getNextApproach, recordCycleOutcome, shouldEscalate } from '../../src/orchestrator/retry.js'
import type { ExecutionCycle } from '../../src/orchestrator/plan.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'

function makePacket(): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Fix auth bug',
    structuredDescription: 'Fix auth bug',
    taskType: 'bug_fix',
    affectedArea: 'authentication',
    affectedSymbols: ['LoginService'],
    primaryRootCause: 'Broken branch',
    alternativeRootCauses: [],
    rankedApproaches: [
      { approach: 'Approach A', confidence: 0.9, rank: 1, supportingChunkIds: [], estimatedRisk: 'medium' },
      { approach: 'Approach B', confidence: 0.8, rank: 2, supportingChunkIds: [], estimatedRisk: 'low' }
    ],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.8,
    verifiedChunkIds: [],
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    synthesizedAt: new Date().toISOString()
  }
}

function makePacketWithTestingApproach(): EnrichedPacket {
  const packet = makePacket()
  packet.rankedApproaches = [
    { approach: 'Add integration tests for SSR cache behavior', confidence: 0.95, rank: 1, supportingChunkIds: [], estimatedRisk: 'low' },
    { approach: 'Implement forceServerGcTimeInfinity in withTRPC', confidence: 0.9, rank: 2, supportingChunkIds: [], estimatedRisk: 'medium' }
  ]
  return packet
}

function makePacketWithMixedTestingApproach(): EnrichedPacket {
  const packet = makePacket()
  packet.rankedApproaches = [
    { approach: 'Add integration tests in withTRPC.test.tsx to verify SSR behavior', confidence: 0.95, rank: 1, supportingChunkIds: [], estimatedRisk: 'low' },
    { approach: 'Implement SSR runtime behavior in ssrPrepass.ts and add tests', confidence: 0.9, rank: 2, supportingChunkIds: [], estimatedRisk: 'medium' }
  ]
  return packet
}

function makeCycle(cycle: number, approach: string, outcome: ExecutionCycle['outcome']): ExecutionCycle {
  return {
    cycle,
    plan: {
      planId: `plan-${cycle}`,
      taskId: 'task-1',
      approach,
      approachRank: cycle,
      steps: [],
      assignedExecutorModel: 'claude-opus-4-5',
      assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
      estimatedStepCount: 0,
      createdAt: new Date().toISOString()
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome,
    blockedByIssue: outcome === 'success' ? null : 'issue',
    monitorInterventions: 0
  }
}

describe('retry manager', () => {
  it('initializes retry state correctly', () => {
    expect(createRetryState('task-1')).toEqual({
      taskId: 'task-1',
      maxCycles: 3,
      cycles: [],
      currentCycle: 1
    })
  })

  it('can retry while currentCycle is within the max', () => {
    expect(canRetry(createRetryState('task-1'))).toBe(true)
  })

  it('cannot retry when currentCycle exceeds the max', () => {
    const state = { ...createRetryState('task-1'), currentCycle: 4 }
    expect(canRetry(state)).toBe(false)
  })

  it('never returns a previously tried approach', () => {
    const state = recordCycleOutcome(createRetryState('task-1'), makeCycle(1, 'Approach A', 'verifier_rejected'))
    expect(getNextApproach(state, makePacket())?.approach).toBe('Approach B')
  })

  it('returns null when all approaches are exhausted', () => {
    let state = createRetryState('task-1')
    state = recordCycleOutcome(state, makeCycle(1, 'Approach A', 'verifier_rejected'))
    state = recordCycleOutcome(state, makeCycle(2, 'Approach B', 'verifier_rejected'))

    expect(getNextApproach(state, makePacket())).toBeNull()
  })

  it('escalates when cycles are exhausted', () => {
    const state = { ...createRetryState('task-1'), currentCycle: 4 }
    expect(shouldEscalate(state, makePacket())).toBe(true)
  })

  it('escalates when all approaches are exhausted', () => {
    let state = createRetryState('task-1')
    state = recordCycleOutcome(state, makeCycle(1, 'Approach A', 'verifier_rejected'))
    state = recordCycleOutcome(state, makeCycle(2, 'Approach B', 'verifier_rejected'))

    expect(shouldEscalate(state, makePacket())).toBe(true)
  })

  it('records cycle outcomes immutably', () => {
    const state = createRetryState('task-1')
    const nextState = recordCycleOutcome(state, makeCycle(1, 'Approach A', 'verifier_rejected'))

    expect(state.cycles).toHaveLength(0)
    expect(nextState.cycles).toHaveLength(1)
  })

  it('prefers implementation approaches before test-focused approaches', () => {
    expect(getNextApproach(createRetryState('task-1'), makePacketWithTestingApproach())?.approach)
      .toBe('Implement forceServerGcTimeInfinity in withTRPC')
  })

  it('returns a test-focused approach only when no implementation approaches remain', () => {
    let state = createRetryState('task-1')
    state = recordCycleOutcome(state, makeCycle(1, 'Implement forceServerGcTimeInfinity in withTRPC', 'verifier_rejected'))
    expect(getNextApproach(state, makePacketWithTestingApproach())?.approach)
      .toBe('Add integration tests for SSR cache behavior')
  })

  it('keeps mixed implementation approaches eligible even when they also mention tests', () => {
    expect(getNextApproach(createRetryState('task-1'), makePacketWithMixedTestingApproach())?.approach)
      .toBe('Implement SSR runtime behavior in ssrPrepass.ts and add tests')
  })
})
