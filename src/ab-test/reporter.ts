import Database from 'better-sqlite3'
import { resolve } from 'node:path'

import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { AbMode } from './index.js'

/**
 * Aggregated per-mode A/B statistics derived from the raw trace store.
 */
export interface AbModeStats {
  mode: AbMode
  taskCount: number
  successCount: number
  successRate: number
  verifierRejections: number
  avgStepsPerTask: number
  avgTokensPerTask: number
  avgCostPerTask: number
  escalationCount: number
}

/**
 * Full A/B report emitted by the Week 6 CLI.
 */
export interface AbReport {
  generatedAt: string
  totalTasks: number
  totalCost: number
  modes: AbModeStats[]
  recommendation: string
}

interface TraceRow {
  ab_mode: AbMode
  content_json: string
  tokens_used: number | null
  cost_usd: number | null
}

const ALL_MODES: AbMode[] = ['A', 'B', 'C', 'D']

/**
 * Generates a raw-SQL A/B report from the shared trace SQLite database.
 *
 * This function never throws. Empty or malformed databases degrade to a
 * zero-filled report so the CLI can still render something useful.
 */
export function generateAbReport(rts: RawTraceStore): AbReport {
  const dbPath = getTraceDbPath(rts)
  const blankModes = ALL_MODES.map((mode) => buildEmptyStats(mode))

  let db: Database.Database | null = null

  try {
    db = new Database(dbPath, { readonly: true })

    const taskRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'task_start'
    `).all() as TraceRow[]
    const cycleRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'cycle_end'
    `).all() as TraceRow[]
    const verifierRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'verifier_result'
    `).all() as TraceRow[]
    const escalationRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'ESCALATION'
    `).all() as TraceRow[]
    const budgetRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'budget_check'
    `).all() as TraceRow[]
    const llmRows = db.prepare(`
      SELECT ab_mode, content_json, tokens_used, cost_usd
      FROM trace_events
      WHERE event_type = 'llm_call'
    `).all() as TraceRow[]

    const statsByMode = new Map<AbMode, AbModeStats>(blankModes.map((stats) => [stats.mode, stats]))

    for (const row of taskRows) {
      const stats = statsByMode.get(row.ab_mode)

      if (stats !== undefined) {
        stats.taskCount += 1
      }
    }

    for (const row of cycleRows) {
      const stats = statsByMode.get(row.ab_mode)
      const payload = safeParseJson(row.content_json)

      if (stats === undefined || payload === null || typeof payload !== 'object') {
        continue
      }

      if (payload.outcome === 'success') {
        stats.successCount += 1
      }

      if (payload.plan !== undefined && typeof payload.plan === 'object' && payload.plan !== null) {
        const stepCount = Array.isArray((payload.plan as { steps?: unknown }).steps)
          ? (payload.plan as { steps: unknown[] }).steps.length
          : 0
        stats.avgStepsPerTask += stepCount
      }
    }

    for (const row of verifierRows) {
      const stats = statsByMode.get(row.ab_mode)
      const payload = safeParseJson(row.content_json)

      if (stats === undefined || payload === null || typeof payload !== 'object') {
        continue
      }

      if (payload.verdict === 'FAIL') {
        stats.verifierRejections += 1
      }
    }

    for (const row of escalationRows) {
      const stats = statsByMode.get(row.ab_mode)

      if (stats !== undefined) {
        stats.escalationCount += 1
      }
    }

    for (const row of budgetRows) {
      const stats = statsByMode.get(row.ab_mode)

      if (stats !== undefined) {
        stats.avgTokensPerTask += row.tokens_used ?? 0
      }
    }

    let totalCost = 0

    for (const row of llmRows) {
      const stats = statsByMode.get(row.ab_mode)
      const cost = row.cost_usd ?? 0
      totalCost += cost

      if (stats !== undefined) {
        stats.avgCostPerTask += cost
      }
    }

    const modes = ALL_MODES.map((mode) => finalizeStats(statsByMode.get(mode) ?? buildEmptyStats(mode)))
    const totalTasks = modes.reduce((sum, mode) => sum + mode.taskCount, 0)

    return {
      generatedAt: new Date().toISOString(),
      totalTasks,
      totalCost: Number(totalCost.toFixed(6)),
      modes,
      recommendation: buildRecommendation(modes)
    }
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      totalTasks: 0,
      totalCost: 0,
      modes: blankModes,
      recommendation: 'Insufficient data'
    }
  } finally {
    db?.close()
  }
}

function getTraceDbPath(rts: RawTraceStore): string {
  const maybePath = (rts as unknown as { dbPath?: unknown }).dbPath
  return typeof maybePath === 'string' ? maybePath : resolve(process.cwd(), '.planone/trace.db')
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function buildEmptyStats(mode: AbMode): AbModeStats {
  return {
    mode,
    taskCount: 0,
    successCount: 0,
    successRate: 0,
    verifierRejections: 0,
    avgStepsPerTask: 0,
    avgTokensPerTask: 0,
    avgCostPerTask: 0,
    escalationCount: 0
  }
}

function finalizeStats(stats: AbModeStats): AbModeStats {
  const divisor = stats.taskCount === 0 ? 1 : stats.taskCount

  return {
    ...stats,
    successRate: stats.taskCount === 0 ? 0 : Number((stats.successCount / stats.taskCount).toFixed(4)),
    avgStepsPerTask: Number((stats.avgStepsPerTask / divisor).toFixed(4)),
    avgTokensPerTask: Number((stats.avgTokensPerTask / divisor).toFixed(4)),
    avgCostPerTask: Number((stats.avgCostPerTask / divisor).toFixed(6))
  }
}

function buildRecommendation(modes: AbModeStats[]): string {
  const sorted = [...modes].sort((left, right) => right.successRate - left.successRate)
  const best = sorted[0]
  const second = sorted[1]

  if (best === undefined || second === undefined || Math.abs(best.successRate - second.successRate) <= 0.05) {
    return 'Insufficient data'
  }

  return `Mode ${best.mode} shows highest success rate (${(best.successRate * 100).toFixed(1)}%)`
}
