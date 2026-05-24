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
              throw new Error('No mock NVIDIA client configured')
            }

            return latestClient.create(...args)
          }
        }
      }
    }
  }
})

describe('nvidia provider', () => {
  beforeEach(() => {
    createMock.mockReset()
    latestClient = createClientHandle()
  })

  it('sets baseURL to the NVIDIA NIM API', async () => {
    const { NvidiaProvider } = await import('../../src/llm/nvidia.js')
    new NvidiaProvider('nvapi-test')

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://integrate.api.nvidia.com/v1'
    }))
  })

  it('keeps native tool mode once detected instead of downgrading to sticky json mode', async () => {
    const { NvidiaProvider } = await import('../../src/llm/nvidia.js')
    const provider = new NvidiaProvider('nvapi-test')
    const client = createClientHandle()

    client.create
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })

    setLatestClient(client)

    await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'minimaxai/minimax-m2.7'
    )

    await provider.callWithTools(
      [{ role: 'user', content: 'done?' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'minimaxai/minimax-m2.7'
    )

    const secondCall = client.create.mock.calls[1]?.[0] as { messages?: unknown; tools?: unknown } | undefined
    expect(secondCall?.tools).toBeDefined()
    expect(client.create).toHaveBeenCalledTimes(2)
  })

  it('sends assistant tool_use history as structured tool_calls instead of plain text', async () => {
    const { NvidiaProvider } = await import('../../src/llm/nvidia.js')
    const provider = new NvidiaProvider('nvapi-test')
    const client = createClientHandle()

    client.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    await provider.callWithTools(
      [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/app.ts' } }] }
      ],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'z-ai/glm-5.1'
    )

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'src/app.ts' })
            }
          }]
        })
      ])
    }))
  })

  it('sends user tool_result history as tool-role messages instead of plain text', async () => {
    const { NvidiaProvider } = await import('../../src/llm/nvidia.js')
    const provider = new NvidiaProvider('nvapi-test')
    const client = createClientHandle()

    client.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    await provider.callWithTools(
      [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] }
      ],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'z-ai/glm-5.1'
    )

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'tool-1',
          content: 'file content'
        })
      ])
    }))
  })

  it('uses chat_template_kwargs to enable reasoning for NVIDIA chat calls', async () => {
    const { NvidiaProvider } = await import('../../src/llm/nvidia.js')
    const provider = new NvidiaProvider('nvapi-test')
    const client = createClientHandle()

    client.create.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })

    setLatestClient(client)

    await provider.analyze('inspect this', 'z-ai/glm-5.1')

    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'z-ai/glm-5.1',
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false
      }
    }))
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
