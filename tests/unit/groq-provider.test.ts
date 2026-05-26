import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
let latestClient: MockClientHandle | null = null

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      constructor(config: unknown) {
        createMock(config)
      }

      chat = {
        completions: {
          create: (...args: unknown[]) => {
            if (latestClient === null) {
              throw new Error('No mock Groq client configured')
            }

            return latestClient.create(...args)
          }
        }
      }
    }
  }
})

describe('groq provider', () => {
  beforeEach(() => {
    createMock.mockReset()
    latestClient = createClientHandle()
  })

  it('sets baseURL to the Groq API', async () => {
    const { GroqProvider } = await import('../../src/llm/groq.js')
    new GroqProvider('gsk_test')

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.groq.com/openai/v1'
    }))
  })

  it('formats tool calls in OpenAI format and parses tool_calls', async () => {
    const { GroqProvider } = await import('../../src/llm/groq.js')
    const provider = new GroqProvider('gsk_test')
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{
        message: {
          tool_calls: [{
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'src/app.ts' })
            }
          }]
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    const result = await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'llama-3.3-70b-versatile'
    )

    expect(result.content).toEqual([{
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'src/app.ts' }
    }])
  })

  it('returns text from analyze', async () => {
    const { GroqProvider } = await import('../../src/llm/groq.js')
    const provider = new GroqProvider('gsk_test')
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'ready' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 }
    })
    setLatestClient(client)

    await expect(provider.analyze('prompt', 'llama-3.1-8b-instant')).resolves.toEqual({
      text: 'ready',
      tokensUsed: 6,
      costUsd: 0
    })
  })

  it('falls back to NVIDIA on retryable tool failure', async () => {
    const { GroqProvider } = await import('../../src/llm/groq.js')
    const fallbackTools = {
      callWithTools: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'fallback' }],
        tokensUsed: 1,
        costUsd: 0
      })
    }
    const provider = new GroqProvider('gsk_test', {
      executorProvider: fallbackTools,
      executorModel: 'z-ai/glm-5.1'
    })
    const client = createClientHandle()
    client.create.mockRejectedValue(new Error('503 Service Unavailable'))
    setLatestClient(client)

    const result = await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'llama-3.3-70b-versatile'
    )

    expect(fallbackTools.callWithTools).toHaveBeenCalled()
    expect(result.content).toEqual([{ type: 'text', text: 'fallback' }])
  })
})

type MockClientHandle = {
  create: ReturnType<typeof vi.fn>
}

function createClientHandle(): MockClientHandle {
  return {
    create: vi.fn()
  }
}

function setLatestClient(client: MockClientHandle): void {
  latestClient = client
  createMock.mockImplementation(() => {
    return {
      chat: {
        completions: {
          create: client.create
        }
      }
    }
  })
}
