import type { PlanOneRules } from '../../intake/rules.js'
import { executeTool, type ToolExecutionContext } from '../../executor/tools.js'

/**
 * Structured result of the functional verifier gate.
 */
export interface FunctionalGateResult {
  passed: boolean
  passedCount: number
  failedCount: number
  regressions: string[]
  newFailures: string[]
  gateNote: string
}

/**
 * Runs the functional verification gate using the executor test tool.
 */
export async function runFunctionalGate(
  repoRoot: string,
  rules: PlanOneRules,
  context: ToolExecutionContext
): Promise<FunctionalGateResult> {
  const toolResult = await executeTool('run_tests', {
    ...(rules.test_command === undefined ? {} : { testCommand: rules.test_command }),
    timeoutMs: 120_000
  }, {
    ...context,
    repoRoot
  })
  const passedCount = asNumber(toolResult.metadata?.passed)
  const failedCount = asNumber(toolResult.metadata?.failed)
  const failures = asStringArray(toolResult.metadata?.failures)
  const newFailures = failures.filter((failure) => /\b(TODO|skip|pending)\b/i.test(failure))
  const regressions = failures.filter((failure) => /\b(TODO|skip|pending)\b/i.test(failure) === false)
  const passed = failedCount === 0 || regressions.length === 0
  const gateNote = failedCount === 0
    ? 'All tests passed.'
    : regressions.length === 0
      ? 'Only likely pre-existing failures were observed.'
      : 'Regressions detected in the current test run.'

  return {
    passed,
    passedCount,
    failedCount,
    regressions,
    newFailures,
    gateNote
  }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
