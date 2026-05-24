import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { runMemoryUseGate } from '../../src/memory/context-db/memory-use-gate.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'

function makeMockClient(responder: (name: string, args: Record<string, unknown>) => Record<string, unknown>): BaseMemoryClient {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => ({
      structuredContent: responder(name, args)
    })
  } as unknown as BaseMemoryClient
}

function makeChunk(overrides: Partial<ContextChunk> = {}): ContextChunk {
  return {
    chunk_id: '123e4567-e89b-12d3-a456-426614174000',
    chunk_type: 'symbol',
    task_id_origin: 'task-1',
    repo: 'planone',
    created_at: new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
    memory_quality_score: 0.9,
    symbols: ['AuthService'],
    base_memory_snapshot: {
      chunk_ids: ['chunk-1'],
      symbol_ids: ['sym-1'],
      call_graph_hash: ''
    },
    invalid_if: [{ type: 'call_graph_changed', description: 'Graph changed.' }],
    symbol_name: 'AuthService',
    symbol_id: 'sym-1',
    file_path: 'src/auth.ts',
    kind: 'class',
    approach_notes: 'worked',
    test_coverage: [],
    ...overrides
  }
}

describe('memory use gate', () => {
  it('returns QUARANTINE when all symbols are missing', async () => {
    const client = makeMockClient((name) => (
      name === 'symbol_info'
        ? { symbols: [], total: 0, ambiguous: false }
        : { results: [], total: 0, cursor: undefined }
    ))
    const result = await runMemoryUseGate(makeChunk(), client)
    expect(result.verdict).toBe('QUARANTINE')
  })

  it('returns ACTIVE when all symbols are present with low divergence and high quality', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      invalid_if: [{ type: 'age_exceeded', max_age_days: 999, description: 'Eventually old.' }]
    }), client)
    expect(result.verdict).toBe('ACTIVE')
  })

  it('returns DOWNRANK when some symbols are missing but quality is high', async () => {
    const client = makeMockClient((name, args) => {
      if (name === 'symbol_info' && args.symbol === 'AuthService') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      symbols: ['AuthService', 'MissingSymbol'],
      invalid_if: [{ type: 'age_exceeded', max_age_days: 999, description: 'Eventually old.' }]
    }), client)
    expect(result.verdict).toBe('DOWNRANK')
  })

  it('returns QUARANTINE for high divergence above 0.7', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'other-symbol', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [{ symbol_id: 'caller-1', symbol: 'Caller', file_path: 'src/caller.ts', resolved: true }], total: 1, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      invalid_if: [{ type: 'age_exceeded', max_age_days: 999, description: 'Eventually old.' }],
      base_memory_snapshot: {
        chunk_ids: ['chunk-1'],
        symbol_ids: ['sym-1'],
        call_graph_hash: 'snapshot'
      }
    }), client)
    expect(result.verdict).toBe('QUARANTINE')
  })

  it('returns DOWNRANK for moderate divergence above 0.4', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      invalid_if: [{ type: 'age_exceeded', max_age_days: 999, description: 'Eventually old.' }],
      base_memory_snapshot: {
        chunk_ids: ['chunk-1'],
        symbol_ids: ['sym-1'],
        call_graph_hash: 'mismatch'
      }
    }), client)
    expect(result.verdict).toBe('DOWNRANK')
  })

  it('returns QUARANTINE when age_exceeded invalidation is met', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      created_at: new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)).toISOString(),
      invalid_if: [{ type: 'age_exceeded', max_age_days: 1, description: 'Too old.' }]
    }), client)
    expect(result.verdict).toBe('QUARANTINE')
  })

  it('returns QUARANTINE when symbol_deleted invalidation is met', async () => {
    const client = makeMockClient((name) => (
      name === 'symbol_info'
        ? { symbols: [], total: 0, ambiguous: false }
        : { results: [], total: 0, cursor: undefined }
    ))
    const result = await runMemoryUseGate(makeChunk({
      invalid_if: [{ type: 'symbol_deleted', symbol: 'AuthService', description: 'Deleted.' }]
    }), client)
    expect(result.verdict).toBe('QUARANTINE')
  })

  it('returns ARCHIVED when default age exceeds 90 days', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      created_at: new Date(Date.now() - (100 * 24 * 60 * 60 * 1000)).toISOString(),
      invalid_if: [{ type: 'call_graph_changed', description: 'Graph changed.' }]
    }), client)
    expect(result.verdict).toBe('ARCHIVED')
  })

  it('returns DOWNRANK when default age exceeds 60 days after ACTIVE routing', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate(makeChunk({
      created_at: new Date(Date.now() - (70 * 24 * 60 * 60 * 1000)).toISOString(),
      invalid_if: [{ type: 'call_graph_changed', description: 'Graph changed.' }]
    }), client)
    expect(result.verdict).toBe('DOWNRANK')
  })

  it('returns FAILURE_ONLY for low-quality failed approaches', async () => {
    const client = makeMockClient((name) => {
      if (name === 'symbol_info') {
        return { symbols: [{ symbol_id: 'sym-1', file_path: 'src/auth.ts' }], total: 1, ambiguous: false }
      }
      return { results: [], total: 0, cursor: undefined }
    })

    const result = await runMemoryUseGate({
      ...makeChunk(),
      chunk_type: 'approach',
      memory_quality_score: 0.2,
      approach_description: 'Bad path',
      worked_for: [],
      failed_for: ['auth bug'],
      prerequisites: [],
      contraindications: []
    }, client)
    expect(result.verdict).toBe('FAILURE_ONLY')
  })
})
