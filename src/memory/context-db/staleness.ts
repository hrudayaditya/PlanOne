import type { ContextChunk } from './schema.js'

/**
 * Staleness penalty breakdown used for ContextDB ranking.
 */
export interface StalenessScore {
  age_penalty: number
  symbol_changed_penalty: number
  total_penalty: number
  effective_quality: number
}

/**
 * Computes Phase 1 staleness penalties for a ContextDB entry.
 */
export function computeStaleness(chunk: ContextChunk, divergenceScore: number): StalenessScore {
  const ageDays = (Date.now() - Date.parse(chunk.created_at)) / (1000 * 60 * 60 * 24)
  const agePenalty = ageDays <= 7
    ? 0
    : ageDays <= 30
      ? 0.1
      : ageDays <= 60
        ? 0.3
        : ageDays <= 90
          ? 0.6
          : 1
  const symbolChangedPenalty = Math.min(0.8, Math.max(0, divergenceScore) * 0.8)
  const totalPenalty = Number(((agePenalty * 0.4) + (symbolChangedPenalty * 0.6)).toFixed(4))
  const rawEffectiveQuality = chunk.memory_quality_score * (1 - totalPenalty)
  const effectiveQuality = Math.min(
    chunk.memory_quality_score,
    Math.max(0, Number(rawEffectiveQuality.toFixed(4)))
  )

  return {
    age_penalty: agePenalty,
    symbol_changed_penalty: symbolChangedPenalty,
    total_penalty: totalPenalty,
    effective_quality: effectiveQuality
  }
}
