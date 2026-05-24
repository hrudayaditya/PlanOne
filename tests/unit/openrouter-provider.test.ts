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
              throw new Error('No mock OpenRouter client configured')
            }

            return latestClient.create(...args)
          }
        }
      }
    }
  }
})

describe('openrouter provider', () => {
  beforeEach(() => {
    createMock.mockReset()
    latestClient = createClientHandle()
  })

  it('sets baseURL to the OpenRouter API', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t'
    })

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://openrouter.ai/api/v1'
    }))
  })

  it('appends :free when free path is requested without the suffix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
    setLatestClient(client)

    expect(warn).toHaveBeenCalled()
    await provider.generateJson('hello', ['inclusionai/ling-2.6-1t'])
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'inclusionai/ling-2.6-1t:free'
    }))
    warn.mockRestore()
  })

  it('strips :free when paid path is requested with the suffix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'paid',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('uses zero cost on the free path', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    const result = await provider.analyze('prompt', 'inclusionai/ling-2.6-1t:free')
    expect(result.costUsd).toBe(0)
  })

  it('throws a quota message on 429', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockRejectedValue({ status: 429, message: 'daily free quota exhausted' })
    setLatestClient(client)

    await expect(provider.generateJson('prompt', ['inclusionai/ling-2.6-1t:free'])).rejects.toThrow(/daily free quota exhausted/i)
  })

  it('returns model and text on generateJson success', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
    setLatestClient(client)

    await expect(provider.generateJson('prompt', ['inclusionai/ling-2.6-1t:free'])).resolves.toEqual({
      model: 'inclusionai/ling-2.6-1t:free',
      text: 'hello'
    })
  })

  it('returns native tool LlmContent blocks when tool calling is supported', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
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
      [{
        name: 'read_file',
        description: 'Read file',
        input_schema: { type: 'object', properties: {}, required: [] }
      }],
      'inclusionai/ling-2.6-1t:free'
    )

    expect(result.content).toEqual([{
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'src/app.ts' }
    }])
  })

  it('sends assistant tool_use history as structured tool_calls instead of plain text', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    await provider.callWithTools(
      [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/app.ts' } }] }
      ],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'inclusionai/ling-2.6-1t:free'
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
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    await provider.callWithTools(
      [
        { role: 'user', content: 'task' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] }
      ],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'inclusionai/ling-2.6-1t:free'
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

  it('sends multiple tool calls in one assistant turn as multiple tool_calls entries', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    setLatestClient(client)

    await provider.callWithTools(
      [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/app.ts' } },
          { type: 'tool_use', id: 'tool-2', name: 'search_in_files', input: { pattern: 'LoginService' } }
        ] }
      ],
      [
        { name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } },
        { name: 'search_in_files', description: 'Search files', input_schema: { type: 'object', properties: {}, required: [] } }
      ],
      'inclusionai/ling-2.6-1t:free'
    )

    const request = client.create.mock.calls[0]?.[0] as { messages: Array<{ role: string; tool_calls?: unknown[] }> }
    const assistantMessage = request.messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.tool_calls).toHaveLength(2)
  })

  it('falls back to JSON tool injection when native tool calls are not returned', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'not a native tool call' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ tool: 'read_file', input: { path: 'src/app.ts' } }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    setLatestClient(client)

    const result = await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{
        name: 'read_file',
        description: 'Read file',
        input_schema: { type: 'object', properties: {}, required: [] }
      }],
      'inclusionai/ling-2.6-1t:free'
    )

    expect(result.content).toEqual([{
      type: 'tool_use',
      id: expect.stringMatching(/^openrouter-json-/),
      name: 'read_file',
      input: { path: 'src/app.ts' }
    }])
  })

  it('caches detected tool mode after first detection', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'not a native tool call' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ tool: 'read_file', input: {} }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ tool: 'read_file', input: {} }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    setLatestClient(client)

    await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'inclusionai/ling-2.6-1t:free'
    )
    await provider.callWithTools(
      [{ role: 'user', content: 'read it' }],
      [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {}, required: [] } }],
      'inclusionai/ling-2.6-1t:free'
    )

    expect(client.create).toHaveBeenCalledTimes(3)
  })

  it('returns a valid PreActionPlan or safe default on failure', async () => {
    const { OpenRouterProvider } = await import('../../src/llm/openrouter.js')
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    })
    const client = createClientHandle()
    client.create.mockRejectedValue(new Error('nope'))
    setLatestClient(client)

    const result = await provider.generatePreActionPlan({
      stepIndex: 0,
      description: 'Inspect auth flow',
      approach: 'Fix auth bug',
      affectedSymbols: ['validateToken'],
      affectedFiles: [],
      estimatedRisk: 'medium',
      dependsOn: [],
      isCheckpoint: false
    }, {
      taskId: 'task-1',
      originalTask: 'fix auth',
      structuredDescription: 'fix auth',
      taskType: 'bug_fix',
      affectedArea: 'auth',
      affectedSymbols: ['validateToken'],
      primaryRootCause: 'bug',
      alternativeRootCauses: [],
      rankedApproaches: [],
      identifiedRisks: [],
      activeConstraints: [],
      memberCount: 1,
      consensusConfidence: 0.8,
      verifiedChunkIds: [],
      rules: {
        version: '1.0',
        repo_name: 'repo',
        never_touch: [],
        always_escalate_if: [],
        max_files_changed: 20,
        mutation_scope: 'changed_only'
      },
      synthesizedAt: new Date().toISOString()
    }, 'inclusionai/ling-2.6-1t:free')

    expect(result).toEqual({
      intendedAction: 'Inspect auth flow',
      affectedSymbols: ['validateToken'],
      estimatedRiskLevel: 'medium',
      reasoning: 'Safe fallback pre-action plan because structured generation failed.'
    })
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
