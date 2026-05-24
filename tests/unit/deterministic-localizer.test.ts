import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { IntakeResult } from '../../src/intake/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import {
  buildFileTree,
  runDeterministicLocalization,
  type LocalizationResult
} from '../../src/panel/deterministic-localizer.js'
import type { PanelMemberLlmProvider } from '../../src/panel/member.js'

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-localizer-'))
  mkdirSync(join(root, 'astroid'), { recursive: true })
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '__pycache__'), { recursive: true })

  writeFileSync(join(root, 'astroid/scoped_nodes.py'), [
    'class LookupMixIn:',
    '    def igetattr(self, name, context=None):',
    '        return self._get_attribute_from_metaclass(name, context)',
    '',
    'def helper():',
    '    return None'
  ].join('\n'))
  writeFileSync(join(root, 'astroid/helpers.py'), 'def helper_fn():\n    return True\n')
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'export const ignored = true\n')
  writeFileSync(join(root, '__pycache__/junk.pyc'), '')

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makeStore(): { store: RawTraceStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-localizer-trace-'))
  const store = new RawTraceStore(join(root, 'trace.db'))

  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function makeIntake(repoRoot: string, task?: string): IntakeResult {
  return {
    taskId: 'task-localizer',
    abMode: 'B',
    enhancedTask: {
      original: task ?? 'Fix metaclass property inference in astroid/scoped_nodes.py\nTraceback\n  File "astroid/scoped_nodes.py", line 2, in igetattr',
      structured_description: 'Fix metaclass property inference in astroid/scoped_nodes.py',
      task_type: 'bug_fix',
      affected_area: 'astroid',
      likely_files: ['astroid/scoped_nodes.py'],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.9
    },
    classification: {
      complexity: 'MODERATE',
      confidence: 0.8,
      rationale: 'localized bug',
      estimated_steps: 2,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'astroid',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 10,
      mutation_scope: 'changed_only'
    },
    repoContext: {
      repoRoot,
      primaryLanguage: 'Python',
      hasTests: true,
      testFramework: 'pytest',
      packageManager: 'unknown',
      language: 'python',
      pythonBinary: 'python3',
      testRunner: 'pytest',
      testFilePattern: 'test_*.py',
      testCommand: 'python3 -m pytest'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

describe('deterministic localizer', () => {
  it('buildFileTree excludes node_modules, __pycache__, and .git', () => {
    const { root, cleanup } = makeRepo()

    try {
      const tree = buildFileTree(root)
      expect(tree).toContain('astroid/')
      expect(tree).toContain('scoped_nodes.py')
      expect(tree).not.toContain('node_modules/')
      expect(tree).not.toContain('__pycache__/')
      expect(tree).not.toContain('.git/')
    } finally {
      cleanup()
    }
  })

  it('discards hallucinated file paths and invented symbols during deterministic localization', async () => {
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore()

    const provider: PanelMemberLlmProvider = {
      async analyze(prompt: string) {
        if (prompt.includes('### Repository Structure ###')) {
          return {
            text: ['`ghost/not-real.py`', '`astroid/scoped_nodes.py`'].join('\n'),
            tokensUsed: 5,
            costUsd: 0
          }
        }

        return {
          text: [
            'astroid/scoped_nodes.py',
            '    function: igetattr',
            '    function: invented_symbol'
          ].join('\n'),
          tokensUsed: 5,
          costUsd: 0
        }
      }
    }

    try {
      const result = await runDeterministicLocalization({
        intake: makeIntake(root),
        provider,
        rts: store
      })

      expect(result.localizationMethod).toBe('deterministic')
      expect(result.files.map((file) => file.path)).toEqual(['astroid/scoped_nodes.py'])
      expect(result.symbols).toEqual([{
        file: 'astroid/scoped_nodes.py',
        name: 'igetattr',
        type: 'function',
        lineNumber: 2
      }])
      expect(result.implementationContext.get('astroid/scoped_nodes.py')).toContain('def igetattr')
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('falls back when no verified file can be localized', async () => {
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore()

    const provider: PanelMemberLlmProvider = {
      async analyze(): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
        return {
          text: '`ghost/not-real.py`',
          tokensUsed: 3,
          costUsd: 0
        }
      }
    }

    try {
      const result: LocalizationResult = await runDeterministicLocalization({
        intake: makeIntake(root, 'Fix a bug with no valid file'),
        provider,
        rts: store
      })

      expect(result.localizationMethod).toBe('fallback')
      expect(result.files).toEqual([])
      expect(result.symbols).toEqual([])
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('records an RTS error when localization setup throws before any LLM call', async () => {
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore()

    try {
      await expect(runDeterministicLocalization({
        intake: makeIntake(root),
        provider: {} as PanelMemberLlmProvider,
        rts: store
      })).rejects.toThrow('missing analyze()')

      const errorEvents = store.queryByType('error', 10)
      const contents = errorEvents.map((event) => JSON.parse(event.content_json))
      expect(contents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'Deterministic localization stage failed.',
          stage: 'provider_validation'
        })
      ]))
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('retries retryable localization failures and falls back to another model', async () => {
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore()
    const calls: Array<{ prompt: string; model: string; lane: 'primary' | 'fallback' }> = []

    const provider: PanelMemberLlmProvider = {
      async analyze(prompt: string, model: string) {
        calls.push({ prompt, model, lane: 'primary' })
        throw new Error('[503 Service Unavailable] try later')
      }
    }

    const fallbackProvider: PanelMemberLlmProvider = {
      async analyze(prompt: string, model: string) {
        calls.push({ prompt, model, lane: 'fallback' })

        if (prompt.includes('### Repository Structure ###')) {
          return {
            text: '`astroid/scoped_nodes.py`',
            tokensUsed: 5,
            costUsd: 0
          }
        }

        return {
          text: [
            'astroid/scoped_nodes.py',
            '    function: igetattr'
          ].join('\n'),
          tokensUsed: 5,
          costUsd: 0
        }
      }
    }

    try {
      const result = await runDeterministicLocalization({
        intake: makeIntake(root),
        provider,
        fallbackProvider,
        rts: store
      })

      expect(result.localizationMethod).toBe('deterministic')
      expect(calls.filter((call) => call.lane === 'primary' && call.model === 'gemini-2.5-flash')).toHaveLength(6)
      expect(calls.some((call) => call.lane === 'fallback' && call.model === 'google/gemini-2.5-flash')).toBe(true)

      const stepOutputs = store.queryByType('step_output', 20).map((event) => JSON.parse(event.content_json))
      expect(stepOutputs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'deterministic_localization_model_fallback',
          fromModel: 'gemini-2.5-flash',
          toModel: 'google/gemini-2.5-flash'
        })
      ]))
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('treats 429 quota failures as retryable and falls back to another model', async () => {
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore()
    const calls: Array<{ prompt: string; model: string; lane: 'primary' | 'fallback' }> = []

    const provider: PanelMemberLlmProvider = {
      async analyze(prompt: string, model: string) {
        calls.push({ prompt, model, lane: 'primary' })
        throw new Error('[429 Too Many Requests] Quota exceeded for metric: generate_content_free_tier_requests. retryDelay: 9s')
      }
    }

    const fallbackProvider: PanelMemberLlmProvider = {
      async analyze(prompt: string, model: string) {
        calls.push({ prompt, model, lane: 'fallback' })

        if (prompt.includes('### Repository Structure ###')) {
          return {
            text: '`astroid/scoped_nodes.py`',
            tokensUsed: 5,
            costUsd: 0
          }
        }

        return {
          text: [
            'astroid/scoped_nodes.py',
            '    function: igetattr'
          ].join('\n'),
          tokensUsed: 5,
          costUsd: 0
        }
      }
    }

    try {
      const result = await runDeterministicLocalization({
        intake: makeIntake(root),
        provider,
        fallbackProvider,
        rts: store
      })

      expect(result.localizationMethod).toBe('deterministic')
      expect(calls.filter((call) => call.lane === 'primary' && call.model === 'gemini-2.5-flash')).toHaveLength(6)
      expect(calls.some((call) => call.lane === 'fallback' && call.model === 'google/gemini-2.5-flash')).toBe(true)

      const stepOutputs = store.queryByType('step_output', 20).map((event) => JSON.parse(event.content_json))
      expect(stepOutputs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'deterministic_localization_attempt_failed',
          model: 'gemini-2.5-flash',
          retryable: true
        }),
        expect.objectContaining({
          operation: 'deterministic_localization_model_fallback',
          fromModel: 'gemini-2.5-flash',
          toModel: 'google/gemini-2.5-flash'
        })
      ]))
    } finally {
      cleanupStore()
      cleanup()
    }
  })
})
