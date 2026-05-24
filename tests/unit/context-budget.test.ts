import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import {
  BudgetOverflowError,
  checkBudget,
  countAnchorTokens,
  countWorkingTokens,
  enforceBudget,
  getModelLimit,
  logBudgetCheck,
  trimWorkingContent,
  type BudgetCheckResult,
  type PermanentAnchorSet,
  type WorkingContentItem
} from '../../src/pipeline/context-budget.js'

function makeAnchors(overrides: Partial<PermanentAnchorSet> = {}): PermanentAnchorSet {
  return {
    taskDescription: '',
    enrichedPacket: '',
    userRepoRules: '',
    currentStepDescription: '',
    ...overrides
  }
}

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-budget-'))
  const dbPath = join(directory, 'trace.db')
  const store = new RawTraceStore(dbPath)

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function findWorkingRawTokensForAdjustedTarget(targetAdjustedTokens: number): number {
  for (let raw = 0; raw <= targetAdjustedTokens; raw += 1) {
    if (Math.ceil(raw * 1.05) === targetAdjustedTokens) {
      return raw
    }
  }

  throw new Error(`Unable to find raw token count for adjusted target ${targetAdjustedTokens}.`)
}

function findAnchorSetForAdjustedTokens(targetAdjustedTokens: number, model: string): PermanentAnchorSet {
  const anchorFor = (repeatCount: number): PermanentAnchorSet => makeAnchors({
    currentStepDescription: 'token '.repeat(repeatCount)
  })

  let low = 0
  let high = Math.max(1, Math.ceil(targetAdjustedTokens / 1.05) + 1_000)

  while (countAnchorTokens(anchorFor(high), model) < targetAdjustedTokens) {
    high *= 2
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const midTokens = countAnchorTokens(anchorFor(mid), model)

    if (midTokens < targetAdjustedTokens) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  for (let repeatCount = Math.max(0, low - 16); repeatCount <= low + 16; repeatCount += 1) {
    const anchors = anchorFor(repeatCount)

    if (countAnchorTokens(anchors, model) === targetAdjustedTokens) {
      return anchors
    }
  }

  throw new Error(`Unable to find anchor set for adjusted target ${targetAdjustedTokens}.`)
}

describe('getModelLimit', () => {
  it('returns the correct limit for a known model', () => {
    expect(getModelLimit('claude-opus-4-5')).toBe(200_000)
  })

  it('returns 128_000 for an unknown model', () => {
    expect(getModelLimit('unknown-model')).toBe(128_000)
  })

  it('never throws', () => {
    expect(() => getModelLimit('')).not.toThrow()
  })
})

describe('checkBudget', () => {
  it('approves empty anchors and empty working content', () => {
    const result = checkBudget({ anchors: makeAnchors(), workingContent: [] }, 'gpt-4o')
    expect(result.approved).toBe(true)
  })

  it('approves anchors at exactly the 60% cap', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const anchors = findAnchorSetForAdjustedTokens(capTokens, model)

    const result = checkBudget({ anchors, workingContent: [] }, model)
    expect(result.approved).toBe(true)
    expect(result.totalTokens).toBe(capTokens)
  })

  it('rejects anchors at cap plus one working token after margin', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const anchors = findAnchorSetForAdjustedTokens(capTokens, model)
    const workingContent: WorkingContentItem[] = [
      { chunkId: 'chunk-1', content: 'x', source: 'basememory', tokens: 1 }
    ]

    const result = checkBudget({ anchors, workingContent }, model)
    expect(result.approved).toBe(false)
  })

  it('approves totals exactly at the cap', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const workingAdjustedTokens = 1_050
    const rawTokens = findWorkingRawTokensForAdjustedTarget(workingAdjustedTokens)
    const anchors = findAnchorSetForAdjustedTokens(capTokens - workingAdjustedTokens, model)

    const result = checkBudget({
      anchors,
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: rawTokens }]
    }, model)

    expect(result.approved).toBe(true)
    expect(result.totalTokens).toBe(capTokens)
  })

  it('rejects totals at cap plus one', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const workingAdjustedTokens = 1_050
    const rawTokens = findWorkingRawTokensForAdjustedTarget(workingAdjustedTokens)
    const anchors = findAnchorSetForAdjustedTokens((capTokens + 1) - workingAdjustedTokens, model)

    const result = checkBudget({
      anchors,
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: rawTokens }]
    }, model)

    expect(result.approved).toBe(false)
    expect(result.totalTokens).toBe(capTokens + 1)
  })

  it('includes all required fields when approved', () => {
    const result = checkBudget({ anchors: makeAnchors(), workingContent: [] }, 'gpt-4o')
    expect(result).toMatchObject({
      approved: true,
      permanentTokens: expect.any(Number),
      workingTokens: expect.any(Number),
      totalTokens: expect.any(Number),
      modelLimit: expect.any(Number),
      capTokens: expect.any(Number),
      utilizationPct: expect.any(Number),
      remainingTokens: expect.any(Number)
    } satisfies BudgetCheckResult)
  })

  it('includes a rejection reason when not approved', () => {
    const result = checkBudget({
      anchors: makeAnchors(),
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 1_000_000 }]
    }, 'gpt-4o')

    expect(result.approved).toBe(false)
    expect(result.rejectionReason).toEqual(expect.any(String))
  })

  it('computes utilization percentage as total/model limit * 100', () => {
    const result = checkBudget({
      anchors: makeAnchors(),
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 100 }]
    }, 'gpt-4o')

    expect(result.utilizationPct).toBe(Number(((result.totalTokens / result.modelLimit) * 100).toFixed(4)))
  })

  it('returns negative remaining tokens when overflowed', () => {
    const result = checkBudget({
      anchors: makeAnchors(),
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 1_000_000 }]
    }, 'gpt-4o')

    expect(result.remainingTokens).toBeLessThan(0)
  })
})

