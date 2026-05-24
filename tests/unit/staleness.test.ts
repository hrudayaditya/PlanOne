import { describe, expect, it } from 'vitest'

import { computeStaleness } from '../../src/memory/context-db/staleness.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'

function makeChunk(createdAt: string, quality = 0.9): ContextChunk {
  return {
    chunk_id: '123e4567-e89b-12d3-a456-426614174000',
    chunk_type: 'task',
    task_id_origin: 'task-1',
    repo: 'planone',
    created_at: createdAt,
    last_validated_at: createdAt,
    memory_quality_score: quality,
    symbols: [],
    base_memory_snapshot: { chunk_ids: [], symbol_ids: [], call_graph_hash: '' },
    invalid_if: [{ type: 'age_exceeded', max_age_days: 30, description: 'old' }],
    task_description: 'task',
    outcome: 'success',
    approach_used: 'approach',
    steps_taken: 1,
    verifier_verdict: 'pass',
    cycles_used: 1,
    tokens_total: 10,
    cost_usd: 0
  }
}

describe('staleness', () => {
  it('keeps effective quality near original for a 3-day-old chunk with no divergence', () => {
    const score = computeStaleness(makeChunk(new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)).toISOString()), 0)
    expect(score.effective_quality).toBeCloseTo(0.9, 4)
  })

  it('uses age_penalty 0.3 at 45 days', () => {
    const score = computeStaleness(makeChunk(new Date(Date.now() - (45 * 24 * 60 * 60 * 1000)).toISOString()), 0)
    expect(score.age_penalty).toBe(0.3)
  })

  it('uses age_penalty 1.0 at 100 days', () => {
    const score = computeStaleness(makeChunk(new Date(Date.now() - (100 * 24 * 60 * 60 * 1000)).toISOString()), 0)
    expect(score.age_penalty).toBe(1)
  })

  it('caps high divergence symbol_changed_penalty near 0.8', () => {
    const score = computeStaleness(makeChunk(new Date().toISOString()), 1)
    expect(score.symbol_changed_penalty).toBe(0.8)
  })

  it('never lets effective_quality exceed memory_quality_score', () => {
    const score = computeStaleness(makeChunk(new Date().toISOString()), 0)
    expect(score.effective_quality).toBeLessThanOrEqual(0.9)
  })

  it('never lets effective_quality go below 0.0', () => {
    const score = computeStaleness(makeChunk(new Date(Date.now() - (100 * 24 * 60 * 60 * 1000)).toISOString(), 0.2), 1)
    expect(score.effective_quality).toBeGreaterThanOrEqual(0)
  })
})
