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

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

const PreActionPlanSchema = z.object({
  intendedAction: z.string(),
  affectedSymbols: z.array(z.string()),
  estimatedRiskLevel: z.enum(['low', 'medium', 'high']),
  reasoning: z.string()
})

interface GroqFallbackConfig {
  intakeProvider?: IntakeLlmProvider & Partial<PanelMemberLlmProvider> & Partial<CompressionLlmProvider>
  intakeModel?: string
  executorProvider?: ExecutorLlmProvider
  executorModel?: string
}

export class GroqProvider implements IntakeLlmProvider, PanelMemberLlmProvider, CompressionLlmProvider, ExecutorLlmProvider {
  private readonly apiKey: string | null
  private readonly client: OpenAI | null
  private readonly fallback: GroqFallbackConfig

  constructor(apiKey?: string, fallback: GroqFallbackConfig = {}) {
    this.apiKey = apiKey ?? process.env.GROQ_API_KEY ?? null
    this.client = this.apiKey === null || this.apiKey.length === 0
      ? null
      : new OpenAI({
        apiKey: this.apiKey,
        baseURL: GROQ_BASE_URL
      })
    this.fallback = fallback
  }

  getDefaultModel(): string {
    return 'llama-3.3-70b-versatile'
  }

  async generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!isGroqModel(model)) {
        continue
      }

      try {
        logInfo('llm:groq', '[LLM:Groq] POST generateJson', { model })
        const response = await client.chat.completions.create({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }]
        })
        appendLlmTranscript({
          provider: 'groq',
          operation: 'generateJson',
          model,
          request: { prompt },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })
        logInfo('llm:groq', '[LLM:Groq] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        lastError = asError(error)
        appendLlmTranscript({
          provider: 'groq',
          operation: 'generateJson',
          model,
          request: { prompt },
          error: { message: lastError.message }
        })
        logWarn('llm:groq', '[LLM:Groq] Request failed', { model, error: lastError.message })
      }
    }

    throw lastError ?? new Error('No Groq models were available in preferredModels.')
  }

  async generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!isGroqModel(model)) {
        continue
      }

      try {
        logInfo('llm:groq', '[LLM:Groq] POST generateText', { model })
        const response = await client.chat.completions.create({
          model,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        })
        appendLlmTranscript({
          provider: 'groq',
          operation: 'generateText',
          model,
          request: { prompt },
          response: {
            message: response.choices[0]?.message ?? null,
            usage: response.usage ?? null
          }
        })
        logInfo('llm:groq', '[LLM:Groq] Response 200', {
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0
        })

        return {
          model,
          text: extractMessageText(response.choices[0]?.message.content)
        }
      } catch (error) {
        const candidateError = asError(error)
        appendLlmTranscript({
          provider: 'groq',
          operation: 'generateText',
          model,
          request: { prompt },
          error: { message: candidateError.message }
        })
        logWarn('llm:groq', '[LLM:Groq] Request failed', { model, error: candidateError.message })
        if (isRetryableGroqError(candidateError)) {
          const fallbackResult = await this.tryFallbackGenerateText(prompt)

          if (fallbackResult !== null) {
            return fallbackResult
          }
        }
        lastError = candidateError
      }
    }

    throw lastError ?? new Error('No Groq models were available in preferredModels.')
  }

  async analyze(prompt: string, model: string): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
    try {
      const client = this.getClient()
      logInfo('llm:groq', '[LLM:Groq] POST analyze', { model })
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
      appendLlmTranscript({
        provider: 'groq',
        operation: 'analyze',
        model,
        request: { prompt },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      const promptTokens = response.usage?.prompt_tokens ?? 0
      const completionTokens = response.usage?.completion_tokens ?? 0
      return {
        text: extractMessageText(response.choices[0]?.message.content),
        tokensUsed: promptTokens + completionTokens,
        costUsd: 0
      }
    } catch (error) {
      const candidateError = asError(error)
      if (isRetryableGroqError(candidateError)) {
        const fallback = await this.tryFallbackAnalyze(prompt)

        if (fallback !== null) {
          return fallback
        }
      }
      throw candidateError
    }
  }

  async distill(content: string, taskContext: string, model: string): Promise<string> {
    try {
      const client = this.getClient()
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
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
      })
      appendLlmTranscript({
        provider: 'groq',
        operation: 'distill',
        model,
        request: { content, taskContext },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      return extractMessageText(response.choices[0]?.message.content)
    } catch (error) {
      const candidateError = asError(error)
      if (isRetryableGroqError(candidateError) && this.fallback.intakeProvider?.distill !== undefined && this.fallback.intakeModel !== undefined) {
        return this.fallback.intakeProvider.distill(content, taskContext, this.fallback.intakeModel)
      }
      throw candidateError
    }
  }

  async generatePreActionPlan(step: ExecutionStep, enrichedPacket: EnrichedPacket, model: string): Promise<PreActionPlan> {
    try {
      const client = this.getClient()
      const prompt = buildPreActionPlanPrompt(step, enrichedPacket)
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
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
      })
      appendLlmTranscript({
        provider: 'groq',
        operation: 'generatePreActionPlan',
        model,
        request: { prompt, tools: ['submit_pre_action_plan'] },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      const toolCall = response.choices[0]?.message.tool_calls?.[0]

      if (toolCall?.type === 'function') {
        return PreActionPlanSchema.parse(JSON.parse(toolCall.function.arguments) as unknown)
      }
    } catch (error) {
      const candidateError = asError(error)
      if (isRetryableGroqError(candidateError) && this.fallback.executorProvider?.generatePreActionPlan !== undefined && this.fallback.executorModel !== undefined) {
        return this.fallback.executorProvider.generatePreActionPlan(step, enrichedPacket, this.fallback.executorModel) as Promise<PreActionPlan>
      }
    }

    return {
      intendedAction: step.description,
      affectedSymbols: step.affectedSymbols,
      estimatedRiskLevel: step.estimatedRisk,
      reasoning: 'Safe fallback pre-action plan because structured generation failed.'
    }
  }

  async callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number }> {
    try {
      const client = this.getClient()
      logInfo('llm:groq', '[LLM:Groq] POST callWithTools', { model, mode: 'native' })
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          ...(system === undefined || system.length === 0 ? [] : [{ role: 'system' as const, content: system }]),
          ...toOpenAiMessages(messages)
        ],
        tools: tools.map(toOpenAiTool),
        tool_choice: 'auto'
      })
      appendLlmTranscript({
        provider: 'groq',
        operation: 'callWithTools:native',
        model,
        request: { messages, tools },
        response: {
          message: response.choices[0]?.message ?? null,
          usage: response.usage ?? null
        }
      })
      const promptTokens = response.usage?.prompt_tokens ?? 0
      const completionTokens = response.usage?.completion_tokens ?? 0
      const content = contentFromChoice(response.choices[0]?.message)
      return {
        content,
        tokensUsed: promptTokens + completionTokens,
        costUsd: 0
      }
    } catch (error) {
      const candidateError = asError(error)
      appendLlmTranscript({
        provider: 'groq',
        operation: 'callWithTools:native',
        model,
        request: { messages, tools },
        error: { message: candidateError.message }
      })
      if (isRetryableGroqError(candidateError) && this.fallback.executorProvider !== undefined && this.fallback.executorModel !== undefined) {
        return this.fallback.executorProvider.callWithTools(messages, tools, this.fallback.executorModel, system)
      }
      throw candidateError
    }
  }

  private async tryFallbackAnalyze(prompt: string): Promise<{ text: string; tokensUsed: number; costUsd: number } | null> {
    if (this.fallback.intakeProvider?.analyze === undefined || this.fallback.intakeModel === undefined) {
      return null
    }

    return this.fallback.intakeProvider.analyze(prompt, this.fallback.intakeModel)
  }

  private async tryFallbackGenerateText(prompt: string): Promise<{ model: string; text: string } | null> {
    if (this.fallback.intakeProvider?.generateText === undefined || this.fallback.intakeModel === undefined) {
      return null
    }

    return this.fallback.intakeProvider.generateText(prompt, [this.fallback.intakeModel])
  }

  private getClient(): OpenAI {
    if (this.client === null) {
      throw new Error('GroqProvider requires GROQ_API_KEY. Set process.env.GROQ_API_KEY or pass apiKey to the constructor.')
    }

    return this.client
  }
}

