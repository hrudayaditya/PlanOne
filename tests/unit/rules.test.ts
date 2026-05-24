import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { loadRules, serializeRules } from '../../src/intake/rules.js'

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-rules-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

describe('rules', () => {
  it('returns safe defaults when no file exists', async () => {
    const { root, cleanup } = makeRepo()

    try {
      const rules = await loadRules(root)
      expect(rules.never_touch).toEqual([])
      expect(rules.always_escalate_if).toEqual([])
      expect(rules.max_files_changed).toBe(20)
    } finally {
      cleanup()
    }
  })

  it('throws with a clear message on invalid yaml', async () => {
    const { root, cleanup } = makeRepo()

    try {
      writeFileSync(join(root, 'PLANONE.rules.yaml'), 'version: 1\nrepo_name: 2\nnever_touch: nope\nalways_escalate_if: 3\n')
      await expect(loadRules(root)).rejects.toThrow(/version|repo_name|never_touch|always_escalate_if/)
    } finally {
      cleanup()
    }
  })

  it('returns typed rules on valid yaml', async () => {
    const { root, cleanup } = makeRepo()

    try {
      writeFileSync(join(root, 'PLANONE.rules.yaml'), [
        'version: "1.0"',
        'repo_name: "planone"',
        'never_touch:',
        '  - "**/.env*"',
        'always_escalate_if:',
        '  - "touches auth"',
        'max_files_changed: 10'
      ].join('\n'))

      const rules = await loadRules(root)
      expect(rules.repo_name).toBe('planone')
      expect(rules.max_files_changed).toBe(10)
    } finally {
      cleanup()
    }
  })

  it('serializeRules produces valid JSON', async () => {
    const { root, cleanup } = makeRepo()

    try {
      const rules = await loadRules(root)
      const json = serializeRules(rules)
      const ParsedSchema = z.string().transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON.' })
          return z.NEVER
        }
      }).pipe(z.object({
        version: z.string(),
        repo_name: z.string()
      }).passthrough())

      expect(ParsedSchema.parse(json).repo_name).toBe(rules.repo_name)
    } finally {
      cleanup()
    }
  })

  it('preserves always_escalate_if exactly', async () => {
    const { root, cleanup } = makeRepo()

    try {
      writeFileSync(join(root, 'PLANONE.rules.yaml'), [
        'version: "1.0"',
        'repo_name: "planone"',
        'never_touch: []',
        'always_escalate_if:',
        '  - "changes auth logic"',
        '  - "modifies database schema"'
      ].join('\n'))

      const rules = await loadRules(root)
      expect(rules.always_escalate_if).toEqual(['changes auth logic', 'modifies database schema'])
    } finally {
      cleanup()
    }
  })
})
