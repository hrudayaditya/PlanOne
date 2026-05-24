import { describe, expect, it } from 'vitest'

import { buildPostWriteBlockedResult, isAllowedPostWriteCommand, sanitizeSymbols } from '../../src/executor/step.js'

describe('executor post-write enforcement', () => {
  it('blocks read_file after implementation with an explicit blocked result', () => {
    expect(buildPostWriteBlockedResult('read_file')).toContain('[BLOCKED: read_file is not permitted after implementation.')
  })

  it('would block a second write_file after implementation', () => {
    expect(buildPostWriteBlockedResult('write_file')).toContain('[BLOCKED: write_file is not permitted after implementation.')
  })

  it('allows test and type-check commands in post-write mode', () => {
    expect(isAllowedPostWriteCommand('npx tsc --noEmit')).toBe(true)
    expect(isAllowedPostWriteCommand('npm test')).toBe(true)
  })

  it('blocks arbitrary commands in post-write mode', () => {
    expect(isAllowedPostWriteCommand('echo hello')).toBe(false)
  })

  it('filters framework-generic noise symbols before prompt construction', () => {
    expect(sanitizeSymbols(['Client', 'Helper', 'createTRPCNext', 'T'])).toEqual(['createTRPCNext'])
  })
})
