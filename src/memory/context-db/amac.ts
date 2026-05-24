import type { ContextChunk } from './schema.js'

/**
 * Admission control decision for a candidate ContextDB entry.
 */
export interface AMACDecision {
  admitted: boolean
  reason: string
  deduplicated: boolean
  existing_chunk_id?: string
}

/**
 * Decides whether a candidate chunk is admitted into ContextDB.
 */
export async function checkAdmission(
  candidate: ContextChunk,
  existingChunks: ContextChunk[],
  verifierApproved: boolean
): Promise<AMACDecision> {
  if (!verifierApproved) {
    return {
      admitted: false,
      reason: 'Verifier did not approve this task',
      deduplicated: false
    }
  }

  for (const existingChunk of existingChunks) {
    if (existingChunk.chunk_type !== candidate.chunk_type || existingChunk.repo !== candidate.repo) {
      continue
    }

    const overlapRatio = computeSymbolOverlap(candidate.symbols, existingChunk.symbols)

    if (overlapRatio > 0.8) {
      return {
        admitted: false,
        reason: `Merged with existing entry ${existingChunk.chunk_id}`,
        deduplicated: true,
        existing_chunk_id: existingChunk.chunk_id
      }
    }
  }

  if (candidate.memory_quality_score < 0.4) {
    return {
      admitted: false,
      reason: 'Quality score below admission threshold',
      deduplicated: false
    }
  }

  if (candidate.invalid_if.length === 0) {
    return {
      admitted: false,
      reason: 'invalid_if conditions are required',
      deduplicated: false
    }
  }

  if (['symbol', 'approach', 'pattern', 'error'].includes(candidate.chunk_type) && candidate.symbols.length === 0) {
    return {
      admitted: false,
      reason: 'Structural chunk requires symbols',
      deduplicated: false
    }
  }

  return {
    admitted: true,
    reason: 'Admitted',
    deduplicated: false
  }
}

function computeSymbolOverlap(left: string[], right: string[]): number {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const union = new Set([...leftSet, ...rightSet])

  if (union.size === 0) {
    return 0
  }

  let overlap = 0

  for (const symbol of union) {
    if (leftSet.has(symbol) && rightSet.has(symbol)) {
      overlap += 1
    }
  }

  return overlap / union.size
}
