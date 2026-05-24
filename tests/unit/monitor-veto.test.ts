import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import { checkVeto, isCodeSymbol } from '../../src/monitor/veto.js'
import type { VetoInput } from '../../src/monitor/veto.js'

function makeClient(responder: (name: string, args: Record<string, unknown>) => BaseMemoryToolResult): BaseMemoryClient {
  return {
    callTool: async (name, args) => responder(name, args)
  } as unknown as BaseMemoryClient
}

function makeInput(): VetoInput {
  return {
    preActionPlan: {
      intendedAction: 'Refactor LoginService',
      affectedSymbols: ['LoginService'],
      estimatedRiskLevel: 'medium',
      reasoning: 'routine change'
    },
    currentStep: {
      stepIndex: 0,
      description: 'Update login logic',
      approach: 'Patch auth branch',
      affectedSymbols: ['LoginService'],
      affectedFiles: [],
      estimatedRisk: 'medium',
      dependsOn: [],
      isCheckpoint: false
    },
    enrichedPacket: {
      taskId: 'task-1',
      originalTask: 'Fix auth bug',
      structuredDescription: 'Fix auth bug',
      taskType: 'bug_fix',
      affectedArea: 'authentication',
      affectedSymbols: ['LoginService'],
      primaryRootCause: '',
      alternativeRootCauses: [],
      rankedApproaches: [],
      identifiedRisks: [],
      activeConstraints: [],
      memberCount: 1,
      consensusConfidence: 0.8,
      verifiedChunkIds: [],
      rules: {
        version: '1.0',
        repo_name: 'planone',
        never_touch: [],
        always_escalate_if: [],
        max_files_changed: 20,
        mutation_scope: 'changed_only'
      },
      synthesizedAt: new Date().toISOString()
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    confirmedFiles: [],
    preloadedFileContents: new Map(),
    repoRoot: '/repo'
  }
}

describe('monitor veto', () => {
  it('recognizes real code symbols and rejects natural-language phrases', () => {
    expect(isCodeSymbol('QueryClient')).toBe(true)
    expect(isCodeSymbol('withTRPC')).toBe(true)
    expect(isCodeSymbol('ssr option handling logic')).toBe(false)
    expect(isCodeSymbol('with TRPC')).toBe(false)
  })

  it('vetoes an out-of-scope symbol that is not a callee', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['GhostSymbol']
    const result = await checkVeto(input, makeClient((name) => {
      if (name === 'symbol_info') {
        return { structuredContent: { symbols: [], total: 0, ambiguous: false } }
      }

      return { structuredContent: { results: [], total: 0, cursor: null } }
    }))
    expect(result.vetoed).toBe(true)
    expect(result.vetoType).toBe('out_of_scope')
  })

  it('does not veto when the out-of-scope symbol is a callee', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['HelperSymbol']
    const result = await checkVeto(input, makeClient((name, args) => {
      if (name === 'callees') {
        return {
          structuredContent: {
            results: typeof args.symbol === 'string' && args.symbol === 'LoginService' ? [{ symbol: 'HelperSymbol' }] : [],
            total: typeof args.symbol === 'string' && args.symbol === 'LoginService' ? 1 : 0,
            cursor: null
          }
        }
      }

      if (name === 'symbol_info') {
        return { structuredContent: { symbols: [], total: 0, ambiguous: false } }
      }

      return { structuredContent: { results: [], total: 0, cursor: null } }
    }))
    expect(result.vetoed).toBe(false)
  })

  it('never vetoes step 0 for out-of-scope symbol discovery', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 0
    input.preActionPlan.affectedSymbols = ['TRPCNextOptions']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('runs scope checks for a continuous step even when stepIndex is 0', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 0
    input.currentStep.phaseHint = 'continuous'
    input.preActionPlan.affectedSymbols = ['GhostSymbol']

    const result = await checkVeto(input, makeClient((name) => {
      if (name === 'symbol_info') {
        return { structuredContent: { symbols: [], total: 0, ambiguous: false } }
      }

      return { structuredContent: { results: [], total: 0, cursor: null } }
    }))

    expect(result.vetoed).toBe(true)
    expect(result.vetoType).toBe('out_of_scope')
  })

  it('does not veto a symbol that shares a file with an in-scope symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.currentStep.affectedSymbols = ['createTRPCNext']
    input.enrichedPacket.affectedSymbols = ['createTRPCNext']
    input.preActionPlan.affectedSymbols = ['TRPCNextOptions']

    const result = await checkVeto(input, makeClient((name, args) => {
      if (name === 'symbol_info') {
        const symbol = typeof args.symbol === 'string' ? args.symbol : ''

        if (symbol === 'createTRPCNext' || symbol === 'TRPCNextOptions') {
          return {
            structuredContent: {
              symbols: [{ symbol_id: `sym-${symbol}`, relative_path: 'packages/next/src/withTRPC.tsx' }],
              total: 1,
              ambiguous: false
            }
          }
        }

        return { structuredContent: { symbols: [], total: 0, ambiguous: false } }
      }

      if (name === 'callees') {
        return { structuredContent: { results: [], total: 0, cursor: null } }
      }

      return { structuredContent: { results: [], total: 0, cursor: null } }
    }))

    expect(result.vetoed).toBe(false)
  })

  it('does not veto when the intendedAction explicitly mentions the symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['WithTRPCSSROptions']
    input.preActionPlan.intendedAction = 'Extend WithTRPCSSROptions interface with forceServerGcTimeInfinity'

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('does not veto a low-risk Options-style symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['WithTRPCSSROptions']
    input.preActionPlan.estimatedRiskLevel = 'low'

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('does not veto a medium-risk Options-style symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['WithTRPCSSROptions']
    input.preActionPlan.estimatedRiskLevel = 'medium'

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('does not treat a file path as an out-of-scope symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['withTRPC.tsx']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('does not veto a low-risk generic Options-style symbol', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['TRPCNextOptions<TRouter>']
    input.preActionPlan.estimatedRiskLevel = 'low'

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('vetoes rules violations from always_escalate_if', async () => {
    const input = makeInput()
    input.rules.always_escalate_if = ['touches auth logic']
    input.preActionPlan.reasoning = 'This touches auth logic directly.'
    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))
    expect(result.vetoType).toBe('rules_violation')
  })

  it('vetoes security-sensitive patterns', async () => {
    const input = makeInput()
    input.preActionPlan.intendedAction = 'Add exec() helper'
    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))
    expect(result.vetoType).toBe('security_concern')
  })

  it('vetoes never_touch glob matches', async () => {
    const input = makeInput()
    input.rules.never_touch = ['src/secrets/**']
    input.preActionPlan.affectedSymbols = ['src/secrets/config.ts:SecretConfig']
    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))
    expect(result.vetoType).toBe('never_touch_violation')
  })

  it('returns a non-veto result when nothing triggers', async () => {
    const result = await checkVeto(makeInput(), makeClient(() => ({
      structuredContent: { results: [], total: 0, cursor: null }
    })))
    expect(result.vetoed).toBe(false)
  })

  it('degrades safely on BaseMemory failure', async () => {
    const input = makeInput()
    input.preActionPlan.affectedSymbols = ['GhostSymbol']
    const client = {
      callTool: async () => {
        throw new Error('failure')
      }
    } as unknown as BaseMemoryClient
    const result = await checkVeto(input, client)
    expect(result.vetoed).toBe(false)
  })

  it('does not veto a symbol that belongs to a confirmed discovery file', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['withTRPC']
    input.confirmedFiles = ['packages/next/src/withTRPC.tsx']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('still vetoes symbols that are not in confirmed discovery files or scope', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['GhostSymbol']
    input.confirmedFiles = ['packages/next/src/withTRPC.tsx']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(true)
    expect(result.vetoType).toBe('out_of_scope')
  })

  it('does not veto a symbol that appears in confirmed preloaded file content', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.confirmedFiles = ['packages/next/src/createTRPCNext.tsx']
    input.preloadedFileContents = new Map([
      ['packages/next/src/createTRPCNext.tsx', 'export type TRPCNextHandler = () => void\nexport function createTRPCNext() {}\n']
    ])
    input.preActionPlan.affectedSymbols = ['TRPCNextHandler']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('still vetoes symbols absent from confirmed file content and scope', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.confirmedFiles = ['packages/next/src/createTRPCNext.tsx']
    input.preloadedFileContents = new Map([
      ['packages/next/src/createTRPCNext.tsx', 'export function createTRPCNext() {}\n']
    ])
    input.preActionPlan.affectedSymbols = ['UnrelatedWidget']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(true)
    expect(result.vetoType).toBe('out_of_scope')
  })

  it('does not veto a natural-language phrase in affectedSymbols', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['ssr option handling logic']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })

  it('does not veto when all affectedSymbols are phrases with spaces', async () => {
    const input = makeInput()
    input.currentStep.stepIndex = 1
    input.preActionPlan.affectedSymbols = ['with TRPC', 'ssr option handling logic']

    const result = await checkVeto(input, makeClient(() => ({
      structuredContent: { results: [], symbols: [], total: 0, ambiguous: false, cursor: null }
    })))

    expect(result.vetoed).toBe(false)
  })
})
