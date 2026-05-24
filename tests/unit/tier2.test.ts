import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import type { StepOutput } from '../../src/pipeline/state-machine.js'
import { Tier2Memory } from '../../src/memory/tier2/index.js'

function makeOutput(stepIndex: number, dependencies: number[] = []): StepOutput {
  return {
    stepIndex,
    producedContent: `content-${stepIndex}`,
    affectedFiles: [`src/file-${stepIndex}.ts`],
    causalDependencies: dependencies,
    baseMemoryChunksUsed: [`chunk-${stepIndex}`]
  }
}

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'planone-tier2-'))
  const store = new RawTraceStore(join(directory, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

describe('tier2', () => {
  it('record stores StepOutput correctly', () => {
    const memory = new Tier2Memory('task-1')
    memory.record(makeOutput(1))
    expect(memory.get(1)?.producedContent).toBe('content-1')
  })

  it('get returns null for a missing step index', () => {
    const memory = new Tier2Memory('task-1')
    expect(memory.get(99)).toBeNull()
  })

  it('getDependencyChain returns the correct chain', () => {
    const memory = new Tier2Memory('task-1')
    memory.record(makeOutput(1))
    memory.record(makeOutput(2, [1]))
    expect(memory.getDependencyChain(2).map((record) => record.stepIndex)).toEqual([2, 1])
  })

  it('getDependencyChain is cycle-safe', () => {
    const memory = new Tier2Memory('task-1')
    memory.record(makeOutput(1, [2]))
    memory.record(makeOutput(2, [1]))
    expect(memory.getDependencyChain(1).map((record) => record.stepIndex)).toEqual([1, 2])
  })

  it('toWorkingContentItems returns correct items', () => {
    const memory = new Tier2Memory('task-1')
    memory.record(makeOutput(1))
    const items = memory.toWorkingContentItems()
    expect(items[0]).toMatchObject({ source: 'tier2', chunkId: 'tier2:task-1:1' })
  })

  it('flush writes to RTS before clear', () => {
    const { store, cleanup } = makeStore()

    try {
      const memory = new Tier2Memory('task-1')
      memory.record(makeOutput(1))
      memory.flush(store, 'B')
      expect(store.queryByType('tier2_flush')).toHaveLength(1)
      memory.clear()
      expect(memory.toWorkingContentItems()).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('clear empties the store', () => {
    const memory = new Tier2Memory('task-1')
    memory.record(makeOutput(1))
    memory.clear()
    expect(memory.toWorkingContentItems()).toEqual([])
  })
})
