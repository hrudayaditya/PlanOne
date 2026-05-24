import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { setIntakeLlmProviderForTesting, type IntakeLlmProvider } from '../../src/intake/llm.js'
import { runReproducer } from '../../src/intake/reproducer.js'
import type { RepoContext } from '../../src/intake/repo-context.js'
import type { TraceEvent } from '../../src/memory/raw-trace-store/index.js'

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-reproducer-'))
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "fixture"\nrequires-python = ">=3.10"\n')

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makeRepoContext(repoRoot: string): RepoContext {
  return {
    repoRoot,
    primaryLanguage: 'Python',
    hasTests: true,
    testFramework: 'pytest',
    packageManager: 'pip',
    language: 'python',
    pythonBinary: 'python3',
    testRunner: 'pytest',
    testFilePattern: 'test_*.py',
    testCommand: 'python3 -m pytest'
  }
}

function makeTraceStore(): { events: TraceEvent[]; append: (event: TraceEvent) => void } {
  const events: TraceEvent[] = []
  return {
    events,
    append(event: TraceEvent): void {
      events.push(event)
    }
  }
}

afterEach(() => {
  setIntakeLlmProviderForTesting(null)
})

describe('reproducer', () => {
  it('captures a traceback from a runnable Python reproducer', async () => {
    const { root, cleanup } = makeRepo()
    const traceStore = makeTraceStore()
    setIntakeLlmProviderForTesting({
      async generateJson() {
        throw new Error('not used')
      },
      async generateText() {
        return {
          model: 'gemini-2.5-flash',
          text: [
            'class BaseMeta(type):',
            '    @property',
            '    def __members__(cls):',
            "        raise RuntimeError('boom')",
            '',
            'class Parent(metaclass=BaseMeta):',
            '    pass',
            '',
            'print(Parent.__members__)'
          ].join('\n')
        }
      }
    } satisfies IntakeLlmProvider)

    try {
      const result = await runReproducer({
        taskId: 'task-1',
        rawTask: 'issue text',
        repoContext: makeRepoContext(root),
        abMode: 'B',
        rts: traceStore
      })

      expect(result.attempted).toBe(true)
      expect(result.succeeded).toBe(true)
      expect(result.traceback).toContain('RuntimeError: boom')
      expect(result.reproducerCode).toContain('class BaseMeta')
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toContain('reproducer_entry')
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toContain('reproducer_exit_runtime_error')
    } finally {
      cleanup()
    }
  })

  it('returns not attempted when no reproducer can be extracted', async () => {
    const { root, cleanup } = makeRepo()
    const traceStore = makeTraceStore()
    setIntakeLlmProviderForTesting({
      async generateJson() {
        throw new Error('not used')
      },
      async generateText() {
        return {
          model: 'gemini-2.5-flash',
          text: 'NO_REPRODUCER'
        }
      }
    } satisfies IntakeLlmProvider)

    try {
      const result = await runReproducer({
        taskId: 'task-2',
        rawTask: 'issue text',
        repoContext: makeRepoContext(root),
        abMode: 'B',
        rts: traceStore
      })

      expect(result.attempted).toBe(false)
      expect(result.succeeded).toBe(false)
      expect(result.traceback).toBeNull()
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toEqual([
        'reproducer_entry',
        'reproduction_extract',
        'reproducer_exit_no_reproducer'
      ])
    } finally {
      cleanup()
    }
  })

  it('marks import errors as failed reproduction attempts without traceback signal', async () => {
    const { root, cleanup } = makeRepo()
    const traceStore = makeTraceStore()
    setIntakeLlmProviderForTesting({
      async generateJson() {
        throw new Error('not used')
      },
      async generateText() {
        return {
          model: 'gemini-2.5-flash',
          text: 'import definitely_missing_module\nprint("hello")'
        }
      }
    } satisfies IntakeLlmProvider)

    try {
      const result = await runReproducer({
        taskId: 'task-3',
        rawTask: 'issue text',
        repoContext: makeRepoContext(root),
        abMode: 'B',
        rts: traceStore
      })

      expect(result.attempted).toBe(true)
      expect(result.succeeded).toBe(false)
      expect(result.traceback).toBeNull()
      expect(result.output).toContain('ModuleNotFoundError')
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toContain('reproducer_exit_run_failure')
    } finally {
      cleanup()
    }
  })

  it('rewrites trailing Python expressions into an assertion failure signal', async () => {
    const { root, cleanup } = makeRepo()
    const traceStore = makeTraceStore()
    setIntakeLlmProviderForTesting({
      async generateJson() {
        throw new Error('not used')
      },
      async generateText() {
        return {
          model: 'gemini-2.5-flash',
          text: [
            'value = 1',
            '',
            'value',
            '2'
          ].join('\n')
        }
      }
    } satisfies IntakeLlmProvider)

    try {
      const result = await runReproducer({
        taskId: 'task-5',
        rawTask: 'issue text',
        repoContext: makeRepoContext(root),
        abMode: 'B',
        rts: traceStore
      })

      expect(result.attempted).toBe(true)
      expect(result.succeeded).toBe(true)
      expect(result.traceback).toContain('AssertionError')
      expect(result.reproducerCode).toContain('__planone_observed_0 = value')
      expect(result.reproducerCode).toContain('__planone_observed_1 = 2')
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toContain('reproducer_script_augmented')
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toContain('reproducer_exit_runtime_error')
    } finally {
      cleanup()
    }
  })

  it('logs a visible early exit when the provider cannot generate text', async () => {
    const { root, cleanup } = makeRepo()
    const traceStore = makeTraceStore()
    setIntakeLlmProviderForTesting({
      async generateJson() {
        throw new Error('not used')
      }
    } satisfies IntakeLlmProvider)

    try {
      const result = await runReproducer({
        taskId: 'task-4',
        rawTask: 'issue text',
        repoContext: makeRepoContext(root),
        abMode: 'B',
        rts: traceStore
      })

      expect(result.attempted).toBe(false)
      expect(traceStore.events.map((event) => JSON.parse(event.content_json).operation)).toEqual([
        'reproducer_entry',
        'reproducer_exit_generate_text_unavailable'
      ])
    } finally {
      cleanup()
    }
  })
})
