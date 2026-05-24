import { logWarn } from '../utils/logger.js'
import { countTokens } from '../utils/tokens.js'
import type { WorkingContentItem } from '../pipeline/context-budget.js'

/**
 * Input to the context compression module.
 */
export interface CompressionInput {
  items: WorkingContentItem[]
  model: string
  targetTokenBudget: number
  taskContext: string
}

const NEVER_COMPRESS_PREFIXES = [
  'preload:',
  'read_this_step:',
  'anchor:'
]
const NEVER_COMPRESS_IF_SMALL = 2_000
const SKIP_COMPRESSION_TOKEN_THRESHOLD = 100

/**
 * Result of deduplication and optional distillation.
 */
export interface CompressionResult {
  compressed: WorkingContentItem[]
  originalTokens: number
  compressedTokens: number
  compressionRatio: number
  deduplicatedCount: number
}

/**
 * Mockable provider used for LLM-based distillation.
 */
export interface CompressionLlmProvider {
  /**
   * Distills content for task-focused context reduction.
   */
  distill(
    content: string,
    taskContext: string,
    model: string
  ): Promise<string>
}

/**
 * Deduplicates and optionally distills working content before budget checks.
 *
 * This function never truncates. If distillation fails or expands the content,
 * it falls back to the mechanically deduplicated result.
 */
export async function compressWorkingContent(
  input: CompressionInput,
  provider: CompressionLlmProvider
): Promise<CompressionResult> {
  const originalTokens = input.items.reduce((sum, item) => sum + Math.max(0, item.tokens), 0)

  if (input.items.length === 0) {
    return {
      compressed: [],
      originalTokens: 0,
      compressedTokens: 0,
      compressionRatio: 1,
      deduplicatedCount: 0
    }
  }

  const deduplicated = deduplicateItems(input.items, input.model)
  const deduplicatedCount = input.items.length - deduplicated.length
  const deduplicatedTokens = deduplicated.reduce((sum, item) => sum + item.tokens, 0)

  if (deduplicatedTokens <= input.targetTokenBudget) {
    return {
      compressed: deduplicated,
      originalTokens,
      compressedTokens: deduplicatedTokens,
      compressionRatio: originalTokens === 0 ? 1 : Number((deduplicatedTokens / originalTokens).toFixed(4)),
      deduplicatedCount
    }
  }

  const itemsToCompress = deduplicated.filter((item) => isCompressible(item))

  if (itemsToCompress.length === 0) {
    return {
      compressed: deduplicated,
      originalTokens,
      compressedTokens: deduplicatedTokens,
      compressionRatio: originalTokens === 0 ? 1 : Number((deduplicatedTokens / originalTokens).toFixed(4)),
      deduplicatedCount
    }
  }

  try {
    const distilledCompressibleItems = await Promise.all(itemsToCompress.map(async (item) => {
      const distilledContent = await provider.distill(item.content, input.taskContext, input.model)
      return {
        ...item,
        content: distilledContent,
        tokens: countTokens(distilledContent, input.model)
      }
    }))
    const distilled = deduplicated.map((item) => {
      const compressedIndex = itemsToCompress.findIndex((candidate) => candidate.chunkId === item.chunkId)
      return compressedIndex >= 0
        ? distilledCompressibleItems[compressedIndex] ?? item
        : item
    })
    const distilledTokens = distilled.reduce((sum, item) => sum + item.tokens, 0)

    if (distilledTokens >= originalTokens) {
      logWarn('compression', 'Compression expanded content; keeping deduplicated items.', {
        originalTokens,
        distilledTokens
      })

      return {
        compressed: deduplicated,
        originalTokens,
        compressedTokens: deduplicatedTokens,
        compressionRatio: originalTokens === 0 ? 1 : Number((deduplicatedTokens / originalTokens).toFixed(4)),
        deduplicatedCount
      }
    }

    return {
      compressed: distilled,
      originalTokens,
      compressedTokens: distilledTokens,
      compressionRatio: originalTokens === 0 ? 1 : Number((distilledTokens / originalTokens).toFixed(4)),
      deduplicatedCount
    }
  } catch (error) {
    logWarn('compression', 'Compression provider failed; using deduplicated items.', {
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    return {
      compressed: deduplicated,
      originalTokens,
      compressedTokens: deduplicatedTokens,
      compressionRatio: originalTokens === 0 ? 1 : Number((deduplicatedTokens / originalTokens).toFixed(4)),
      deduplicatedCount
    }
  }
}

function isCompressible(item: WorkingContentItem): boolean {
  if (NEVER_COMPRESS_PREFIXES.some((prefix) => item.chunkId.startsWith(prefix))) {
    return false
  }

  if (item.tokens < SKIP_COMPRESSION_TOKEN_THRESHOLD) {
    return false
  }

  if (item.tokens < NEVER_COMPRESS_IF_SMALL) {
    return false
  }

  const trimmed = item.content.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return false
  }

  return true
}

function deduplicateItems(items: WorkingContentItem[], model: string): WorkingContentItem[] {
  const sortedItems = [...items].sort((left, right) => left.chunkId.localeCompare(right.chunkId))
  const deduplicated: WorkingContentItem[] = []

  for (const item of sortedItems) {
    const previous = deduplicated[deduplicated.length - 1]

    if (previous !== undefined && canMerge(previous.chunkId, item.chunkId)) {
      const mergedContent = `${previous.content}\n/* merged adjacent context */\n${item.content}`
      const canonicalId = previous.chunkId.localeCompare(item.chunkId) <= 0 ? previous.chunkId : item.chunkId

      deduplicated[deduplicated.length - 1] = {
        chunkId: canonicalId,
        content: mergedContent,
        source: previous.source,
        tokens: countTokens(mergedContent, model),
        score: mergeScores(previous.score, item.score)
      }
      continue
    }

    deduplicated.push({
      ...item,
      tokens: countTokens(item.content, model)
    })
  }

  return deduplicated
}

function canMerge(leftChunkId: string, rightChunkId: string): boolean {
  const leftLocation = parseChunkLocation(leftChunkId)
  const rightLocation = parseChunkLocation(rightChunkId)

  if (leftLocation === null || rightLocation === null) {
    return false
  }

  return leftLocation.prefix === rightLocation.prefix
    && leftLocation.file === rightLocation.file
    && Math.abs(leftLocation.endLine - rightLocation.startLine) <= 10
}

function parseChunkLocation(chunkId: string): { prefix: string; file: string; startLine: number; endLine: number } | null {
  const match = /^(.*?):([^:]+):(\d+)-(\d+)$/.exec(chunkId)

  if (match === null) {
    return null
  }

  return {
    prefix: match[1] ?? '',
    file: match[2] ?? '',
    startLine: Number(match[3]),
    endLine: Number(match[4])
  }
}

function mergeScores(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined
  }

  return Math.max(left ?? Number.NEGATIVE_INFINITY, right ?? Number.NEGATIVE_INFINITY)
}
