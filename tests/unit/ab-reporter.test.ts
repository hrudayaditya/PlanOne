import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { TraceEvent } from '../../src/memory/raw-trace-store/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { generateAbReport } from '../../src/ab-test/reporter.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-ab-report-'))
  const store = new RawTraceStore(join(directory, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function appendEvent(store: RawTraceStore, event: Partial<TraceEvent> & Pick<TraceEvent, 'task_id' | 'ab_mode' | 'agent_role' | 'event_type' | 'content_json'>): void {
  store.append({
    step_index: null,
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString(),
    ...event
  })
}

describe('ab reporter', () => {
  it('returns an empty report when the store has no events', () => {
    const { store, cleanup } = makeStore()

    try {
      const report = generateAbReport(store)
      expect(report.totalTasks).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('returns entries for all 4 modes', () => {
    const { store, cleanup } = makeStore()

    try {
      const report = generateAbReport(store)
      expect(report.modes.map((mode) => mode.mode)).toEqual(['A', 'B', 'C', 'D'])
    } finally {
      cleanup()
    }
  })

  it('computes success rate correctly from task_start and cycle_end events', () => {
    const { store, cleanup } = makeStore()

    try {
      appendEvent(store, {
        task_id: 'task-a-1',
        ab_mode: 'A',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-a-2',
        ab_mode: 'A',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-a-1',
        ab_mode: 'A',
        agent_role: 'executor',
        event_type: 'cycle_end',
        content_json: JSON.stringify({ outcome: 'success', plan: { steps: [{}, {}] } })
      })

      const report = generateAbReport(store)
      const modeA = report.modes.find((mode) => mode.mode === 'A')
      expect(modeA?.successRate).toBe(0.5)
    } finally {
      cleanup()
    }
  })

  it('returns Insufficient data when success rates are within 5%', () => {
    const { store, cleanup } = makeStore()

    try {
      appendEvent(store, {
        task_id: 'task-a-1',
        ab_mode: 'A',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-a-2',
        ab_mode: 'A',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-b-1',
        ab_mode: 'B',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-a-1',
        ab_mode: 'A',
        agent_role: 'executor',
        event_type: 'cycle_end',
        content_json: JSON.stringify({ outcome: 'success', plan: { steps: [{}] } })
      })
      appendEvent(store, {
        task_id: 'task-b-2',
        ab_mode: 'B',
        agent_role: 'intake',
        event_type: 'task_start',
        content_json: '{}'
      })
      appendEvent(store, {
        task_id: 'task-b-1',
        ab_mode: 'B',
        agent_role: 'executor',
        event_type: 'cycle_end',
        content_json: JSON.stringify({ outcome: 'success', plan: { steps: [{}] } })
      })

      const report = generateAbReport(store)
      expect(report.recommendation).toBe('Insufficient data')
    } finally {
      cleanup()
    }
  })

  it('never throws on empty or malformed databases', () => {
    const { store, cleanup } = makeStore()

    try {
      appendEvent(store, {
        task_id: 'task-1',
        ab_mode: 'A',
        agent_role: 'verifier',
        event_type: 'verifier_result',
        content_json: '{not-json'
      })

      expect(() => generateAbReport(store)).not.toThrow()
    } finally {
      cleanup()
    }
  })
})
