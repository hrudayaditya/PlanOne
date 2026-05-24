import type { AbMode } from '../../ab-test/index.js'
import type { BaseMemoryClient } from '../../basememory/client.js'
import { applyAbModeFilter, getAbModeFilter } from './ab-modes.js'
import { runMemoryUseGate, type GateResult } from './memory-use-gate.js'
import { computeStaleness, type StalenessScore } from './staleness.js'
import type { ChunkType, ContextChunk } from './schema.js'

/**
 * Query input routed through the Phase 1 ContextDB ladder.
 */
export interface QueryInput {
  queryText: string
  currentRepo: string
  symbols: string[]
  chunkTypes: ChunkType[]
  abMode: AbMode
  limit: number
}

/**
 * Scored ContextDB retrieval result.
 */
export interface ScoredChunk {
  chunk: ContextChunk
  gate_result: GateResult
  staleness: StalenessScore
  final_score: number
}

/**
 * Serializable result of a ContextDB query route.
 */
export interface QueryResult {
  chunks: ScoredChunk[]
  tier_used: 'primary' | 'secondary' | 'tertiary' | 'fallback'
  gate_results: GateResult[]
  bypassed: boolean
}

/**
 * Routes a ContextDB query through the primary/secondary/tertiary/fallback ladder.
 *
 * This function never throws. Empty results and bypassed mode A are valid
 * outputs and are returned explicitly.
 */
export async function routeQuery(
  input: QueryInput,
  store: Map<string, ContextChunk>,
  client: BaseMemoryClient
): Promise<QueryResult> {
  try {
    const filter = getAbModeFilter(input.abMode)

    if (filter.bypassContextDb) {
      return {
        chunks: [],
        tier_used: 'fallback',
        gate_results: [],
        bypassed: true
      }
    }

    const allChunks = [...store.values()]
    const tiers: Array<{
      name: QueryResult['tier_used']
      match: (chunk: ContextChunk) => boolean
    }> = [
      {
        name: 'primary',
        match: (chunk) => chunk.repo === input.currentRepo && chunk.symbols.some((symbol) => input.symbols.includes(symbol))
      },
      {
        name: 'secondary',
        match: (chunk) => chunk.repo === input.currentRepo && input.chunkTypes.includes(chunk.chunk_type)
      },
      {
        name: 'tertiary',
        match: (chunk) => input.chunkTypes.includes(chunk.chunk_type)
      }
    ]

    for (const tier of tiers) {
      const matchedChunks = allChunks.filter(tier.match)
      const filteredChunks = applyAbModeFilter(matchedChunks, filter, input.currentRepo)
      const evaluated = await scoreChunks(filteredChunks, client, input.limit)

      if (evaluated.chunks.length >= 1) {
        return {
          chunks: evaluated.chunks,
          tier_used: tier.name,
          gate_results: evaluated.gateResults,
          bypassed: false
        }
      }
    }

    return {
      chunks: [],
      tier_used: 'fallback',
      gate_results: [],
      bypassed: false
    }
  } catch {
    return {
      chunks: [],
      tier_used: 'fallback',
      gate_results: [],
      bypassed: input.abMode === 'A'
    }
  }
}

async function scoreChunks(
  chunks: ContextChunk[],
  client: BaseMemoryClient,
  limit: number
): Promise<{ chunks: ScoredChunk[]; gateResults: GateResult[] }> {
  const scored: ScoredChunk[] = []
  const gateResults: GateResult[] = []

  for (const chunk of chunks) {
    const gateResult = await runMemoryUseGate(chunk, client)
    gateResults.push(gateResult)

    const modifier = getGateVerdictModifier(gateResult.verdict)

    if (modifier === 0) {
      continue
    }

    const staleness = computeStaleness(chunk, gateResult.divergence_score)
    const finalScore = Number((staleness.effective_quality * modifier).toFixed(4))

    scored.push({
      chunk,
      gate_result: gateResult,
      staleness,
      final_score: finalScore
    })
  }

  scored.sort((left, right) => right.final_score - left.final_score)

  return {
    chunks: scored.slice(0, Math.max(0, limit)),
    gateResults
  }
}

function getGateVerdictModifier(verdict: GateResult['verdict']): number {
  if (verdict === 'ACTIVE') {
    return 1
  }

  if (verdict === 'DOWNRANK') {
    return 0.6
  }

  if (verdict === 'LOW_CONFIDENCE') {
    return 0.4
  }

  if (verdict === 'FAILURE_ONLY') {
    return 0.2
  }

  return 0
}
