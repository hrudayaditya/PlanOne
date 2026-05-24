import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import { calculateCost } from '../utils/cost.js'
import type { CompressionLlmProvider } from '../executor/compression.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { ExecutorLlmProvider, LlmContent, LlmMessage } from '../executor/step.js'
import type { AnthropicToolDefinition } from '../executor/tools.js'
import type { IntakeLlmProvider } from '../intake/llm.js'
import type { PanelMemberLlmProvider } from '../panel/member.js'
import type { PreActionPlan } from '../pipeline/state-machine.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { appendLlmTranscript } from '../utils/llm-transcript.js'

const PreActionPlanSchema = z.object({
  intendedAction: z.string(),
  affectedSymbols: z.array(z.string()),
  estimatedRiskLevel: z.enum(['low', 'medium', 'high']),
  reasoning: z.string()
})

/**
 * Real Anthropic-backed provider implementation for Week 6.
 *
 * The class satisfies every existing provider interface so tests can mock the
 * same contract while production uses one SDK-backed object.
 */
export class AnthropicProvider implements IntakeLlmProvider, PanelMemberLlmProvider, CompressionLlmProvider, ExecutorLlmProvider {
  private readonly apiKey: string | null
  private client: Anthropic | null = null

  /**
   * Creates an Anthropic provider using an explicit key or `ANTHROPIC_API_KEY`.
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? null
  }

  /**
   * Generates JSON text with the first successful Claude model in preference order.
   */
  async generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!model.startsWith('claude-')) {
        continue
      }

      try {
        logInfo('llm:anthropic', '[LLM:Anthropic] POST generateJson', { model })
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
        appendLlmTranscript({
          provider: 'anthropic',
          operation: 'generateJson',
          model,
          request: {
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
          },
          response: {
            content: response.content,
            usage: response.usage
          }
        })

        logInfo('llm:anthropic', '[LLM:Anthropic] Response 200', {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        })
        return {
          model,
          text: extractTextContent(response.content)
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'anthropic',
          operation: 'generateJson',
          model,
          request: {
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown Anthropic error'
          }
        })
        logWarn('llm:anthropic', '[LLM:Anthropic] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown Anthropic error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown Anthropic error')
      }
    }

    throw lastError ?? new Error('No Claude models were available in preferredModels.')
  }

  async generateText(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    const client = this.getClient()
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!model.startsWith('claude-')) {
        continue
      }

      try {
        logInfo('llm:anthropic', '[LLM:Anthropic] POST generateText', { model })
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
        appendLlmTranscript({
          provider: 'anthropic',
          operation: 'generateText',
          model,
          request: {
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
          },
          response: {
            content: response.content,
            usage: response.usage
          }
        })

        logInfo('llm:anthropic', '[LLM:Anthropic] Response 200', {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        })
        return {
          model,
          text: extractTextContent(response.content)
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'anthropic',
          operation: 'generateText',
          model,
          request: {
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
          },
          error: {
            message: error instanceof Error ? error.message : 'Unknown Anthropic error'
          }
        })
        logWarn('llm:anthropic', '[LLM:Anthropic] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown Anthropic error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown Anthropic error')
      }
    }

    throw lastError ?? new Error('No Claude models were available in preferredModels.')
  }

  /**
   * Runs the panel analysis call and returns text plus usage metadata.
   */
  async analyze(prompt: string, model: string): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
    const client = this.getClient()
    logInfo('llm:anthropic', '[LLM:Anthropic] POST analyze', { model })
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
    appendLlmTranscript({
      provider: 'anthropic',
      operation: 'analyze',
      model,
      request: {
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      },
      response: {
        content: response.content,
        usage: response.usage
      }
    })
    const inputTokens = response.usage.input_tokens
    const outputTokens = response.usage.output_tokens

    logInfo('llm:anthropic', '[LLM:Anthropic] Response 200', {
      model,
      inputTokens,
      outputTokens
    })
    return {
      text: extractTextContent(response.content),
      tokensUsed: inputTokens + outputTokens,
      costUsd: calculateCost(model, inputTokens, outputTokens)
    }
  }

  /**
   * Distills working content for compression without truncating it.
   */
  async distill(content: string, taskContext: string, model: string): Promise<string> {
    const client = this.getClient()
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
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
      provider: 'anthropic',
      operation: 'distill',
      model,
      request: {
        max_tokens: 2048,
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
        content: response.content,
        usage: response.usage
      }
    })

    return extractTextContent(response.content)
  }

  /**
   * Generates a structured pre-action plan using Anthropic tool use.
   */
  async generatePreActionPlan(step: ExecutionStep, enrichedPacket: EnrichedPacket, model: string): Promise<PreActionPlan> {
    const client = this.getClient()

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        tools: [{
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
        }],
        messages: [{
          role: 'user',
          content: buildPreActionPlanPrompt(step, enrichedPacket)
        }]
      })
      appendLlmTranscript({
        provider: 'anthropic',
        operation: 'generatePreActionPlan',
        model,
        request: {
          max_tokens: 1024,
          tools: ['submit_pre_action_plan'],
          messages: [{
            role: 'user',
            content: buildPreActionPlanPrompt(step, enrichedPacket)
          }]
        },
        response: {
          content: response.content,
          usage: response.usage
        }
      })

      const toolUseBlock = response.content.find((block) => block.type === 'tool_use')

      if (toolUseBlock !== undefined && toolUseBlock.type === 'tool_use') {
        return PreActionPlanSchema.parse(toolUseBlock.input)
      }
    } catch {
      return buildSafePreActionPlan(step)
    }

    return buildSafePreActionPlan(step)
  }

  /**
   * Runs the executor conversation with Claude tool use enabled.
   */
  async callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number }> {
    const client = this.getClient()
    logInfo('llm:anthropic', '[LLM:Anthropic] POST callWithTools', { model })
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      ...(system === undefined || system.length === 0
        ? {}
        : {
          system
        }),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema
      })),
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string'
          ? toAnthropicStringContent(message)
          : convertLlmContentToAnthropicBlocks(message.content)
      }))
    })
    appendLlmTranscript({
      provider: 'anthropic',
      operation: 'callWithTools',
      model,
      request: {
        max_tokens: 4096,
        tools,
        messages
      },
      response: {
        content: response.content,
        usage: response.usage
      }
    })
    const inputTokens = response.usage.input_tokens
    const outputTokens = response.usage.output_tokens

    const content: LlmContent[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
        continue
      }

      if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: normalizeRecord(block.input)
        })
      }
    }

    logInfo('llm:anthropic', '[LLM:Anthropic] Response 200', {
      model,
      inputTokens,
      outputTokens,
      contentTypes: response.content.map((block) => block.type)
    })
    return {
      content,
      tokensUsed: inputTokens + outputTokens,
      costUsd: calculateCost(model, inputTokens, outputTokens)
    }
  }

  private getClient(): Anthropic {
    if (this.apiKey === null || this.apiKey.length === 0) {
      throw new Error('AnthropicProvider requires ANTHROPIC_API_KEY. Set process.env.ANTHROPIC_API_KEY or pass apiKey to the constructor.')
    }

    if (this.client === null) {
      this.client = new Anthropic({ apiKey: this.apiKey })
    }

    return this.client
  }
}

