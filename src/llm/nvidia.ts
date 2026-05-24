import OpenAI from 'openai'
import { z } from 'zod'

import type { CompressionLlmProvider } from '../executor/compression.js'
import type { ExecutorLlmProvider, LlmContent, LlmMessage } from '../executor/step.js'
import { repairToolArgs } from '../executor/tool-repair.js'
import type { AnthropicToolDefinition } from '../executor/tools.js'
import type { IntakeLlmProvider } from '../intake/llm.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { PanelMemberLlmProvider } from '../panel/member.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { PreActionPlan } from '../pipeline/state-machine.js'
import { appendLlmTranscript } from '../utils/llm-transcript.js'
import { logInfo, logWarn } from '../utils/logger.js'

const PreActionPlanSchema = z.object({
  intendedAction: z.string(),
  affectedSymbols: z.array(z.string()),
  estimatedRiskLevel: z.enum(['low', 'medium', 'high']),
  reasoning: z.string()
})

const NVIDIA_MODEL_PREFIXES = ['minimaxai/', 'z-ai/'] as const
const NVIDIA_THINKING_KWARGS = {
  enable_thinking: true,
  clear_thinking: false
} as const

function extractReasoningText(message: OpenAI.Chat.Completions.ChatCompletionMessage | null | undefined): string | undefined {
  const candidate = (message as { reasoning_content?: unknown } | null | undefined)?.reasoning_content
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/**
 * NVIDIA NIM provider backed by the OpenAI SDK pointed at NVIDIA's base URL.
 */
export class NvidiaProvider implements IntakeLlmProvider, PanelMemberLlmProvider, CompressionLlmProvider, ExecutorLlmProvider {
  private readonly apiKey: string | null
  private readonly client: OpenAI | null
  private readonly toolSupportByModel = new Map<string, 'native'>()

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.NVIDIA_API_KEY ?? null
    this.client = this.apiKey === null || this.apiKey.length === 0
      ? null
      : new OpenAI({
        apiKey: this.apiKey,
        baseURL: 'https://integrate.api.nvidia.com/v1'
      })
  }

  getDefaultModel(): string {
    return 'z-ai/glm-5.1'
  }

  async generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!isNvidiaModel(model)) {
        continue
      }

      try {
        logInfo('llm:nvidia', '[LLM:NVIDIA] POST generateJson', { model })
        const response = await client.chat.completions.create(withNvidiaThinking({
          model,
          messages: [{ role: 'user', content: prompt }]
        }))
        logInfo('llm:nvidia', '[LLM:NVIDIA] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })
        appendLlmTranscript({
          provider: 'nvidia',
          operation: 'generateJson',
          model,
          request: {
            prompt
          },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        logWarn('llm:nvidia', '[LLM:NVIDIA] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown NVIDIA error'
        })
        appendLlmTranscript({
          provider: 'nvidia',
          operation: 'generateJson',
          model,
          request: {
            prompt
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown NVIDIA error'
          }
        })
        lastError = error instanceof Error ? error : new Error('Unknown NVIDIA error')
      }
    }

    throw lastError ?? new Error('No NVIDIA models were available in preferredModels.')
  }

  async generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!isNvidiaModel(model)) {
        continue
      }

      try {
        logInfo('llm:nvidia', '[LLM:NVIDIA] POST generateText', { model })
        const response = await client.chat.completions.create(withNvidiaThinking({
          model,
          messages: [{ role: 'user', content: prompt }]
        }))
        logInfo('llm:nvidia', '[LLM:NVIDIA] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })
        appendLlmTranscript({
          provider: 'nvidia',
          operation: 'generateText',
          model,
          request: {
            prompt
          },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        logWarn('llm:nvidia', '[LLM:NVIDIA] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown NVIDIA error'
        })
        appendLlmTranscript({
          provider: 'nvidia',
          operation: 'generateText',
          model,
          request: {
            prompt
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown NVIDIA error'
          }
        })
        lastError = error instanceof Error ? error : new Error('Unknown NVIDIA error')
      }
    }

    throw lastError ?? new Error('No NVIDIA models were available in preferredModels.')
  }

  async analyze(prompt: string, model: string): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
    const client = this.getClient()
    logInfo('llm:nvidia', '[LLM:NVIDIA] POST analyze', { model })
    const response = await client.chat.completions.create(withNvidiaThinking({
      model,
      messages: [{ role: 'user', content: prompt }]
    }))
    const promptTokens = response.usage?.prompt_tokens ?? 0
    const completionTokens = response.usage?.completion_tokens ?? 0

    logInfo('llm:nvidia', '[LLM:NVIDIA] Response 200', {
      model,
      promptTokens,
      completionTokens
    })
    appendLlmTranscript({
      provider: 'nvidia',
      operation: 'analyze',
      model,
      request: {
        prompt
      },
      response: {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null
      }
    })
    return {
      text: extractMessageText(response.choices[0]?.message.content),
      tokensUsed: promptTokens + completionTokens,
      costUsd: 0
    }
  }

  async distill(content: string, taskContext: string, model: string): Promise<string> {
    const client = this.getClient()
    const response = await client.chat.completions.create(withNvidiaThinking({
      model,
      messages: [{
        role: 'user',
        content: [
          'You are a context compression engine.',
          `Task context: ${taskContext}`,
          'Compress the following code content. Preserve: symbol names, function signatures, key logic, error patterns.',
          'Remove: comments, blank lines, import blocks not directly relevant.',
          'Return ONLY the compressed content. No explanation.',
          `Content:\n${content}`
        ].join('\n')
      }]
    }))
    appendLlmTranscript({
      provider: 'nvidia',
      operation: 'distill',
      model,
      request: {
        content,
        taskContext
      },
      response: {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null
      }
    })

    return extractMessageText(response.choices[0]?.message.content)
  }

  async generatePreActionPlan(step: ExecutionStep, enrichedPacket: EnrichedPacket, model: string): Promise<PreActionPlan> {
    const client = this.getClient()
    const prompt = buildPreActionPlanPrompt(step, enrichedPacket)

    try {
      const response = await client.chat.completions.create(withNvidiaThinking({
        model,
        messages: [{ role: 'user', content: prompt }],
        tools: [toOpenAiTool({
          name: 'submit_pre_action_plan',
          description: 'Submit the executor pre-action plan in structured form.',
          input_schema: {
            type: 'object',
            properties: {
              intendedAction: { type: 'string' },
              affectedSymbols: { type: 'array', items: { type: 'string' } },
              estimatedRiskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
              reasoning: { type: 'string' }
            },
            required: ['intendedAction', 'affectedSymbols', 'estimatedRiskLevel', 'reasoning']
          }
        })],
        tool_choice: 'auto'
      }))
      appendLlmTranscript({
        provider: 'nvidia',
        operation: 'generatePreActionPlan',
        model,
        request: {
          prompt,
          tools: ['submit_pre_action_plan']
        },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      const toolCall = response.choices[0]?.message.tool_calls?.[0]

      if (toolCall?.type === 'function') {
        this.logToolModeOnce(model, 'native')
        return PreActionPlanSchema.parse(JSON.parse(toolCall.function.arguments) as unknown)
      }
    } catch {
      // Fall through to JSON mode.
    }

    return this.generatePreActionPlanJson(prompt, model, step)
  }

  async callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number; reasoningText?: string }> {
    const client = this.getClient()
    const detectedMode = this.toolSupportByModel.get(model)
    logInfo('llm:nvidia', '[LLM:NVIDIA] POST callWithTools', {
      model,
      mode: detectedMode ?? 'native-probe'
    })

    try {
      const nativeResponse = await client.chat.completions.create(withNvidiaThinking({
        model,
        messages: [
          ...(system === undefined || system.length === 0 ? [] : [{ role: 'system' as const, content: system }]),
          ...toOpenAiMessages(messages)
        ],
        tools: tools.map(toOpenAiTool),
        tool_choice: 'auto'
      }))
      appendLlmTranscript({
        provider: 'nvidia',
        operation: 'callWithTools:native',
        model,
        request: {
          messages,
          tools
        },
        response: {
          message: nativeResponse.choices[0]?.message ?? null,
          usage: nativeResponse.usage ?? null
        }
      })
      const toolCalls = nativeResponse.choices[0]?.message.tool_calls ?? []

      if (toolCalls.length > 0) {
        this.logToolModeOnce(model, 'native')
        return {
          content: toolCalls.flatMap((toolCall) => (
            toolCall.type === 'function'
              ? [{
                type: 'tool_use' as const,
                id: toolCall.id,
                name: toolCall.function.name,
                input: parseToolArguments(toolCall.function.name, toolCall.function.arguments)
              }]
              : []
          )),
          tokensUsed: (nativeResponse.usage?.prompt_tokens ?? 0) + (nativeResponse.usage?.completion_tokens ?? 0),
          costUsd: 0,
          reasoningText: extractReasoningText(nativeResponse.choices[0]?.message)
        }
      }

      const text = extractMessageText(nativeResponse.choices[0]?.message.content)
      const finishReason = nativeResponse.choices[0]?.finish_reason ?? 'stop'

      if (detectedMode === 'native' || finishReason !== 'stop' || text.trim().length > 0) {
        return {
          content: [{ type: 'text', text }],
          tokensUsed: (nativeResponse.usage?.prompt_tokens ?? 0) + (nativeResponse.usage?.completion_tokens ?? 0),
          costUsd: 0,
          reasoningText: extractReasoningText(nativeResponse.choices[0]?.message)
        }
      }
    } catch {
      if (detectedMode === 'native') {
        throw new Error(`NVIDIA native tool call failed for ${model}.`)
      }
    }

    return this.callWithJsonToolInjection(messages, tools, model, system)
  }

  private getClient(): OpenAI {
    if (this.client === null) {
      throw new Error('NvidiaProvider requires NVIDIA_API_KEY. Set process.env.NVIDIA_API_KEY or pass apiKey to the constructor.')
    }

    return this.client
  }

  private async callWithJsonToolInjection(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number; reasoningText?: string }> {
    const client = this.getClient()
    const response = await client.chat.completions.create(withNvidiaThinking({
      model,
      messages: buildJsonInjectionMessages(messages, tools, system)
    }))
    appendLlmTranscript({
      provider: 'nvidia',
      operation: 'callWithTools:json_fallback',
      model,
      request: {
        messages,
        tools
      },
      response: {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null
      }
    })
    const promptTokens = response.usage?.prompt_tokens ?? 0
    const completionTokens = response.usage?.completion_tokens ?? 0
    const text = extractMessageText(response.choices[0]?.message.content)
    const parsedToolPayload = safeParseToolPayload(text)

    if (parsedToolPayload !== null) {
      return {
        content: [{
          type: 'tool_use',
          id: `nvidia-json-${Date.now()}`,
          name: parsedToolPayload.tool,
          input: parsedToolPayload.input
        }],
        tokensUsed: promptTokens + completionTokens,
        costUsd: 0,
        reasoningText: extractReasoningText(response.choices[0]?.message)
      }
    }

    return {
      content: [{ type: 'text', text }],
      tokensUsed: promptTokens + completionTokens,
      costUsd: 0,
      reasoningText: extractReasoningText(response.choices[0]?.message)
    }
  }

  private async generatePreActionPlanJson(prompt: string, model: string, step: ExecutionStep): Promise<PreActionPlan> {
    try {
      const response = await this.getClient().chat.completions.create(withNvidiaThinking({
        model,
        messages: [{
          role: 'user',
          content: [
            prompt,
            'Respond ONLY with valid JSON matching this schema exactly:',
            "{ intendedAction: string, affectedSymbols: string[], estimatedRiskLevel: 'low'|'medium'|'high', reasoning: string }",
            'No markdown. No explanation. Just JSON.'
          ].join('\n')
        }]
      }))
      appendLlmTranscript({
        provider: 'nvidia',
        operation: 'generatePreActionPlan:json_fallback',
        model,
        request: {
          prompt
        },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })

      return PreActionPlanSchema.parse(JSON.parse(extractMessageText(response.choices[0]?.message.content)) as unknown)
    } catch {
      return buildSafePreActionPlan(step)
    }
  }

  private logToolModeOnce(model: string, mode: 'native'): void {
    if (this.toolSupportByModel.get(model) === mode) {
      return
    }

    this.toolSupportByModel.set(model, mode)
    console.log(`[NVIDIA] Model ${model}: native tool calling supported`)
  }
}

