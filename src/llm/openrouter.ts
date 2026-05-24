import { setTimeout as sleep } from 'node:timers/promises'

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
import { calculateCost } from '../utils/cost.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { appendLlmTranscript } from '../utils/llm-transcript.js'

/**
 * Static OpenRouter provider configuration for one provider instance.
 */
export interface OpenRouterConfig {
  apiKey: string
  path: 'free' | 'paid'
  modelId: string
  siteUrl?: string
  siteName?: string
  rateLimitRetryMs?: number
}

const DEFAULT_SITE_URL = 'https://github.com/planone'
const DEFAULT_SITE_NAME = 'PlanOne'
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000

const ToolPayloadSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown())
})

const PreActionPlanSchema = z.object({
  intendedAction: z.string(),
  affectedSymbols: z.array(z.string()),
  estimatedRiskLevel: z.enum(['low', 'medium', 'high']),
  reasoning: z.string()
})

/**
 * OpenRouter provider backed by the OpenAI SDK pointed at OpenRouter's base URL.
 *
 * The provider prefers native tool calling and only falls back to JSON tool
 * injection when the model demonstrably fails to emit tool calls.
 */
export class OpenRouterProvider implements IntakeLlmProvider, PanelMemberLlmProvider, CompressionLlmProvider, ExecutorLlmProvider {
  private readonly config: Required<Omit<OpenRouterConfig, 'apiKey'>> & { apiKey: string }
  private readonly client: OpenAI
  private readonly toolSupportByModel = new Map<string, 'native' | 'json'>()

