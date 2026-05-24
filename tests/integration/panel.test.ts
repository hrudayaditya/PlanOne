import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import type { IntakeResult } from '../../src/intake/index.js'
import { runPanel } from '../../src/panel/index.js'
import type { PanelMemberLlmProvider } from '../../src/panel/member.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-panel-integration-'))
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

function makeIntake(repoRoot = '/repo', task = 'Fix auth bug'): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: task,
      structured_description: task,
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: ['LoginService'],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.7,
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
      repoRoot,
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm',
      language: 'typescript',
      pythonBinary: null,
      testRunner: 'vitest',
      testFilePattern: '*.test.ts',
      testCommand: 'npm test'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

describe('panel integration', () => {
  it('returns PanelOutput with all required fields', async () => {
    const { store, cleanup } = makeStore()

    try {
      const client = makeClient(async (name, args) => {
        if (name === 'symbol_info') {
          return { structuredContent: { results: [{ symbol_id: 'sym-1' }], total: 1, cursor: null } }
        }

        if (name === 'codebase_peek' && args.query === 'chunk-1') {
          return { structuredContent: { results: [{ id: 'chunk-1' }], total: 1, cursor: null, expandedContext: [] } }
        }

        return {
          structuredContent: {
            results: [{ id: 'chunk-1', symbol: 'LoginService', content: 'function LoginService() {}' }],
            total: 1,
            cursor: null,
            expandedContext: []
          }
        }
      })
      const contextDb = new ContextDB(client)
      const provider: PanelMemberLlmProvider = {
        async analyze() {
          return {
            text: JSON.stringify({
              taskUnderstanding: 'Fix login path.',
              rootCauses: [{ claim: 'Broken branch', chunkIds: ['chunk-1'], confidence: 0.9 }],
              suggestedApproaches: [{ claim: 'Patch LoginService', chunkIds: ['chunk-1'], confidence: 0.8 }],
              risks: [],
              constraints: []
            }),
            tokensUsed: 100,
            costUsd: 1
          }
        }
      }

      const result = await runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)

      expect(result.enrichedPacket).toBeDefined()
      expect(result.memberAnalyses).toHaveLength(1)
      expect(result.citationResults).toHaveLength(1)
      expect(typeof result.panelDurationMs).toBe('number')
    } finally {
      cleanup()
    }
  })

  it('never throws regardless of provider failures', async () => {
    const { store, cleanup } = makeStore()

    try {
      const client = makeClient(async () => {
        throw new Error('BaseMemory failure')
      })
      const contextDb = new ContextDB(client)
      const provider: PanelMemberLlmProvider = {
        async analyze() {
          throw new Error('LLM failure')
        }
      }

      await expect(runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)).resolves.toBeDefined()
    } finally {
      cleanup()
    }
  })

  it('uses the default single-member config when configs are empty', async () => {
    const { store, cleanup } = makeStore()

    try {
      const client = makeClient(async () => ({
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
      }))
      const contextDb = new ContextDB(client)
      const provider: PanelMemberLlmProvider = {
        async analyze() {
          throw new Error('LLM failure')
        }
      }

      const result = await runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)
      expect(result.memberAnalyses[0]?.memberId).toBe('member-1')
    } finally {
      cleanup()
    }
  })

  it('returns a JSON-serializable PanelOutput', async () => {
    const { store, cleanup } = makeStore()

    try {
      const client = makeClient(async () => ({
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
      }))
      const contextDb = new ContextDB(client)
      const provider: PanelMemberLlmProvider = {
        async analyze() {
          throw new Error('LLM failure')
        }
      }

      const result = await runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    } finally {
      cleanup()
    }
  })

  it('overrides degraded localization fields when deterministic localization succeeds', async () => {
    const { store, cleanup } = makeStore()
    const repoRoot = mkdtempSync(join(tmpdir(), 'planone-panel-localizer-'))
    mkdirSync(join(repoRoot, 'astroid'), { recursive: true })
    writeFileSync(join(repoRoot, 'astroid/scoped_nodes.py'), [
      'class LookupMixIn:',
      '    def igetattr(self, name, context=None):',
      '        return self._get_attribute_from_metaclass(name, context)'
    ].join('\n'))

    try {
      const client = makeClient(async () => ({
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
      }))
      const contextDb = new ContextDB(client)
      const provider: PanelMemberLlmProvider = {
        async analyze(prompt: string) {
          if (prompt.includes('### Repository Structure ###')) {
            return {
              text: '`astroid/scoped_nodes.py`',
              tokensUsed: 20,
              costUsd: 0
            }
          }

          if (prompt.includes('### Skeleton of Relevant Files ###')) {
            return {
              text: [
                'astroid/scoped_nodes.py',
                '    function: igetattr'
              ].join('\n'),
              tokensUsed: 20,
              costUsd: 0
            }
          }

          return {
            text: JSON.stringify({
              taskUnderstanding: 'Fix metaclass inference.',
              rootCauses: [],
              suggestedApproaches: [],
              risks: [],
              constraints: []
            }),
            tokensUsed: 20,
            costUsd: 0
          }
        }
      }

      const result = await runPanel({
        intake: makeIntake(
          repoRoot,
          '@property members defined in metaclasses of a base class are not correctly inferred\nTraceback\n  File "astroid/scoped_nodes.py", line 2, in igetattr'
        ),
        rts: store,
        client,
        contextDb
      }, [], provider)

      expect(result.enrichedPacket.affectedSymbols).toEqual(['igetattr'])
      expect(result.enrichedPacket.citationVerificationDegraded).toBe(false)
      expect(result.enrichedPacket.verifiedChunkIds).toEqual([
        `${join(repoRoot, 'astroid/scoped_nodes.py')}:2-2`
      ])
      expect(result.enrichedPacket.implementationContext?.['astroid/scoped_nodes.py']).toContain('def igetattr')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
      cleanup()
    }
  })

  it('writes an RTS error when deterministic localization throws and falls back', async () => {
    const { store, cleanup } = makeStore()
    const repoRoot = mkdtempSync(join(tmpdir(), 'planone-panel-localizer-failure-'))
    mkdirSync(join(repoRoot, 'astroid'), { recursive: true })
    writeFileSync(join(repoRoot, 'astroid/scoped_nodes.py'), 'def igetattr():\n    return None\n')

    try {
      const client = makeClient(async () => ({
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
      }))
      const contextDb = new ContextDB(client)
      const provider = {} as PanelMemberLlmProvider

      await runPanel({
        intake: makeIntake(repoRoot, 'Fix astroid/scoped_nodes.py'),
        rts: store,
        client,
        contextDb
      }, [], provider)

      const errorEvents = store.queryByType('error', 10)
      const contents = errorEvents.map((event) => JSON.parse(event.content_json))
      expect(contents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'Deterministic localization threw an exception. Falling back to degraded panel.'
        })
      ]))
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
      cleanup()
    }
  })
})
