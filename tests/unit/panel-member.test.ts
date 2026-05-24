import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, afterEach } from 'vitest'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import { extractDirectoryHint, runPanelMember, type PanelMemberAnalysis, type PanelMemberInput, type PanelMemberLlmProvider } from '../../src/panel/member.js'
import type { IntakeResult } from '../../src/intake/index.js'

const mockSearchResult = {
  file_path: 'packages/next/src/createTRPCNext.tsx',
  start_line: 42,
  end_line: 67,
  content: 'export function createTRPCNext<TRouter>(...) {...}',
  chunk_type: 'function',
  name: 'createTRPCNext',
  lane: 'hybrid',
  reranker_score: 0.95
}

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-panel-member-'))
  const store = new RawTraceStore(join(directory, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function makeRepoRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-panel-repo-'))
  const nextSrc = join(root, 'packages', 'next', 'src')
  mkdirSync(nextSrc, { recursive: true })
  writeFileSync(
    join(nextSrc, 'withTRPC.tsx'),
    'export type WithTRPCSSROptions<TRouter> = { forceServerGcTimeInfinity?: boolean }\n'
  )

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
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
    reproductionResult: {
      attempted: false,
      succeeded: false,
      traceback: null,
      output: null,
      reproducerCode: null,
      executionTimeMs: 0
    },
    intakeTimestamp: new Date().toISOString()
  }
}

function makeTrpcIntake(): IntakeResult {
  return {
    ...makeIntake(),
    enhancedTask: {
      ...makeIntake().enhancedTask,
      original: 'Add forceServerGcTimeInfinity to @trpc/next',
      structured_description: 'Add forceServerGcTimeInfinity to @trpc/next createTRPCNext TRPCNextOptions ssrPrepass',
      affected_area: '@trpc/next server-side SSR logic',
      likely_files: ['createTRPCNext', 'TRPCNextOptions', 'ssrPrepass']
    }
  }
}

function makeInput(store: RawTraceStore, client: BaseMemoryClient, intake: IntakeResult = makeIntake()): PanelMemberInput {
  return {
    intake,
    config: {
      memberId: 'member-1',
      model: 'claude-opus-4-5',
      role: 'primary'
    },
    rts: store,
    client
  }
}

function makeProvider(implementation: PanelMemberLlmProvider['analyze']): PanelMemberLlmProvider {
  return {
    analyze: implementation
  }
}

function expectMinimalAnalysis(analysis: PanelMemberAnalysis): void {
  expect(analysis.rootCauses).toEqual([])
  expect(analysis.suggestedApproaches).toEqual([])
  expect(analysis.risks).toEqual([])
  expect(analysis.constraints).toEqual([])
  expect(analysis.tokensUsed).toBe(0)
  expect(analysis.costUsd).toBe(0)
}

