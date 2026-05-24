import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { minimatch } from 'minimatch'

import { callees, symbolInfo } from '../basememory/tools.js'
import type { BaseMemoryClient } from '../basememory/client.js'
import type { PlanOneRules } from '../intake/rules.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { PreActionPlan } from '../pipeline/state-machine.js'
import { logInfo, logWarn } from '../utils/logger.js'
import type { CyclePlan } from '../executor/cycle-plan.js'

/**
 * Supported monitor veto categories.
 */
export type VetoType =
  | 'out_of_scope'
  | 'rules_violation'
  | 'security_concern'
  | 'never_touch_violation'

/**
 * Full input required for a pre-action veto review.
 */
export interface VetoInput {
  cyclePlan?: CyclePlan | PreActionPlan
  preActionPlan?: CyclePlan | PreActionPlan
  currentStep: ExecutionStep
  enrichedPacket: EnrichedPacket
  confirmedFiles: string[]
  preloadedFileContents: Map<string, string>
  rules: PlanOneRules
  repoRoot: string
}

/**
 * Serializable result of a pre-action veto check.
 */
export interface VetoResult {
  vetoed: boolean
  reason: string | null
  vetoType: VetoType | null
  constraintReminder: string | null
}

const SECURITY_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /exec\s*\(|shell\s*\(|spawn\s*\(/i, description: 'Direct shell execution' },
  { pattern: /process\.env\b/i, description: 'Environment variable access' },
  { pattern: /require\s*\(\s*['"`]child_process/i, description: 'Child process import' },
  { pattern: /eval\s*\(/i, description: 'eval() usage' },
  { pattern: /fs\.write.*\/etc\//i, description: 'Write to system directory' }
]

/**
 * Runs the monitor's Phase 1 pre-action veto checks.
 *
 * This function never throws. BaseMemory graph failures degrade to a non-veto
 * result so the executor can continue with other safeguards still active.
 */
export async function checkVeto(
  input: VetoInput,
  client: BaseMemoryClient
): Promise<VetoResult> {
  try {
    const cyclePlan = normalizePlan(input.cyclePlan ?? input.preActionPlan)
    logInfo('monitor:veto', '[Monitor:Veto] Starting pre-action veto review', {
      stepIndex: input.currentStep.stepIndex,
      affectedSymbols: cyclePlan.targetSymbols,
      intendedAction: cyclePlan.intendedAction,
      estimatedRiskLevel: cyclePlan.estimatedRisk
    })
    const scopeResult = await checkScope({ ...input, cyclePlan }, client)

    if (scopeResult !== null) {
      logWarn('monitor:veto', '[Monitor:Veto] Result: vetoed=true', {
        vetoType: scopeResult.vetoType,
        reason: scopeResult.reason
      })
      return scopeResult
    }

    const normalizedAction = cyclePlan.intendedAction.toLowerCase()
    const normalizedReasoning = cyclePlan.reasoning.toLowerCase()

    for (const condition of input.rules.always_escalate_if) {
      const normalizedCondition = condition.toLowerCase()

      if (normalizedAction.includes(normalizedCondition) || normalizedReasoning.includes(normalizedCondition)) {
        return {
          vetoed: true,
          vetoType: 'rules_violation',
          reason: `Action triggers always_escalate_if rule: '${condition}'`,
          constraintReminder: `CONSTRAINT: This task must escalate if: ${condition}`
        }
      }
    }

    for (const symbolReference of cyclePlan.targetSymbols) {
      const filePath = extractFilePath(symbolReference)

      if (filePath === null) {
        continue
      }

      const matchingPattern = input.rules.never_touch.find((pattern) => minimatch(filePath, pattern))

      if (matchingPattern !== undefined) {
        return {
          vetoed: true,
          vetoType: 'never_touch_violation',
          reason: `Action targets file matching never_touch pattern: '${matchingPattern}'`,
          constraintReminder: null
        }
      }
    }

    for (const securityPattern of SECURITY_PATTERNS) {
      if (securityPattern.pattern.test(cyclePlan.intendedAction)) {
        return {
          vetoed: true,
          vetoType: 'security_concern',
          reason: `Action contains security-sensitive pattern: '${securityPattern.description}'`,
          constraintReminder: `SECURITY: Avoid ${securityPattern.description}. Propose an alternative approach.`
        }
      }
    }

    return {
      vetoed: false,
      reason: null,
      vetoType: null,
      constraintReminder: null
    }
  } catch {
    logWarn('monitor:veto', '[Monitor:Veto] BaseMemory failure degraded to allow', {
      stepIndex: input.currentStep.stepIndex
    })
    return {
      vetoed: false,
      reason: null,
      vetoType: null,
      constraintReminder: null
    }
  }
}

async function checkScope(input: VetoInput & { cyclePlan: CyclePlan }, client: BaseMemoryClient): Promise<VetoResult | null> {
  const isContinuousMode = input.currentStep.phaseHint === 'continuous'

  if (input.currentStep.stepIndex === 0 && !isContinuousMode) {
    logInfo('monitor:veto', '[Monitor:Veto] Step 0 skip rule applied', {
      stepIndex: input.currentStep.stepIndex
    })
    return null
  }

  const inScopeSymbols = new Set([
    ...input.currentStep.affectedSymbols,
    ...input.enrichedPacket.affectedSymbols,
    ...input.cyclePlan.allowedScope
  ])

  for (const symbol of input.cyclePlan.targetSymbols) {
    if (!isCodeSymbol(symbol)) {
      logInfo('monitor:veto', `[Monitor:Veto] Skipping non-symbol scope token "${symbol}"`, {
        rule: 'non_code_symbol_skip'
      })
      continue
    }

    if (extractFilePath(symbol) !== null || looksLikeFileReference(symbol)) {
      continue
    }

    logInfo('monitor:veto', `[Monitor:Veto] Checking symbol "${symbol}"`, {
      inAffectedSymbols: inScopeSymbols.has(symbol),
      inStructuredDescription: isNameMentionInScope(symbol, input.enrichedPacket),
      inPlanText: isActionMentionInScope(symbol, input.cyclePlan),
      lowRiskTypeLike: isLowRiskTypeLikeScope(symbol, input.cyclePlan)
    })

    if (inScopeSymbols.has(symbol)) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via affectedSymbols`, {
        rule: 'affected_symbols'
      })
      continue
    }

    if (isNameMentionInScope(symbol, input.enrichedPacket)) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via structured description mention`, {
        rule: 'structured_description_mention'
      })
      continue
    }

    if (isActionMentionInScope(symbol, input.cyclePlan)) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via intendedAction/reasoning mention`, {
        rule: 'plan_text_mention'
      })
      continue
    }

    if (isLowRiskTypeLikeScope(symbol, input.cyclePlan)) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via low-risk type/interface heuristic`, {
        rule: 'low_risk_type_like'
      })
      continue
    }

    const sameFile = await sharesFileWithScope(symbol, [...inScopeSymbols], client)

    if (sameFile) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via same-file rule`, {
        rule: 'same_file'
      })
      continue
    }

    const reachable = await isReachableFromScope(symbol, [...inScopeSymbols], client)

    if (reachable) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via callee reachability`, {
        rule: 'callee_reachable'
      })
      continue
    }

    const confirmedFileScope = await isInConfirmedFileScope(symbol, input, client)

    if (confirmedFileScope) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via confirmed discovery files`, {
        rule: 'confirmed_files'
      })
      continue
    }

    const importedPackageScope = isImportedPackageSymbolInConfirmedFileScope(symbol, input)

    if (importedPackageScope) {
      logInfo('monitor:veto', `[Monitor:Veto] "${symbol}" allowed via imports from confirmed discovery files`, {
        rule: 'confirmed_file_imports'
      })
      continue
    }

    if (reachable === false) {
      logWarn('monitor:veto', `[Monitor:Veto] VETOED symbol "${symbol}"`, {
        reason: 'not in affectedSymbols, not in callees, not in same file, not mentioned in intendedAction, not a low-risk Options type',
        vetoType: 'out_of_scope'
      })
      return {
        vetoed: true,
        vetoType: 'out_of_scope',
        reason: `Action targets symbol '${symbol}' which is outside task scope`,
        constraintReminder: null
      }
    }
  }

  return null
}

export function isCodeSymbol(symbol: string): boolean {
  if (symbol.length < 2) {
    return false
  }

  if (symbol.includes(' ')) {
    return false
  }

  return /^[a-zA-Z_$][a-zA-Z0-9_$.:>\-]*$/.test(symbol)
}

async function isReachableFromScope(
  targetSymbol: string,
  inScopeSymbols: string[],
  client: BaseMemoryClient
): Promise<boolean> {
  try {
    for (const inScopeSymbol of inScopeSymbols) {
      const response = await callees({ symbol: inScopeSymbol, limit: 100 }, client)

      if (response.results.some((entry) => entry.symbol === targetSymbol)) {
        return true
      }
    }
  } catch {
    return true
  }

  return false
}

async function isInConfirmedFileScope(
  symbol: string,
  input: VetoInput & { cyclePlan: CyclePlan },
  client: BaseMemoryClient
): Promise<boolean> {
  if (input.confirmedFiles.length === 0) {
    return false
  }

  const normalizedSymbol = normalizeScopeSymbol(symbol)
  const normalizedPlanText = `${input.cyclePlan.intendedAction}\n${input.cyclePlan.reasoning}`.toLowerCase()

  for (const filePath of input.confirmedFiles) {
    const fileStem = basename(filePath, extname(filePath)).toLowerCase()
    if (normalizedSymbol.toLowerCase().includes(fileStem) || fileStem.includes(normalizedSymbol.toLowerCase())) {
      return true
    }

    if (normalizedPlanText.includes(filePath.toLowerCase())) {
      return true
    }
  }

  for (const filePath of input.confirmedFiles) {
    const content = input.preloadedFileContents.get(filePath)
    if (content?.includes(normalizedSymbol)) {
      return true
    }
  }

  try {
    const targetInfo = await symbolInfo({ symbol: normalizedSymbol, limit: 3 }, client)
    const confirmedFileSet = new Set(input.confirmedFiles.map((filePath) => filePath.toLowerCase()))
    return targetInfo.results.some((entry) => {
      const filePath = getSymbolInfoFilePath(entry)
      if (filePath === undefined) {
        return false
      }

      return confirmedFileSet.has(filePath.toLowerCase())
        || [...confirmedFileSet].some((confirmedFile) => confirmedFile.endsWith(`/${filePath.toLowerCase()}`))
    })
  } catch {
    return false
  }
}

function isImportedPackageSymbolInConfirmedFileScope(symbol: string, input: VetoInput): boolean {
  if (input.confirmedFiles.length === 0) {
    return false
  }

  for (const confirmedFile of input.confirmedFiles) {
    try {
      const content = input.preloadedFileContents.get(confirmedFile)
        ?? readFileSync(resolve(input.repoRoot, confirmedFile), 'utf8')
      const importLines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('import ') || line.startsWith('from '))

      for (const importLine of importLines) {
        if (importLine.includes(symbol)) {
          return true
        }
      }
    } catch {
      continue
    }
  }

  return false
}

async function sharesFileWithScope(
  targetSymbol: string,
  inScopeSymbols: string[],
  client: BaseMemoryClient
): Promise<boolean> {
  try {
    const targetInfo = await symbolInfo({ symbol: targetSymbol, limit: 1 }, client)
    const targetFilePath = getSymbolInfoFilePath(targetInfo.results[0])

    if (targetFilePath === undefined) {
      return false
    }

    for (const inScopeSymbol of inScopeSymbols) {
      const scopeInfo = await symbolInfo({ symbol: inScopeSymbol, limit: 1 }, client)

      if (scopeInfo.results.some((entry) => pathsReferenceSameFile(getSymbolInfoFilePath(entry), targetFilePath))) {
        return true
      }
    }
  } catch {
    return true
  }

  return false
}

function isNameMentionInScope(symbol: string, enrichedPacket: EnrichedPacket): boolean {
  const normalizedSymbol = normalizeScopeSymbol(symbol)

  if (!looksLikeTypeLikeSymbol(normalizedSymbol)) {
    return false
  }

  return enrichedPacket.structuredDescription.includes(normalizedSymbol)
}

function isActionMentionInScope(symbol: string, cyclePlan: CyclePlan): boolean {
  const normalizedSymbol = normalizeScopeSymbol(symbol)
  return cyclePlan.intendedAction.includes(normalizedSymbol) || cyclePlan.reasoning.includes(normalizedSymbol)
}

function isLowRiskTypeLikeScope(symbol: string, cyclePlan: CyclePlan): boolean {
  if (cyclePlan.estimatedRisk === 'high') {
    return false
  }

  return /(?:Options|Config|Props|Input|Output|Params|Type|Interface|Schema)$/i.test(normalizeScopeSymbol(symbol))
}

function normalizePlan(plan: CyclePlan | PreActionPlan | undefined): CyclePlan {
  if (plan === undefined) {
    throw new Error('VetoInput requires cyclePlan')
  }

  if ('targetFiles' in plan && 'targetSymbols' in plan && 'allowedScope' in plan && 'estimatedRisk' in plan) {
    return plan
  }

  return {
    targetFiles: [],
    targetSymbols: plan.affectedSymbols,
    primaryFile: '',
    primarySymbol: plan.affectedSymbols[0] ?? null,
    estimatedRisk: plan.estimatedRiskLevel,
    allowedScope: [],
    intendedAction: plan.intendedAction,
    reasoning: plan.reasoning
  }
}

function looksLikeTypeLikeSymbol(symbol: string): boolean {
  return /^(?:[A-Z][A-Za-z0-9_]*|T[A-Z][A-Za-z0-9_]*)$/.test(symbol)
}

function normalizeScopeSymbol(symbol: string): string {
  return symbol.replace(/<[^>]+>/g, '').trim()
}

function getSymbolInfoFilePath(entry: { file_path?: string; relative_path?: string } | undefined): string | undefined {
  return entry?.file_path ?? entry?.relative_path
}

function pathsReferenceSameFile(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return false
  }

  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function extractFilePath(symbolReference: string): string | null {
  if (looksLikeFileReference(symbolReference)) {
    return symbolReference
  }

  const separatorIndex = symbolReference.indexOf(':')

  if (separatorIndex <= 0) {
    return null
  }

  return symbolReference.slice(0, separatorIndex)
}

function looksLikeFileReference(value: string): boolean {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]+$/.test(value)
}
