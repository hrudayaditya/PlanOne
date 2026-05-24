import { describe, expect, it } from 'vitest'

import { applyAbModeFilter, getAbModeFilter } from '../../src/memory/context-db/ab-modes.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'

function makeChunk(repo: string, quality: number): ContextChunk {
  return {
    chunk_id: crypto.randomUUID(),
    chunk_type: 'task',
    task_id_origin: 'task',
    repo,
    created_at: new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
    memory_quality_score: quality,
    symbols: [],
    base_memory_snapshot: { chunk_ids: [], symbol_ids: [], call_graph_hash: '' },
    invalid_if: [{ type: 'age_exceeded', max_age_days: 10, description: 'old' }],
    task_description: 'task',
    outcome: 'success',
    approach_used: 'approach',
    steps_taken: 1,
    verifier_verdict: 'pass',
    cycles_used: 1,
    tokens_total: 1,
    cost_usd: 0
  }
}

describe('ab-modes', () => {
  it('mode A returns empty regardless of input', () => {
    expect(applyAbModeFilter([makeChunk('a', 0.9)], getAbModeFilter('A'), 'a')).toEqual([])
  })

  it('mode B includes cross-repo chunks', () => {
    expect(applyAbModeFilter([makeChunk('other', 0.9)], getAbModeFilter('B'), 'current')).toHaveLength(1)
  })

  it('mode C excludes cross-repo chunks', () => {
    expect(applyAbModeFilter([makeChunk('other', 0.9)], getAbModeFilter('C'), 'current')).toEqual([])
  })

  it('mode D excludes chunks below 0.80 quality', () => {
    expect(applyAbModeFilter([makeChunk('current', 0.79)], getAbModeFilter('D'), 'current')).toEqual([])
  })

  it('returns the correct filter for each mode', () => {
    expect(getAbModeFilter('A')).toMatchObject({ bypassContextDb: true })
    expect(getAbModeFilter('B')).toMatchObject({ crossRepoAllowed: true, minQualityScore: 0 })
    expect(getAbModeFilter('C')).toMatchObject({ crossRepoAllowed: false })
    expect(getAbModeFilter('D')).toMatchObject({ minQualityScore: 0.8 })
  })
})
