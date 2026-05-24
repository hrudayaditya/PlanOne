import type { AbMode } from '../../ab-test/index.js'
import type { ContextChunk } from './schema.js'

/**
 * Effective ContextDB filtering rules derived from an immutable A/B mode.
 */
export interface AbModeFilter {
  mode: AbMode
  bypassContextDb: boolean
  crossRepoAllowed: boolean
  minQualityScore: number
}

/**
 * Returns the ContextDB filter semantics for a given A/B mode.
 */
export function getAbModeFilter(mode: AbMode): AbModeFilter {
  if (mode === 'A') {
    return { mode, bypassContextDb: true, crossRepoAllowed: true, minQualityScore: 0 }
  }

  if (mode === 'B') {
    return { mode, bypassContextDb: false, crossRepoAllowed: true, minQualityScore: 0 }
  }

  if (mode === 'C') {
    return { mode, bypassContextDb: false, crossRepoAllowed: false, minQualityScore: 0 }
  }

  return { mode, bypassContextDb: false, crossRepoAllowed: true, minQualityScore: 0.8 }
}

/**
 * Applies the A/B mode filter to a list of ContextDB chunks.
 */
export function applyAbModeFilter(
  chunks: ContextChunk[],
  filter: AbModeFilter,
  currentRepo: string
): ContextChunk[] {
  if (filter.bypassContextDb) {
    return []
  }

  return chunks.filter((chunk) => {
    const repoAllowed = chunk.repo === currentRepo || filter.crossRepoAllowed
    const qualityAllowed = chunk.memory_quality_score >= filter.minQualityScore
    return repoAllowed && qualityAllowed
  })
}
