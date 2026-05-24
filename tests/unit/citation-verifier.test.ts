import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import {
  parseChunkId,
  verifyCitations,
  type CitationVerificationResult
} from '../../src/panel/citation-verifier.js'
import type { PanelMemberAnalysis } from '../../src/panel/member.js'

function makeClient(
  responder: (name: string, args: Record<string, unknown>) => Promise<BaseMemoryToolResult>
): BaseMemoryClient {
  return {
    callTool: (name: string, args: Record<string, unknown> = {}) => responder(name, args)
  } as unknown as BaseMemoryClient
}

function makeAnalysis(chunkIds: string[]): PanelMemberAnalysis {
  return {
    memberId: 'member-1',
    model: 'gemini-3.1-flash-lite-preview',
    taskUnderstanding: 'task',
    rootCauses: [{ claim: 'Root', chunkIds, confidence: 0.9, claimType: 'root_cause' }],
    affectedSymbols: [],
    suggestedApproaches: [],
    risks: [],
    constraints: [],
    retrievedChunkIds: chunkIds,
    analysisTimestamp: new Date().toISOString(),
    tokensUsed: 0,
    costUsd: 0
  }
}

describe('citation verifier', () => {
  it("parseChunkId('/path/file.tsx:42-67') returns file path and line span", () => {
    expect(parseChunkId('/path/file.tsx:42-67')).toEqual({
      filePath: '/path/file.tsx',
      startLine: 42,
      endLine: 67
    })
  })

  it("parseChunkId('file.tsx') returns null", () => {
    expect(parseChunkId('file.tsx')).toBeNull()
  })

  it("parseChunkId('createTRPCNext') returns null", () => {
    expect(parseChunkId('createTRPCNext')).toBeNull()
  })

  it('verifies a valid chunk ID when implementationLookup returns a matching file', async () => {
    const chunkId = '/repo/packages/next/src/createTRPCNext.tsx:42-67'
    const result = await verifyCitations(
      makeAnalysis([chunkId]),
      makeClient(async () => ({
        structuredContent: {
          results: [{ file_path: '/repo/packages/next/src/createTRPCNext.tsx' }],
          total: 1,
          cursor: null,
          expandedContext: []
        }
      }))
    )

    expect(result.verifiedChunkIds).toEqual([chunkId])
    expect(result.verifiedClaims).toHaveLength(1)
    expect(result.verificationMethod).toBe('structural')
    expect(result.verificationMethods[chunkId]).toBe('structural')
  })

  it('rejects a chunk when implementationLookup returns no matching file', async () => {
    const chunkId = '/repo/packages/next/src/createTRPCNext.tsx:42-67'
    const result = await verifyCitations(
      makeAnalysis([chunkId]),
      makeClient(async () => ({
        structuredContent: {
          results: [],
          total: 0,
          cursor: null,
          expandedContext: []
        }
      }))
    )

    expect(result.rejectedChunkIds).toEqual([chunkId])
    expect(result.rejectedClaims).toHaveLength(1)
    expect(result.verificationMethod).toBe('rejected')
    expect(result.verificationMethods[chunkId]).toBe('rejected')
  })

  it('attempts structural verification for a bare file path instead of rejecting immediately', async () => {
    const chunkId = '/repo/packages/next/src/createTRPCNext.tsx'
    const result = await verifyCitations(
      makeAnalysis([chunkId]),
      makeClient(async (_name, args) => {
        expect(args.symbol).toBe('createTRPCNext.tsx')

        return {
          structuredContent: {
            results: [{ file_path: '/repo/packages/next/src/createTRPCNext.tsx' }],
            total: 1,
            cursor: null,
            expandedContext: []
          }
        }
      })
    )

    expect(result.verifiedChunkIds).toEqual([chunkId])
    expect(result.verificationMethods[chunkId]).toBe('structural')
  })

  it('treats a relative local chunk ID as search-verified instead of structural', async () => {
    const chunkId = 'packages/next/src/createTRPCNext.tsx:42-67'
    const result = await verifyCitations(
      makeAnalysis([chunkId]),
      makeClient(async () => ({
        structuredContent: {
          results: [{ file_path: '/repo/packages/next/src/createTRPCNext.tsx' }],
          total: 1,
          cursor: null,
          expandedContext: []
        }
      }))
    )

    expect(result.verifiedChunkIds).toEqual([chunkId])
    expect(result.verificationMethods[chunkId]).toBe('search')
    expect(result.verificationMethod).toBe('search')
  })

  it('rejects a bare symbol name instead of treating it like a file citation', async () => {
    const chunkId = 'createTRPCNext'
    const result = await verifyCitations(
      makeAnalysis([chunkId]),
      makeClient(async () => ({
        structuredContent: {
          results: [{ file_path: '/repo/packages/next/src/createTRPCNext.tsx' }],
          total: 1,
          cursor: null,
          expandedContext: []
        }
      }))
    )

    expect(result.rejectedChunkIds).toEqual([chunkId])
    expect(result.verificationMethods[chunkId]).toBe('rejected')
  })

  it('keeps verificationMethod metadata on the result', async () => {
    const result: CitationVerificationResult = await verifyCitations(
      makeAnalysis(['/repo/packages/next/src/createTRPCNext.tsx:42-67']),
      makeClient(async () => ({
        structuredContent: {
          results: [{ file_path: '/repo/packages/next/src/createTRPCNext.tsx' }],
          total: 1,
          cursor: null,
          expandedContext: []
        }
      }))
    )

    expect(result.verificationMethod).toBe('structural')
    expect(Object.keys(result.verificationMethods)).toHaveLength(1)
  })
})
