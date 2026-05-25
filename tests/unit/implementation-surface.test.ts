import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import {
  attachRelatedTestFiles,
  buildImplementationSurface,
  classifyApproachFocus,
  classifyFileImplementationRole,
  discoverRelatedTestFiles,
  extractTargetPackage,
  extractMentionsFromApproach,
  getTaskRelevanceBoost,
  isCodeFile
} from '../../src/executor/implementation-surface.js'
import type { ExecutionPlan } from '../../src/orchestrator/plan.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'planone-surface-'))
  mkdirSync(join(root, 'packages/next/src'), { recursive: true })
  mkdirSync(join(root, 'packages/react-query/src'), { recursive: true })
  mkdirSync(join(root, 'packages/client/src'), { recursive: true })
  writeFileSync(join(root, 'packages/next/src/withTRPC.tsx'), [
    'export interface WithTRPCSSROptions {',
    '  ssr?: boolean',
    '}',
    '',
    'export function withTRPC() {}'
  ].join('\n'))
  writeFileSync(join(root, 'packages/next/src/createTRPCNext.tsx'), [
    'export interface TRPCNextOptions<TRouter> {',
    '  ssr?: boolean',
    '}',
    '',
    'export function createTRPCNext() {}'
  ].join('\n'))
  writeFileSync(join(root, 'packages/next/src/ssrPrepass.ts'), 'export function ssrPrepass() {}\n')
  writeFileSync(join(root, 'packages/react-query/src/noise.ts'), 'export const noise = true\n')

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makeClient(root: string): BaseMemoryClient {
  return {
    callTool: async (name, args) => {
      if (name === 'symbol_info' && args.symbol === 'WithTRPCSSROptions') {
        return {
          structuredContent: {
            symbols: [{
              name: 'WithTRPCSSROptions',
              symbol_id: 'sym-1',
              relative_path: 'packages/next/src/withTRPC.tsx',
              start_line: 1,
              end_line: 3
            }],
            total: 1,
            ambiguous: false
          }
        }
      }

      if (name === 'symbol_info' && args.symbol === 'createTRPCNext') {
        return {
          structuredContent: {
            symbols: [{
              name: 'createTRPCNext',
              symbol_id: 'sym-2',
              relative_path: 'packages/next/src/createTRPCNext.tsx',
              start_line: 5,
              end_line: 5
            }],
            total: 1,
            ambiguous: false
          }
        }
      }

      return {
        structuredContent: {
          symbols: [],
          total: 0,
          ambiguous: false
        }
      }
    }
  } as unknown as BaseMemoryClient
}

function makePacket(root: string): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Implement forceServerGcTimeInfinity',
    structuredDescription: 'Implement forceServerGcTimeInfinity during SSR server-side rendering',
    taskType: 'feature',
    affectedArea: '@trpc/next',
    affectedSymbols: ['WithTRPCSSROptions', 'createTRPCNext'],
    primaryRootCause: 'SSR option wiring is missing',
    alternativeRootCauses: [],
    rankedApproaches: [{
      approach: 'Update withTRPC and createTRPCNext',
      confidence: 0.9,
      rank: 1,
      supportingChunkIds: [`${join(root, 'packages/next/src/createTRPCNext.tsx')}:1-5`],
      estimatedRisk: 'medium'
    }],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.9,
    verifiedChunkIds: [`${join(root, 'packages/next/src/withTRPC.tsx')}:1-5`],
    citationVerificationDegraded: false,
    rules: {
      version: '1.0',
      repo_name: 'trpc',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 10,
      mutation_scope: 'changed_only'
    },
    synthesizedAt: new Date().toISOString()
  }
}

function makePlan(): ExecutionPlan {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    approach: 'Update SSR option wiring',
    approachRank: 1,
    steps: [{
      stepIndex: 0,
      description: 'Understand the code',
      approach: 'Inspect SSR files',
      affectedSymbols: ['WithTRPCSSROptions'],
      affectedFiles: ['packages/next/src/ssrPrepass.ts'],
      estimatedRisk: 'low',
      dependsOn: [],
      isCheckpoint: false
    }],
    assignedExecutorModel: 'z-ai/glm-5.1',
    assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
    estimatedStepCount: 2,
    createdAt: new Date().toISOString()
  }
}

