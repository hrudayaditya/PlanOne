import { describe, expect, it } from 'vitest'

import { scanDiff } from '../../src/sek/diff-policy.js'

describe('SEK diff policy', () => {
  it('flags CI/CD changes as block violations', () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n+name: CI\n`
    expect(scanDiff(diff, '', '').some((v) => v.severity === 'block')).toBe(true)
  })

  it('flags hardcoded credentials as block violations', () => {
    const diff = `diff --git a/app.ts b/app.ts\n+++ b/app.ts\n+const api_key = "secret"\n`
    expect(scanDiff(diff, '', '').some((v) => v.description.includes('credential'))).toBe(true)
  })

  it('flags new HTTP calls as warnings', () => {
    const diff = `diff --git a/app.ts b/app.ts\n+++ b/app.ts\n+fetch("https://example.com")\n`
    expect(scanDiff(diff, '', '').some((v) => v.severity === 'warn')).toBe(true)
  })

  it('flags environment variables in test output as block violations', () => {
    expect(scanDiff('', '', 'API_KEY=secret').some((v) => v.severity === 'block')).toBe(true)
  })

  it('flags shell execution as a block violation', () => {
    const diff = `diff --git a/app.ts b/app.ts\n+++ b/app.ts\n+exec("rm -rf /")\n`
    expect(scanDiff(diff, '', '').some((v) => v.description.includes('Shell execution'))).toBe(true)
  })

  it('returns an empty array for a clean diff', () => {
    expect(scanDiff('diff --git a/app.ts b/app.ts\n', '', '')).toEqual([])
  })

  it('never throws regardless of input', () => {
    expect(() => scanDiff('', '', '')).not.toThrow()
  })
})
