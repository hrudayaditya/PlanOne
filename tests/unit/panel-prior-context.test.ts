import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import type { ContextChunk } from '../../src/memory/context-db/schema.js'
import { runPanel } from '../../src/panel/index.js'
import type { PanelMemberLlmProvider } from '../../src/panel/member.js'
import type { IntakeResult } from '../../src/intake/index.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-panel-prior-context-'))
  const store = new RawTraceStore(join(directory, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function makeClient(
  responder: (name: string, args: Record<string, unknown>) => Promise<BaseMemoryToolResult>
): BaseMemoryClient {
  return {
    callTool: (name: string, args: Record<string, unknown> = {}) => responder(name, args)
  } as unknown as BaseMemoryClient
}

function makeIntake(): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'Fix LoginService auth bug in auth.ts',
      structured_description: 'Fix LoginService auth bug in auth.ts',
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: ['LoginService', 'auth.ts'],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.8,
      rationale: 'multi-step',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    repoContext: {
      repoRoot: '/repo',
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

function makeContextChunk(): ContextChunk {
  return {
    chunk_id: crypto.randomUUID(),
    chunk_type: 'approach',
    task_id_origin: 'task-old',
    repo: 'planone',
    created_at: new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
    memory_quality_score: 0.9,
    symbols: ['LoginService'],
    base_memory_snapshot: {
      chunk_ids: ['chunk-ctx-1'],
      symbol_ids: [],
      call_graph_hash: ''
    },
    invalid_if: [{
      type: 'age_exceeded',
      max_age_days: 60,
      description: 'old'
    }],
    approach_description: 'Re-use prior auth fix',
    worked_for: ['Fix LoginService auth bug in auth.ts'],
    failed_for: [],
    prerequisites: [],
    contraindications: []
  }
}

function makeQueryResult(verdict: 'ACTIVE' | 'DOWNRANK' | 'QUARANTINE' | 'ARCHIVED') {
  const chunk = makeContextChunk()
  return {
    chunks: [{
      chunk,
      gate_result: {
        verdict,
        chunk_id: chunk.chunk_id,
        reasons: [],
        divergence_score: 0,
        symbols_verified: chunk.symbols,
        symbols_missing: [],
        checked_at: new Date().toISOString()
      },
      staleness: {
        age_penalty: 0,
        symbol_changed_penalty: 0,
        total_penalty: 0,
        effective_quality: chunk.memory_quality_score
      },
      final_score: chunk.memory_quality_score
    }],
    tier_used: 'primary' as const,
    gate_results: [],
    bypassed: false
  }
}

function makeProvider(promptSpy: (prompt: string) => void): PanelMemberLlmProvider {
  return {
    analyze: vi.fn(async (prompt: string) => {
      promptSpy(prompt)
      return {
        text: JSON.stringify({
          taskUnderstanding: 'Fix the auth path.',
          rootCauses: [],
          suggestedApproaches: [],
          risks: [],
          constraints: []
        }),
        tokensUsed: 10,
        costUsd: 0.01
      }
    })
  }
}

describe('panel prior context', () => {
  it('includes prior context section when ContextDB returns ACTIVE chunks', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => makeQueryResult('ACTIVE'))
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))

      expect(promptSeen).toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })

  it('omits prior context section when ContextDB returns empty results', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => ({
            chunks: [],
            tier_used: 'fallback',
            gate_results: [],
            bypassed: false
          }))
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))

      expect(promptSeen).not.toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })

  it('omits prior context section when ContextDB returns only QUARANTINE chunks', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => makeQueryResult('QUARANTINE'))
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))

      expect(promptSeen).not.toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })

  it('continues without prior context if ContextDB.query throws', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await expect(runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => {
            throw new Error('query failed')
          })
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))).resolves.toBeDefined()

      expect(promptSeen).not.toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })

  it('includes DOWNRANK chunks in prior context', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => makeQueryResult('DOWNRANK'))
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))

      expect(promptSeen).toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })

  it('excludes ARCHIVED chunks from prior context', async () => {
    const { store, cleanup } = makeStore()
    let promptSeen = ''

    try {
      await runPanel({
        intake: makeIntake(),
        rts: store,
        client: makeClient(async (name) => {
          if (name === 'symbol_info') {
            return { structuredContent: { results: [], total: 0, cursor: null } }
          }
          return { structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] } }
        }),
        contextDb: {
          query: vi.fn(async () => makeQueryResult('ARCHIVED'))
        } as never
      }, [], makeProvider((prompt) => {
        promptSeen = prompt
      }))

      expect(promptSeen).not.toContain('## Prior Context From Similar Tasks')
    } finally {
      cleanup()
    }
  })
})
