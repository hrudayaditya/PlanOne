import { describe, expect, it } from 'vitest'

import {
  ApproachChunkSchema,
  ContextChunkSchema,
  ConventionChunkSchema,
  DependencyChunkSchema,
  ErrorChunkSchema,
  PatternChunkSchema,
  SymbolChunkSchema,
  TaskChunkSchema,
  TestChunkSchema
} from '../../src/memory/context-db/schema.js'

function makeBase(chunk_type: string) {
  return {
    chunk_id: '123e4567-e89b-12d3-a456-426614174000',
    chunk_type,
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
    invalid_if: [{ type: 'age_exceeded', max_age_days: 30, description: 'Ages out.' }]
  }
}

function makeChunks() {
  return [
    TaskChunkSchema.parse({
      ...makeBase('task'),
      symbols: [],
      task_description: 'Fix auth bug',
      outcome: 'success',
      approach_used: 'retry',
      steps_taken: 2,
      verifier_verdict: 'pass',
      cycles_used: 1,
      tokens_total: 100,
      cost_usd: 0.01
    }),
    SymbolChunkSchema.parse({
      ...makeBase('symbol'),
      symbol_name: 'AuthService',
      symbol_id: 'sym-1',
      file_path: 'src/auth.ts',
      kind: 'class',
      approach_notes: 'Worked',
      test_coverage: ['auth.test.ts']
    }),
    ApproachChunkSchema.parse({
      ...makeBase('approach'),
      approach_description: 'Patch the handler',
      worked_for: ['task'],
      failed_for: [],
      prerequisites: ['tests exist'],
      contraindications: ['schema change']
    }),
    PatternChunkSchema.parse({
      ...makeBase('pattern'),
      pattern_name: 'Retry loop',
      pattern_description: 'Retry transient failures',
      example_task_id: 'task-1',
      code_template: '',
      applicable_when: ['network errors']
    }),
    ErrorChunkSchema.parse({
      ...makeBase('error'),
      error_signature: 'EADDRINUSE',
      root_cause: 'Port already bound',
      fix_applied: 'Select different port',
      recurrence_count: 2,
      related_symbols: ['Server']
    }),
    TestChunkSchema.parse({
      ...makeBase('test'),
      test_name: 'auth flow',
      test_file: 'tests/auth.test.ts',
      covers_symbols: ['AuthService'],
      last_passed_at: new Date().toISOString(),
      flaky: false,
      flakiness_notes: ''
    }),
    DependencyChunkSchema.parse({
      ...makeBase('dependency'),
      symbols: [],
      dependency_name: 'zod',
      version: '3.0.0',
      usage_notes: 'validation',
      known_issues: [],
      upgrade_notes: 'safe'
    }),
    ConventionChunkSchema.parse({
      ...makeBase('convention'),
      symbols: [],
      convention_description: 'Prefer named exports',
      applies_to: ['src/**'],
      enforcement: 'preferred',
      examples: ['export function foo() {}']
    })
  ]
}

describe('context-db schema', () => {
  it('validates each of the 8 chunk types', () => {
    expect(makeChunks()).toHaveLength(8)
  })

  it('rejects missing invalid_if for each chunk type', () => {
    for (const chunk of makeChunks()) {
      const { invalid_if: _invalidIf, ...withoutInvalidIf } = chunk
      expect(() => ContextChunkSchema.parse(withoutInvalidIf)).toThrow()
    }
  })

  it('rejects empty invalid_if arrays for each chunk type', () => {
    for (const chunk of makeChunks()) {
      expect(() => ContextChunkSchema.parse({ ...chunk, invalid_if: [] })).toThrow()
    }
  })

  it('rejects empty symbols for structural chunks', () => {
    for (const chunkType of ['symbol', 'approach', 'pattern', 'error'] as const) {
      const chunk = makeChunks().find((entry) => entry.chunk_type === chunkType)
      expect(() => ContextChunkSchema.parse({ ...chunk!, symbols: [] })).toThrow()
    }
  })

  it('routes correctly by chunk_type in the discriminated union', () => {
    for (const chunk of makeChunks()) {
      expect(ContextChunkSchema.parse(chunk).chunk_type).toBe(chunk.chunk_type)
    }
  })

  it('rejects invalid chunk_type in the union schema', () => {
    expect(() => ContextChunkSchema.parse({ ...makeChunks()[0], chunk_type: 'invalid' })).toThrow()
  })
})
