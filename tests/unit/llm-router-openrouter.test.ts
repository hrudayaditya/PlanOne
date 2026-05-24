import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../../src/llm/anthropic.js'
import { GeminiProvider } from '../../src/llm/gemini.js'
import { NvidiaProvider } from '../../src/llm/nvidia.js'
import { OpenRouterProvider } from '../../src/llm/openrouter.js'
import { createProviders, getModelFamily, selectProviderType } from '../../src/llm/router.js'

describe('llm router openrouter support', () => {
  it("getModelFamily('inclusionai/ling-2.6-1t:free') returns inclusionai", () => {
    expect(getModelFamily('inclusionai/ling-2.6-1t:free')).toBe('inclusionai')
  })

  it("getModelFamily('google/gemma-3-27b-it:free') returns google", () => {
    expect(getModelFamily('google/gemma-3-27b-it:free')).toBe('google')
  })

  it("getModelFamily('gemini-2.5-flash') returns google", () => {
    expect(getModelFamily('gemini-2.5-flash')).toBe('google')
  })

  it("getModelFamily('gemma-4-27b-it') returns google", () => {
    expect(getModelFamily('gemma-4-27b-it')).toBe('google')
  })

  it("getModelFamily('claude-opus-4-5') returns anthropic", () => {
    expect(getModelFamily('claude-opus-4-5')).toBe('anthropic')
  })

  it("getModelFamily('minimaxai/minimax-m2.7') returns nvidia", () => {
    expect(getModelFamily('minimaxai/minimax-m2.7')).toBe('nvidia')
  })

  it("getModelFamily('z-ai/glm-5.1') returns nvidia", () => {
    expect(getModelFamily('z-ai/glm-5.1')).toBe('nvidia')
  })

  it('does not throw for inclusionai executor and google verifier', () => {
    expect(() => createProviders({
      openrouterApiKey: 'sk-or-v1-test',
      geminiApiKey: 'test',
      executorModel: 'inclusionai/ling-2.6-1t:free',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'gemini-2.5-flash',
      panelModel: 'gemini-3.1-flash-lite-preview',
      compressionModel: 'gemini-3-flash-preview'
    })).not.toThrow()
  })

  it('throws for inclusionai executor and inclusionai verifier', () => {
    expect(() => createProviders({
      openrouterApiKey: 'sk-or-v1-test',
      executorModel: 'inclusionai/ling-2.6-1t:free',
      verifierModel: 'inclusionai/ling-2.6-1t:free',
      intakeModel: 'gemini-2.5-flash',
      panelModel: 'gemini-3.1-flash-lite-preview',
      compressionModel: 'gemini-3-flash-preview'
    })).toThrow()
  })

  it('throws for google executor and google verifier', () => {
    expect(() => createProviders({
      geminiApiKey: 'test',
      executorModel: 'gemini-2.5-flash',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'gemini-2.5-flash',
      panelModel: 'gemini-3.1-flash-lite-preview',
      compressionModel: 'gemini-3-flash-preview'
    })).toThrow()
  })

  it('routes namespaced models to OpenRouterProvider', () => {
    expect(selectProviderType('inclusionai/ling-2.6-1t:free', { openrouterApiKey: 'sk-or-v1-test' })).toBe('openrouter')
  })

  it('routes gemini models to GeminiProvider', () => {
    expect(selectProviderType('gemini-2.5-flash', {})).toBe('gemini')
  })

  it('routes minimaxai models to NvidiaProvider when NVIDIA_API_KEY is configured', () => {
    expect(selectProviderType('minimaxai/minimax-m2.7', { nvidiaApiKey: 'nvapi-test' })).toBe('nvidia')
  })

  it('routes z-ai models to NvidiaProvider when NVIDIA_API_KEY is configured', () => {
    expect(selectProviderType('z-ai/glm-5.1', { nvidiaApiKey: 'nvapi-test' })).toBe('nvidia')
  })

  it('creates the expected provider families for the zero-cost stack', () => {
    const providers = createProviders({
      openrouterApiKey: 'sk-or-v1-test',
      geminiApiKey: 'test',
      executorModel: 'inclusionai/ling-2.6-1t:free',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'gemini-2.5-flash',
      panelModel: 'gemini-3.1-flash-lite-preview',
      compressionModel: 'gemini-3-flash-preview'
    })

    expect(providers.executorProvider).toBeInstanceOf(OpenRouterProvider)
    expect(providers.verifierProvider).toBeInstanceOf(GeminiProvider)
    expect(providers.panelProvider).toBeInstanceOf(GeminiProvider)
    expect(providers.intakeProvider).toBeInstanceOf(GeminiProvider)
    expect(providers.compressionProvider).toBeInstanceOf(GeminiProvider)
  })

  it('creates the expected provider families for the NVIDIA executor stack', () => {
    const providers = createProviders({
      nvidiaApiKey: 'nvapi-test',
      geminiApiKey: 'test',
      executorModel: 'z-ai/glm-5.1',
      verifierModel: 'gemini-3.1-flash-lite-preview',
      intakeModel: 'gemini-2.5-flash',
      panelModel: 'gemini-3.1-flash-lite-preview',
      compressionModel: 'gemini-3-flash-preview'
    })

    expect(providers.executorProvider).toBeInstanceOf(NvidiaProvider)
    expect(providers.verifierProvider).toBeInstanceOf(GeminiProvider)
  })
})
