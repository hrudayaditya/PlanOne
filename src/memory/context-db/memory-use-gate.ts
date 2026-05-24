import { callGraphDivergence, symbolExists, symbolInfo } from '../../basememory/tools.js'
import type { BaseMemoryClient } from '../../basememory/client.js'
import type { ApproachChunk, ContextChunk, SymbolChunk } from './schema.js'

/**
 * Possible verdicts from the Memory Use Gate.
 */
export type GateVerdict =
  | 'ACTIVE'
  | 'DOWNRANK'
  | 'LOW_CONFIDENCE'
  | 'FAILURE_ONLY'
  | 'QUARANTINE'
  | 'ARCHIVED'

/**
 * Structured result of a Memory Use Gate evaluation.
 */
export interface GateResult {
  verdict: GateVerdict
  chunk_id: string
  reasons: string[]
  divergence_score: number
  symbols_verified: string[]
  symbols_missing: string[]
  checked_at: string
}

/**
 * Re-grounds a ContextDB entry against the current BaseMemory state.
 *
 * This function never throws. Unexpected BaseMemory failures produce a safe
 * low-confidence result instead of breaking the pipeline.
 */
export async function runMemoryUseGate(
  chunk: ContextChunk,
  client: BaseMemoryClient
): Promise<GateResult> {
  const checkedAt = new Date().toISOString()
  const reasons: string[] = []

  try {
    const symbolsVerified: string[] = []
    const symbolsMissing: string[] = []

    for (const symbol of chunk.symbols) {
      const exists = await safeSymbolExists(symbol, client)

      if (exists) {
        symbolsVerified.push(symbol)
      } else {
        symbolsMissing.push(symbol)
      }
    }

    if (symbolsMissing.length === chunk.symbols.length && chunk.symbols.length > 0) {
      return buildGateResult({
        verdict: 'QUARANTINE',
        chunk,
        reasons: ['All referenced symbols have been deleted'],
        divergenceScore: 1,
        symbolsVerified,
        symbolsMissing,
        checkedAt
      })
    }

    if (symbolsMissing.length > 0) {
      reasons.push('Some referenced symbols are missing from BaseMemory.')
    }

    const divergenceScores: number[] = []

    for (const symbol of symbolsVerified) {
      divergenceScores.push(await safeCallGraphDivergence(chunk, symbol, client))
    }

    const divergenceScore = divergenceScores.length === 0
      ? 0
      : Number((divergenceScores.reduce((sum, score) => sum + score, 0) / divergenceScores.length).toFixed(4))

    if (divergenceScore > 0.7) {
      return buildGateResult({
        verdict: 'QUARANTINE',
        chunk,
        reasons: [...reasons, 'Call graph has diverged significantly'],
        divergenceScore,
        symbolsVerified,
        symbolsMissing,
        checkedAt
      })
    }

    if (divergenceScore > 0.4) {
      reasons.push('Call graph divergence is elevated.')
    }

    for (const condition of chunk.invalid_if) {
      const triggered = await evaluateInvalidationCondition(chunk, condition, divergenceScore, client)

      if (triggered) {
        return buildGateResult({
          verdict: 'QUARANTINE',
          chunk,
          reasons: [...reasons, `Invalidation condition met: ${condition.description}`],
          divergenceScore,
          symbolsVerified,
          symbolsMissing,
          checkedAt
        })
      }

      if (condition.type === 'file_deleted' || condition.type === 'contradiction_detected') {
        reasons.push(`Invalidation condition unchecked in Phase 1: ${condition.description}`)
      }
    }

    let verdict: GateVerdict

    if (chunk.memory_quality_score >= 0.8) {
      verdict = symbolsMissing.length === 0 && divergenceScore < 0.2 ? 'ACTIVE' : 'DOWNRANK'
    } else if (chunk.memory_quality_score >= 0.5) {
      verdict = symbolsMissing.length === 0 ? 'DOWNRANK' : 'LOW_CONFIDENCE'
    } else if (chunk.chunk_type === 'approach' && chunk.failed_for.length > 0) {
      verdict = 'FAILURE_ONLY'
    } else {
      verdict = 'ARCHIVED'
    }

    const hasAgeCondition = chunk.invalid_if.some((condition) => condition.type === 'age_exceeded')
    const ageDays = daysSince(chunk.created_at)

    if (!hasAgeCondition) {
      if (ageDays > 90) {
        verdict = 'ARCHIVED'
        reasons.push('Archived by default age policy (> 90 days old).')
      } else if (ageDays > 60 && verdict === 'ACTIVE') {
        verdict = 'DOWNRANK'
        reasons.push('Downranked by default age policy (> 60 days old).')
      }
    }

    return buildGateResult({
      verdict,
      chunk,
      reasons,
      divergenceScore,
      symbolsVerified,
      symbolsMissing,
      checkedAt
    })
  } catch (error) {
    return buildGateResult({
      verdict: 'LOW_CONFIDENCE',
      chunk,
      reasons: [`Memory Use Gate degraded safely after an unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      divergenceScore: 1,
      symbolsVerified: [],
      symbolsMissing: [...chunk.symbols],
      checkedAt
    })
  }
}

async function evaluateInvalidationCondition(
  chunk: ContextChunk,
  condition: ContextChunk['invalid_if'][number],
  divergenceScore: number,
  client: BaseMemoryClient
): Promise<boolean> {
  switch (condition.type) {
    case 'symbol_deleted':
      return condition.symbol !== undefined ? !(await safeSymbolExists(condition.symbol, client)) : false
    case 'file_deleted':
      return false
    case 'call_graph_changed':
      return divergenceScore > 0.3
    case 'age_exceeded':
      return condition.max_age_days !== undefined ? daysSince(chunk.created_at) > condition.max_age_days : false
    case 'approach_failed':
      return chunk.chunk_type === 'approach' && chunk.failed_for.length > chunk.worked_for.length
    case 'contradiction_detected':
      return false
    case 'symbol_moved':
      if (condition.symbol === undefined) {
        return false
      }

      return await hasSymbolMoved(chunk, condition.symbol, client)
    default:
      return false
  }
}

async function hasSymbolMoved(chunk: ContextChunk, symbol: string, client: BaseMemoryClient): Promise<boolean> {
  const info = await safeSymbolInfo(symbol, client)
  const currentFilePath = info.results[0]?.file_path
  const expectedFilePath = getExpectedFilePath(chunk, symbol)

  if (expectedFilePath === null || currentFilePath === undefined) {
    return false
  }

  return currentFilePath !== expectedFilePath
}

function getExpectedFilePath(chunk: ContextChunk, symbol: string): string | null {
  if (chunk.chunk_type === 'symbol') {
    return chunk.symbol_name === symbol ? chunk.file_path : null
  }

  if (chunk.chunk_type === 'test') {
    return chunk.covers_symbols.includes(symbol) ? chunk.test_file : null
  }

  return null
}

async function safeSymbolExists(symbol: string, client: BaseMemoryClient): Promise<boolean> {
  try {
    return await symbolExists(symbol, undefined, client)
  } catch {
    return false
  }
}

async function safeSymbolInfo(symbol: string, client: BaseMemoryClient) {
  try {
    return await symbolInfo({ symbol, limit: 1 }, client)
  } catch {
    return { results: [], total: 0, cursor: undefined }
  }
}

async function safeCallGraphDivergence(chunk: ContextChunk, symbol: string, client: BaseMemoryClient): Promise<number> {
  try {
    return await callGraphDivergence(symbol, {
      symbolId: chunk.base_memory_snapshot.symbol_ids[0] ?? '',
      callers: [],
      callees: [],
      callGraphHash: chunk.base_memory_snapshot.call_graph_hash
    }, client)
  } catch {
    return 1
  }
}

function buildGateResult(input: {
  verdict: GateVerdict
  chunk: ContextChunk
  reasons: string[]
  divergenceScore: number
  symbolsVerified: string[]
  symbolsMissing: string[]
  checkedAt: string
}): GateResult {
  return {
    verdict: input.verdict,
    chunk_id: input.chunk.chunk_id,
    reasons: input.reasons,
    divergence_score: input.divergenceScore,
    symbols_verified: input.symbolsVerified,
    symbols_missing: input.symbolsMissing,
    checked_at: input.checkedAt
  }
}

function daysSince(isoTimestamp: string): number {
  return (Date.now() - Date.parse(isoTimestamp)) / (1000 * 60 * 60 * 24)
}
