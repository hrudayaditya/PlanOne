import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { AbMode } from '../ab-test/index.js'
import { OpenRouterProvider } from '../llm/openrouter.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { getIntakeLlmProvider } from './llm.js'
import type { RepoContext } from './repo-context.js'

const REPRODUCTION_MODELS = ['gemini-2.5-flash', 'google/gemini-2.5-flash', 'gpt-4o-mini']
const REPRODUCER_TIMEOUT_MS = 30_000
const REPRODUCTION_MAX_RETRIES = 2
const REPRODUCTION_INITIAL_RETRY_MS = 1_500

export interface ReproductionResult {
  attempted: boolean
  succeeded: boolean
  traceback: string | null
  output: string | null
  reproducerCode: string | null
  executionTimeMs: number
}

export async function runReproducer(input: {
  taskId: string
  rawTask: string
  repoContext: RepoContext
  abMode: AbMode
  rts: { append(entry: Record<string, unknown>): void }
}): Promise<ReproductionResult> {
  appendReproducerTrace(input, 'reproducer_entry', {
    language: input.repoContext.language,
    hasRuntime: resolveRuntime(input.repoContext) !== null,
    hasGenerateText: getIntakeLlmProvider().generateText !== undefined
  })

  const runtime = resolveRuntime(input.repoContext)
  if (runtime === null) {
    appendReproducerTrace(input, 'reproducer_exit_runtime_unavailable', {
      language: input.repoContext.language
    })
    return emptyResult(false)
  }

  const provider = getIntakeLlmProvider()
  if (provider.generateText === undefined) {
    appendReproducerTrace(input, 'reproducer_exit_generate_text_unavailable', {
      runtime: runtime.command
    })
    return emptyResult(false)
  }

  const textProvider: { generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> } = {
    generateText: provider.generateText!
  }

  const prompt = [
    'Given this GitHub issue, write a minimal repository-local Python/TypeScript/language script that FAILS when the bug is present.',
    '',
    'Return ONLY the script code. No explanation. No markdown fences.',
    'If no runnable reproducer can be extracted, return exactly: NO_REPRODUCER',
    '',
    'Requirements:',
    '- The script must exit non-zero on the buggy behavior.',
    '- Prefer asserting the expected behavior so the script fails clearly when the bug is still present.',
    '- If the issue describes plain example code, translate it into a repository-level reproducer using this repository\'s own APIs when needed.',
    '- If the repository bug is about inference or analysis, exercise the repository code path directly instead of restating plain language semantics.',
    '- Keep the script minimal and self-contained.',
    '',
    'Issue:',
    input.rawTask
  ].join('\n')

  const llmStartedAt = Date.now()
  let reproducerCode: string

  try {
    const response = await generateReproducerText(input, textProvider, prompt)
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'intake',
      step_index: null,
      event_type: 'llm_call',
      content_json: JSON.stringify({
        operation: 'reproduction_extract',
        model: response.model
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    reproducerCode = prepareReproducerCode(sanitizeReproducerCode(response.text), input)
  } catch (error) {
    logWarn('intake:reproducer', '[Reproducer] Failed to extract reproducer; skipping', {
      error: error instanceof Error ? error.message : String(error),
      taskId: input.taskId
    })
    appendReproducerTrace(input, 'reproducer_exit_extract_error', {
      error: error instanceof Error ? error.message : String(error)
    })
    return emptyResult(false)
  }

  if (reproducerCode === 'NO_REPRODUCER' || !looksLikeCode(reproducerCode)) {
    appendReproducerTrace(input, 'reproducer_exit_no_reproducer', {
      looksLikeCode: looksLikeCode(reproducerCode),
      responsePreview: reproducerCode.slice(0, 120)
    })
    return emptyResult(false)
  }

  const tempFile = join(
    input.repoContext.repoRoot,
    `.planone_reproducer_${input.taskId}${runtime.extension}`
  )

  try {
    writeFileSync(tempFile, reproducerCode, 'utf8')
  } catch (error) {
    logWarn('intake:reproducer', '[Reproducer] Failed to write reproducer; skipping', {
      error: error instanceof Error ? error.message : String(error),
      taskId: input.taskId
    })
    appendReproducerTrace(input, 'reproducer_exit_write_failed', {
      path: tempFile,
      error: error instanceof Error ? error.message : String(error)
    })
    return emptyResult(false)
  }

  const startedAt = Date.now()

  try {
    const output = execFileSync(runtime.command, [...runtime.args, tempFile], {
      cwd: input.repoContext.repoRoot,
      encoding: 'utf8',
      timeout: REPRODUCER_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    appendReproducerTrace(input, 'reproducer_exit_success', {
      runtime: runtime.command,
      hadOutput: output.trim().length > 0
    })
    return {
      attempted: true,
      succeeded: true,
      traceback: null,
      output: output.trim().length > 0 ? output.trim() : null,
      reproducerCode,
      executionTimeMs: Date.now() - startedAt
    }
  } catch (error) {
    const executionTimeMs = Date.now() - startedAt
    const failure = parseExecutionFailure(error)

    if (failure.kind === 'timeout') {
      logWarn('intake:reproducer', '[Reproducer] Timed out; skipping reproduction signal', {
        taskId: input.taskId,
        timeoutMs: REPRODUCER_TIMEOUT_MS
      })
      appendReproducerTrace(input, 'reproducer_exit_timeout', {
        timeoutMs: REPRODUCER_TIMEOUT_MS,
        runtime: runtime.command
      })
      return emptyResult(true)
    }

    if (failure.kind === 'runtime_error') {
      appendReproducerTrace(input, 'reproducer_exit_runtime_error', {
        runtime: runtime.command,
        hadTraceback: failure.text !== null
      })
      return {
        attempted: true,
        succeeded: true,
        traceback: failure.text,
        output: failure.stdout,
        reproducerCode,
        executionTimeMs
      }
    }

    appendReproducerTrace(input, 'reproducer_exit_run_failure', {
      runtime: runtime.command,
      errorPreview: failure.text?.slice(0, 160) ?? null
    })
    return {
      attempted: true,
      succeeded: false,
      traceback: null,
      output: failure.text ?? null,
      reproducerCode,
      executionTimeMs
    }
  } finally {
    rmSync(tempFile, { force: true })
    logInfo('intake:reproducer', '[Reproducer] Reproducer attempt finished', {
      taskId: input.taskId,
      runtime: runtime.command,
      extractDurationMs: Date.now() - llmStartedAt
    })
  }
}

function appendReproducerTrace(
  input: {
    taskId: string
    abMode: AbMode
    rts: { append(entry: Record<string, unknown>): void }
  },
  operation: string,
  details: Record<string, unknown>
): void {
  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'intake',
    step_index: null,
    event_type: operation === 'reproducer_entry' ? 'task_start' : 'step_output',
    content_json: JSON.stringify({
      operation,
      ...details
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

function emptyResult(attempted: boolean): ReproductionResult {
  return {
    attempted,
    succeeded: false,
    traceback: null,
    output: null,
    reproducerCode: null,
    executionTimeMs: 0
  }
}

function sanitizeReproducerCode(text: string): string {
  const trimmed = text.trim()
  if (trimmed === 'NO_REPRODUCER') {
    return trimmed
  }

  return trimmed.replace(/^```[a-zA-Z0-9_-]*\n/, '').replace(/\n```$/, '').trim()
}

function prepareReproducerCode(
  code: string,
  input: {
    repoContext: RepoContext
    taskId: string
    abMode: AbMode
    rts: { append(entry: Record<string, unknown>): void }
  }
): string {
  if (code === 'NO_REPRODUCER') {
    return code
  }

  if (input.repoContext.language !== 'python') {
    return code
  }

  const augmented = augmentPythonReproducerForFailureSignal(code)
  if (augmented !== code) {
    appendReproducerTrace(input, 'reproducer_script_augmented', {
      language: input.repoContext.language,
      strategy: 'trailing_expression_assertions'
    })
  }

  return augmented
}

function augmentPythonReproducerForFailureSignal(code: string): string {
  if (/\bassert\b|self\.assert|pytest\.raises|\braise\b/.test(code)) {
    return code
  }

  const lines = code.split('\n')
  let end = lines.length - 1
  while (end >= 0 && lines[end]?.trim().length === 0) {
    end -= 1
  }

  if (end < 0) {
    return code
  }

  const expressionIndexes: number[] = []
  for (let index = end; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      if (expressionIndexes.length === 0) {
        continue
      }
      break
    }

    if (!isTopLevelPythonExpressionLine(line)) {
      break
    }

    expressionIndexes.unshift(index)
  }

  if (expressionIndexes.length < 2) {
    return code
  }

  const expressions = expressionIndexes.map((index) => (lines[index] ?? '').trim())
  const replacement = buildPythonAssertionBlock(expressions)
  const nextLines = [
    ...lines.slice(0, expressionIndexes[0]),
    ...replacement,
    ...lines.slice(end + 1)
  ]

  return nextLines.join('\n').trim()
}

function isTopLevelPythonExpressionLine(line: string): boolean {
  if (/^\s/.test(line)) {
    return false
  }

  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('@')) {
    return false
  }

  if (/^(class|def|import|from|if|elif|else|for|while|try|except|finally|with|return|assert|raise|pass|break|continue|yield)\b/.test(trimmed)) {
    return false
  }

  if (/(?<![=!<>])=(?!=)/.test(trimmed)) {
    return false
  }

  return true
}

function buildPythonAssertionBlock(expressions: string[]): string[] {
  const lines: string[] = []

  expressions.forEach((expression, index) => {
    lines.push(`__planone_observed_${index} = ${expression}`)
  })

  const referenceExpression = expressions[0] ?? '<expr0>'
  for (let index = 1; index < expressions.length; index += 1) {
    const expression = expressions[index] ?? `<expr${index}>`
    lines.push(
      `assert __planone_observed_${index} == __planone_observed_0, (`,
      `    "PlanOne reproducer mismatch:\\n"`,
      '    f"' + escapeForPythonAssertion(referenceExpression) + ' -> {__planone_observed_0!r}\\n"',
      '    f"' + escapeForPythonAssertion(expression) + ` -> {__planone_observed_${index}!r}"`,
      `)`
    )
  }

  return lines
}

function escapeForPythonAssertion(expression: string): string {
  return expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function looksLikeCode(text: string): boolean {
  if (text.length === 0 || /\bNO_REPRODUCER\b/.test(text)) {
    return false
  }

  if (text.includes('```')) {
    return false
  }

  return /(?:\bclass\b|\bdef\b|\bimport\b|\bfrom\b|\bconsole\.log\b|\bfunction\b|=>|print\(|assert\b)/.test(text)
}

function resolveRuntime(repoContext: RepoContext): {
  command: string
  args: string[]
  extension: string
} | null {
  if (repoContext.language === 'python') {
    return {
      command: repoContext.pythonBinary ?? 'python3',
      args: [],
      extension: '.py'
    }
  }

  if (repoContext.language === 'javascript') {
    return {
      command: 'node',
      args: [],
      extension: '.js'
    }
  }

  if (repoContext.language === 'typescript') {
    return {
      command: 'node',
      args: [],
      extension: '.js'
    }
  }

  return null
}

function parseExecutionFailure(error: unknown): {
  kind: 'timeout' | 'runtime_error' | 'run_failure'
  text: string | null
  stdout: string | null
} {
  if (!(error instanceof Error)) {
    return { kind: 'run_failure', text: null, stdout: null }
  }

  const failure = error as Error & {
    signal?: string
    stdout?: string | Buffer
    stderr?: string | Buffer
  }

  if (failure.signal === 'SIGTERM') {
    return { kind: 'timeout', text: null, stdout: null }
  }

  const stdout = normalizeCapturedOutput(failure.stdout)
  const stderr = normalizeCapturedOutput(failure.stderr)
  const combined = [stderr, stdout].filter((value): value is string => value !== null && value.length > 0).join('\n').trim()
  const syntaxOrImportFailure = combined.includes('SyntaxError') || combined.includes('ModuleNotFoundError') || combined.includes('ImportError')

  if (syntaxOrImportFailure) {
    return {
      kind: 'run_failure',
      text: combined.length > 0 ? combined : error.message,
      stdout
    }
  }

  return {
    kind: 'runtime_error',
    text: combined.length > 0 ? combined : error.message,
    stdout
  }
}

async function generateReproducerText(
  input: {
    taskId: string
    abMode: AbMode
    rts: { append(entry: Record<string, unknown>): void }
  },
  provider: { generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> },
  prompt: string
): Promise<{ model: string; text: string }> {
  const plans: Array<{
    provider: { generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> }
    models: string[]
    providerHint: string
  }> = [
    {
      provider,
      models: REPRODUCTION_MODELS,
      providerHint: provider.constructor?.name ?? 'PrimaryProvider'
    }
  ]

  const openrouterApiKey = process.env.OPENROUTER_API_KEY
  if (openrouterApiKey !== undefined && openrouterApiKey.length > 0) {
    plans.push({
      provider: new OpenRouterProvider({
        apiKey: openrouterApiKey,
        path: 'paid',
        modelId: 'google/gemini-2.5-flash'
      }),
      models: ['google/gemini-2.5-flash', 'gpt-4o-mini'],
      providerHint: 'OpenRouterProvider'
    })
  }

  let lastError: unknown = null

  for (const [planIndex, plan] of plans.entries()) {
    for (let attempt = 1; attempt <= REPRODUCTION_MAX_RETRIES; attempt += 1) {
      try {
        return await plan.provider.generateText(prompt, plan.models)
      } catch (error) {
        lastError = error
        const retryable = isRetryableReproducerError(error)
        const willRetrySameProvider = retryable && attempt < REPRODUCTION_MAX_RETRIES
        const willTryFallbackProvider = !willRetrySameProvider && planIndex < plans.length - 1

        appendReproducerTrace(input, 'reproduction_extract_attempt_failed', {
          providerHint: plan.providerHint,
          models: plan.models,
          attempt,
          retryable,
          willRetrySameProvider,
          willTryFallbackProvider,
          error: error instanceof Error ? error.message : String(error)
        })

        if (willRetrySameProvider) {
          const delayMs = REPRODUCTION_INITIAL_RETRY_MS * 2 ** (attempt - 1)
          appendReproducerTrace(input, 'reproduction_extract_retry_scheduled', {
            providerHint: plan.providerHint,
            nextAttempt: attempt + 1,
            delayMs
          })
          await sleep(delayMs)
          continue
        }

        if (willTryFallbackProvider) {
          appendReproducerTrace(input, 'reproduction_extract_provider_fallback', {
            fromProvider: plan.providerHint,
            toProvider: plans[planIndex + 1]?.providerHint ?? 'unknown'
          })
          break
        }

        throw error
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Reproducer extraction failed.')
}

function isRetryableReproducerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b5\d\d\b/.test(message)
    || /\b429\b/.test(message)
    || /too many requests/i.test(message)
    || /quota exceeded/i.test(message)
    || /rate.?limit/i.test(message)
    || /retrydelay/i.test(message)
    || /resource exhausted/i.test(message)
    || /service unavailable/i.test(message)
    || /temporarily unavailable/i.test(message)
}

function normalizeCapturedOutput(value: string | Buffer | undefined): string | null {
  if (value === undefined) {
    return null
  }

  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : null
  }

  const text = value.toString('utf8').trim()
  return text.length > 0 ? text : null
}

export function inferReproducerExtension(repoContext: RepoContext): string | null {
  const runtime = resolveRuntime(repoContext)
  return runtime?.extension ?? null
}

export function reproductionFileName(taskId: string, repoContext: RepoContext): string | null {
  const extension = inferReproducerExtension(repoContext)
  if (extension === null) {
    return null
  }

  return `.planone_reproducer_${taskId}${extension}`
}

export function isRuntimeScriptPath(filePath: string): boolean {
  return ['.py', '.js', '.ts'].includes(extname(filePath))
}
