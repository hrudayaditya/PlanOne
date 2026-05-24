import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RawTraceStore, type TraceEvent } from '../../src/memory/raw-trace-store/index.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-rts-'))
  const dbPath = join(directory, 'trace.db')
  const store = new RawTraceStore(dbPath)

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function makeEvent(taskId: string, eventType: TraceEvent['event_type'], abMode: TraceEvent['ab_mode']): TraceEvent {
  return {
    task_id: taskId,
    ab_mode: abMode,
    agent_role: 'intake',
    step_index: null,
    event_type: eventType,
    content_json: JSON.stringify({ taskId, eventType, abMode }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  }
}

describe('RawTraceStore', () => {
  it('append is synchronous', () => {
    const { store, cleanup } = makeStore()

    try {
      store.append(makeEvent('task-1', 'task_start', 'B'))
      const events = store.query('task-1')
      expect(events).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('append never throws even for malformed data', () => {
    const { store, cleanup } = makeStore()

    try {
      expect(() => {
        store.append({
          task_id: '',
          ab_mode: 'not-a-mode' as TraceEvent['ab_mode'],
          agent_role: 'intake',
          step_index: null,
          event_type: 'task_start',
          content_json: 'not-json',
          tokens_used: null,
          cost_usd: null,
          created_at: 'invalid-date'
        })
      }).not.toThrow()
    } finally {
      cleanup()
    }
  })

  it('query returns events in insertion order', () => {
    const { store, cleanup } = makeStore()

    try {
      store.append(makeEvent('task-2', 'task_start', 'B'))
      store.append(makeEvent('task-2', 'tool_call', 'B'))
      store.append(makeEvent('task-2', 'step_output', 'B'))

      expect(store.query('task-2').map((event) => event.event_type)).toEqual([
        'task_start',
        'tool_call',
        'step_output'
      ])
    } finally {
      cleanup()
    }
  })

  it('queryByAbMode filters correctly', () => {
    const { store, cleanup } = makeStore()

    try {
      store.append(makeEvent('task-3', 'task_start', 'A'))
      store.append(makeEvent('task-4', 'task_start', 'B'))
      store.append(makeEvent('task-5', 'task_start', 'A'))

      expect(store.queryByAbMode('A').map((event) => event.task_id)).toEqual(['task-3', 'task-5'])
    } finally {
      cleanup()
    }
  })

  it('persists multiple appends in sequence', () => {
    const { store, cleanup } = makeStore()

    try {
      for (let index = 0; index < 5; index += 1) {
        store.append(makeEvent(`task-seq-${index}`, 'task_start', 'B'))
      }

      expect(store.queryByAbMode('B')).toHaveLength(5)
    } finally {
      cleanup()
    }
  })
})
