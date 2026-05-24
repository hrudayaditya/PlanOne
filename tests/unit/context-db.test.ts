import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'

function makeMockClient(): BaseMemoryClient {
  return {
    callTool: async (name: string) => {
      if (name === 'symbol_info') {
        return { structuredContent: { results: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, cursor: undefined } }
      }
      return { structuredContent: { results: [], total: 0, cursor: undefined } }
    }
  } as unknown as BaseMemoryClient
}

function makeChunk(): ContextChunk {
  return {
    chunk_id: '123e4567-e89b-12d3-a456-426614174000',
    chunk_type: 'symbol',
    task_id_origin: 'task-1',
    repo: 'planone',
    created_at: new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
    memory_quality_score: 0.9,
    symbols: ['AuthService'],
    base_memory_snapshot: { chunk_ids: ['chunk-1'], symbol_ids: ['sym-1'], call_graph_hash: '' },
    invalid_if: [{ type: 'age_exceeded', max_age_days: 999, description: 'old' }],
    symbol_name: 'AuthService',
    symbol_id: 'sym-1',
    file_path: 'src/auth.ts',
    kind: 'class',
    approach_notes: 'works',
    test_coverage: []
  }
}

describe('context-db', () => {
  it('query returns fallback empty result when store is empty', async () => {
    const db = new ContextDB(makeMockClient())
    const result = await db.query({
      queryText: 'auth',
      currentRepo: 'planone',
      symbols: ['AuthService'],
      chunkTypes: ['symbol'],
      abMode: 'B',
      limit: 5
    })
    expect(result.tier_used).toBe('fallback')
    expect(result.chunks).toEqual([])
  })

  it('admit adds to store when all checks pass', async () => {
    const db = new ContextDB(makeMockClient())
    const decision = await db.admit(makeChunk(), true)
    expect(decision.admitted).toBe(true)
    expect(db.size()).toBe(1)
  })

  it('admit rejects when verifier is not approved', async () => {
    const db = new ContextDB(makeMockClient())
    const decision = await db.admit(makeChunk(), false)
    expect(decision.admitted).toBe(false)
    expect(db.size()).toBe(0)
  })

  it('validate returns GateResult for an existing chunk', async () => {
    const db = new ContextDB(makeMockClient())
    await db.admit(makeChunk(), true)
    const result = await db.validate(makeChunk().chunk_id)
    expect(result?.chunk_id).toBe(makeChunk().chunk_id)
  })

  it('validate returns null for a missing chunk id', async () => {
    const db = new ContextDB(makeMockClient())
    expect(await db.validate('missing')).toBeNull()
  })

  it('size returns the correct count after admits', async () => {
    const db = new ContextDB(makeMockClient())
    await db.admit(makeChunk(), true)
    expect(db.size()).toBe(1)
  })

  it('mode A query returns bypassed true with empty chunks', async () => {
    const db = new ContextDB(makeMockClient())
    await db.admit(makeChunk(), true)
    const result = await db.query({
      queryText: 'auth',
      currentRepo: 'planone',
      symbols: ['AuthService'],
      chunkTypes: ['symbol'],
      abMode: 'A',
      limit: 5
    })
    expect(result.bypassed).toBe(true)
    expect(result.chunks).toEqual([])
  })
})
