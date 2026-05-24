import { basename, isAbsolute } from 'node:path'

import { implementationLookup } from '../basememory/tools.js'
import type { BaseMemoryClient } from '../basememory/client.js'
import { logInfo, logWarn } from '../utils/logger.js'
import type { CitedClaim, PanelMemberAnalysis } from './member.js'

export type CitationVerificationMethod = 'structural' | 'search' | 'rejected'

/**
 * Structured output of the mechanical citation verification pass.
 */
export interface CitationVerificationResult {
  verifiedChunkIds: string[]
  rejectedChunkIds: string[]
  rejectedClaims: CitedClaim[]
  partialClaims: CitedClaim[]
  verifiedClaims: CitedClaim[]
  verificationMethod: CitationVerificationMethod
  verificationMethods: Record<string, CitationVerificationMethod>
}

/**
 * Verifies cited chunk IDs conservatively against BaseMemory.
 *
 * This is a best-effort approximation in Phase 1 and never throws.
 */
export async function verifyCitations(
  analysis: PanelMemberAnalysis,
  client: BaseMemoryClient
): Promise<CitationVerificationResult> {
  try {
    const allClaims = [
      ...analysis.rootCauses,
      ...analysis.suggestedApproaches,
      ...analysis.risks,
      ...analysis.constraints
    ]
    const uniqueChunkIds = [...new Set(allClaims.flatMap((claim) => claim.chunkIds))]
    logInfo('panel:citation', '[Panel:Citation] Verifying chunk IDs', {
      count: uniqueChunkIds.length
    })
    const verifiedChunkIds = new Set<string>()
    const rejectedChunkIds = new Set<string>()
    const verificationMethods: Record<string, CitationVerificationMethod> = {}

    for (const chunkId of uniqueChunkIds) {
      try {
        const method = await verifyChunkIdStructurally(chunkId, client)

        if (method !== 'rejected') {
          verifiedChunkIds.add(chunkId)
          verificationMethods[chunkId] = method
        } else {
          rejectedChunkIds.add(chunkId)
          verificationMethods[chunkId] = 'rejected'
        }
      } catch {
        rejectedChunkIds.add(chunkId)
        verificationMethods[chunkId] = 'rejected'
      }
    }

    const rejectedClaims: CitedClaim[] = []
    const partialClaims: CitedClaim[] = []
    const verifiedClaims: CitedClaim[] = []

    for (const claim of allClaims) {
      const keptChunkIds = claim.chunkIds.filter((chunkId) => verifiedChunkIds.has(chunkId))

      if (keptChunkIds.length === 0) {
        rejectedClaims.push(claim)
      } else if (keptChunkIds.length < claim.chunkIds.length) {
        partialClaims.push({ ...claim, chunkIds: keptChunkIds })
      } else {
        verifiedClaims.push(claim)
      }
    }

    return {
      verifiedChunkIds: [...verifiedChunkIds],
      rejectedChunkIds: [...rejectedChunkIds],
      rejectedClaims,
      partialClaims,
      verifiedClaims,
      verificationMethod: deriveOverallVerificationMethod(verificationMethods),
      verificationMethods
    }
  } catch {
    logWarn('panel:citation', '[Panel:Citation] Verification failed; rejecting all claims')
    return {
      verifiedChunkIds: [],
      rejectedChunkIds: [],
      rejectedClaims: [
        ...analysis.rootCauses,
        ...analysis.suggestedApproaches,
        ...analysis.risks,
        ...analysis.constraints
      ],
      partialClaims: [],
      verifiedClaims: [],
      verificationMethod: 'rejected',
      verificationMethods: {}
    }
  }
}

export function parseChunkId(chunkId: string): {
  filePath: string
  startLine: number
  endLine: number
} | null {
  const match = chunkId.match(/^(.+):(\d+)-(\d+)$/)

  if (match === null) {
    return null
  }

  return {
    filePath: match[1] ?? '',
    startLine: Number.parseInt(match[2] ?? '', 10),
    endLine: Number.parseInt(match[3] ?? '', 10)
  }
}

async function verifyChunkIdStructurally(
  chunkId: string,
  client: BaseMemoryClient
): Promise<CitationVerificationMethod> {
  const parsedChunkId = parseChunkId(chunkId)

  if (parsedChunkId !== null) {
    const filename = basename(parsedChunkId.filePath)
    return doesIndexedFileExist(
      filename,
      parsedChunkId.filePath,
      client,
      isAbsolute(parsedChunkId.filePath) ? 'structural' : 'search'
    )
  }

  if (looksLikeBareFilePath(chunkId)) {
    const filename = basename(chunkId)
    return doesIndexedFileExist(
      filename,
      chunkId,
      client,
      isAbsolute(chunkId) ? 'structural' : 'search'
    )
  }

  return 'rejected'
}

async function doesIndexedFileExist(
  filename: string,
  expectedFilePath: string,
  client: BaseMemoryClient,
  verificationMethod: CitationVerificationMethod
): Promise<CitationVerificationMethod> {
  const response = await implementationLookup({ symbol: filename, limit: 5 }, client)

  return response.results.some((result) => (
    typeof result.file_path === 'string' && (
      result.file_path === expectedFilePath || result.file_path.endsWith(filename)
    )
  ))
    ? verificationMethod
    : 'rejected'
}

function looksLikeBareFilePath(value: string): boolean {
  return value.includes('/') || /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(value)
}

function deriveOverallVerificationMethod(
  verificationMethods: Record<string, CitationVerificationMethod>
): CitationVerificationMethod {
  const methods = Object.values(verificationMethods)

  if (methods.includes('structural')) {
    return 'structural'
  }

  if (methods.includes('search')) {
    return 'search'
  }

  return 'rejected'
}
