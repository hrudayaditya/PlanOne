import { describe, expect, it } from 'vitest'

import { checkAdmission } from '../../src/memory/context-db/amac.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'

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
    base_memory_snapshot: { chunk_ids: ['chunk-1'], symbol_ids: ['sym-1'], call_graph_hash: '' },
    invalid_if: [{ type: 'age_exceeded', max_age_days: 30, description: 'old' }],
    symbol_name: 'AuthService',
    symbol_id: 'sym-1',
    file_path: 'src/auth.ts',
    kind: 'class',
    approach_notes: 'note',
    test_coverage: [],
    ...overrides
  }
}

describe('amac', () => {
  it('rejects when verifier is not approved', async () => {
    const decision = await checkAdmission(makeChunk(), [], false)
    expect(decision.admitted).toBe(false)
  })

  it('rejects when quality is below 0.40', async () => {
    const decision = await checkAdmission(makeChunk({ memory_quality_score: 0.2 }), [], true)
    expect(decision.admitted).toBe(false)
  })

  it('rejects when invalid_if is empty', async () => {
    const decision = await checkAdmission(makeChunk({ invalid_if: [] }), [], true)
    expect(decision.admitted).toBe(false)
  })

  it('rejects structural chunks with empty symbols', async () => {
    const decision = await checkAdmission(makeChunk({ symbols: [] }), [], true)
    expect(decision.admitted).toBe(false)
  })

  it('deduplicates when symbol overlap is high', async () => {
    const existing = makeChunk({ chunk_id: 'existing' })
    const decision = await checkAdmission(makeChunk(), [existing], true)
    expect(decision.deduplicated).toBe(true)
    expect(decision.existing_chunk_id).toBe('existing')
  })

  it('admits when all checks pass', async () => {
    const decision = await checkAdmission(makeChunk(), [], true)
    expect(decision.admitted).toBe(true)
  })
})
