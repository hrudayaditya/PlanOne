import { describe, expect, it } from 'vitest'

import { generateConstraintReminders } from '../../src/monitor/anchor-recurrence.js'
import type { AnchorRecurrenceInput } from '../../src/monitor/anchor-recurrence.js'

function makeInput(): AnchorRecurrenceInput {
  return {
    currentStep: {
      stepIndex: 1,
      description: 'Implement change',
      approach: 'Patch auth branch',
      affectedSymbols: ['LoginService'],
      affectedFiles: [],
      estimatedRisk: 'medium',
      dependsOn: [],
      isCheckpoint: false
    },
    preActionPlan: {
      intendedAction: 'Refactor LoginService',
      affectedSymbols: ['LoginService'],
      estimatedRiskLevel: 'medium',
      reasoning: 'routine change'
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    enrichedPacket: {
      taskId: 'task-1',
      originalTask: 'Fix auth bug',
      structuredDescription: 'Fix auth bug',
      taskType: 'bug_fix',
      affectedArea: 'authentication',
      affectedSymbols: ['LoginService'],
      primaryRootCause: '',
      alternativeRootCauses: [],
      rankedApproaches: [],
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
    },
    stepHistory: []
  }
}

describe('monitor anchor recurrence', () => {
  it('generates a high-priority reminder for high-risk steps', () => {
    const input = makeInput()
    input.currentStep.estimatedRisk = 'high'
    expect(generateConstraintReminders(input).some((r) => r.priority === 'high')).toBe(true)
  })

  it('generates a high-priority reminder for checkpoints', () => {
    const input = makeInput()
    input.currentStep.isCheckpoint = true
    expect(generateConstraintReminders(input).some((r) => r.trigger === 'checkpoint')).toBe(true)
  })

  it('generates a medium reminder for never_touch rules', () => {
    const input = makeInput()
    input.rules.never_touch = ['src/secrets/**']
    expect(generateConstraintReminders(input).some((r) => r.trigger === 'never_touch')).toBe(true)
  })

  it('generates a drift warning when the last two steps touched the same files', () => {
    const input = makeInput()
    input.stepHistory = [
      { stepIndex: 0, producedContent: '', affectedFiles: ['a.ts'], causalDependencies: [], baseMemoryChunksUsed: [] },
      { stepIndex: 1, producedContent: '', affectedFiles: ['a.ts'], causalDependencies: [0], baseMemoryChunksUsed: [] }
    ]
    expect(generateConstraintReminders(input).some((r) => r.trigger === 'repeated_approach')).toBe(true)
  })

  it('generates a carry-forward reminder every third step when constraints exist', () => {
    const input = makeInput()
    input.currentStep.stepIndex = 3
    input.enrichedPacket.activeConstraints = ['Do not touch secrets']
    input.stepHistory = [
      { stepIndex: 0, producedContent: '', affectedFiles: [], causalDependencies: [], baseMemoryChunksUsed: [] }
    ]
    expect(generateConstraintReminders(input).some((r) => r.trigger === 'constraint_carry_forward')).toBe(true)
  })

  it('returns an empty array when nothing triggers', () => {
    expect(generateConstraintReminders(makeInput())).toEqual([])
  })
})
