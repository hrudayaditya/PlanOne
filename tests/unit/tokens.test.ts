import { describe, expect, it } from 'vitest'

import { countTokens } from '../../src/utils/tokens.js'

describe('countTokens', () => {
  it('returns a number greater than zero for non-empty input', () => {
    expect(countTokens('PlanOne foundation', 'gpt-4o')).toBeGreaterThan(0)
  })

  it('returns zero for empty input', () => {
    expect(countTokens('', 'gpt-4o')).toBe(0)
  })

  it('does not throw for an unknown model and returns a safe estimate', () => {
    expect(() => countTokens('fallback estimate', 'unknown-model')).not.toThrow()
    expect(countTokens('fallback estimate', 'unknown-model')).toBeGreaterThan(0)
  })
})
