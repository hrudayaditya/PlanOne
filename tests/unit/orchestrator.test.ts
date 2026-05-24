import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { DEFAULT_EXECUTOR_MODEL, DEFAULT_VERIFIER_MODEL } from '../../src/llm/models.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { EscalationRequired } from '../../src/escalation/index.js'
import type { IntakeResult } from '../../src/intake/index.js'
import { buildExecutionPlan } from '../../src/orchestrator/index.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'

function makeClient(): BaseMemoryClient {
  return {
    callTool: async () => ({ structuredContent: { results: [], total: 0, cursor: null } })
  } as unknown as BaseMemoryClient
}

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-orchestrator-'))
  const store = new RawTraceStore(join(directory, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function makeIntake(alwaysEscalateIf: string[] = []): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'Fix auth bug',
      structured_description: 'Fix auth bug',
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: [],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.7,
      rationale: 'multi-step',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: ['**/secrets/**'],
      always_escalate_if: alwaysEscalateIf,
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    repoContext: {
      repoRoot: '/repo',
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

function makePacket(approaches = [
  { approach: 'Patch auth branch', confidence: 0.8, rank: 1, supportingChunkIds: ['chunk-1'], estimatedRisk: 'medium' as const },
  { approach: 'Add regression tests', confidence: 0.6, rank: 2, supportingChunkIds: ['chunk-2'], estimatedRisk: 'low' as const }
]): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Fix auth bug',
    structuredDescription: 'Fix auth bug',
    taskType: 'bug_fix',
    affectedArea: 'authentication',
    affectedSymbols: ['LoginService'],
    primaryRootCause: 'Broken branch',
    alternativeRootCauses: [],
    rankedApproaches: approaches,
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.8,
    verifiedChunkIds: ['chunk-1'],
    rules: makeIntake().rules,
    synthesizedAt: new Date().toISOString()
  }
}

describe('orchestrator', () => {
  it('removes rule-matching approaches and escalates when all are removed', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const input = {
        enrichedPacket: makePacket([{ approach: 'changes auth logic', confidence: 0.8, rank: 1, supportingChunkIds: [], estimatedRisk: 'high' }]),
        intake: makeIntake(['changes auth logic']),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      }

      await expect(buildExecutionPlan(input)).rejects.toBeInstanceOf(EscalationRequired)
    } finally {
      cleanup()
    }
  })

  it('uses remaining approaches when only some are removed by rules', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket([
          { approach: 'changes auth logic', confidence: 0.9, rank: 1, supportingChunkIds: [], estimatedRisk: 'high' },
          { approach: 'Patch safe login path', confidence: 0.8, rank: 2, supportingChunkIds: [], estimatedRisk: 'medium' }
        ]),
        intake: makeIntake(['changes auth logic']),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      })

      expect(plan.approach).toBe('Patch safe login path')
    } finally {
      cleanup()
    }
  })

  it('assigns the exact configured executor and verifier models', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: 'inclusionai/ling-2.6-1t:free',
        verifierModel: 'gemini-3.1-flash-lite-preview'
      })

      expect(plan.assignedExecutorModel).toBe('inclusionai/ling-2.6-1t:free')
      expect(plan.assignedVerifierModel).toBe('gemini-3.1-flash-lite-preview')
    } finally {
      cleanup()
    }
  })

  it('builds a four-step Phase 1 heuristic plan', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      })

      expect(plan.steps).toHaveLength(4)
    } finally {
      cleanup()
    }
  })

  it('builds a single continuous-loop step when enabled', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL,
        continuousLoop: true
      })

      expect(plan.executionMode).toBe('continuous')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]?.phaseHint).toBe('continuous')
      expect(plan.steps[0]?.isCheckpoint).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('marks step 1 and step 3 as checkpoints', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      })

      expect(plan.steps[1]?.isCheckpoint).toBe(true)
      expect(plan.steps[3]?.isCheckpoint).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('uses sequential dependsOn links', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      const plan = await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      })

      expect(plan.steps.map((step) => step.dependsOn)).toEqual([[], [0], [1], [2]])
    } finally {
      cleanup()
    }
  })

  it('logs the final plan as a step_output event', async () => {
    const { store, cleanup } = makeStore()

    try {
      const contextDb = new ContextDB(makeClient())
      await buildExecutionPlan({
        enrichedPacket: makePacket(),
        intake: makeIntake(),
        rts: store,
        contextDb,
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL
      })

      expect(store.queryByType('step_output')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })
})