function isGroqModel(model: string): boolean {
  return model.startsWith('llama-') || model.startsWith('mixtral-') || model.startsWith('qwen-')
}

function isRetryableGroqError(error: Error): boolean {
  const message = error.message
  return /\b429\b/.test(message)
    || /\b503\b/.test(message)
    || /too many requests/i.test(message)
    || /service unavailable/i.test(message)
    || /retry-after/i.test(message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
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
  return messages.flatMap((message) => {
    if (!Array.isArray(message.content)) {
      return [{
        role: message.role,
        content: message.content
      }]
    }

    const toolUses = message.content.filter((block) => block.type === 'tool_use')
    const toolResults = message.content.filter((block) => block.type === 'tool_result')
    const textBlocks = message.content.filter((block) => block.type === 'text')
    const openAiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

    if (message.role === 'assistant') {
      if (toolUses.length > 0) {
        openAiMessages.push({
          role: 'assistant',
          content: textBlocks.map((block) => block.text ?? '').join('\n').trim() || null,
          tool_calls: toolUses.map((block) => ({
            id: block.id ?? `tool-${block.name ?? 'unknown'}`,
            type: 'function',
            function: {
              name: block.name ?? 'unknown',
              arguments: JSON.stringify(block.input ?? {})
            }
          }))
        })
      } else {
        openAiMessages.push({
          role: 'assistant',
          content: textBlocks.map((block) => block.text ?? '').join('\n')
        })
      }

      return openAiMessages
    }

    if (toolResults.length > 0) {
      for (const block of toolResults) {
        openAiMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? '',
          content: block.content ?? ''
        })
      }

      return openAiMessages
    }

    openAiMessages.push({
      role: 'user',
      content: textBlocks.map((block) => block.text ?? '').join('\n')
    })
    return openAiMessages
  })
}

function contentFromChoice(message: OpenAI.Chat.Completions.ChatCompletionMessage | null | undefined): LlmContent[] {
  if (message?.tool_calls?.length) {
    return message.tool_calls
      .filter((toolCall) => toolCall.type === 'function')
      .map((toolCall) => ({
        type: 'tool_use' as const,
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolArguments(toolCall.function.name, toolCall.function.arguments)
      }))
  }

  const text = extractMessageText(message?.content)
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

function parseToolArguments(toolName: string, rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return repairToolArgs(toolName, {}, rawArguments)
  }
}

function extractMessageText(content: OpenAI.Chat.Completions.ChatCompletionMessage['content'] | null | undefined): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n')
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
    `Primary root cause: ${enrichedPacket.primaryRootCause}`,
    'Respond ONLY with valid JSON matching this schema exactly:',
    "{ intendedAction: string, affectedSymbols: string[], estimatedRiskLevel: 'low'|'medium'|'high', reasoning: string }",
    'No markdown. No explanation. Just JSON.'
  ].join('\n')
}
