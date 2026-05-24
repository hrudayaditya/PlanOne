import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildEscalationPackage, EscalationRequired } from '../../src/escalation/index.js'
import type { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import type { IntakeResult } from '../../src/intake/index.js'
import type { PanelOutput } from '../../src/panel/index.js'
import type { ExecutionPlan } from '../../src/orchestrator/plan.js'
import type { ExecutorResult } from '../../src/executor/index.js'
import { DEFAULT_EXECUTOR_MODEL, DEFAULT_VERIFIER_MODEL } from '../../src/llm/models.js'

const createClientMock = vi.fn()
const indexHealthCheckMock = vi.fn()
const createProvidersMock = vi.fn()
const runIntakeMock = vi.fn()
const runPanelMock = vi.fn()
const buildExecutionPlanMock = vi.fn()
const runExecutorMock = vi.fn()

vi.mock('../../src/basememory/client.js', () => ({
  createClient: createClientMock
}))

vi.mock('../../src/basememory/tools.js', () => ({
  indexHealthCheck: indexHealthCheckMock
}))

vi.mock('../../src/llm/router.js', () => ({
  createProviders: createProvidersMock
}))

vi.mock('../../src/intake/index.js', () => ({
  runIntake: runIntakeMock
}))

vi.mock('../../src/panel/index.js', () => ({
  runPanel: runPanelMock
}))

vi.mock('../../src/orchestrator/index.js', () => ({
  buildExecutionPlan: buildExecutionPlanMock
}))

vi.mock('../../src/executor/index.js', () => ({
  runExecutor: runExecutorMock
}))

describe('pipeline integration', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns a full PipelineResult shape', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockResolvedValue({
      disconnect: vi.fn()
    })
    indexHealthCheckMock.mockResolvedValue({ healthy: true })
    createProvidersMock.mockReturnValue({
      intakeProvider: { generateJson: vi.fn() },
      panelProvider: { analyze: vi.fn() },
      executorProvider: { generatePreActionPlan: vi.fn(), callWithTools: vi.fn() },
      verifierProvider: { analyze: vi.fn() },
      compressionProvider: { distill: vi.fn() }
    })
    runIntakeMock.mockResolvedValue(makeIntake())
    runPanelMock.mockResolvedValue(makePanelOutput())
    buildExecutionPlanMock.mockResolvedValue(makePlan())
    runExecutorMock.mockResolvedValue(makeExecutorResult('success', ['src/auth.ts']))
    const result = await runPipeline({
      taskId: 'task-1',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 10
    })

    expect(result.taskId).toBe('task-1')
    expect(result.enrichedPacket).not.toBeNull()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(buildExecutionPlanMock).toHaveBeenCalledWith(expect.objectContaining({
      executorModel: DEFAULT_EXECUTOR_MODEL,
      verifierModel: DEFAULT_VERIFIER_MODEL
    }))
  })

  it('returns error on BaseMemory connection failure instead of throwing', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockRejectedValue(new Error('connect failed'))

    const result = await runPipeline({
      taskId: 'task-2',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 1
    })

    expect(result.outcome).toBe('error')
  })

  it('returns escalated when EscalationRequired is thrown internally', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockResolvedValue({
      disconnect: vi.fn()
    })
    indexHealthCheckMock.mockResolvedValue({ healthy: true })
    createProvidersMock.mockReturnValue({
      intakeProvider: { generateJson: vi.fn() },
      panelProvider: { analyze: vi.fn() },
      executorProvider: { generatePreActionPlan: vi.fn(), callWithTools: vi.fn() },
      verifierProvider: { analyze: vi.fn() },
      compressionProvider: { distill: vi.fn() }
    })
    runIntakeMock.mockResolvedValue(makeIntake())
    runPanelMock.mockResolvedValue(makePanelOutput())
    buildExecutionPlanMock.mockImplementation(() => {
      throw new EscalationRequired(buildEscalationPackage(
        'retry_exhaustion',
        'task-3',
        'fix auth',
        {
          enriched_packet: null,
          execution_history: [],
          suggested_actions: []
        }
      ))
    })

    const result = await runPipeline({
      taskId: 'task-3',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 1
    })

    expect(result.outcome).toBe('escalated')
  })

  it('assigns and returns an abMode', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockResolvedValue({
      disconnect: vi.fn()
    })
    indexHealthCheckMock.mockResolvedValue({ healthy: true })
    createProvidersMock.mockReturnValue({
      intakeProvider: { generateJson: vi.fn() },
      panelProvider: { analyze: vi.fn() },
      executorProvider: { generatePreActionPlan: vi.fn(), callWithTools: vi.fn() },
      verifierProvider: { analyze: vi.fn() },
      compressionProvider: { distill: vi.fn() }
    })
    runIntakeMock.mockResolvedValue(makeIntake())
    runPanelMock.mockResolvedValue(makePanelOutput())
    buildExecutionPlanMock.mockResolvedValue(makePlan())
    runExecutorMock.mockResolvedValue(makeExecutorResult('all_cycles_exhausted'))

    const result = await runPipeline({
      taskId: 'task-4',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 20
    })

    expect(result.abMode).toBe('C')
  })

  it('returns a JSON-serializable PipelineResult', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockResolvedValue({
      disconnect: vi.fn()
    })
    indexHealthCheckMock.mockResolvedValue({ healthy: true })
    createProvidersMock.mockReturnValue({
      intakeProvider: { generateJson: vi.fn() },
      panelProvider: { analyze: vi.fn() },
      executorProvider: { generatePreActionPlan: vi.fn(), callWithTools: vi.fn() },
      verifierProvider: { analyze: vi.fn() },
      compressionProvider: { distill: vi.fn() }
    })
    runIntakeMock.mockResolvedValue(makeIntake())
    runPanelMock.mockResolvedValue(makePanelOutput())
    buildExecutionPlanMock.mockResolvedValue(makePlan())
    runExecutorMock.mockResolvedValue(makeExecutorResult('success', ['src/auth.ts']))
    const result = await runPipeline({
      taskId: 'task-5',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 1
    })

    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('does not report success when executor changed zero files', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js')
    createClientMock.mockResolvedValue({
      disconnect: vi.fn()
    })
    indexHealthCheckMock.mockResolvedValue({ healthy: true })
    createProvidersMock.mockReturnValue({
      intakeProvider: { generateJson: vi.fn() },
      panelProvider: { analyze: vi.fn() },
      executorProvider: { generatePreActionPlan: vi.fn(), callWithTools: vi.fn() },
      verifierProvider: { analyze: vi.fn() },
      compressionProvider: { distill: vi.fn() }
    })
    runIntakeMock.mockResolvedValue(makeIntake())
    runPanelMock.mockResolvedValue(makePanelOutput())
    buildExecutionPlanMock.mockResolvedValue(makePlan())
    runExecutorMock.mockResolvedValue(makeExecutorResult('success'))

    const result = await runPipeline({
      taskId: 'task-6',
      rawTask: 'fix auth',
      config: {
        repoRoot: '/tmp/repo',
        providerConfig: {}
      },
      taskSequenceNumber: 1
    })

    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toMatch(/without changing any files/i)
  })
})