function isNvidiaModel(modelId: string): boolean {
  return NVIDIA_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))
}

function withNvidiaThinking<T extends OpenAI.Chat.Completions.ChatCompletionCreateParams>(request: T): T & {
  chat_template_kwargs: typeof NVIDIA_THINKING_KWARGS
} {
  return {
    ...request,
    chat_template_kwargs: NVIDIA_THINKING_KWARGS
  }
}

function toOpenAiTool(tool: AnthropicToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  }
}

function toOpenAiMessages(messages: LlmMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const converted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      converted.push({
        role: message.role,
        content: message.content
      })
      continue
    }

    if (message.role === 'assistant') {
      const toolCalls = message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: block.id ?? `tool-${Date.now()}`,
          type: 'function' as const,
          function: {
            name: block.name ?? 'unknown',
            arguments: JSON.stringify(block.input ?? {})
          }
        }))
      const textContent = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim()

      if (toolCalls.length > 0) {
        converted.push({
          role: 'assistant',
          content: textContent.length > 0 ? textContent : null,
          tool_calls: toolCalls
        })
        continue
      }

      converted.push({
        role: 'assistant',
        content: textContent
      })
      continue
    }

    const toolResults = message.content.filter((block) => block.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        converted.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? 'unknown',
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '')
        })
      }
      continue
    }

    converted.push({
      role: 'user',
      content: stringifyMessageContent(message.content)
    })
  }

  return converted
}

