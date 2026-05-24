import { z } from 'zod'

import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { DEFAULT_INTAKE_MODEL, DEFAULT_INTAKE_PREFERRED_MODELS } from '../llm/models.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { withLlmTranscriptContext } from '../utils/llm-transcript.js'
import { countTokens } from '../utils/tokens.js'
import type { PlanOneRules } from './rules.js'
import type { EnhancedTask } from './prompt-enhancer.js'
import { getIntakeLlmProvider, parseJsonResponse, withTimeout } from './llm.js'
import { logIntakeLlmCall } from './prompt-enhancer.js'

export const COMPLEXITY_CLASSIFIER_TIMEOUT_MS = 30_000

/**
 * Structured result of the intake complexity classifier.
 */
export const ComplexityClassificationSchema = z.object({
  complexity: z.enum(['TRIVIAL', 'COMPLEX']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  estimated_steps: z.number().int().nonnegative(),
  risk_flags: z.array(z.string())
})

/**
 * Complexity classification type inferred from zod.
 */
export type ComplexityClassification = z.infer<typeof ComplexityClassificationSchema>

/**
 * Classifies whether a task is trivial or complex for planning purposes.
 *
 * This function never throws. Rule matches force `COMPLEX`, and provider
 * failures return a safe complex fallback classification.
 */
export async function classifyComplexity(
  task: EnhancedTask,
  rules: PlanOneRules,
  rts: RawTraceStore,
  abMode: AbMode,
  taskId = 'intake:unknown'
): Promise<ComplexityClassification> {
  const forcedMatches = rules.always_escalate_if.filter((condition) => matchesEscalationCondition(task, condition))

  if (forcedMatches.length > 0) {
    const forcedResult: ComplexityClassification = {
      complexity: 'COMPLEX',
      confidence: 1,
      rationale: 'Repository escalation rule matched the intake task.',
      estimated_steps: Math.max(3, forcedMatches.length + 2),
      risk_flags: forcedMatches
    }

    logIntakeLlmCall(rts, {
      taskId,
      abMode,
      operation: 'complexity_classifier',
      model: 'rule_override',
      inputTokens: 0,
      outputTokens: 0,
      success: true
    })

    return forcedResult
  }

  const prompt = buildClassifierPrompt(task, rules)
  const inputTokens = countTokens(prompt, DEFAULT_INTAKE_MODEL)
  const startedAt = Date.now()

  try {
    const provider = getIntakeLlmProvider()
    logInfo('intake:classifier', '[Intake:Classifier] Calling intake model', {
      taskId,
      preferredModels: DEFAULT_INTAKE_PREFERRED_MODELS,
      attempt: '1/1'
    })
    const response = await withLlmTranscriptContext(
      {
        taskId,
        stage: 'intake:complexity_classifier'
      },
      async () => await withTimeout(
        provider.generateJson(prompt, [...DEFAULT_INTAKE_PREFERRED_MODELS]),
        COMPLEXITY_CLASSIFIER_TIMEOUT_MS
      )
    )
    const classification = parseJsonResponse(response.text, ComplexityClassificationSchema)
    const outputTokens = countTokens(response.text, response.model)

    logIntakeLlmCall(rts, {
      taskId,
      abMode,
      operation: 'complexity_classifier',
      model: response.model,
      inputTokens,
      outputTokens,
      success: true
    })
    logInfo('intake:classifier', '[Intake:Classifier] Response received', {
      taskId,
      model: response.model,
      durationMs: Date.now() - startedAt,
      complexity: classification.complexity,
      confidence: classification.confidence
    })

    return classification
  } catch (error) {
    logError('complexity-classifier', 'Complexity classification failed; using safe fallback.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      taskId
    })

    const fallbackClassification: ComplexityClassification = {
      complexity: 'COMPLEX',
      confidence: 0,
      rationale: 'classifier unavailable',
      estimated_steps: 3,
      risk_flags: []
    }

    logIntakeLlmCall(rts, {
      taskId,
      abMode,
      operation: 'complexity_classifier',
      model: 'unavailable',
      inputTokens,
      outputTokens: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    logWarn('intake:classifier', '[Intake:Classifier] FALLBACK — model unavailable or returned invalid JSON', {
      taskId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    return fallbackClassification
  }
}

function buildClassifierPrompt(task: EnhancedTask, rules: PlanOneRules): string {
  return [
    'IMPORTANT: Respond with ONLY a JSON object. No markdown. No code fences.',
    'No explanation before or after. The first character of your response must be { and the last character must be }.',
    'Classify the following engineering task as TRIVIAL or COMPLEX.',
    'Return only valid JSON matching this schema:',
    JSON.stringify(z.toJSONSchema(ComplexityClassificationSchema)),
    'Enhanced task:',
    JSON.stringify(task, null, 2),
    'Repository rules:',
    JSON.stringify(rules, null, 2),
    'Guidance:',
    '- Use COMPLEX when multiple files, risky domains, or unclear root causes are involved.',
    '- Keep estimated_steps realistic but rough.',
    '- risk_flags should mention concrete risks.',
    'IMPORTANT: Respond with ONLY a JSON object. No markdown. No code fences.',
    'No explanation before or after. The first character of your response must be { and the last character must be }.'
  ].join('\n')
}

function matchesEscalationCondition(task: EnhancedTask, condition: string): boolean {
  const normalizedCondition = normalizeText(condition)
  const normalizedTask = normalizeText([
    task.original,
    task.structured_description,
    task.affected_area,
    task.symptom_vs_root_cause
  ].join(' '))

  if (normalizedTask.includes(normalizedCondition)) {
    return true
  }

  const conditionWords = normalizedCondition
    .split(' ')
    .filter((word) => word.length >= 4)

  return conditionWords.length > 0 && conditionWords.every((word) => normalizedTask.includes(word))
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
