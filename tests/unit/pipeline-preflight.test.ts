import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../../src/llm/anthropic.js'
import { GeminiProvider } from '../../src/llm/gemini.js'
import { NvidiaProvider } from '../../src/llm/nvidia.js'
import { OpenRouterProvider } from '../../src/llm/openrouter.js'
import type { ProviderBundle } from '../../src/llm/router.js'
import { validateProviderModelAlignment } from '../../src/pipeline/index.js'

function makeBundle(overrides: Partial<ProviderBundle>): ProviderBundle {
  const gemini = new GeminiProvider('test-gemini')

  return {
    intakeProvider: gemini,
    panelProvider: gemini,
    executorProvider: gemini,
    compressionProvider: gemini,
    ...overrides
  }
}

describe('pipeline preflight validation', () => {
  it('throws when GeminiProvider is paired with claude-opus-4-5 for panel', async () => {
    await expect(validateProviderModelAlignment(
      makeBundle({
        panelProvider: new GeminiProvider('test-gemini')
      }),
      {
        panelModel: 'claude-opus-4-5'
      }
    )).rejects.toThrow(/panelModel is 'claude-opus-4-5'.*GeminiProvider/i)
  })

  it('does not throw when GeminiProvider is paired with a gemma model for panel', async () => {
    await expect(validateProviderModelAlignment(
      makeBundle({
        panelProvider: new GeminiProvider('test-gemini')
      }),
      {
        panelModel: 'gemma-3-27b-it'
      }
    )).resolves.toBeUndefined()
  })

  it('does not throw when OpenRouterProvider is paired with an inclusionai executor model', async () => {
    await expect(validateProviderModelAlignment(
      makeBundle({
        executorProvider: new OpenRouterProvider({
          apiKey: 'sk-or-v1-test',
          path: 'free',
          modelId: 'inclusionai/ling-2.6-1t:free'
        })
      }),
      {
        executorModel: 'inclusionai/ling-2.6-1t:free'
      }
    )).resolves.toBeUndefined()
  })

  it('does not throw when NvidiaProvider is paired with z-ai/glm-5.1 for executor', async () => {
    await expect(validateProviderModelAlignment(
      makeBundle({
        executorProvider: new NvidiaProvider('nvapi-test')
      }),
      {
        executorModel: 'z-ai/glm-5.1'
      }
    )).resolves.toBeUndefined()
  })

  it('includes the actual model ID and provider name in the mismatch error', async () => {
    await expect(validateProviderModelAlignment(
      makeBundle({
        panelProvider: new GeminiProvider('test-gemini'),
        executorProvider: new AnthropicProvider('test-anthropic')
      }),
      {
        panelModel: 'claude-opus-4-5'
      }
    )).rejects.toThrow(/claude-opus-4-5.*GeminiProvider/i)
  })
})
