import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { loadEnvFiles, parseEnvFile } from '../../src/utils/env.js'

describe('env loader', () => {
  const touchedKeys = [
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'GEMINI_API_KEY'
  ]

  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key]
    }
  })

  it('parses plain, quoted, and export-prefixed env lines', () => {
    const parsed = parseEnvFile([
      '# comment',
      'OPENROUTER_API_KEY=sk-or-test',
      'export GROQ_API_KEY="gsk_test"',
      'GEMINI_API_KEY=\'gemini-test\''
    ].join('\n'))

    expect(parsed).toEqual({
      OPENROUTER_API_KEY: 'sk-or-test',
      GROQ_API_KEY: 'gsk_test',
      GEMINI_API_KEY: 'gemini-test'
    })
  })

  it('loads .env and .env.local without overriding existing shell vars', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'planone-env-'))

    try {
      writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=from-dotenv\nGROQ_API_KEY=from-dotenv\n', 'utf8')
      writeFileSync(path.join(dir, '.env.local'), 'GEMINI_API_KEY=from-local\n', 'utf8')
      process.env.OPENROUTER_API_KEY = 'from-shell'

      const result = loadEnvFiles(dir)

      expect(result.loadedFiles).toHaveLength(2)
      expect(process.env.OPENROUTER_API_KEY).toBe('from-shell')
      expect(process.env.GROQ_API_KEY).toBe('from-dotenv')
      expect(process.env.GEMINI_API_KEY).toBe('from-local')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