function stringifyMessageContent(content: LlmContent[]): string {
  return content.map((block) => {
    if (block.type === 'text') {
      return block.text ?? ''
    }

    if (block.type === 'tool_result') {
      return `Tool result (${block.tool_use_id ?? 'unknown'}): ${block.content ?? ''}`
    }

    return `Tool call (${block.name ?? 'unknown'}): ${JSON.stringify(block.input ?? {})}`
  }).join('\n')
}

function buildJsonInjectionMessages(
  messages: LlmMessage[],
  tools: AnthropicToolDefinition[],
  system?: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const toolList = tools.map((tool) => [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    `Input schema: ${JSON.stringify(tool.input_schema)}`
  ].join('\n')).join('\n\n')

  const systemPrompt = [
    'You are operating in JSON tool fallback mode.',
    'If you need to use a tool, respond ONLY with valid JSON matching this schema:',
    '{ "tool": string, "input": object }',
    'If no tool is needed, respond with plain text only.',
    'Available tools:',
    toolList
  ].join('\n')

  const serializedMessages = messages.map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : stringifyMessageContent(message.content)}`)

  return [
    ...(system === undefined || system.length === 0 ? [] : [{ role: 'system' as const, content: system }]),
    { role: 'system', content: systemPrompt },
    { role: 'user', content: serializedMessages.join('\n') }
  ]
}

function safeParseToolPayload(text: string): { tool: string; input: Record<string, unknown> } | null {
  try {
    const ToolPayloadSchema = z.object({
      tool: z.string().min(1),
      input: z.record(z.string(), z.unknown())
    })

    return ToolPayloadSchema.parse(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseToolArguments(toolName: string, rawArguments: string): Record<string, unknown> {
  const parsed = safeParseObject(rawArguments)
  if (Object.keys(parsed).length > 0) {
    return parsed
  }

  return repairToolArgs(toolName, {}, rawArguments)
}

function extractMessageText(content: OpenAI.Chat.Completions.ChatCompletionMessage['content'] | null | undefined): string {
  if (typeof content === 'string') {
    return content
  }

  const contentBlocks = Array.isArray(content) ? content as Array<{ text?: string }> : null

  if (contentBlocks !== null) {
    return contentBlocks
      .map((block) => block.text ?? '')
      .join('')
  }

  return ''
}

function buildPreActionPlanPrompt(step: ExecutionStep, enrichedPacket: EnrichedPacket): string {
  return [
    'Build a precise pre-action plan for this execution step.',
    `Step description: ${step.description}`,
    `Approach: ${step.approach}`,
    `Affected symbols: ${step.affectedSymbols.join(', ') || 'none'}`,
    `Structured task description: ${enrichedPacket.structuredDescription}`,
    `Primary root cause: ${enrichedPacket.primaryRootCause}`
  ].join('\n')
}

function buildSafePreActionPlan(step: ExecutionStep): PreActionPlan {
  return {
    intendedAction: step.description,
    affectedSymbols: step.affectedSymbols,
    estimatedRiskLevel: step.estimatedRisk,
    reasoning: 'Safe fallback pre-action plan because structured generation failed.'
  }
}
