import type { PlanOneRules } from '../../intake/rules.js'
import { executeTool, type ToolExecutionContext } from '../../executor/tools.js'

/**
 * Structured result of the mutation verifier gate.
 */
export interface MutationGateResult {
  passed: boolean
  verdict: 'PASS' | 'LOW_CONFIDENCE_PASS' | 'FAIL' | 'NOT_RUN'
  killRate: number
  mutantsTotal: number
  mutantsKilled: number
  tool: 'stryker' | 'mutpy' | 'cargo-mutants' | 'unknown'
  gateNote: string
}

/**
 * Runs the mutation-testing verifier gate for the affected files.
 */
export async function runMutationGate(
  repoRoot: string,
  affectedFiles: string[],
  _rules: PlanOneRules,
  context: ToolExecutionContext
): Promise<MutationGateResult> {
  const tool = detectMutationTool(affectedFiles)

  if (tool === 'unknown') {
    return buildNotRunResult('Could not determine a mutation tool for the changed files.')
  }

  const command = buildMutationCommand(tool, affectedFiles)

  if (command === null) {
    return buildNotRunResult('Could not build a scoped mutation command.')
  }

  const toolResult = await executeTool('run_command', {
    command,
    cwd: repoRoot,
    timeoutMs: 300_000
  }, {
    ...context,
    repoRoot
  })

  if (toolResult.success === false) {
    return buildNotRunResult(toolResult.error ?? 'Mutation tool unavailable.', tool)
  }

  const parsed = parseMutationOutput(toolResult.output, tool)

  if (parsed === null) {
    return buildNotRunResult('Mutation output could not be parsed.', tool)
  }

  if (parsed.killRate >= 0.8) {
    return {
      passed: true,
      verdict: 'PASS',
      killRate: parsed.killRate,
      mutantsTotal: parsed.mutantsTotal,
      mutantsKilled: parsed.mutantsKilled,
      tool,
      gateNote: 'Mutation kill rate met the pass threshold.'
    }
  }

  if (parsed.killRate >= 0.6) {
    return {
      passed: true,
      verdict: 'LOW_CONFIDENCE_PASS',
      killRate: parsed.killRate,
      mutantsTotal: parsed.mutantsTotal,
      mutantsKilled: parsed.mutantsKilled,
      tool,
      gateNote: 'Mutation kill rate is acceptable but low-confidence.'
    }
  }

  return {
    passed: false,
    verdict: 'FAIL',
    killRate: parsed.killRate,
    mutantsTotal: parsed.mutantsTotal,
    mutantsKilled: parsed.mutantsKilled,
    tool,
    gateNote: 'Mutation kill rate fell below the minimum threshold.'
  }
}

function detectMutationTool(affectedFiles: string[]): MutationGateResult['tool'] {
  const extensions = new Set(affectedFiles.map((filePath) => filePath.split('.').pop() ?? ''))

  if ([...extensions].every((extension) => extension === 'ts' || extension === 'js')) {
    return 'stryker'
  }

  if ([...extensions].every((extension) => extension === 'py')) {
    return 'mutpy'
  }

  if ([...extensions].every((extension) => extension === 'rs')) {
    return 'cargo-mutants'
  }

  return 'unknown'
}

function buildMutationCommand(tool: MutationGateResult['tool'], affectedFiles: string[]): string | null {
  if (tool === 'stryker') {
    return `npx stryker run --files ${affectedFiles.join(',')}`
  }

  if (tool === 'mutpy') {
    return `python -m mutpy --target ${affectedFiles.join(',')} --unit-test tests`
  }

  if (tool === 'cargo-mutants') {
    return `cargo mutants ${affectedFiles.map((filePath) => `--file ${filePath}`).join(' ')}`
  }

  return null
}

function parseMutationOutput(
  output: string,
  tool: MutationGateResult['tool']
): { killRate: number; mutantsTotal: number; mutantsKilled: number } | null {
  if (tool === 'stryker') {
    const match = /Mutation score:\s*([0-9.]+)%/i.exec(output)

    if (match === null) {
      return null
    }

    const killRate = Number(match[1]) / 100
    return {
      killRate,
      mutantsTotal: killRate === 0 ? 0 : 100,
      mutantsKilled: Math.round(killRate * 100)
    }
  }

  if (tool === 'mutpy') {
    const match = /Mutation score operator:\s*([0-9.]+)%/i.exec(output)

    if (match === null) {
      return null
    }

    const killRate = Number(match[1]) / 100
    return {
      killRate,
      mutantsTotal: killRate === 0 ? 0 : 100,
      mutantsKilled: Math.round(killRate * 100)
    }
  }

  if (tool === 'cargo-mutants') {
    const match = /(\d+)\s+caught,\s+(\d+)\s+missed/i.exec(output)

    if (match === null) {
      return null
    }

    const mutantsKilled = Number(match[1])
    const mutantsMissed = Number(match[2])
    const mutantsTotal = mutantsKilled + mutantsMissed
    return {
      killRate: mutantsTotal === 0 ? 0 : mutantsKilled / mutantsTotal,
      mutantsTotal,
      mutantsKilled
    }
  }

  return null
}

function buildNotRunResult(
  gateNote: string,
  tool: MutationGateResult['tool'] = 'unknown'
): MutationGateResult {
  return {
    passed: true,
    verdict: 'NOT_RUN',
    killRate: 0,
    mutantsTotal: 0,
    mutantsKilled: 0,
    tool,
    gateNote
  }
}
