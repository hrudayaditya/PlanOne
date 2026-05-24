import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/executor/tools.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/tools.js')>('../../src/executor/tools.js')
  return {
    ...actual,
    executeTool: vi.fn(async (name: string) => {
      if (name === 'run_tests') {
        return {
          success: true,
          output: '5 passed 0 failed',
          metadata: { passed: 5, failed: 0, failures: [] }
        }
      }

      return {
        success: false,
        output: '',
        error: 'not available'
      }
    })
  }
})

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { runVerifier } from '../../src/verifier/index.js'
import type { ToolExecutionContext } from '../../src/executor/tools.js'

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-verifier-'))
  const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('verifier integration', () => {
  it('returns a low-confidence pass when mutation is not run', async () => {
    const { store, cleanup } = makeStore()

    try {
      const context: ToolExecutionContext = {
        repoRoot: '/tmp/test-repo',
        taskId: 'task-1',
        stepIndex: -1,
        rts: store,
        abMode: 'B'
      }
      const result = await runVerifier({
        repoRoot: '/tmp/test-repo',
        plan: {
          planId: 'plan-1',
          taskId: 'task-1',
          approach: 'Patch auth branch',
          approachRank: 1,
          steps: [],
          assignedExecutorModel: 'claude-opus-4-5',
          assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
          estimatedStepCount: 1,
          createdAt: new Date().toISOString()
        },
        rules: {
          version: '1.0',
          repo_name: 'planone',
          never_touch: [],
          always_escalate_if: [],
          max_files_changed: 20,
          mutation_scope: 'changed_only'
        },
        taskId: 'task-1',
        abMode: 'B',
        rts: store,
        stepOutputs: [{ stepIndex: 0, producedContent: 'done', affectedFiles: ['a.go'], causalDependencies: [], baseMemoryChunksUsed: [] }]
      }, context)

      expect(result.verdict).toBe('LOW_CONFIDENCE_PASS')
      expect(result.gatesRun).toBe(2)
      expect(result.gatesTotal).toBe(7)
      expect(store.queryByType('verifier_result').length).toBeGreaterThan(0)
      expect(result.verifierModel).toBe('gemini-3.1-flash-lite-preview')
    } finally {
      cleanup()
    }
  })
})
