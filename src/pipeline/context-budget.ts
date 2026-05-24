import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { countTokens } from '../utils/tokens.js'

const DEFAULT_MODEL_LIMIT = 128_000
const SAFETY_MARGIN_MULTIPLIER = 1.05
const BUDGET_CAP_MULTIPLIER = 0.6

export interface BudgetOptions {
  capMultiplier?: number
}

const MODEL_LIMITS: Record<string, number> = {
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3-flash-preview': 1_000_000,
  'gemini-3.1-flash-lite-preview': 1_000_000,
  'gemma-3-27b-it': 128_000
}

/**
 * Permanent anchor set that must always remain in context.
 *
 * These anchors are never evicted and consume the budget before any working
 * content is allowed in the assembled context.
 */
export interface PermanentAnchorSet {
  taskDescription: string
  enrichedPacket: string
  userRepoRules: string
  currentStepDescription: string
}

/**
 * Working content item candidate for transient step context.
 *
 * `tokens` is pre-counted upstream and must not be recomputed during budget
 * assembly. `score` is optional and only used by score-based trimming.
 */
export interface WorkingContentItem {
  chunkId: string
  content: string
  source: 'context_db' | 'basememory' | 'tier2'
  tokens: number
  score?: number
}

/**
 * Full context assembly evaluated by the hard budget enforcer.
 */
export interface ContextAssembly {
  anchors: PermanentAnchorSet
  workingContent: WorkingContentItem[]
}

/**
 * Structured result of a context budget decision.
 *
 * `approved` is the authoritative boolean for whether the assembled context can
 * proceed. `rejectionReason` is present only on hard rejection.
 */
export interface BudgetCheckResult {
  approved: boolean
  permanentTokens: number
  workingTokens: number
  totalTokens: number
  modelLimit: number
  capTokens: number
  utilizationPct: number
  remainingTokens: number
  rejectionReason?: string
}

/**
 * Error thrown when a context assembly exceeds the hard budget cap.
 *
 * The original assembly and structured budget result are attached so callers
 * can log, inspect, and escalate deterministically.
 */
export class BudgetOverflowError extends Error {
  result: BudgetCheckResult
  assembly: ContextAssembly

  /**
   * Creates a hard-failure error for a rejected context assembly.
   */
  constructor(result: BudgetCheckResult, assembly: ContextAssembly) {
    super(result.rejectionReason ?? 'Context budget exceeded.')
    this.name = 'BudgetOverflowError'
    this.result = result
    this.assembly = assembly
  }
}

/**
 * Returns the hard context limit for a model.
 *
 * Unknown models fall back to `128_000` tokens and the function never throws.
 */
export function getModelLimit(model: string): number {
  return MODEL_LIMITS[model.trim().toLowerCase()] ?? DEFAULT_MODEL_LIMIT
}

/**
 * Counts permanent anchor tokens with the mandatory 5% safety margin applied.
 *
 * All anchor fields are concatenated with newlines and tokenized as one block.
 */
export function countAnchorTokens(anchors: PermanentAnchorSet, model: string): number {
  const anchorText = [
    anchors.taskDescription,
    anchors.enrichedPacket,
    anchors.userRepoRules,
    anchors.currentStepDescription
  ].join('\n')

  const rawTokenCount = countTokens(anchorText, model)
  return applySafetyMargin(rawTokenCount)
}

/**
 * Counts working content tokens using pre-counted item token values only.
 *
 * This function never re-tokenizes content strings. It sums the provided token
 * counts and then applies the mandatory 5% safety margin.
 */
export function countWorkingTokens(items: WorkingContentItem[]): number {
  const rawTokenCount = items.reduce((sum, item) => sum + Math.max(0, item.tokens), 0)
  return applySafetyMargin(rawTokenCount)
}

/**
 * Checks whether an assembled context fits within the hard 60% cap.
 *
 * This function never throws. It returns a complete `BudgetCheckResult` with a
 * rejection reason when the assembled context must be blocked.
 */