describe('enforceBudget', () => {
  it('throws BudgetOverflowError when the budget is exceeded', () => {
    expect(() => enforceBudget({
      anchors: makeAnchors(),
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 1_000_000 }]
    }, 'gpt-4o')).toThrow(BudgetOverflowError)
  })

  it('attaches the result to BudgetOverflowError', () => {
    try {
      enforceBudget({
        anchors: makeAnchors(),
        workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 1_000_000 }]
      }, 'gpt-4o')
      throw new Error('Expected a budget overflow.')
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetOverflowError)
      expect((error as BudgetOverflowError).result.approved).toBe(false)
    }
  })

  it('does not throw when the budget is not exceeded', () => {
    expect(() => enforceBudget({ anchors: makeAnchors(), workingContent: [] }, 'gpt-4o')).not.toThrow()
  })

  it('returns the budget result when approved', () => {
    const result = enforceBudget({ anchors: makeAnchors(), workingContent: [] }, 'gpt-4o')
    expect(result.approved).toBe(true)
  })
})

describe('safety margin', () => {
  it('turns 1000 raw working tokens into at least 1050 adjusted tokens', () => {
    expect(countWorkingTokens([
      { chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: 1_000 }
    ])).toBeGreaterThanOrEqual(1_050)
  })

  it('applies the margin before cap comparison, not after', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const baseAnchorTokens = countAnchorTokens(makeAnchors(), model)
    const rawTokens = Math.floor((capTokens - baseAnchorTokens) / 1.05)
    const result = checkBudget({
      anchors: makeAnchors(),
      workingContent: [{ chunkId: 'chunk-1', content: 'x', source: 'tier2', tokens: rawTokens + 1 }]
    }, model)

    expect(result.totalTokens).toBe(baseAnchorTokens + Math.ceil((rawTokens + 1) * 1.05))
    expect(result.approved).toBe(result.totalTokens <= capTokens)
  })
})

