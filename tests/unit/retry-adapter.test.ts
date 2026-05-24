import { describe, expect, it } from 'vitest'

import { toEscalationCycle } from '../../src/orchestrator/retry.js'

describe('retry escalation adapter', () => {
  it('maps fields correctly', () => {
    const result = toEscalationCycle({
      cycle: 2,
      plan: {
        planId: 'plan-1',
        taskId: 'task-1',
        approach: 'Patch auth branch',
        approachRank: 1,
        steps: [{ stepIndex: 0, description: '', approach: '', affectedSymbols: [], affectedFiles: [], estimatedRisk: 'low', dependsOn: [], isCheckpoint: false }],
        assignedExecutorModel: 'claude-opus-4-5',
        assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
        estimatedStepCount: 1,
        createdAt: new Date().toISOString()
      },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outcome: 'verifier_rejected',
      blockedByIssue: 'failed tests',
      monitorInterventions: 3
    })

    expect(result).toEqual({
      cycle: 2,
      approach: 'Patch auth branch',
      steps_taken: 1,
      monitor_interventions: 3,
      verifier_verdict: 'verifier_rejected',
      blocking_issue: 'failed tests'
    })
  })

  it('maps null blockedByIssue to none', () => {
    const result = toEscalationCycle({
      cycle: 1,
      plan: {
        planId: 'plan-1',
        taskId: 'task-1',
        approach: 'Patch auth branch',
        approachRank: 1,
        steps: [],
        assignedExecutorModel: 'claude-opus-4-5',
        assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
        estimatedStepCount: 0,
        createdAt: new Date().toISOString()
      },
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: 'in_progress',
      blockedByIssue: null,
      monitorInterventions: 0
    })

    expect(result.blocking_issue).toBe('none')
  })
})
