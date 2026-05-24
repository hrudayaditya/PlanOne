import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { resolveAffectedFiles, type StepExecutionResult } from '../../src/executor/step.js'
import type { ExecutorLlmProvider } from '../../src/executor/step.js'
import type { CompressionLlmProvider } from '../../src/executor/compression.js'
import type { IntakeResult } from '../../src/intake/index.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'
import type { ExecutionPlan } from '../../src/orchestrator/plan.js'
import type { StepOutput } from '../../src/pipeline/state-machine.js'
import type { VerifierResult } from '../../src/verifier/index.js'

const { executeStepMock, runVerifierMock } = vi.hoisted(() => ({
  executeStepMock: vi.fn<(...args: any[]) => Promise<StepExecutionResult>>(),
  runVerifierMock: vi.fn<(...args: any[]) => Promise<VerifierResult>>()
}))

vi.mock('../../src/executor/step.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/step.js')>('../../src/executor/step.js')
  return {
    ...actual,
    executeStep: executeStepMock
  }
})

vi.mock('../../src/verifier/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/verifier/index.js')>('../../src/verifier/index.js')
  return {
    ...actual,
    runVerifier: runVerifierMock
  }
})

function makeGitRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-convergence-'))
  writeFileSync(join(root, 'target.ts'), 'export function LoginService() { return 1 }\n')
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'planone@example.com'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'PlanOne Tests'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['add', 'target.ts'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makePlan(): ExecutionPlan {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    approach: 'Patch auth branch',
    approachRank: 1,
    steps: [
      {
        stepIndex: 0,
        description: 'Understand and locate the relevant code',
        approach: 'Patch auth branch',
        affectedSymbols: ['LoginService'],
        affectedFiles: ['target.ts'],
        estimatedRisk: 'low',
        dependsOn: [],
        isCheckpoint: false
      },
      {
        stepIndex: 1,
        description: 'Implement the fix in target.ts',
        approach: 'Patch auth branch',
        affectedSymbols: ['LoginService'],
        affectedFiles: ['target.ts'],
        estimatedRisk: 'low',
        dependsOn: [],
        isCheckpoint: false
      }
    ],
    assignedExecutorModel: 'z-ai/glm-5.1',
    assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
    estimatedStepCount: 2,
    createdAt: new Date().toISOString()
  }
}

function makeIntake(): IntakeResult {
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
      confidence: 0.8,
      rationale: 'multi-step',
      estimated_steps: 2,
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
      repoRoot: '/tmp/repo',
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

function makeEnrichedPacket(): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Fix auth bug',
    structuredDescription: 'Fix auth bug',
    taskType: 'bug_fix',
    affectedArea: 'authentication',
    affectedSymbols: ['LoginService'],
    primaryRootCause: 'The implementation in target.ts needs to change',
    alternativeRootCauses: [],
    rankedApproaches: [{
      rank: 1,
      approach: 'Update the implementation in target.ts',
      rationale: 'Best path',
      supportingChunkIds: []
    }],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.8,
    verifiedChunkIds: ['target.ts:1-1'],
    rules: makeIntake().rules,
    synthesizedAt: new Date().toISOString(),
    citationVerificationDegraded: false
  }
}

function makeClient(): BaseMemoryClient {
  return {
    callTool: async () => ({ structuredContent: { results: [], total: 0, cursor: null, expandedContext: [], symbols: [], ambiguous: false } })
  } as unknown as BaseMemoryClient
}

function makeVerifierResult(): VerifierResult {
  return {
    passed: true,
    confidence: 'high',
    functionalGate: { passed: true, gateNote: 'ok', command: null, output: '' },
    mutationGate: { passed: true, verdict: 'PASS', gateNote: 'ok', tool: 'git_diff', command: null, output: '' },
    gatesRun: 2,
    gatesTotal: 7,
    verdict: 'PASS',
    verifierModel: 'gemini-3.1-flash-lite-preview'
  }
}

describe('executor convergence', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('merges repoChangedFiles into affectedFiles even when surfaceConfirmedFiles is non-empty', () => {
    expect(resolveAffectedFiles(['surface.ts'], ['written.ts'], ['fallback.ts'])).toEqual(['surface.ts', 'written.ts'])
  })

  it('never returns empty affectedFiles when repoChangedFiles has entries', () => {
    expect(resolveAffectedFiles([], ['written.ts'], [])).toEqual(['written.ts'])
  })

  it('runs the verifier when the repo changed during cycle 1 even if step output affectedFiles are empty', async () => {
    const { runExecutor } = await import('../../src/executor/index.js')
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))

    executeStepMock
      .mockImplementationOnce(async () => ({
        outcome: 'success',
        stepOutput: {
          stepIndex: 0,
          producedContent: 'confirmed discovery',
          affectedFiles: ['target.ts'],
          causalDependencies: [],
          baseMemoryChunksUsed: []
        },
        monitorInterventions: 0,
        vetoReason: null,
        tokensUsed: 0,
        costUsd: 0,
        writeCount: 0,
        testsPassed: false,
        typeCheckPassed: false
      }))
      .mockImplementationOnce(async () => {
        writeFileSync(join(root, 'target.ts'), 'export function LoginService() { return 2 }\n')
        return {
          outcome: 'success',
          stepOutput: {
            stepIndex: 1,
            producedContent: 'implemented',
            affectedFiles: [],
            causalDependencies: [],
            baseMemoryChunksUsed: []
          },
          monitorInterventions: 0,
          vetoReason: null,
          tokensUsed: 0,
          costUsd: 0,
          writeCount: 1,
          testsPassed: true,
          typeCheckPassed: false
        }
      })

    runVerifierMock.mockResolvedValue(makeVerifierResult())

    try {
      const result = await runExecutor(
        {
          plan: makePlan(),
          enrichedPacket: makeEnrichedPacket(),
          intake: makeIntake(),
          contextDb: new ContextDB(makeClient()),
          client: makeClient(),
          rts: store,
          repoRoot: root
        },
        {} as ExecutorLlmProvider,
        { distill: async (content: string) => content } as CompressionLlmProvider
      )

      expect(runVerifierMock).toHaveBeenCalledTimes(1)
      expect(result.outcome).toBe('success')
    } finally {
      store.close()
      cleanup()
    }
  })
})