describe('trimWorkingContent', () => {
  it('drop_last removes items from the end', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const baseAnchorTokens = countAnchorTokens(makeAnchors(), model)
    const rawTokens = findWorkingRawTokensForAdjustedTarget((capTokens + 100) - baseAnchorTokens)
    const items: WorkingContentItem[] = [
      { chunkId: 'first', content: 'a', source: 'tier2', tokens: rawTokens - 100 },
      { chunkId: 'last', content: 'b', source: 'tier2', tokens: 10 }
    ]

    const trimmed = trimWorkingContent(items, makeAnchors(), model, 'drop_last')
    expect(trimmed.map((item) => item.chunkId)).toEqual(['first'])
  })

  it('drop_lowest_score removes the lowest score first', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const baseAnchorTokens = countAnchorTokens(makeAnchors(), model)
    const rawTokens = findWorkingRawTokensForAdjustedTarget((capTokens + 100) - baseAnchorTokens)
    const items: WorkingContentItem[] = [
      { chunkId: 'high', content: 'a', source: 'tier2', tokens: rawTokens - 100, score: 0.9 },
      { chunkId: 'low', content: 'b', source: 'tier2', tokens: 10, score: 0.1 }
    ]

    const trimmed = trimWorkingContent(items, makeAnchors(), model, 'drop_lowest_score')
    expect(trimmed.map((item) => item.chunkId)).toEqual(['high'])
  })

  it('returns an empty array if needed to fit', () => {
    const trimmed = trimWorkingContent([
      { chunkId: 'only', content: 'x', source: 'tier2', tokens: 1_000_000 }
    ], makeAnchors(), 'gpt-4o', 'drop_last')

    expect(trimmed).toEqual([])
  })

  it('never includes anchors because it only handles working content items', () => {
    const items: WorkingContentItem[] = [
      { chunkId: 'item', content: 'x', source: 'tier2', tokens: 10 }
    ]

    const trimmed = trimWorkingContent(items, makeAnchors({ taskDescription: 'anchor' }), 'gpt-4o', 'drop_last')
    expect(trimmed.every((item) => 'chunkId' in item)).toBe(true)
  })

  it('returns content that passes checkBudget after trimming when possible', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const baseAnchorTokens = countAnchorTokens(makeAnchors(), model)
    const rawTokens = findWorkingRawTokensForAdjustedTarget((capTokens + 200) - baseAnchorTokens)
    const items: WorkingContentItem[] = [
      { chunkId: 'keep', content: 'a', source: 'tier2', tokens: rawTokens - 200, score: 0.8 },
      { chunkId: 'drop', content: 'b', source: 'tier2', tokens: 50, score: 0.1 }
    ]

    const trimmed = trimWorkingContent(items, makeAnchors(), model, 'drop_lowest_score')
    expect(checkBudget({ anchors: makeAnchors(), workingContent: trimmed }, model).approved).toBe(true)
  })
})

describe('permanent anchor invariant', () => {
  it('keeps failing when anchors alone exceed the cap', () => {
    const model = 'gpt-4o'
    const capTokens = Math.floor(getModelLimit(model) * 0.6)
    const anchors = findAnchorSetForAdjustedTokens(capTokens + 1, model)

    const trimmed = trimWorkingContent([
      { chunkId: 'item', content: 'x', source: 'tier2', tokens: 10 }
    ], anchors, model, 'drop_last')

    expect(trimmed).toEqual([])
    expect(checkBudget({ anchors, workingContent: trimmed }, model).approved).toBe(false)
  })
})

describe('logBudgetCheck', () => {
  it('logs budget checks for approved results', () => {
    const { store, cleanup } = makeStore()

    try {
      const result = checkBudget({ anchors: makeAnchors(), workingContent: [] }, 'gpt-4o')
      logBudgetCheck(result, store, 'task-approved', 1, 'B')

      expect(store.queryByType('budget_check')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('logs budget overflows for rejected results and keeps the event queryable', () => {
    const { store, cleanup } = makeStore()

    try {
      const result = checkBudget({
        anchors: makeAnchors(),
        workingContent: [{ chunkId: 'overflow', content: 'x', source: 'tier2', tokens: 1_000_000 }]
      }, 'gpt-4o')

      logBudgetCheck(result, store, 'task-overflow', 2, 'A')

      expect(store.queryByType('budget_overflow')).toHaveLength(1)
      expect(store.queryByType('budget_overflow').length).toBeTypeOf('number')
    } finally {
      cleanup()
    }
  })
})