function makeIntake(): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'fix auth',
      structured_description: 'fix auth',
      task_type: 'bug_fix',
      affected_area: 'auth',
      likely_files: [],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.8,
      rationale: 'reason',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'repo',
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

function makePanelOutput(): PanelOutput {
  return {
    enrichedPacket: {
      taskId: 'task-1',
      originalTask: 'fix auth',
      structuredDescription: 'fix auth',
      taskType: 'bug_fix',
      affectedArea: 'auth',
      affectedSymbols: ['validateToken'],
      primaryRootCause: 'bug',
      alternativeRootCauses: [],
      rankedApproaches: [{
        approach: 'Patch auth path',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [],
        estimatedRisk: 'medium'
      }],
      identifiedRisks: [],
      activeConstraints: [],
      memberCount: 1,
      consensusConfidence: 0.8,
      verifiedChunkIds: [],
      rules: makeIntake().rules,
      synthesizedAt: new Date().toISOString()
    },
    memberAnalyses: [],
    citationResults: [],
    panelDurationMs: 10
  }
}

function makePlan(): ExecutionPlan {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    approach: 'Patch auth path',
    approachRank: 1,
    steps: [],
    assignedExecutorModel: DEFAULT_EXECUTOR_MODEL,
    assignedVerifierModel: DEFAULT_VERIFIER_MODEL,
    estimatedStepCount: 0,
    createdAt: new Date().toISOString()
  }
}

function makeExecutorResult(outcome: ExecutorResult['outcome'], affectedFiles: string[] = []): ExecutorResult {
  return {
    outcome,
    completedCycles: [],
    finalStepOutputs: affectedFiles.length === 0 ? [] : [{
      stepIndex: 1,
      producedContent: 'patched auth flow',
      affectedFiles,
      causalDependencies: [],
      baseMemoryChunksUsed: [],
      completedAt: new Date().toISOString()
    }],
    totalTokensUsed: 10,
    totalCostUsd: 0.1,
    verifierResult: outcome === 'success' ? makeVerifierResult() : null
  }
}

function makeVerifierResult() {
  return {
    passed: true,
    confidence: {
      raw: 0.9,
      calibrated: 0.9,
      calibrationMethod: 'identity'
    },
    functionalGate: {
      passed: true,
      passedCount: 1,
      failedCount: 0,
      regressions: [],
      newFailures: [],
      gateNote: 'ok'
    },
    mutationGate: {
      passed: true,
      verdict: 'NOT_RUN',
      killRate: 0,
      mutantsTotal: 0,
      mutantsKilled: 0,
      tool: 'unknown',
      gateNote: 'ok'
    },
    gatesRun: 2,
    gatesTotal: 7,
    verdict: 'LOW_CONFIDENCE_PASS',
    verifierModel: 'gemini-3.1-flash-lite-preview'
  }
}
