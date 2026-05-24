import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import {
  EscalationPackageSchema,
  EscalationRequired,
  buildEscalationPackage,
  escalate
} from '../../src/escalation/index.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-escalation-'))
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

describe('escalation', () => {
  it('throws EscalationRequired from escalate()', () => {
    const { store, cleanup } = makeStore()

    try {
      const pkg = buildEscalationPackage('retry_exhaustion', 'task-1', 'Fix the bug', {
        enriched_packet: { severity: 'high' },
        execution_history: [],
        memory_contradictions_detected: [],
        suggested_actions: ['Ask for human review']
      })

      expect(() => escalate(pkg, store, 'B')).toThrow(EscalationRequired)
    } finally {
      cleanup()
    }
  })

  it('writes the raw trace store entry before the throw', () => {
    const { store, cleanup } = makeStore()

    try {
      const pkg = buildEscalationPackage('retry_exhaustion', 'task-2', 'Implement feature', {
        enriched_packet: { stage: 'orchestrator' },
        execution_history: [],
        memory_contradictions_detected: [],
        suggested_actions: ['Escalate']
      })

      try {
        escalate(pkg, store, 'A')
      } catch (error) {
        expect(error).toBeInstanceOf(EscalationRequired)
      }

      const events = store.query('task-2')
      expect(events).toHaveLength(1)
      expect(events[0]?.event_type).toBe('ESCALATION')
    } finally {
      cleanup()
    }
  })

  it('produces unique valid UUID escalation ids', () => {
    const first = buildEscalationPackage('retry_exhaustion', 'task-3', 'Task one', {
      enriched_packet: null,
      execution_history: [],
      memory_contradictions_detected: [],
      suggested_actions: []
    })
    const second = buildEscalationPackage('retry_exhaustion', 'task-4', 'Task two', {
      enriched_packet: null,
      execution_history: [],
      memory_contradictions_detected: [],
      suggested_actions: []
    })

    expect(first.escalation_id).not.toBe(second.escalation_id)
    expect(() => EscalationPackageSchema.parse(first)).not.toThrow()
    expect(() => EscalationPackageSchema.parse(second)).not.toThrow()
  })

  it('stores content_json that parses back to the original escalation package', () => {
    const { store, cleanup } = makeStore()

    try {
      const pkg = buildEscalationPackage('retry_exhaustion', 'task-5', 'Investigate failure', {
        enriched_packet: { signal: 'conflict' },
        execution_history: [],
        memory_contradictions_detected: [],
        suggested_actions: ['Page operator']
      })

      try {
        escalate(pkg, store, 'D')
      } catch {
        // Expected for the test.
      }

      const storedEvent = store.query('task-5')[0]
      const EscalationJsonSchema = z.string().transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid JSON payload.'
          })
          return z.NEVER
        }
      }).pipe(EscalationPackageSchema)
      const parsedPackage = EscalationJsonSchema.parse(storedEvent!.content_json)
      expect(parsedPackage).toEqual(pkg)
    } finally {
      cleanup()
    }
  })
})
