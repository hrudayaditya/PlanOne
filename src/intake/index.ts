import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { classifyComplexity, type ComplexityClassification } from './complexity-classifier.js'
import { enhanceTask, type EnhancedTask } from './prompt-enhancer.js'
import { detectRepoContext, type RepoContext } from './repo-context.js'
import { runReproducer, type ReproductionResult } from './reproducer.js'
import { loadRules, type PlanOneRules } from './rules.js'

/**
 * Input payload for the Week 3 intake pipeline.
 */
export interface IntakeInput {
  taskId: string
  rawTask: string
  repoRoot: string
  abMode: AbMode
  rts: RawTraceStore
}

/**
 * Serializable output of the Week 3 intake pipeline.
 */
export interface IntakeResult {
  taskId: string
  abMode: AbMode
  enhancedTask: EnhancedTask
  classification: ComplexityClassification
  rules: PlanOneRules
  repoContext: RepoContext
  reproductionResult?: ReproductionResult
  intakeTimestamp: string
}

/**
 * Runs the Week 3 intake sequence.
 *
 * This function never throws. Failures in subcomponents are converted to safe
 * fallbacks so the rest of the pipeline can continue.
 */
export async function runIntake(input: IntakeInput): Promise<IntakeResult> {
  logInfo('intake', '[Intake] Starting intake', {
    taskId: input.taskId,
    repoRoot: input.repoRoot
  })
  const repoContext = await detectRepoContext(input.repoRoot)
  const reproductionResult = await runReproducer({
    taskId: input.taskId,
    rawTask: input.rawTask,
    repoContext,
    abMode: input.abMode,
    rts: input.rts
  })
  const rules = await loadRules(input.repoRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    logWarn('intake:rules', '[Rules] PLANONE.rules.yaml failed to load — using defaults', {
      error: message,
      repoRoot: input.repoRoot
    })
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'PLANONE.rules.yaml failed to load. Using defaults. test_command will be missing.',
        error: message,
        repoRoot: input.repoRoot
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    return {
      version: '1.0',
      repo_name: input.repoRoot.split('/').pop() ?? 'unknown-repo',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only' as const
    }
  })
  const enhancedTask = await enhanceTask(input.rawTask, repoContext, input.rts, input.abMode, input.taskId)
  const classification = await classifyComplexity(enhancedTask, rules, input.rts, input.abMode, input.taskId)
  const intakeResult = {
    taskId: input.taskId,
    abMode: input.abMode,
    enhancedTask,
    classification,
    rules,
    repoContext,
    reproductionResult,
    intakeTimestamp: new Date().toISOString()
  }
  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'intake',
    step_index: null,
    event_type: 'intake_complete',
    content_json: JSON.stringify({
      enhancedTask,
      classification,
      reproductionResult
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
  logInfo('intake', '[Intake] Intake complete', {
    taskId: input.taskId,
    taskType: enhancedTask.task_type,
    affectedArea: enhancedTask.affected_area,
    complexity: classification.complexity,
    reproductionAttempted: reproductionResult.attempted,
    reproductionSucceeded: reproductionResult.succeeded
  })

  return intakeResult
}