describe('panel member', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('extracts a directory hint from a scoped package name using repo existence checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'planone-dirhint-'))
    mkdirSync(join(root, 'packages', 'somepackage', 'src'), { recursive: true })

    try {
      const intake = makeIntake()
      intake.repoContext.repoRoot = root
      intake.enhancedTask.affected_area = '@scope/somepackage'

      expect(extractDirectoryHint(intake)).toBe('packages/somepackage/src')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves @trpc/next via the same general directory hint logic', () => {
    const { root, cleanup } = makeRepoRoot()

    try {
      const intake = makeTrpcIntake()
      intake.repoContext.repoRoot = root

      expect(extractDirectoryHint(intake)).toBe('packages/next/src')
    } finally {
      cleanup()
    }
  })

  it('includes a bug reproduction traceback in the panel prompt when available', async () => {
    const { store, cleanup } = makeStore()
    let capturedPrompt = ''

    try {
      const intake = makeIntake()
      intake.reproductionResult = {
        attempted: true,
        succeeded: true,
        traceback: 'Traceback\n  File "astroid/scoped_nodes.py", line 2, in igetattr',
        output: null,
        reproducerCode: 'raise RuntimeError()',
        executionTimeMs: 10
      }

      await runPanelMember(
        makeInput(store, makeClient(async () => ({
          structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
        })), intake),
        makeProvider(async (prompt) => {
          capturedPrompt = prompt
          return {
            text: JSON.stringify({
              taskUnderstanding: 'Investigate traceback.',
              rootCauses: [],
              suggestedApproaches: [],
              risks: [],
              constraints: []
            }),
            tokensUsed: 1,
            costUsd: 0
          }
        })
      )

      expect(capturedPrompt).toContain('## Bug Reproduction Traceback')
      expect(capturedPrompt).toContain('astroid/scoped_nodes.py')
      expect(capturedPrompt).toContain('igetattr')
    } finally {
      cleanup()
    }
  })

  it('returns minimal analysis when all BaseMemory calls fail', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async () => {
          throw new Error('BaseMemory unavailable')
        })),
        makeProvider(async () => {
          throw new Error('LLM should not be needed')
        })
      )

      expectMinimalAnalysis(analysis)
      expect(analysis.retrievedChunkIds).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('returns minimal analysis when the LLM call fails', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{ ...mockSearchResult, symbol: 'LoginService' }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return typeof args.symbol === 'string' && args.symbol === 'LoginService'
              ? {
                structuredContent: {
                  symbols: [{ symbol_id: 'sym-login-service', name: 'LoginService' }],
                  total: 1,
                  ambiguous: false
                }
              }
              : {
                structuredContent: { symbols: [], total: 0, ambiguous: false }
              }
          }

          return {
            structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
          }
        })),
        makeProvider(async () => {
          throw new Error('LLM down')
        })
      )

      expectMinimalAnalysis(analysis)
      expect(analysis.affectedSymbols).toContain('LoginService')
    } finally {
      cleanup()
    }
  })

  it('returns minimal analysis when zod validation fails on the LLM response', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'symbol_info') {
            return {
              structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        })),
        makeProvider(async () => ({
          text: '{"taskUnderstanding": 123}',
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expectMinimalAnalysis(analysis)
    } finally {
      cleanup()
    }
  })

  it('logs an llm_call event on successful analysis', async () => {
    const { store, cleanup } = makeStore()

    try {
      await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{ ...mockSearchResult, symbol: 'LoginService' }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return {
              structuredContent: {
                symbols: [{
                  symbol_id: 'sym-ssr-prepass',
                  name: 'ssrPrepass',
                  kind: 'function',
                  relative_path: 'packages/next/src/ssrPrepass.ts',
                  start_line: 115,
                  end_line: 167,
                  signature: 'async function ssrPrepass()',
                  chunk_kind: 'function'
                }],
                total: 1,
                ambiguous: false
              }
            }
          }

          return {
            structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
          }
        })),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [{ claim: 'Auth bug', chunkIds: ['packages/next/src/createTRPCNext.tsx:42-67'], confidence: 0.9 }],
            suggestedApproaches: [{ claim: 'Patch LoginService', chunkIds: ['packages/next/src/createTRPCNext.tsx:42-67'], confidence: 0.8 }],
            risks: [{ claim: 'Auth regression', chunkIds: ['packages/next/src/withTRPC.tsx:54-72'], confidence: 0.7 }],
            constraints: [{ claim: 'Do not touch secrets', chunkIds: ['packages/next/src/ssrPrepass.ts:115-167'], confidence: 0.6 }]
          }),
          tokensUsed: 321,
          costUsd: 1.23
        }))
      )

      const llmCalls = store.queryByType('llm_call')
      expect(llmCalls).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('keeps only symbols that symbolInfo verifies', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [
                  { ...mockSearchResult, symbol: 'LoginService' },
                  {
                    file_path: 'packages/next/src/ghost.ts',
                    start_line: 1,
                    end_line: 3,
                    content: 'const GhostSymbol = null',
                    chunk_type: 'variable',
                    name: 'GhostSymbol',
                    symbol: 'GhostSymbol'
                  }
                ],
                total: 2,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return typeof args.symbol === 'string' && args.symbol === 'LoginService'
              ? { structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false } }
              : { structuredContent: { symbols: [], total: 0, ambiguous: false } }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        })),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.affectedSymbols).toContain('LoginService')
      expect(analysis.affectedSymbols).not.toContain('GhostSymbol')
    } finally {
      cleanup()
    }
  })

  it('collects retrieved chunk IDs from BaseMemory responses using file and line spans', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [
                  { ...mockSearchResult, symbol: 'createTRPCNext' },
                  {
                    file_path: 'packages/next/src/withTRPC.tsx',
                    start_line: 54,
                    end_line: 72,
                    content: 'export type WithTRPCSSROptions<TRouter extends AnyRouter> = ...',
                    chunk_type: 'type',
                    name: 'WithTRPCSSROptions',
                    symbol: 'WithTRPCSSROptions'
                  },
                  {
                    file_path: 'packages/next/src/ssrPrepass.ts',
                    start_line: 115,
                    end_line: 167,
                    content: 'async function ssrPrepass() {...}',
                    chunk_type: 'function',
                    name: 'ssrPrepass',
                    symbol: 'ssrPrepass'
                  },
                  {
                    file_path: 'packages/next/src/serverCache.ts',
                    start_line: 10,
                    end_line: 18,
                    content: 'const queryCache = new QueryCache()',
                    chunk_type: 'variable',
                    name: 'queryCache'
                  },
                  {
                    file_path: 'packages/next/src/tests.ts',
                    start_line: 1,
                    end_line: 12,
                    content: 'test(\"server cache\", () => {})',
                    chunk_type: 'test',
                    name: 'server cache'
                  }
                ],
                total: 5,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return {
              structuredContent: {
                symbols: [],
                total: 0,
                ambiguous: false
              }
            }
          }

          return {
            structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
          }
        })),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.retrievedChunkIds).toHaveLength(5)
      expect(analysis.retrievedChunkIds).toContain('packages/next/src/createTRPCNext.tsx:42-67')
      expect(analysis.retrievedChunkIds).toContain('packages/next/src/withTRPC.tsx:54-72')
    } finally {
      cleanup()
    }
  })

  it('passes retrieved chunk content into the panel prompt', async () => {
    const { store, cleanup } = makeStore()
    let receivedPrompt = ''

    try {
      await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{ ...mockSearchResult, symbol: 'createTRPCNext' }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        })),
        makeProvider(async (prompt) => {
          receivedPrompt = prompt
          return {
            text: JSON.stringify({
              taskUnderstanding: 'Fix the login path.',
              rootCauses: [],
              suggestedApproaches: [],
              risks: [],
              constraints: []
            }),
            tokensUsed: 10,
            costUsd: 0.01
          }
        })
      )

      expect(receivedPrompt).toContain(mockSearchResult.content)
      expect(receivedPrompt).toContain(`[CHUNK: packages/next/src/createTRPCNext.tsx:42-67]`)
      expect(receivedPrompt).toContain('Type: function')
      expect(receivedPrompt).toContain('Symbol: createTRPCNext')
    } finally {
      cleanup()
    }
  })

  it('strips invalid citation formats instead of rejecting the entire response', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{ ...mockSearchResult, symbol: 'createTRPCNext' }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return {
              structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        })),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [{
              claim: 'Broken branch',
              chunkIds: ['packages/next/src/createTRPCNext.tsx', 'packages/next/src/createTRPCNext.tsx:42-67'],
              confidence: 0.9
            }],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.rootCauses).toHaveLength(1)
      expect(analysis.rootCauses[0]?.chunkIds).toEqual(['packages/next/src/createTRPCNext.tsx:42-67'])
    } finally {
      cleanup()
    }
  })

  it('filters noisy affected symbols but keeps valid code symbols', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [
                  { ...mockSearchResult, symbol: 'createTRPCNext' },
                  {
                    file_path: 'packages/next/src/withTRPC.tsx',
                    start_line: 54,
                    end_line: 72,
                    content: 'export type WithTRPCSSROptions<TRouter extends AnyRouter> = ...',
                    chunk_type: 'type',
                    name: 'WithTRPCSSROptions',
                    symbol: 'WithTRPCSSROptions'
                  },
                  {
                    file_path: 'packages/next/src/ssrPrepass.ts',
                    start_line: 115,
                    end_line: 167,
                    content: 'async function ssrPrepass() {...}',
                    chunk_type: 'function',
                    name: 'ssrPrepass',
                    symbol: 'ssrPrepass'
                  },
                  { ...mockSearchResult, symbol: 'from' },
                  { ...mockSearchResult, symbol: 'set' },
                  { ...mockSearchResult, symbol: 'T' }
                ],
                total: 6,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return typeof args.symbol === 'string' && ['createTRPCNext', 'WithTRPCSSROptions', 'ssrPrepass', 'from', 'set', 'T'].includes(args.symbol)
              ? { structuredContent: { symbols: [{ symbol_id: `sym-${args.symbol}` }], total: 1, ambiguous: false } }
              : { structuredContent: { symbols: [], total: 0, ambiguous: false } }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        })),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.affectedSymbols).toContain('createTRPCNext')
      expect(analysis.affectedSymbols).toContain('ssrPrepass')
      expect(analysis.affectedSymbols).toContain('WithTRPCSSROptions')
      expect(analysis.affectedSymbols).not.toContain('from')
      expect(analysis.affectedSymbols).not.toContain('set')
      expect(analysis.affectedSymbols).not.toContain('T')
    } finally {
      cleanup()
    }
  })

  it('returns empty retrievedChunkIds when BaseMemory returns zero results', async () => {
    const { store, cleanup } = makeStore()

    try {
      const analysis = await runPanelMember(
        makeInput(store, makeClient(async () => ({
          structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
        }))),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Fix the login path.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.retrievedChunkIds).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('promotes local repo hits into affectedSymbols when BaseMemory symbol_info misses them', async () => {
    const { store, cleanup } = makeStore()
    const { root, cleanup: cleanupRepo } = makeRepoRoot()

    try {
      const intake: IntakeResult = {
        ...makeTrpcIntake(),
        enhancedTask: {
          ...makeTrpcIntake().enhancedTask,
          likely_files: ['WithTRPCSSROptions']
        },
        repoContext: {
          ...makeTrpcIntake().repoContext,
          repoRoot: root
        }
      }

      const analysis = await runPanelMember(
        makeInput(store, makeClient(async (name) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
            }
          }

          if (name === 'symbol_info') {
            return {
              structuredContent: { symbols: [], total: 0, ambiguous: false }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        }), intake),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Implement SSR option.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(analysis.affectedSymbols).toContain('WithTRPCSSROptions')
      expect(analysis.retrievedChunkIds.some((chunkId) => chunkId.includes('packages/next/src/withTRPC.tsx'))).toBe(true)
    } finally {
      cleanupRepo()
      cleanup()
    }
  })

  it('uses symbol_info for symbol-like follow-up queries in @trpc/next tasks', async () => {
    const { store, cleanup } = makeStore()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []

    try {
      await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          calls.push({ name, args })

          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{
                  file_path: 'packages/react-query/src/server/ssgProxy.ts',
                  start_line: 46,
                  end_line: 50,
                  content: 'export interface CreateServerSideHelpersOptions {}',
                  chunk_type: 'interface',
                  name: 'CreateServerSideHelpersOptions'
                }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            return {
              structuredContent: {
                symbols: [{
                  symbol_id: 'sym-withtrpc-ssr-options',
                  name: 'WithTRPCSSROptions',
                  kind: 'type',
                  relative_path: 'packages/next/src/withTRPC.tsx',
                  start_line: 54,
                  end_line: 72,
                  signature: 'type WithTRPCSSROptions<TRouter> = { forceServerGcTimeInfinity?: boolean }',
                  chunk_kind: 'type'
                }],
                total: 1,
                ambiguous: false
              }
            }
          }

          return {
            structuredContent: { symbols: [{ symbol_id: 'sym-1' }], total: 1, ambiguous: false }
          }
        }), makeTrpcIntake()),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Implement SSR option.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      const symbolInfoCalls = calls.filter((entry) => entry.name === 'symbol_info')
      expect(symbolInfoCalls.length).toBeGreaterThan(0)
      expect(symbolInfoCalls.some((entry) => entry.args.symbol === 'createTRPCNext')).toBe(true)
      expect(symbolInfoCalls.some((entry) => entry.args.symbol === 'TRPCNextOptions')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('uses symbol-like lookup queries instead of guessed file paths', async () => {
    const { store, cleanup } = makeStore()
    const lookupSymbols: string[] = []

    try {
      await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{ ...mockSearchResult, symbol: 'createTRPCNext' }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            if (typeof args.symbol === 'string') {
              lookupSymbols.push(args.symbol)
            }

            return {
              structuredContent: { symbols: [], total: 0, ambiguous: false }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        }), makeTrpcIntake()),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Implement SSR option.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(lookupSymbols).toContain('createTRPCNext')
      expect(lookupSymbols).toContain('TRPCNextOptions')
      expect(lookupSymbols).not.toContain('packages/next/src/createTRPCNext.ts')
    } finally {
      cleanup()
    }
  })

  it('strips trailing parentheses before calling symbol_info', async () => {
    const { store, cleanup } = makeStore()
    const lookupSymbols: string[] = []

    try {
      await runPanelMember(
        makeInput(store, makeClient(async (name, args) => {
          if (name === 'codebase_search') {
            return {
              structuredContent: {
                results: [{
                  file_path: 'packages/next/src/withTRPC.tsx',
                  start_line: 53,
                  end_line: 72,
                  content: 'export function withTRPC() {}',
                  chunk_type: 'function',
                  name: 'withTRPC()',
                  symbol: 'withTRPC()'
                }],
                total: 1,
                cursor: null,
                expandedContext: []
              }
            }
          }

          if (name === 'symbol_info') {
            if (typeof args.symbol === 'string') {
              lookupSymbols.push(args.symbol)
            }

            return {
              structuredContent: { symbols: [], total: 0, ambiguous: false }
            }
          }

          return {
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }
        }), makeTrpcIntake()),
        makeProvider(async () => ({
          text: JSON.stringify({
            taskUnderstanding: 'Implement SSR option.',
            rootCauses: [],
            suggestedApproaches: [],
            risks: [],
            constraints: []
          }),
          tokensUsed: 10,
          costUsd: 0.01
        }))
      )

      expect(lookupSymbols).toContain('withTRPC')
      expect(lookupSymbols).not.toContain('withTRPC()')
    } finally {
      cleanup()
    }
  })

  it('retries panel analysis on transient 503 before succeeding', async () => {
    const { store, cleanup } = makeStore()
    vi.useFakeTimers()
    const analyze = vi.fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          taskUnderstanding: 'Implement SSR option.',
          rootCauses: [],
          suggestedApproaches: [],
          risks: [],
          constraints: []
        }),
        tokensUsed: 10,
        costUsd: 0.01
      })

    try {
      const runPromise = runPanelMember(
        {
          ...makeInput(store, makeClient(async () => ({
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }))),
          config: {
            memberId: 'member-1',
            model: 'gemini-3.1-flash-lite-preview',
            role: 'primary'
          }
        },
        makeProvider(analyze)
      )

      await vi.runAllTimersAsync()
      const analysis = await runPromise

      expect(analyze).toHaveBeenCalledTimes(3)
      expect(analysis.taskUnderstanding).toBe('Implement SSR option.')
    } finally {
      cleanup()
    }
  })

  it('falls back to the intake model after retries are exhausted', async () => {
    const { store, cleanup } = makeStore()
    vi.useFakeTimers()
    const analyze = vi.fn(async (_prompt: string, model: string) => {
      if (model === 'gemini-3.1-flash-lite-preview') {
        throw new Error('503 Service Unavailable')
      }

      return {
        text: JSON.stringify({
          taskUnderstanding: 'Fallback panel analysis.',
          rootCauses: [],
          suggestedApproaches: [],
          risks: [],
          constraints: []
        }),
        tokensUsed: 10,
        costUsd: 0.01
      }
    })
    try {
      const runPromise = runPanelMember(
        {
          ...makeInput(store, makeClient(async () => ({
            structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
          }))),
          config: {
            memberId: 'member-1',
            model: 'gemini-3.1-flash-lite-preview',
            role: 'primary'
          },
          fallbackModel: 'gemini-2.5-flash'
        },
        makeProvider(analyze)
      )

      await vi.runAllTimersAsync()
      const analysis = await runPromise

      expect(analyze).toHaveBeenCalledWith(expect.any(String), 'gemini-3.1-flash-lite-preview')
      expect(analyze).toHaveBeenCalledWith(expect.any(String), 'gemini-2.5-flash')
      expect(analysis.taskUnderstanding).toBe('Fallback panel analysis.')
    } finally {
      cleanup()
    }
  })
})
