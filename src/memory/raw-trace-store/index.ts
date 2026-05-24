import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { z } from 'zod'

import { logError } from '../../utils/logger.js'

/**
 * Supported agent roles for Week 1 trace capture.
 */
export const AgentRoleSchema = z.enum([
  'intake',
  'panel',
  'orchestrator',
  'executor',
  'monitor',
  'verifier',
  'sek',
  'escalation'
])

/**
 * Supported A/B modes stored in the trace database.
 */
export const TraceAbModeSchema = z.enum(['A', 'B', 'C', 'D'])

/**
 * Supported Week 1 event types stored in the trace database.
 */
export const TraceEventTypeSchema = z.enum([
  'task_start',
  'step_start',
  'cycle_start',
  'cycle_end',
  'intake_complete',
  'llm_call',
  'tool_call',
  'tool_execution',
  'step_output',
  'budget_check',
  'veto',
  'monitor_review',
  'sek_scan',
  'verifier_result',
  'ESCALATION',
  'budget_overflow',
  'tier2_flush',
  'error'
])

/**
 * Append-only trace event schema persisted in SQLite.
 */
export const TraceEventSchema = z.object({
  task_id: z.string().min(1),
  ab_mode: TraceAbModeSchema,
  agent_role: AgentRoleSchema,
  step_index: z.number().int().nullable(),
  event_type: TraceEventTypeSchema,
  content_json: z.string(),
  tokens_used: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  created_at: z.string().datetime({ offset: true })
})

/**
 * Trace event TypeScript type inferred from the zod schema.
 */
export type TraceEvent = z.infer<typeof TraceEventSchema>

const TraceRowSchema = TraceEventSchema.extend({
  id: z.number().int()
})

const TraceRowsSchema = z.array(TraceRowSchema)

type TraceRow = z.infer<typeof TraceRowSchema>

/**
 * Synchronous, append-only SQLite store for raw execution trace events.
 *
 * `append()` is intentionally best-effort and never throws. Losing a trace
 * event is acceptable; crashing the pipeline is not.
 */
export class RawTraceStore {
  private readonly db: Database.Database
  private readonly dbPath: string

  /**
   * Creates or opens the Week 1 trace database at `.planone/trace.db`.
   */
  constructor(dbPath = resolve(process.cwd(), '.planone/trace.db')) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ab_mode TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        step_index INTEGER,
        event_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        tokens_used INTEGER,
        cost_usd REAL,
        created_at TEXT NOT NULL
      )
    `)
  }

  /**
   * Appends a trace event synchronously and never throws.
   *
   * Invalid payloads are logged to stderr and ignored so the pipeline can
   * continue running even if trace capture is partially degraded.
   */
  append(event: TraceEvent): void {
    try {
      const parsedEvent = TraceEventSchema.parse(event)
      const statement = this.db.prepare(`
        INSERT INTO trace_events (
          task_id,
          ab_mode,
          agent_role,
          step_index,
          event_type,
          content_json,
          tokens_used,
          cost_usd,
          created_at
        ) VALUES (
          @task_id,
          @ab_mode,
          @agent_role,
          @step_index,
          @event_type,
          @content_json,
          @tokens_used,
          @cost_usd,
          @created_at
        )
      `)

      statement.run(parsedEvent)
    } catch (error) {
      logError('raw-trace-store', 'Failed to append trace event.', {
        dbPath: this.dbPath,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Returns all events for a task in insertion order.
   */
  query(taskId: string): TraceEvent[] {
    return this.mapRows(`
      SELECT id, task_id, ab_mode, agent_role, step_index, event_type, content_json, tokens_used, cost_usd, created_at
      FROM trace_events
      WHERE task_id = ?
      ORDER BY id ASC
    `, [taskId])
  }

  /**
   * Returns recent events filtered by event type in reverse insertion order.
   */
  queryByType(eventType: string, limit = 100): TraceEvent[] {
    return this.mapRows(`
      SELECT id, task_id, ab_mode, agent_role, step_index, event_type, content_json, tokens_used, cost_usd, created_at
      FROM trace_events
      WHERE event_type = ?
      ORDER BY id DESC
      LIMIT ?
    `, [eventType, limit])
  }

  /**
   * Returns all events tagged with the requested immutable A/B mode.
   */
  queryByAbMode(mode: string): TraceEvent[] {
    return this.mapRows(`
      SELECT id, task_id, ab_mode, agent_role, step_index, event_type, content_json, tokens_used, cost_usd, created_at
      FROM trace_events
      WHERE ab_mode = ?
      ORDER BY id ASC
    `, [mode])
  }

  /**
   * Closes the underlying SQLite connection.
   */
  close(): void {
    this.db.close()
  }

  private mapRows(sql: string, params: unknown[]): TraceEvent[] {
    const statement = this.db.prepare(sql)
    const rows = statement.all(...params)
    const parsedRows = TraceRowsSchema.parse(rows)

    return parsedRows.map(({ id: _id, ...event }: TraceRow) => event)
  }
}
