import { describe, expect, it, vi } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'
import { admitCycleToContextDb } from '../../src/executor/index.js'
import type { IntakeResult } from '../../src/intake/index.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'
import type { ExecutionCycle } from '../../src/orchestrator/plan.js'
import type { StepOutput } from '../../src/pipeline/state-machine.js'
import type { VerifierResult } from '../../src/verifier/index.js'

function makeMockClient(): BaseMemoryClient {
  return {
    callTool: async () => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })
  } as unknown as BaseMemoryClient
}

function makeIntake(): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'Fix auth validation',
      structured_description: 'Fix authentication token validation logic',
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: ['src/auth.ts'],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.9
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.8,
      rationale: 'cross-cutting auth work',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
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

function makeEnrichedPacket(affectedSymbols: string[] = ['validateToken', 'checkAuth']): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Fix auth validation',
    structuredDescription: 'Fix authentication token validation logic',
    taskType: 'bug_fix',
    affectedArea: 'authentication',
    affectedSymbols,
    primaryRootCause: 'Validation path misses expired tokens',
    alternativeRootCauses: [],
    rankedApproaches: [{
      approach: 'Tighten auth validation branch',
      confidence: 0.9,
      rank: 1,
      supportingChunkIds: ['chunk-1'],
      estimatedRisk: 'medium'
    }],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.85,
    verifiedChunkIds: ['chunk-1', 'chunk-2'],
    rules: makeIntake().rules,
    synthesizedAt: new Date().toISOString()
  }
}

function makeCycle(): ExecutionCycle {
  return {
    cycle: 1,
    plan: {
      planId: 'plan-1',
      taskId: 'task-1',
      approach: 'Tighten auth validation branch',
      approachRank: 1,
      steps: [
        {
          stepIndex: 0,
          description: 'Inspect auth flow',
          approach: 'Tighten auth validation branch',
          affectedSymbols: ['validateToken'],
          affectedFiles: [],
          estimatedRisk: 'low',
          dependsOn: [],
          isCheckpoint: false
        },
        {
          stepIndex: 1,
          description: 'Implement auth fix',
          approach: 'Tighten auth validation branch',
          affectedSymbols: ['checkAuth'],
          affectedFiles: [],
          estimatedRisk: 'medium',
          dependsOn: [0],
          isCheckpoint: true
        }
      ],
      assignedExecutorModel: 'claude-opus-4-5',
      assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
      estimatedStepCount: 2,
      createdAt: new Date().toISOString()
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: 'success',
    blockedByIssue: null,
    monitorInterventions: 0
  }
}

function makeVerifierResult(verdict: VerifierResult['verdict']): VerifierResult {
  return {
    passed: verdict !== 'FAIL',
    confidence: {
      raw: verdict === 'PASS' ? 0.9 : 0.7,
      calibrated: verdict === 'PASS' ? 0.9 : 0.7,
      calibrationMethod: 'identity'
    },
    functionalGate: {
      passed: true,
      passedCount: 5,
      failedCount: 0,
      regressions: [],
      newFailures: [],
      gateNote: 'ok'
    },
    mutationGate: {
      passed: true,
      verdict: verdict === 'PASS' ? 'PASS' : 'NOT_RUN',
      killRate: verdict === 'PASS' ? 0.9 : 0,
      mutantsTotal: 0,
      mutantsKilled: 0,
      tool: 'unknown',
      gateNote: 'ok'
    },
    gatesRun: 2,
    gatesTotal: 7,
    verdict,
    verifierModel: 'gemini-3.1-flash-lite-preview'
  }
}

function makeStepOutputs(withTestFile: boolean): StepOutput[] {
  return [{
    stepIndex: 0,
    producedContent: 'Updated auth flow',
    affectedFiles: withTestFile ? ['src/auth.ts', 'tests/auth.test.ts'] : ['src/auth.ts'],
    causalDependencies: [],
    baseMemoryChunksUsed: []
  }]
}

describe('contextdb write path', () => {
  it('adds chunks to ContextDB after a successful admission pass', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(true),
      makeVerifierResult('PASS'),
      contextDb
    )

    expect(contextDb.size()).toBeGreaterThan(0)
    expect(contextDb.size()).toBe(5)
  })

  it('admits a TaskChunk', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    expect(contextDb.getAll().some((chunk) => chunk.chunk_type === 'task')).toBe(true)
  })

  it('admits an ApproachChunk', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    expect(contextDb.getAll().some((chunk) => chunk.chunk_type === 'approach')).toBe(true)
  })

  it('admits one SymbolChunk per symbol up to the max of 5', async () => {
    const contextDb = new ContextDB(makeMockClient())
    const symbols = ['a', 'b', 'c', 'd', 'e', 'f']

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(symbols),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    const symbolChunks = contextDb.getAll().filter((chunk) => chunk.chunk_type === 'symbol')
    expect(symbolChunks).toHaveLength(5)
  })

  it('admits TestChunks for detected test files', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(true),
      makeVerifierResult('PASS'),
      contextDb
    )

    const testChunks = contextDb.getAll().filter((chunk) => chunk.chunk_type === 'test')
    expect(testChunks).toHaveLength(1)
    expect(testChunks[0]?.test_file).toBe('tests/auth.test.ts')
  })

  it('never throws even if contextDb.admit throws', async () => {
    const contextDb = {
      admit: vi.fn(async () => {
        throw new Error('admission failed')
      })
    } as unknown as ContextDB

    await expect(admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(true),
      makeVerifierResult('PASS'),
      contextDb
    )).resolves.toBeUndefined()
  })

  it('uses 0.65 memory quality for LOW_CONFIDENCE_PASS', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('LOW_CONFIDENCE_PASS'),
      contextDb
    )

    const taskChunk = contextDb.getAll().find((chunk) => chunk.chunk_type === 'task')
    expect(taskChunk?.memory_quality_score).toBe(0.65)
  })

  it('uses 0.85 memory quality for PASS', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    const taskChunk = contextDb.getAll().find((chunk) => chunk.chunk_type === 'task')
    expect(taskChunk?.memory_quality_score).toBe(0.85)
  })

  it('does not error or admit TestChunks when no test files are present', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket(),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    expect(contextDb.getAll().filter((chunk) => chunk.chunk_type === 'test')).toHaveLength(0)
  })

  it('does not error or admit SymbolChunks when affectedSymbols is empty', async () => {
    const contextDb = new ContextDB(makeMockClient())

    await admitCycleToContextDb(
      makeCycle(),
      makeEnrichedPacket([]),
      makeIntake(),
      makeStepOutputs(false),
      makeVerifierResult('PASS'),
      contextDb
    )

    expect(contextDb.getAll().filter((chunk) => chunk.chunk_type === 'symbol')).toHaveLength(0)
  })
})
