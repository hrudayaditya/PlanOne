import { describe, expect, it, vi } from 'vitest'

import { compressWorkingContent, type CompressionLlmProvider } from '../../src/executor/compression.js'
import type { WorkingContentItem } from '../../src/pipeline/context-budget.js'

function makeProvider(implementation: CompressionLlmProvider['distill']): CompressionLlmProvider {
  return {
    distill: vi.fn(implementation)
  }
}

describe('compression', () => {
  it('returns an empty result for empty input', async () => {
    const provider = makeProvider(async () => 'unused')
    const result = await compressWorkingContent({
      items: [],
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(result).toEqual({
      compressed: [],
      originalTokens: 0,
      compressedTokens: 0,
      compressionRatio: 1,
      deduplicatedCount: 0
    })
    expect(provider.distill).not.toHaveBeenCalled()
  })

  it('returns items as-is when already within budget', async () => {
    const provider = makeProvider(async () => 'unused')
    const items: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'alpha', source: 'basememory', tokens: 2 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 1_000,
      taskContext: 'task'
    }, provider)

    expect(result.compressed).toHaveLength(1)
    expect(result.compressedTokens).toBeLessThanOrEqual(1_000)
    expect(provider.distill).not.toHaveBeenCalled()
  })

  it('does not distill preload items even when over budget', async () => {
    const provider = makeProvider(async () => 'compressed')
    const items: WorkingContentItem[] = [
      { chunkId: 'preload:target.ts', content: 'large content '.repeat(300), source: 'tier2', tokens: 5_000 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(result.compressed[0]?.content).toContain('large content')
    expect(provider.distill).not.toHaveBeenCalled()
  })

  it('does not distill read_this_step items even when over budget', async () => {
    const provider = makeProvider(async () => 'compressed')
    const items: WorkingContentItem[] = [
      { chunkId: 'read_this_step:target.ts', content: 'large content '.repeat(300), source: 'tier2', tokens: 5_000 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(result.compressed[0]?.content).toContain('large content')
    expect(provider.distill).not.toHaveBeenCalled()
  })

  it('does not distill small structured metadata items', async () => {
    const provider = makeProvider(async () => 'compressed')
    const items: WorkingContentItem[] = [
      { chunkId: 'tier2:task-1:0', content: '{"stepIndex":0,"affectedFiles":["a.ts"]}', source: 'tier2', tokens: 50 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 10,
      taskContext: 'task'
    }, provider)

    expect(result.compressed[0]?.content).toContain('"stepIndex":0')
    expect(provider.distill).not.toHaveBeenCalled()
  })

  it('calls distill when items exceed the target token budget', async () => {
    const provider = makeProvider(async () => 'small')
    const items: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'large content '.repeat(5_000), source: 'basememory', tokens: 5_000 }
    ]

    await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(provider.distill).toHaveBeenCalledTimes(1)
  })

  it('keeps the original deduplicated content when compression expands content', async () => {
    const provider = makeProvider(async () => 'expansion '.repeat(2_000))
    const items: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'small', source: 'basememory', tokens: 200 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 10,
      taskContext: 'task'
    }, provider)

    expect(result.compressed[0]?.content).toBe('small')
  })

  it('deduplicates adjacent same-file items', async () => {
    const provider = makeProvider(async () => 'unused')
    const items: WorkingContentItem[] = [
      { chunkId: 'basememory:file.ts:10-20', content: 'first', source: 'basememory', tokens: 10 },
      { chunkId: 'basememory:file.ts:21-25', content: 'second', source: 'basememory', tokens: 10 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 10_000,
      taskContext: 'task'
    }, provider)

    expect(result.compressed).toHaveLength(1)
    expect(result.deduplicatedCount).toBe(1)
    expect(result.compressed[0]?.content).toContain('merged adjacent context')
  })

  it('never exceeds original tokens after successful compression', async () => {
    const provider = makeProvider(async () => 'small distilled summary')
    const items: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'large content '.repeat(200), source: 'basememory', tokens: 5_000 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens)
  })

  it('falls back to deduplicated content when the provider fails', async () => {
    const provider = makeProvider(async () => {
      throw new Error('distill failed')
    })
    const items: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'large content '.repeat(200), source: 'basememory', tokens: 5_000 }
    ]

    const result = await compressWorkingContent({
      items,
      model: 'gpt-4o',
      targetTokenBudget: 100,
      taskContext: 'task'
    }, provider)

    expect(result.compressed[0]?.content).toContain('large content')
  })
})