export function checkBudget(assembly: ContextAssembly, model: string, options: BudgetOptions = {}): BudgetCheckResult {
  const modelLimit = getModelLimit(model)
  const capTokens = Math.floor(modelLimit * (options.capMultiplier ?? BUDGET_CAP_MULTIPLIER))
  const permanentTokens = countAnchorTokens(assembly.anchors, model)
  const workingTokens = countWorkingTokens(assembly.workingContent)
  const totalTokens = permanentTokens + workingTokens
  const approved = totalTokens <= capTokens
  const remainingTokens = capTokens - totalTokens
  const utilizationPct = Number(((totalTokens / modelLimit) * 100).toFixed(4))

  if (approved) {
    return {
      approved,
      permanentTokens,
      workingTokens,
      totalTokens,
      modelLimit,
      capTokens,
      utilizationPct,
      remainingTokens
    }
  }

  const rejectionReason = permanentTokens > capTokens
    ? `Permanent anchors alone consume ${permanentTokens} tokens, exceeding the hard cap of ${capTokens} tokens.`
    : `Assembled context uses ${totalTokens} tokens, exceeding the hard cap of ${capTokens} tokens by ${Math.abs(remainingTokens)} tokens.`

  return {
    approved,
    permanentTokens,
    workingTokens,
    totalTokens,
    modelLimit,
    capTokens,
    utilizationPct,
    remainingTokens,
    rejectionReason
  }
}

/**
 * Enforces the hard budget and throws on overflow.
 *
 * Approved results are returned unchanged. Rejected results always raise a
 * `BudgetOverflowError`, making overflow impossible to ignore.
 */
export function enforceBudget(assembly: ContextAssembly, model: string, options: BudgetOptions = {}): BudgetCheckResult {
  const result = checkBudget(assembly, model, options)

  if (!result.approved) {
    throw new BudgetOverflowError(result, assembly)
  }

  return result
}

/**
 * Alias for the requested Week 2 API spelling.
 *
 * This delegates to `enforceBudget()` and exists so callers can use either
 * spelling without changing the hard-overflow behavior.
 */
export function enforcebudget(assembly: ContextAssembly, model: string, options: BudgetOptions = {}): BudgetCheckResult {
  return enforceBudget(assembly, model, options)
}

/**
 * Logs a budget decision to the raw trace store for every step.
 *
 * Rejections are written as `budget_overflow`; approved checks are written as
 * `budget_check`.
 */
export function logBudgetCheck(
  result: BudgetCheckResult,
  rts: RawTraceStore,
  taskId: string,
  stepIndex: number,
  abMode: AbMode
): void {
  rts.append({
    task_id: taskId,
    ab_mode: abMode,
    agent_role: 'executor',
    step_index: stepIndex,
    event_type: result.approved ? 'budget_check' : 'budget_overflow',
    content_json: JSON.stringify(result),
    tokens_used: result.totalTokens,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

/**
 * Trims working content until the assembled context would pass the hard budget.
 *
 * Permanent anchors are never modified. If anchors alone exceed the cap, an
 * empty array is returned and the caller must escalate instead of trimming.
 */
export function trimWorkingContent(
  items: WorkingContentItem[],
  anchors: PermanentAnchorSet,
  model: string,
  strategy: 'drop_lowest_score' | 'drop_last',
  options: BudgetOptions = {}
): WorkingContentItem[] {
  const workingItems = [...items]

  if (checkBudget({ anchors, workingContent: [] }, model, options).approved === false) {
    return []
  }

  const trimmedItems = strategy === 'drop_lowest_score'
    ? [...workingItems].sort(compareForScoreTrimming)
    : [...workingItems]

  while (trimmedItems.length > 0 && !checkBudget({ anchors, workingContent: trimmedItems }, model, options).approved) {
    if (strategy === 'drop_lowest_score') {
      trimmedItems.shift()
    } else {
      trimmedItems.pop()
    }
  }

  return trimmedItems
}

function applySafetyMargin(rawTokenCount: number): number {
  return Math.ceil(Math.max(0, rawTokenCount) * SAFETY_MARGIN_MULTIPLIER)
}

function compareForScoreTrimming(left: WorkingContentItem, right: WorkingContentItem): number {
  const leftScore = left.score ?? Number.NEGATIVE_INFINITY
  const rightScore = right.score ?? Number.NEGATIVE_INFINITY

  if (leftScore !== rightScore) {
    return leftScore - rightScore
  }

  return left.chunkId.localeCompare(right.chunkId)
}
