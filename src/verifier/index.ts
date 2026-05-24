import type { AbMode } from '../ab-test/index.js'
import type { ToolExecutionContext } from '../executor/tools.js'
import type { PlanOneRules } from '../intake/rules.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { ExecutionPlan } from '../orchestrator/plan.js'
import type { StepOutput } from '../pipeline/state-machine.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { computeConfidence, type ConfidenceScore } from './confidence.js'
import { runFunctionalGate, type FunctionalGateResult } from './gates/functional.js'
import { runMutationGate, type MutationGateResult } from './gates/mutation.js'

/**
 * Full verifier input for one execution cycle.
 */
export interface VerifierInput {
  repoRoot: string
  plan: ExecutionPlan
  rules: PlanOneRules
  taskId: string
  abMode: AbMode
  rts: RawTraceStore
  stepOutputs: StepOutput[]
}

/**
 * Structured result of the Phase 1 verifier.
 */
export interface VerifierResult {
  passed: boolean
  confidence: ConfidenceScore
  functionalGate: FunctionalGateResult
  mutationGate: MutationGateResult
  gatesRun: number
  gatesTotal: number
  verdict: 'PASS' | 'FAIL' | 'LOW_CONFIDENCE_PASS'
  verifierModel: string
}

/**
 * Runs the Phase 1 verifier gates in order and logs every result.
 */
export async function runVerifier(
  input: VerifierInput,
  context: ToolExecutionContext
): Promise<VerifierResult> {
  logInfo('verifier', '[Verifier] Running Gate 1 (functional)', {
    taskId: input.taskId,
    repoRoot: input.repoRoot
  })
  const executorProvider = detectProvider(input.plan.assignedExecutorModel)
  const verifierProvider = detectProvider(input.plan.assignedVerifierModel)

  if (executorProvider === verifierProvider) {
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'verifier',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Verifier model provider family matches executor provider family.',
        executorModel: input.plan.assignedExecutorModel,
        verifierModel: input.plan.assignedVerifierModel
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
  }

  const affectedFiles = [...new Set(input.stepOutputs.flatMap((output) => output.affectedFiles))]
  const functionalGate = await runFunctionalGate(input.repoRoot, input.rules, {
    ...context,
    repoRoot: input.repoRoot
  })
  logVerifierGate(input, 1, functionalGate)
  logInfo('verifier', '[Verifier:Gate1] Completed', {
    passed: functionalGate.passed,
    gateNote: functionalGate.gateNote
  })

  logInfo('verifier', '[Verifier] Running Gate 2 (mutation)', {
    affectedFiles
  })
  const mutationGate = await runMutationGate(input.repoRoot, affectedFiles, input.rules, {
    ...context,
    repoRoot: input.repoRoot
  })
  logVerifierGate(input, 2, mutationGate)
  logInfo('verifier', '[Verifier:Gate2] Completed', {
    passed: mutationGate.passed,
    verdict: mutationGate.verdict
  })

  const confidence = computeConfidence(functionalGate, mutationGate)
  const verdict = functionalGate.passed && mutationGate.passed
    ? (mutationGate.verdict === 'LOW_CONFIDENCE_PASS' || mutationGate.verdict === 'NOT_RUN')
      ? 'LOW_CONFIDENCE_PASS'
      : 'PASS'
    : 'FAIL'
  const result: VerifierResult = {
    passed: verdict !== 'FAIL',
    confidence,
    functionalGate,
    mutationGate,
    gatesRun: 2,
    gatesTotal: 7,
    verdict,
    verifierModel: input.plan.assignedVerifierModel
  }

  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'verifier',
    step_index: null,
    event_type: 'verifier_result',
    content_json: JSON.stringify(result),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
  logInfo('verifier', '[Verifier] Verdict', {
    verdict,
    passed: result.passed,
    calibratedConfidence: confidence.calibrated
  })

  return result
}

function logVerifierGate(input: VerifierInput, gate: number, result: unknown): void {
  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'verifier',
    step_index: null,
    event_type: 'verifier_result',
    content_json: JSON.stringify({ gate, result }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

function detectProvider(model: string): 'anthropic' | 'openai' | 'google' | 'unknown' {
  if (model.startsWith('claude-')) {
    return 'anthropic'
  }

  if (model.startsWith('gpt-') || model.startsWith('o1-')) {
    return 'openai'
  }

  if (model.startsWith('gemini-')) {
    return 'google'
  }

  return 'unknown'
}
