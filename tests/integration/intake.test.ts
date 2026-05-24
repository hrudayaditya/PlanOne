import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, afterEach } from 'vitest'
import { z } from 'zod'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { runIntake } from '../../src/intake/index.js'
import { setIntakeLlmProviderForTesting, type IntakeLlmProvider } from '../../src/intake/llm.js'

function makeRepo(withRules = false): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-intake-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'planone-fixture',
    devDependencies: { vitest: '^1.0.0' }
  }))
  writeFileSync(join(root, 'src.test.ts'), 'export const ok = true\n')
  if (withRules) {
    writeFileSync(join(root, 'PLANONE.rules.yaml'), [
      'version: "1.0"',
      'repo_name: "fixture"',
      'never_touch: []',
      'always_escalate_if:',
      '  - "touches auth logic"'
    ].join('\n'))
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makeStore(root: string): { store: RawTraceStore; cleanup: () => void } {
  const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
  return {
    store,
    cleanup: () => store.close()
  }
}

afterEach(() => {
  setIntakeLlmProviderForTesting(null)
})

describe('intake integration', () => {
  it('returns IntakeResult with all required fields', async () => {
    const provider: IntakeLlmProvider = {
      async generateJson(prompt) {
        if (prompt.includes('structured JSON object')) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'fix auth bug',
              structured_description: 'Fix the authentication bug.',
              task_type: 'bug_fix',
              affected_area: 'authentication',
              likely_files: ['src/auth.ts'],
              symptom_vs_root_cause: '',
              complexity_hint: 'moderate',
              confidence: 0.8
            })
          }
        }

        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.7,
            rationale: 'multiple files likely',
            estimated_steps: 3,
            risk_flags: ['auth']
          })
        }
      }
    }
    setIntakeLlmProviderForTesting(provider)
    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-1',
        rawTask: 'fix auth bug',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.taskId).toBe('task-1')
      expect(result.enhancedTask.original).toBe('fix auth bug')
      expect(result.classification.complexity).toBe('COMPLEX')
      expect(result.repoContext.packageManager).toBe('npm')
      expect(result.repoContext.language).toBe('typescript')
      expect(result.repoContext.testRunner).toBe('vitest')
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('detects python repo context from pyproject.toml', async () => {
    setIntakeLlmProviderForTesting({
      async generateJson(prompt) {
        if (prompt.includes('structured JSON object')) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'fix inference bug',
              structured_description: 'Fix inference bug.',
              task_type: 'bug_fix',
              affected_area: 'inference',
              likely_files: ['astroid/scoped_nodes.py'],
              symptom_vs_root_cause: '',
              complexity_hint: 'moderate',
              confidence: 0.8
            })
          }
        }

        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.7,
            rationale: 'multiple files likely',
            estimated_steps: 3,
            risk_flags: []
          })
        }
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'planone-intake-py-'))
    writeFileSync(join(root, 'pyproject.toml'), [
      '[project]',
      'name = "astroid-fixture"',
      'requires-python = ">=3.10"',
      '',
      '[project.optional-dependencies]',
      'dev = ["pytest"]'
    ].join('\n'))
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-python',
        rawTask: 'fix inference bug',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.repoContext.language).toBe('python')
      expect(result.repoContext.pythonBinary).toBe('python3')
      expect(result.repoContext.testRunner).toBe('pytest')
      expect(result.repoContext.testCommand).toBe('python3 -m pytest')
    } finally {
      cleanupStore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('detects vitest from package.json scripts and dependencies', async () => {
    setIntakeLlmProviderForTesting({
      async generateJson(prompt) {
        if (prompt.includes('structured JSON object')) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'fix web bug',
              structured_description: 'Fix web bug.',
              task_type: 'bug_fix',
              affected_area: 'ui',
              likely_files: ['src/app.ts'],
              symptom_vs_root_cause: '',
              complexity_hint: 'moderate',
              confidence: 0.8
            })
          }
        }

        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.7,
            rationale: 'multiple files likely',
            estimated_steps: 3,
            risk_flags: []
          })
        }
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'planone-intake-vitest-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'vitest-fixture',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^1.0.0' }
    }))
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-vitest',
        rawTask: 'fix web bug',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.repoContext.language).toBe('typescript')
      expect(result.repoContext.testRunner).toBe('vitest')
      expect(result.repoContext.testCommand).toBe('npx vitest run')
    } finally {
      cleanupStore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles prompt enhancer failure gracefully', async () => {
    let callCount = 0
    setIntakeLlmProviderForTesting({
      async generateJson() {
        callCount += 1
        if (callCount === 1) {
          throw new Error('enhancer down')
        }
        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.5,
            rationale: 'fallback task still risky',
            estimated_steps: 2,
            risk_flags: []
          })
        }
      }
    })

    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-2',
        rawTask: 'do a thing',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.enhancedTask.structured_description).toBe('do a thing')
      expect(result.enhancedTask.task_type).toBe('unknown')
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('handles complexity classifier failure gracefully', async () => {
    let callCount = 0
    setIntakeLlmProviderForTesting({
      async generateJson() {
        callCount += 1
        if (callCount === 1) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'add docs',
              structured_description: 'Add documentation.',
              task_type: 'documentation',
              affected_area: 'docs',
              likely_files: ['README.md'],
              symptom_vs_root_cause: '',
              complexity_hint: 'trivial',
              confidence: 0.9
            })
          }
        }
        throw new Error('classifier down')
      }
    })

    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-3',
        rawTask: 'add docs',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.classification.complexity).toBe('COMPLEX')
      expect(result.classification.confidence).toBe(0)
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('forces COMPLEX classification when rules match always_escalate_if', async () => {
    setIntakeLlmProviderForTesting({
      async generateJson() {
        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            original: 'touches auth logic in login path',
            structured_description: 'Update authentication logic in the login path.',
            task_type: 'feature',
            affected_area: 'authentication',
            likely_files: ['src/auth.ts'],
            symptom_vs_root_cause: '',
            complexity_hint: 'moderate',
            confidence: 0.8
          })
        }
      }
    })

    const { root, cleanup } = makeRepo(true)
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-4',
        rawTask: 'touches auth logic in login path',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.classification.complexity).toBe('COMPLEX')
      expect(result.classification.confidence).toBe(1)
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('returns a JSON-serializable IntakeResult', async () => {
    setIntakeLlmProviderForTesting({
      async generateJson(prompt) {
        if (prompt.includes('structured JSON object')) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'fix bug',
              structured_description: 'Fix bug.',
              task_type: 'bug_fix',
              affected_area: 'core',
              likely_files: [],
              symptom_vs_root_cause: '',
              complexity_hint: 'moderate',
              confidence: 0.7
            })
          }
        }

        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.7,
            rationale: 'risky',
            estimated_steps: 2,
            risk_flags: []
          })
        }
      }
    })

    const { root, cleanup } = makeRepo()
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-5',
        rawTask: 'fix bug',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      const SerializableSchema = z.string().transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON.' })
          return z.NEVER
        }
      }).pipe(z.unknown())

      const roundTrip = SerializableSchema.parse(JSON.stringify(result))
      expect(roundTrip).toEqual(result)
    } finally {
      cleanupStore()
      cleanup()
    }
  })

  it('logs a trace error when PLANONE.rules.yaml fails to load and falls back to defaults', async () => {
    setIntakeLlmProviderForTesting({
      async generateJson(prompt) {
        if (prompt.includes('structured JSON object')) {
          return {
            model: 'gemini-2.5-flash',
            text: JSON.stringify({
              original: 'fix bug',
              structured_description: 'Fix the bug.',
              task_type: 'bug_fix',
              affected_area: 'core',
              likely_files: ['src/core.ts'],
              symptom_vs_root_cause: '',
              complexity_hint: 'moderate',
              confidence: 0.7
            })
          }
        }

        return {
          model: 'gemini-2.5-flash',
          text: JSON.stringify({
            complexity: 'COMPLEX',
            confidence: 0.7,
            rationale: 'fallback rules still allow execution',
            estimated_steps: 2,
            risk_flags: []
          })
        }
      }
    })

    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'PLANONE.rules.yaml'), 'version: 1\nrepo_name: 2\nnever_touch: nope\nalways_escalate_if: 3\n')
    const { store, cleanup: cleanupStore } = makeStore(root)

    try {
      const result = await runIntake({
        taskId: 'task-rules-fallback',
        rawTask: 'fix bug',
        repoRoot: root,
        abMode: 'B',
        rts: store
      })

      expect(result.rules.never_touch).toEqual([])
      const errors = store.queryByType('error').map((entry) => JSON.parse(entry.content_json))
      expect(errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'PLANONE.rules.yaml failed to load. Using defaults. test_command will be missing.'
        })
      ]))
    } finally {
      cleanupStore()
      cleanup()
    }
  })
})
