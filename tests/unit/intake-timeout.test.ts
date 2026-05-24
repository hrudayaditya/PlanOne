import { describe, expect, it } from 'vitest'

import { COMPLEXITY_CLASSIFIER_TIMEOUT_MS } from '../../src/intake/complexity-classifier.js'
import { PROMPT_ENHANCER_TIMEOUT_MS } from '../../src/intake/prompt-enhancer.js'

describe('intake timeout configuration', () => {
  it('uses a 30 second timeout for the prompt enhancer', () => {
    expect(PROMPT_ENHANCER_TIMEOUT_MS).toBe(30_000)
  })

  it('uses a 30 second timeout for the complexity classifier', () => {
    expect(COMPLEXITY_CLASSIFIER_TIMEOUT_MS).toBe(30_000)
  })
})
