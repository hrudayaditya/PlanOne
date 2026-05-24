import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { logInfo } from '../utils/logger.js'
import { scanDiff, type DiffPolicyViolation } from './diff-policy.js'
import { classifyInjection, type InjectionPattern } from './injection-classifier.js'

/**
 * Shared SEK execution context used by all checks.
 */
export interface SekContext {
  taskId: string
  stepIndex: number
  rts: RawTraceStore
  abMode: AbMode
}

/**
 * Structured output of a SEK check.
 */
export interface SekCheckResult {
  approved: boolean
  violations: DiffPolicyViolation[]
  injectionPatterns: InjectionPattern[]
  blockedTools: string[]
}

/**
 * Runs the pre-write injection screen for generated content.
 */
export async function checkBeforeWrite(
  content: string,
  filePath: string,
  context: SekContext
): Promise<SekCheckResult> {
  const scanResult = classifyInjection(content)
  const result: SekCheckResult = {
    approved: scanResult.clean,
    violations: [],
    injectionPatterns: scanResult.patterns,
    blockedTools: scanResult.clean ? [] : [filePath]
  }

  logSekResult('before_write', result, context)
  return result
}

/**
 * Runs the post-diff SEK policy scan.
 */
export async function checkAfterDiff(
  diff: string,
  context: SekContext
): Promise<SekCheckResult> {
  const violations = scanDiff(diff, '', '')
  const result: SekCheckResult = {
    approved: violations.every((violation) => violation.severity !== 'block'),
    violations,
    injectionPatterns: [],
    blockedTools: []
  }

  logSekResult('after_diff', result, context)
  return result
}

/**
 * Runs the post-command-output SEK policy scan.
 */
export async function checkCommandOutput(
  command: string,
  stdout: string,
  stderr: string,
  context: SekContext
): Promise<SekCheckResult> {
  const violations = scanDiff('', command, `${stdout}\n${stderr}`)
  const result: SekCheckResult = {
    approved: violations.every((violation) => violation.severity !== 'block'),
    violations,
    injectionPatterns: [],
    blockedTools: []
  }

  logSekResult('command_output', result, context)
  return result
}

function logSekResult(checkType: string, result: SekCheckResult, context: SekContext): void {
  logInfo('sek', `[SEK] ${checkType}`, {
    approved: result.approved,
    violations: result.violations.map((violation) => ({
      severity: violation.severity,
      description: violation.description
    })),
    injectionPatterns: result.injectionPatterns.map((pattern) => pattern.type)
  })
  context.rts.append({
    task_id: context.taskId,
    ab_mode: context.abMode,
    agent_role: 'sek',
    step_index: context.stepIndex,
    event_type: 'sek_scan',
    content_json: JSON.stringify({
      checkType,
      approved: result.approved,
      violations: result.violations,
      injectionPatterns: result.injectionPatterns
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}
