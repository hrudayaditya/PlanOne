import { z } from 'zod'

import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { RepoContext } from './repo-context.js'
import { calculateCost } from '../utils/cost.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { withLlmTranscriptContext } from '../utils/llm-transcript.js'
import { countTokens } from '../utils/tokens.js'
import { DEFAULT_INTAKE_MODEL, DEFAULT_INTAKE_PREFERRED_MODELS } from '../llm/models.js'
import { getIntakeLlmProvider, parseJsonResponse, withTimeout } from './llm.js'

export const PROMPT_ENHANCER_TIMEOUT_MS = 30_000

/**
 * Structured enhanced task output produced at intake.
 */
export const EnhancedTaskSchema = z.object({
  original: z.string(),
  structured_description: z.string(),
  task_type: z.enum(['bug_fix', 'feature', 'refactor', 'test', 'documentation', 'unknown']),
  affected_area: z.string(),
  likely_files: z.array(z.string()),
  symptom_vs_root_cause: z.string(),
  complexity_hint: z.enum(['trivial', 'moderate', 'complex']),
  confidence: z.number().min(0).max(1)
})

/**
 * Enhanced task TypeScript type inferred from zod.
 */
export type EnhancedTask = z.infer<typeof EnhancedTaskSchema>

/**
 * Enhances raw task text into a structured intake object.
 *
 * This function never throws. On timeout or provider failure it returns a safe
 * passthrough task and logs the failure for later inspection.
 */
export async function enhanceTask(
  rawTask: string,
  repoContext: RepoContext,
  rts: RawTraceStore,
  abMode: AbMode,
  taskId = 'intake:unknown'
): Promise<EnhancedTask> {
  const prompt = buildEnhancerPrompt(rawTask, repoContext)
  const inputTokens = countTokens(prompt, DEFAULT_INTAKE_MODEL)
  const startedAt = Date.now()

  try {
    const provider = getIntakeLlmProvider()
    logInfo('intake:enhancer', '[Intake:Enhancer] Calling intake model', {
      taskId,
      preferredModels: DEFAULT_INTAKE_PREFERRED_MODELS,
      attempt: '1/1'
    })
    const response = await withLlmTranscriptContext(
      {
        taskId,
        stage: 'intake:prompt_enhancer'
      },
      async () => await withTimeout(
        provider.generateJson(prompt, [...DEFAULT_INTAKE_PREFERRED_MODELS]),
        PROMPT_ENHANCER_TIMEOUT_MS
      )
    )
    const enhancedTask = parseJsonResponse(response.text, EnhancedTaskSchema)
    const outputTokens = countTokens(response.text, response.model)

    logIntakeLlmCall(rts, {
      taskId,
      abMode,
      operation: 'prompt_enhancer',
      model: response.model,
      inputTokens,
      outputTokens,
      success: true
    })
    logInfo('intake:enhancer', '[Intake:Enhancer] Response received', {
      taskId,
      model: response.model,
      durationMs: Date.now() - startedAt,
      taskType: enhancedTask.task_type,
      affectedArea: enhancedTask.affected_area
    })

    return enhancedTask
  } catch (error) {
    logError('prompt-enhancer', 'Prompt enhancement failed; using passthrough task.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      taskId
    })

    const fallbackTask = buildPassthroughEnhancedTask(rawTask)

    logIntakeLlmCall(rts, {
      taskId,
      abMode,
      operation: 'prompt_enhancer',
      model: 'unavailable',
      inputTokens,
      outputTokens: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    logWarn('intake:enhancer', '[Intake:Enhancer] FALLBACK — model unavailable or returned invalid JSON', {
      taskId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    return fallbackTask
  }
}

/**
 * Shared intake LLM call logger for Raw Trace Store integration.
 */
export function logIntakeLlmCall(
  rts: RawTraceStore,
  details: {
    taskId: string
    abMode: AbMode
    operation: string
    model: string
    inputTokens: number
    outputTokens: number
    success: boolean
    error?: string
  }
): void {
  const cost = calculateCost(details.model, details.inputTokens, details.outputTokens)

  rts.append({
    task_id: details.taskId,
    ab_mode: details.abMode,
    agent_role: 'intake',
    step_index: null,
    event_type: 'llm_call',
    content_json: JSON.stringify(details),
    tokens_used: details.inputTokens + details.outputTokens,
    cost_usd: cost,
    created_at: new Date().toISOString()
  })
}

function buildEnhancerPrompt(rawTask: string, repoContext: RepoContext): string {
  return [
    'IMPORTANT: Respond with ONLY a JSON object. No markdown. No code fences.',
    'No explanation before or after. The first character of your response must be { and the last character must be }.',
    'You are enhancing a software task into a structured JSON object.',
    'Return only valid JSON matching this schema:',
    JSON.stringify(z.toJSONSchema(EnhancedTaskSchema)),
    'Repository context:',
    JSON.stringify(repoContext, null, 2),
    'Raw task:',
    rawTask,
    'Rules:',
    '- Preserve the original text verbatim in original.',
    '- Make structured_description clear and concrete.',
    '- likely_files should be guesses only, not verified facts.',
    '- confidence must be between 0.0 and 1.0.',
    'IMPORTANT: Respond with ONLY a JSON object. No markdown. No code fences.',
    'No explanation before or after. The first character of your response must be { and the last character must be }.'
  ].join('\n')
}

function buildPassthroughEnhancedTask(rawTask: string): EnhancedTask {
  return {
    original: rawTask,
    structured_description: rawTask,
    task_type: 'unknown',
    affected_area: '',
    likely_files: [],
    symptom_vs_root_cause: '',
    complexity_hint: 'complex',
    confidence: 0
  }
}
