import { describe, expect, it } from 'vitest'

import { extractJson } from '../../src/intake/llm.js'

describe('intake json extraction', () => {
  it("extractJson strips fenced json blocks", () => {
    expect(extractJson('```json\n{\"a\":1}\n```')).toBe('{"a":1}')
  })

  it('extractJson pulls JSON object out of leading text', () => {
    expect(extractJson('Here is the JSON: {"a":1}')).toBe('{"a":1}')
  })

  it('extractJson returns valid JSON unchanged when already clean', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
  })

  it('extractJson passes through non-JSON text unchanged', () => {
    expect(extractJson('not json at all')).toBe('not json at all')
  })

  it('extractJson outputs are parseable for common Gemini wrappers', () => {
    const inputs = [
      '```json\n{"a":1}\n```',
      'Here is the JSON: {"a":1}',
      '{"a":1}'
    ]

    for (const input of inputs) {
      expect(JSON.parse(extractJson(input))).toEqual({ a: 1 })
    }
  })
})
