import { describe, expect, it } from 'vitest'

import { createProviders } from '../../src/llm/router.js'
import { AnthropicProvider } from '../../src/llm/anthropic.js'
import { GeminiProvider } from '../../src/llm/gemini.js'

describe('llm router', () => {
  it('succeeds with claude executor and gemini verifier', () => {
    const providers = createProviders({
      executorModel: 'claude-opus-4-5',
      verifierModel: 'gemini-3.1-flash-lite-preview'
    })

    expect(providers.executorProvider).toBeInstanceOf(AnthropicProvider)
  })

  it('uses gemini for intake when intakeModel starts with gemini-', () => {
    const providers = createProviders({
      executorModel: 'claude-opus-4-5',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'gemini-2.5-flash'
    })

    expect(providers.intakeProvider).toBeInstanceOf(GeminiProvider)
    expect(typeof providers.intakeProvider.generateText).toBe('function')
  })

  it('uses anthropic for intake when intakeModel starts with claude-', () => {
    const providers = createProviders({
      executorModel: 'claude-opus-4-5',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'claude-haiku-4-5'
    })

    expect(providers.intakeProvider).toBeInstanceOf(AnthropicProvider)
    expect(typeof providers.intakeProvider.generateText).toBe('function')
  })

  it('routes compression by its configured model family', () => {
    const providers = createProviders({
      executorModel: 'claude-opus-4-5',
      verifierModel: 'gemini-3.1-flash-lite-preview'
    })

    expect(providers.compressionProvider).toBeInstanceOf(GeminiProvider)
  })
})