  /**
   * Creates an OpenRouter provider with enforced path/model normalization.
   */
  constructor(config: OpenRouterConfig) {
    const normalizedModelId = normalizeModelId(config.modelId, config.path)

    this.config = {
      apiKey: config.apiKey,
      path: config.path,
      modelId: normalizedModelId,
      siteUrl: config.siteUrl ?? DEFAULT_SITE_URL,
      siteName: config.siteName ?? DEFAULT_SITE_NAME,
      rateLimitRetryMs: config.rateLimitRetryMs ?? DEFAULT_RATE_LIMIT_RETRY_MS
    }
    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': this.config.siteUrl,
        'X-OpenRouter-Title': this.config.siteName
      }
    })
  }

  /**
   * Returns the normalized model ID configured for this provider instance.
   */
  getDefaultModel(): string {
    return this.config.modelId
  }

  /**
   * Generates JSON text using the first successful model in preference order.
   */
  async generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    let lastError: Error | null = null

    for (const preferredModel of preferredModels) {
      try {
        const model = this.normalizeRequestModel(preferredModel)
        logInfo('llm:openrouter', '[LLM:OpenRouter] POST generateJson', { model })
        const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }]
        }))
        appendLlmTranscript({
          provider: 'openrouter',
          operation: 'generateJson',
          model,
          request: {
            messages: [{ role: 'user', content: prompt }]
          },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })
        logInfo('llm:openrouter', '[LLM:OpenRouter] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'openrouter',
          operation: 'generateJson',
          model: preferredModel,
          request: {
            messages: [{ role: 'user', content: prompt }]
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown OpenRouter error'
          }
        })
        logWarn('llm:openrouter', '[LLM:OpenRouter] Request failed', {
          model: preferredModel,
          error: error instanceof Error ? error.message : 'Unknown OpenRouter error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown OpenRouter error')
      }
    }

    throw lastError ?? new Error('OpenRouterProvider could not satisfy any preferred model.')
  }

  async generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    let lastError: Error | null = null

    for (const preferredModel of preferredModels) {
      try {
        const model = this.normalizeRequestModel(preferredModel)
        logInfo('llm:openrouter', '[LLM:OpenRouter] POST generateText', { model })
        const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }]
        }))
        appendLlmTranscript({
          provider: 'openrouter',
          operation: 'generateText',
          model,
          request: {
            messages: [{ role: 'user', content: prompt }]
          },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })
        logInfo('llm:openrouter', '[LLM:OpenRouter] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'openrouter',
          operation: 'generateText',
          model: preferredModel,
          request: {
            messages: [{ role: 'user', content: prompt }]
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown OpenRouter error'
          }
        })
        logWarn('llm:openrouter', '[LLM:OpenRouter] Request failed', {
          model: preferredModel,
          error: error instanceof Error ? error.message : 'Unknown OpenRouter error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown OpenRouter error')
      }
    }

    throw lastError ?? new Error('OpenRouterProvider could not satisfy any preferred model.')
  }

  /**
   * Runs the panel analysis call and returns text plus usage metadata.
   */
  async analyze(prompt: string, model: string): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
    const normalizedModel = this.normalizeRequestModel(model)
    logInfo('llm:openrouter', '[LLM:OpenRouter] POST analyze', { model: normalizedModel })
    const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
      model: normalizedModel,
      messages: [{ role: 'user', content: prompt }]
    }))
    appendLlmTranscript({
      provider: 'openrouter',
      operation: 'analyze',
      model: normalizedModel,
      request: {
        messages: [{ role: 'user', content: prompt }]
      },
      response: {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null
      }
    })
    const promptTokens = response.usage?.prompt_tokens ?? 0
    const completionTokens = response.usage?.completion_tokens ?? 0

    logInfo('llm:openrouter', '[LLM:OpenRouter] Response 200', {
      model: normalizedModel,
      promptTokens,
      completionTokens
    })
    return {
      text: extractMessageText(response.choices[0]?.message.content),
      tokensUsed: promptTokens + completionTokens,
      costUsd: this.computeCostUsd(normalizedModel, promptTokens, completionTokens)
    }
  }

  /**
   * Distills working content for executor compression.
   */
  async distill(content: string, taskContext: string, model: string): Promise<string> {
    const normalizedModel = this.normalizeRequestModel(model)
    const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
      model: normalizedModel,
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
      provider: 'openrouter',
      operation: 'distill',
      model: normalizedModel,
      request: {
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
      },
      response: {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null
      }
    })

    return extractMessageText(response.choices[0]?.message.content)
  }

  /**
   * Generates a structured pre-action plan, preferring native tools first.
   */
  async generatePreActionPlan(step: ExecutionStep, enrichedPacket: EnrichedPacket, model: string): Promise<PreActionPlan> {
    const normalizedModel = this.normalizeRequestModel(model)
    const mode = this.toolSupportByModel.get(normalizedModel)
    const prompt = buildPreActionPlanPrompt(step, enrichedPacket)

    if (mode === 'json') {
      return this.generatePreActionPlanJson(prompt, normalizedModel, step)
    }

    try {
      const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
        model: normalizedModel,
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
        provider: 'openrouter',
        operation: 'generatePreActionPlan',
        model: normalizedModel,
        request: {
          messages: [{ role: 'user', content: prompt }],
          tools: ['submit_pre_action_plan']
        },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      const toolCall = response.choices[0]?.message.tool_calls?.[0]

      if (toolCall?.type === 'function') {
        this.logToolModeOnce(normalizedModel, 'native')
        return PreActionPlanSchema.parse(JSON.parse(toolCall.function.arguments) as unknown)
      }
    } catch {
      // Fall through to JSON mode.
    }

    this.logToolModeOnce(normalizedModel, 'json')
    return this.generatePreActionPlanJson(prompt, normalizedModel, step)
  }

  /**
   * Runs the executor conversation with native OpenRouter tools or JSON fallback.
   */
  async callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number }> {
    const normalizedModel = this.normalizeRequestModel(model)
    const detectedMode = this.toolSupportByModel.get(normalizedModel)
    logInfo('llm:openrouter', '[LLM:OpenRouter] POST callWithTools', {
      model: normalizedModel,
      mode: detectedMode ?? 'unknown'
    })

    if (detectedMode === 'json') {
      return this.callWithJsonToolInjection(messages, tools, normalizedModel, system)
    }

    try {
      const nativeResponse = await this.withRateLimitHandling(() => this.client.chat.completions.create({
        model: normalizedModel,
        messages: [
          ...(system === undefined || system.length === 0 ? [] : [{ role: 'system' as const, content: system }]),
          ...toOpenAiMessages(messages)
        ],
        tools: tools.map(toOpenAiTool),
        tool_choice: 'auto'
      }))
      appendLlmTranscript({
        provider: 'openrouter',
        operation: 'callWithTools',
        model: normalizedModel,
        request: {
          mode: 'native',
          messages: toOpenAiMessages(messages),
          tools: tools.map(toOpenAiTool)
        },
        response: {
          message: nativeResponse.choices[0]?.message ?? null,
          finishReason: nativeResponse.choices[0]?.finish_reason ?? null,
          usage: nativeResponse.usage ?? null
        }
      })
      const toolCalls = nativeResponse.choices[0]?.message.tool_calls ?? []

      if (toolCalls.length > 0) {
        this.logToolModeOnce(normalizedModel, 'native')
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
          costUsd: this.computeCostUsd(
            normalizedModel,
            nativeResponse.usage?.prompt_tokens ?? 0,
            nativeResponse.usage?.completion_tokens ?? 0
          )
        }
      }

      const text = extractMessageText(nativeResponse.choices[0]?.message.content)
      const finishReason = nativeResponse.choices[0]?.finish_reason ?? 'stop'

      if (detectedMode === 'native' || finishReason !== 'stop') {
        return {
          content: [{ type: 'text', text }],
          tokensUsed: (nativeResponse.usage?.prompt_tokens ?? 0) + (nativeResponse.usage?.completion_tokens ?? 0),
          costUsd: this.computeCostUsd(
            normalizedModel,
            nativeResponse.usage?.prompt_tokens ?? 0,
            nativeResponse.usage?.completion_tokens ?? 0
          )
        }
      }
    } catch {
      if (detectedMode === 'native') {
        throw new Error(`OpenRouter native tool call failed for ${normalizedModel}.`)
      }
    }

    this.logToolModeOnce(normalizedModel, 'json')
    return this.callWithJsonToolInjection(messages, tools, normalizedModel, system)
  }

  private async callWithJsonToolInjection(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number }> {
    const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
      model,
      messages: buildJsonInjectionMessages(messages, tools, system)
    }))
    appendLlmTranscript({
      provider: 'openrouter',
      operation: 'callWithTools',
      model,
      request: {
        mode: 'json',
        messages: buildJsonInjectionMessages(messages, tools, system)
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
          id: `openrouter-json-${Date.now()}`,
          name: parsedToolPayload.tool,
          input: parsedToolPayload.input
        }],
        tokensUsed: promptTokens + completionTokens,
        costUsd: this.computeCostUsd(model, promptTokens, completionTokens)
      }
    }

    return {
      content: [{ type: 'text', text }],
      tokensUsed: promptTokens + completionTokens,
      costUsd: this.computeCostUsd(model, promptTokens, completionTokens)
    }
  }

  private async generatePreActionPlanJson(prompt: string, model: string, step: ExecutionStep): Promise<PreActionPlan> {
    try {
      const response = await this.withRateLimitHandling(() => this.client.chat.completions.create({
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
        provider: 'openrouter',
        operation: 'generatePreActionPlanJson',
        model,
        request: {
          messages: [{
            role: 'user',
            content: [
              prompt,
              'Respond ONLY with valid JSON matching this schema exactly:',
              "{ intendedAction: string, affectedSymbols: string[], estimatedRiskLevel: 'low'|'medium'|'high', reasoning: string }",
              'No markdown. No explanation. Just JSON.'
            ].join('\n')
          }]
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

  private normalizeRequestModel(model: string): string {
    return normalizeModelId(model, this.config.path)
  }

  private computeCostUsd(model: string, promptTokens: number, completionTokens: number): number {
    if (this.config.path === 'free') {
      return 0
    }

    const knownCost = calculateCost(model, promptTokens, completionTokens)

    if (knownCost > 0) {
      return knownCost
    }

    return Number((((promptTokens / 1000) * 0.001) + ((completionTokens / 1000) * 0.002)).toFixed(6))
  }

  private async withRateLimitHandling<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (is429Error(error)) {
        const message = getErrorMessage(error)

        if (isTemporaryRateLimitMessage(message)) {
          await sleep(this.config.rateLimitRetryMs)

          try {
            return await operation()
          } catch (retryError) {
            if (is429Error(retryError)) {
              throw new Error('[OpenRouter] Daily free quota exhausted (50 req/day limit). Upgrade to paid OpenRouter or wait until quota resets at midnight UTC.')
            }

            throw retryError
          }
        }

        throw new Error('[OpenRouter] Daily free quota exhausted (50 req/day limit). Upgrade to paid OpenRouter or wait until quota resets at midnight UTC.')
      }

      throw error
    }
  }

  private logToolModeOnce(model: string, mode: 'native' | 'json'): void {
    if (this.toolSupportByModel.get(model) === mode) {
      return
    }

    this.toolSupportByModel.set(model, mode)
    console.log(
      mode === 'native'
        ? `[OpenRouter] Model ${model}: native tool calling supported`
        : `[OpenRouter] Model ${model}: falling back to JSON tool injection`
    )
  }
}

/**
 * Creates an OpenRouter provider instance.
 */
export function createOpenRouterProvider(config: OpenRouterConfig): OpenRouterProvider {
  return new OpenRouterProvider(config)
}

function normalizeModelId(modelId: string, path: 'free' | 'paid'): string {
  if (path === 'free' && !modelId.endsWith(':free')) {
    console.warn(`[OpenRouter] Free path requested for ${modelId}; appending :free suffix automatically.`)
    return `${modelId}:free`
  }

  if (path === 'paid' && modelId.endsWith(':free')) {
    console.warn(`[OpenRouter] Paid path requested for ${modelId}; stripping :free suffix automatically.`)
    return modelId.replace(/:free$/, '')
  }

  return modelId
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
    `Name: ${tool.name}`,
    `Description: ${tool.description}`,
    `Input schema: ${JSON.stringify(tool.input_schema)}`
  ].join('\n')).join('\n\n')

  return [
    ...(system === undefined || system.length === 0 ? [] : [{ role: 'system' as const, content: system }]),
    {
      role: 'user',
      content: [
      'You have access to the following tools. To use a tool, respond with ONLY a JSON object in this exact format (no other text):',
      '{"tool": "<tool_name>", "input": {<tool_input_object>}}',
      '',
      'Available tools:',
      toolList,
      '',
      'If you are done and have no tool to call, respond with your final answer as plain text.',
      '',
      'Conversation:',
      ...messages.map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : stringifyMessageContent(message.content)}`)
      ].join('\n')
    }
  ]
}

function extractMessageText(content: string | Array<OpenAI.Chat.Completions.ChatCompletionContentPartText> | null | undefined): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
  }

  return ''
}

function safeParseToolPayload(text: string): z.infer<typeof ToolPayloadSchema> | null {
  try {
    return ToolPayloadSchema.parse(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function safeParseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
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

function is429Error(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 429
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string') {
      return error.message
    }

    if ('error' in error && typeof error.error === 'object' && error.error !== null && 'message' in error.error && typeof error.error.message === 'string') {
      return error.error.message
    }
  }

  return 'Unknown OpenRouter error'
}

function isTemporaryRateLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('per minute') || normalized.includes('rpm') || normalized.includes('too many requests')
}