describe('implementation surface', () => {
  it('recognizes code files and rejects non-code files', () => {
    expect(isCodeFile('packages/next/package.json')).toBe(false)
    expect(isCodeFile('packages/next/src/withTRPC.tsx')).toBe(true)
  })

  it('extracts file and symbol mentions from approach text', () => {
    expect(extractMentionsFromApproach('Add X to WithTRPCSSROptions in withTRPC.tsx')).toEqual({
      files: ['withTRPC.tsx'],
      symbols: ['WithTRPCSSROptions']
    })
  })

  it('extracts the target package from approach text or verified chunks', () => {
    const { root, cleanup } = makeRepo()
    try {
      const packet = makePacket(root)
      expect(extractTargetPackage('Update packages/next/src/withTRPC.tsx for SSR', packet, root)).toBe('packages/next/')
      expect(extractTargetPackage('General SSR fix', packet, root)).toBe('packages/next/')
    } finally {
      cleanup()
    }
  })

  it('applies a general task relevance boost from task/file word overlap', () => {
    expect(getTaskRelevanceBoost('packages/next/src/ssrPrepass.ts', 'Implement SSR server-side rendering support')).toBe(3)
    expect(getTaskRelevanceBoost('packages/auth/src/loginHandler.ts', 'Fix authentication login handler failures')).toBe(3)
    expect(getTaskRelevanceBoost('src/hooks/useQueryHook.ts', 'Refactor React hooks query lifecycle')).toBe(3)
    expect(getTaskRelevanceBoost('db/migrations/add_users_table.sql', 'Create database migration for users table')).toBe(3)
    expect(getTaskRelevanceBoost('packages/next/src/withTRPC.tsx', 'Implement SSR server-side rendering support')).toBe(0)
  })

  it('keeps short but meaningful terms like SSR in task relevance scoring', () => {
    expect(getTaskRelevanceBoost('packages/next/src/ssrPrepass.ts', 'Fix SSR cache behavior')).toBe(3)
  })

  it('filters out files outside the extracted target package', async () => {
    const { root, cleanup } = makeRepo()

    try {
      const packet = makePacket(root)
      packet.verifiedChunkIds = [
        `${join(root, 'packages/next/src/withTRPC.tsx')}:1-5`,
        `${join(root, 'packages/react-query/src/noise.ts')}:1-1`
      ]
      packet.rankedApproaches = [{
        approach: 'General SSR fix',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [`${join(root, 'packages/react-query/src/noise.ts')}:1-1`],
        estimatedRisk: 'medium'
      }]

      const surface = await buildImplementationSurface(packet, makePlan(), root, makeClient(root))

      expect(surface.primaryFiles.some((file) => file.path.startsWith('packages/react-query/'))).toBe(false)
      expect(surface.primaryFiles.some((file) => file.path === 'packages/next/src/withTRPC.tsx')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('classifies runtime-oriented and type-oriented approaches generically', () => {
    expect(classifyApproachFocus('Override the QueryClient behavior during server-side execution')).toBe('runtime')
    expect(classifyApproachFocus('Add a boolean property to the options interface')).toBe('type')
  })

  it('distinguishes runtime-heavy files from type-heavy files', () => {
    expect(classifyFileImplementationRole([
      'export interface Options {',
      '  enabled?: boolean',
      '}',
      'export type Config = Options & { name: string }'
    ].join('\n'))).toBe('type')

    expect(classifyFileImplementationRole([
      'export function run() {',
      '  const value = getValue()',
      '  if (value) {',
      '    return doWork(value)',
      '  }',
      '  return null',
      '}'
    ].join('\n'))).toBe('runtime')
  })

  it('builds a ranked surface and preloads files that score high from verified chunks plus grep', async () => {
    const { root, cleanup } = makeRepo()

    try {
      const surface = await buildImplementationSurface(makePacket(root), makePlan(), root, makeClient(root))
      const withTrpc = surface.primaryFiles.find((file) => file.path === 'packages/next/src/withTRPC.tsx')
      const createTrpcNext = surface.primaryFiles.find((file) => file.path === 'packages/next/src/createTRPCNext.tsx')
      const ssrPrepass = surface.primaryFiles.find((file) => file.path === 'packages/next/src/ssrPrepass.ts')

      expect(surface.primaryFiles.length).toBeLessThanOrEqual(5)
      expect(withTrpc?.confidence).toBe('high')
      expect(createTrpcNext?.confidence).toBe('high')
      expect(ssrPrepass?.confidence).toBe('high')
      expect(surface.fileContents.has('packages/next/src/withTRPC.tsx')).toBe(true)
      expect(surface.fileContents.has('packages/next/src/createTRPCNext.tsx')).toBe(true)
      expect(surface.fileContents.has('packages/next/src/ssrPrepass.ts')).toBe(true)
      expect(surface.relatedTestFiles).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('strongly boosts files backed by verified chunk locations over noisy symbol matches', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), 'def igetattr():\n    return True\n')
    writeFileSync(join(root, 'astroid/bases.py'), 'def igetattr():\n    return False\n')

    const packet: EnrichedPacket = {
      ...makePacket(root),
      originalTask: 'Fix igetattr in astroid/scoped_nodes.py',
      structuredDescription: 'Fix igetattr in astroid/scoped_nodes.py',
      affectedArea: 'astroid',
      affectedSymbols: ['igetattr'],
      verifiedChunkIds: [`${join(root, 'astroid/scoped_nodes.py')}:2543-2543`],
      rankedApproaches: [{
        approach: 'Fix igetattr in scoped_nodes.py',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [],
        estimatedRisk: 'medium'
      }]
    }

    const plan: ExecutionPlan = {
      ...makePlan(),
      approach: 'Fix igetattr in scoped_nodes.py',
      steps: [{
        ...makePlan().steps[0]!,
        affectedSymbols: ['igetattr'],
        affectedFiles: []
      }]
    }

    const client = {
      callTool: async (name: string, args: { symbol?: string }) => {
        if (name === 'symbol_info' && args.symbol === 'igetattr') {
          return {
            structuredContent: {
              symbols: [{
                name: 'igetattr',
                symbol_id: 'sym-a',
                relative_path: 'astroid/bases.py',
                start_line: 1,
                end_line: 1
              }],
              total: 1,
              ambiguous: false
            }
          }
        }

        return {
          structuredContent: {
            symbols: [],
            total: 0,
            ambiguous: false
          }
        }
      }
    } as unknown as BaseMemoryClient

    try {
      const surface = await buildImplementationSurface(packet, plan, root, client)
      expect(surface.primaryFiles[0]?.path).toBe('astroid/scoped_nodes.py')
    } finally {
      cleanup()
    }
  })

  it('filters confirmed symbol matches to the verified line neighborhood', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), 'def igetattr():\n    return True\n')
    writeFileSync(join(root, 'astroid/bases.py'), 'def igetattr():\n    return False\n')

    const packet: EnrichedPacket = {
      ...makePacket(root),
      originalTask: 'Fix igetattr in astroid/scoped_nodes.py',
      structuredDescription: 'Fix igetattr in astroid/scoped_nodes.py',
      affectedArea: 'astroid',
      affectedSymbols: ['igetattr'],
      verifiedChunkIds: [`${join(root, 'astroid/scoped_nodes.py')}:2543-2543`],
      rankedApproaches: [{
        approach: 'Fix igetattr in scoped_nodes.py',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [],
        estimatedRisk: 'medium'
      }]
    }

    const plan: ExecutionPlan = {
      ...makePlan(),
      approach: 'Fix igetattr in scoped_nodes.py',
      steps: [{
        ...makePlan().steps[0]!,
        affectedSymbols: ['igetattr'],
        affectedFiles: []
      }]
    }

    const client = {
      callTool: async (name: string, args: { symbol?: string }) => {
        if (name === 'symbol_info' && args.symbol === 'igetattr') {
          return {
            structuredContent: {
              symbols: [
                {
                  name: 'igetattr',
                  symbol_id: 'sym-a',
                  relative_path: 'astroid/bases.py',
                  start_line: 203,
                  end_line: 234
                },
                {
                  name: 'igetattr',
                  symbol_id: 'sym-b',
                  relative_path: 'astroid/scoped_nodes.py',
                  start_line: 2543,
                  end_line: 2610
                }
              ],
              total: 2,
              ambiguous: false
            }
          }
        }

        return {
          structuredContent: {
            symbols: [],
            total: 0,
            ambiguous: false
          }
        }
      }
    } as unknown as BaseMemoryClient

    try {
      const surface = await buildImplementationSurface(packet, plan, root, client)
      expect(surface.symbols).toEqual([expect.objectContaining({
        name: 'igetattr',
        filePath: 'astroid/scoped_nodes.py',
        startLine: 2543
      })])
    } finally {
      cleanup()
    }
  })

  it('seeds confirmed symbols directly from verified localization chunks when lookup misses them', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), 'def igetattr():\n    return True\n')

    const packet: EnrichedPacket = {
      ...makePacket(root),
      originalTask: 'Fix igetattr in astroid/scoped_nodes.py',
      structuredDescription: 'Fix igetattr in astroid/scoped_nodes.py',
      affectedArea: 'astroid',
      affectedSymbols: ['igetattr'],
      verifiedChunkIds: [`${join(root, 'astroid/scoped_nodes.py')}:2543-2543`],
      rankedApproaches: [{
        approach: 'Fix igetattr in scoped_nodes.py',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [],
        estimatedRisk: 'medium'
      }]
    }

    const plan: ExecutionPlan = {
      ...makePlan(),
      approach: 'Fix igetattr in scoped_nodes.py',
      steps: [{
        ...makePlan().steps[0]!,
        affectedSymbols: ['igetattr'],
        affectedFiles: []
      }]
    }

    const client = {
      callTool: async () => ({
        structuredContent: {
          symbols: [],
          total: 0,
          ambiguous: false
        }
      })
    } as unknown as BaseMemoryClient

    try {
      const surface = await buildImplementationSurface(packet, plan, root, client)
      expect(surface.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'igetattr',
          filePath: 'astroid/scoped_nodes.py',
          startLine: 2543,
          endLine: 2543
        })
      ]))
    } finally {
      cleanup()
    }
  })

  it('preloads a window around the verified line instead of the top of the file', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    const lines = Array.from({ length: 2700 }, (_, index) => `line_${index + 1}`)
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), lines.join('\n'))

    const packet: EnrichedPacket = {
      ...makePacket(root),
      originalTask: 'Fix igetattr in astroid/scoped_nodes.py',
      structuredDescription: 'Fix igetattr in astroid/scoped_nodes.py',
      affectedArea: 'astroid',
      affectedSymbols: [],
      verifiedChunkIds: [`${join(root, 'astroid/scoped_nodes.py')}:2543-2543`],
      rankedApproaches: [{
        approach: 'Fix igetattr in scoped_nodes.py',
        confidence: 0.9,
        rank: 1,
        supportingChunkIds: [],
        estimatedRisk: 'medium'
      }]
    }

    const plan: ExecutionPlan = {
      ...makePlan(),
      approach: 'Fix igetattr in scoped_nodes.py'
    }

    try {
      const surface = await buildImplementationSurface(packet, plan, root, makeClient(root))
      const preloaded = surface.fileContents.get('astroid/scoped_nodes.py')
      expect(preloaded).toContain('2538 | line_2538')
      expect(preloaded).toContain('2543 | line_2543')
      expect(preloaded?.startsWith('   1 |')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('attaches related test files from the confirmed implementation set instead of primary file discovery order', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests/unittest_scoped_nodes.py'), 'def test_smoke(): pass\n')

    try {
      const surface = await buildImplementationSurface(makePacket(root), makePlan(), root, makeClient(root))
      const withRelatedTests = attachRelatedTestFiles(surface, ['astroid/scoped_nodes.py'], root)

      expect(surface.relatedTestFiles).toEqual([])
      expect(withRelatedTests.relatedTestFiles).toEqual([{
        path: 'tests/unittest_scoped_nodes.py',
        confidence: 'high',
        sourceFile: 'astroid/scoped_nodes.py',
        reason: 'naming convention: unittest_scoped_nodes.py for scoped_nodes.py'
      }])
    } finally {
      cleanup()
    }
  })

  it('discovers a high-confidence related Python test file from a confirmed implementation file', () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), 'class ScopedNodes: pass\n')
    writeFileSync(join(root, 'tests/unittest_scoped_nodes.py'), 'def test_smoke(): pass\n')

    try {
      expect(discoverRelatedTestFiles(['astroid/scoped_nodes.py'], root)).toEqual([{
        path: 'tests/unittest_scoped_nodes.py',
        confidence: 'high',
        sourceFile: 'astroid/scoped_nodes.py',
        reason: 'naming convention: unittest_scoped_nodes.py for scoped_nodes.py'
      }])
    } finally {
      cleanup()
    }
  })

  it('downgrades basename-only matches when multiple implementation files share the same stem', () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'pkg_a'), { recursive: true })
    mkdirSync(join(root, 'pkg_b'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'pkg_a/utils.py'), 'VALUE = 1\n')
    writeFileSync(join(root, 'pkg_b/utils.py'), 'VALUE = 2\n')
    writeFileSync(join(root, 'tests/test_utils.py'), 'def test_utils(): pass\n')

    try {
      expect(discoverRelatedTestFiles(['pkg_a/utils.py'], root)).toEqual([{
        path: 'tests/test_utils.py',
        confidence: 'medium',
        sourceFile: 'pkg_a/utils.py',
        reason: 'naming convention: test_utils.py for utils.py'
      }])
    } finally {
      cleanup()
    }
  })

  it('keeps ambiguous mirrored or same-directory matches at medium confidence', () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'pkg_a'), { recursive: true })
    mkdirSync(join(root, 'pkg_b'), { recursive: true })
    mkdirSync(join(root, 'tests/pkg_a'), { recursive: true })
    writeFileSync(join(root, 'pkg_a/utils.py'), 'VALUE = 1\n')
    writeFileSync(join(root, 'pkg_b/utils.py'), 'VALUE = 2\n')
    writeFileSync(join(root, 'tests/pkg_a/unittest_utils.py'), 'def test_utils(): pass\n')

    try {
      expect(discoverRelatedTestFiles(['pkg_a/utils.py'], root)).toEqual([{
        path: 'tests/pkg_a/unittest_utils.py',
        confidence: 'medium',
        sourceFile: 'pkg_a/utils.py',
        reason: 'naming convention: unittest_utils.py for utils.py'
      }])
    } finally {
      cleanup()
    }
  })

  it('returns no related test files when no deterministic counterpart exists', () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'astroid'), { recursive: true })
    writeFileSync(join(root, 'astroid/scoped_nodes.py'), 'class ScopedNodes: pass\n')

    try {
      expect(discoverRelatedTestFiles(['astroid/scoped_nodes.py'], root)).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('excludes non-code and skills files from primary implementation files', async () => {
    const { root, cleanup } = makeRepo()
    mkdirSync(join(root, 'packages/next/skills/example'), { recursive: true })
    writeFileSync(join(root, 'packages/next/package.json'), '{"name":"next"}\n')
    writeFileSync(join(root, 'packages/next/skills/example/SKILL.md'), '# skill\n')

    try {
      const packet = makePacket(root)
      packet.verifiedChunkIds.push(`${join(root, 'packages/next/package.json')}:1-1`)
      packet.rankedApproaches[0]!.supportingChunkIds.push(`${join(root, 'packages/next/skills/example/SKILL.md')}:1-1`)

      const surface = await buildImplementationSurface(packet, makePlan(), root, makeClient(root))

      expect(surface.primaryFiles.some((file) => file.path.endsWith('package.json'))).toBe(false)
      expect(surface.primaryFiles.some((file) => file.path.endsWith('SKILL.md'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('never throws and always returns a surface', async () => {
    const { root, cleanup } = makeRepo()

    try {
      await expect(buildImplementationSurface(makePacket(root), makePlan(), root, {
        callTool: async () => {
          throw new Error('symbol lookup failed')
        }
      } as unknown as BaseMemoryClient)).resolves.toEqual(expect.objectContaining({
        primaryFiles: expect.any(Array),
        symbols: expect.any(Array),
        fileContents: expect.any(Map),
        searchHits: expect.any(Array)
      }))
    } finally {
      cleanup()
    }
  })

  it('keeps packages/client files out of primaryFiles when the approach targets packages/next', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'packages/client/src/httpBatchLink.ts'), 'export const link = true\n')
    writeFileSync(join(root, 'packages/client/src/httpBatchStreamLink.ts'), 'export const streamLink = true\n')

    try {
      const packet = makePacket(root)
      packet.verifiedChunkIds.push(`${join(root, 'packages/client/src/httpBatchLink.ts')}:1-1`)
      packet.rankedApproaches[0]!.supportingChunkIds.push(`${join(root, 'packages/client/src/httpBatchStreamLink.ts')}:1-1`)
      const plan = {
        ...makePlan(),
        approach: 'Update packages/next/src/withTRPC.tsx to add forceServerGcTimeInfinity'
      }

      const surface = await buildImplementationSurface(packet, plan, root, makeClient(root))

      expect(surface.primaryFiles.some((file) => file.path.includes('packages/client/'))).toBe(false)
    } finally {
      cleanup()
    }
  })
})