/**
 * Creates an Anthropic provider instance.
 */
export function createAnthropicProvider(apiKey?: string): AnthropicProvider {
  return new AnthropicProvider(apiKey)
}

function extractTextContent(content: Anthropic.Messages.Message['content']): string {
  const text = content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  if (text.length === 0) {
    throw new Error('Anthropic returned no text content.')
  }

  return text
}

function buildPreActionPlanPrompt(step: ExecutionStep, enrichedPacket: EnrichedPacket): string {
  return [
    'Build a precise pre-action plan for this execution step.',
    `Step description: ${step.description}`,
    `Approach: ${step.approach}`,
    `Affected symbols: ${step.affectedSymbols.join(', ') || 'none'}`,
    `Structured task description: ${enrichedPacket.structuredDescription}`,
    `Primary root cause: ${enrichedPacket.primaryRootCause}`,
    'Submit the plan only through the submit_pre_action_plan tool.'
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

function convertLlmContentToAnthropicBlocks(content: LlmContent[]): Anthropic.Messages.MessageParam['content'] {
  const blocks: Array<Record<string, unknown>> = []

  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      blocks.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
      blocks.push({
        type: 'tool_use' as const,
        id: block.id,
        name: block.name,
        input: block.input ?? {}
      })
      continue
    }

    if (block.type === 'tool_result' && block.tool_use_id !== undefined) {
      blocks.push({
        type: 'tool_result' as const,
        tool_use_id: block.tool_use_id,
        content: block.content ?? ''
      })
    }
  }

  return blocks as unknown as Anthropic.Messages.MessageParam['content']
}

function toAnthropicStringContent(message: LlmMessage): Anthropic.Messages.MessageParam['content'] {
  if (message.cache_control?.type === 'ephemeral') {
    return [{
      type: 'text',
      text: String(message.content),
      cache_control: { type: 'ephemeral' }
    }] as unknown as Anthropic.Messages.MessageParam['content']
  }

  return String(message.content)
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
