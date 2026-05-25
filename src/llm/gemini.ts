import { GoogleGenerativeAI, type Content, type FunctionDeclaration, type FunctionCall } from '@google/generative-ai'
import { z } from 'zod'

import type { CompressionLlmProvider } from '../executor/compression.js'
import type { ExecutorLlmProvider, LlmContent, LlmMessage } from '../executor/step.js'
import type { AnthropicToolDefinition } from '../executor/tools.js'
import type { IntakeLlmProvider } from '../intake/llm.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { PanelMemberLlmProvider } from '../panel/member.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
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
 * Real Gemini-backed provider implementation for Week 6.
 */
export class GeminiProvider implements IntakeLlmProvider, PanelMemberLlmProvider, CompressionLlmProvider, ExecutorLlmProvider {
  private readonly apiKey: string | null
  private client: GoogleGenerativeAI | null = null

  /**
   * Creates a Gemini provider using an explicit key or `GEMINI_API_KEY`.
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GEMINI_API_KEY ?? null
  }

  /**
   * Generates JSON text with the first successful Gemini model in preference order.
   */
  async generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> {
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!model.startsWith('gemini-')) {
        continue
      }

      try {
        logInfo('llm:gemini', '[LLM:Gemini] POST generateJson', { model })
        const response = await this.getModel(model).generateContent(prompt)
        appendLlmTranscript({
          provider: 'gemini',
          operation: 'generateJson',
          model,
          request: { prompt },
          response: {
            text: response.response.text(),
            usageMetadata: response.response.usageMetadata ?? null
          }
        })
        logInfo('llm:gemini', '[LLM:Gemini] Response 200', { model })
        return {
          model,
          text: response.response.text()
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'gemini',
          operation: 'generateJson',
          model,
          request: { prompt },
          error: {
            message: error instanceof Error ? error.message : 'Unknown Gemini error'
          }
        })
        logWarn('llm:gemini', '[LLM:Gemini] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown Gemini error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown Gemini error')
      }
    }

    throw lastError ?? new Error('No Gemini models were available in preferredModels.')
  }

  generateText = async (prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }> => {
    let lastError: Error | null = null

    for (const model of preferredModels) {
      if (!model.startsWith('gemini-') && !model.startsWith('gemma-')) {
        continue
      }

      try {
        logInfo('llm:gemini', '[LLM:Gemini] POST generateText', { model })
        const response = await this.getModel(model).generateContent(prompt)
        appendLlmTranscript({
          provider: 'gemini',
          operation: 'generateText',
          model,
          request: { prompt },
          response: {
            text: response.response.text(),
            usageMetadata: response.response.usageMetadata ?? null
          }
        })
        logInfo('llm:gemini', '[LLM:Gemini] Response 200', { model })
        return {
          model,
          text: response.response.text()
        }
      } catch (error) {
        appendLlmTranscript({
          provider: 'gemini',
          operation: 'generateText',
          model,
          request: { prompt },
          error: {
            message: error instanceof Error ? error.message : 'Unknown Gemini error'
          }
        })
        logWarn('llm:gemini', '[LLM:Gemini] Request failed', {
          model,
          error: error instanceof Error ? error.message : 'Unknown Gemini error'
        })
        lastError = error instanceof Error ? error : new Error('Unknown Gemini error')
      }
    }

    throw lastError ?? new Error('No Gemini models were available in preferredModels.')
  }

  /**
   * Runs the panel analysis call and returns text plus usage metadata.
   */
  async analyze(prompt: string, model: string): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
    logInfo('llm:gemini', '[LLM:Gemini] POST analyze', { model })
    const response = await this.getModel(model).generateContent(prompt)
    appendLlmTranscript({
      provider: 'gemini',
      operation: 'analyze',
      model,
      request: { prompt },
      response: {
        text: response.response.text(),
        usageMetadata: response.response.usageMetadata ?? null
      }
    })
    const usageMetadata = response.response.usageMetadata
    const promptTokens = usageMetadata?.promptTokenCount ?? 0
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0

    logInfo('llm:gemini', '[LLM:Gemini] Response 200', {
      model,
      promptTokens,
      outputTokens
    })
    return {
      text: response.response.text(),
      tokensUsed: promptTokens + outputTokens,
      costUsd: 0
    }
  }

  /**
   * Distills working content for compression without truncating it.
   */
  async distill(content: string, taskContext: string, model: string): Promise<string> {
    const response = await this.getModel(model).generateContent([
      'You are a context compression engine.',
      `Task context: ${taskContext}`,
      'Compress the following code content. Preserve: symbol names, function signatures, key logic, error patterns.',
      'Remove: comments, blank lines, import blocks not directly relevant.',
      'Return ONLY the compressed content. No explanation.',
      `Content:\n${content}`
    ].join('\n'))
    appendLlmTranscript({
      provider: 'gemini',
      operation: 'distill',
      model,
      request: {
        prompt: [
          'You are a context compression engine.',
          `Task context: ${taskContext}`,
          'Compress the following code content. Preserve: symbol names, function signatures, key logic, error patterns.',
          'Remove: comments, blank lines, import blocks not directly relevant.',
          'Return ONLY the compressed content. No explanation.',
          `Content:\n${content}`
        ].join('\n')
      },
      response: {
        text: response.response.text(),
        usageMetadata: response.response.usageMetadata ?? null
      }
    })

    return response.response.text()
  }

  /**
   * Generates a structured pre-action plan from a JSON-only prompt.
   */
  async generatePreActionPlan(step: ExecutionStep, enrichedPacket: EnrichedPacket, model: string): Promise<PreActionPlan> {
    try {
      const response = await this.getModel(model).generateContent([
        'Build a precise pre-action plan for this execution step.',
        `Step description: ${step.description}`,
        `Approach: ${step.approach}`,
        `Affected symbols: ${step.affectedSymbols.join(', ') || 'none'}`,
        `Structured task description: ${enrichedPacket.structuredDescription}`,
        `Primary root cause: ${enrichedPacket.primaryRootCause}`,
        'Respond ONLY with valid JSON matching this schema exactly:',
        "{ intendedAction: string, affectedSymbols: string[], estimatedRiskLevel: 'low'|'medium'|'high', reasoning: string }",
        'No markdown. No explanation. Just JSON.'
      ].join('\n'))
      appendLlmTranscript({
        provider: 'gemini',
        operation: 'generatePreActionPlan',
        model,
        request: {
          prompt: [
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
        },
        response: {
          text: response.response.text(),
          usageMetadata: response.response.usageMetadata ?? null
        }
      })

      return PreActionPlanSchema.parse(JSON.parse(response.response.text()) as unknown)
    } catch {
      return {
        intendedAction: step.description,
        affectedSymbols: step.affectedSymbols,
        estimatedRiskLevel: step.estimatedRisk,
        reasoning: 'Safe fallback pre-action plan because structured generation failed.'
      }
    }
  }

  /**
   * Runs the executor conversation with Gemini function calling enabled.
   */
  async callWithTools(
    messages: LlmMessage[],
    tools: AnthropicToolDefinition[],
    model: string,
    system?: string
  ): Promise<{ content: LlmContent[]; tokensUsed: number; costUsd: number }> {
    logInfo('llm:gemini', '[LLM:Gemini] POST callWithTools', { model })
    const response = await this.getModel(model).generateContent({
      contents: messages.map(convertMessageToGeminiContent),
      ...(system === undefined || system.length === 0
        ? {}
        : {
          systemInstruction: {
            role: 'system',
            parts: [{ text: system }]
          }
        }),
      tools: [{
        functionDeclarations: tools.map(convertToolToFunctionDeclaration)
      }]
    })
    appendLlmTranscript({
      provider: 'gemini',
      operation: 'callWithTools',
      model,
      request: {
        messages,
        tools
      },
      response: {
        content: extractGeminiContent(response.response),
        usageMetadata: response.response.usageMetadata ?? null
      }
    })
    const usageMetadata = response.response.usageMetadata
    const promptTokens = usageMetadata?.promptTokenCount ?? 0
    const outputTokens = usageMetadata?.candidatesTokenCount ?? 0
    const content = extractGeminiContent(response.response)
    logInfo('llm:gemini', '[LLM:Gemini] Response 200', {
      model,
      promptTokens,
      outputTokens,
      contentTypes: content.map((block) => block.type)
    })

    return {
      content,
      tokensUsed: promptTokens + outputTokens,
      costUsd: 0
    }
  }

  private getModel(model: string) {
    return this.getClient().getGenerativeModel({ model })
  }

  private getClient(): GoogleGenerativeAI {
    if (this.apiKey === null || this.apiKey.length === 0) {
      throw new Error('GeminiProvider requires GEMINI_API_KEY. Set process.env.GEMINI_API_KEY or pass apiKey to the constructor.')
    }

    if (this.client === null) {
      this.client = new GoogleGenerativeAI(this.apiKey)
    }

    return this.client
  }
}

/**
 * Creates a Gemini provider instance.
 */
export function createGeminiProvider(apiKey?: string): GeminiProvider {
  return new GeminiProvider(apiKey)
}

function convertToolToFunctionDeclaration(tool: AnthropicToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as unknown as FunctionDeclaration['parameters']
  }
}

function convertMessageToGeminiContent(message: LlmMessage): Content {
  const parts: Array<Record<string, unknown>> = []

  if (typeof message.content === 'string') {
    parts.push({ text: message.content })
  } else {
    for (const block of message.content) {
      if (block.type === 'text' && block.text !== undefined) {
        parts.push({ text: block.text })
        continue
      }

      if (block.type === 'tool_result' && block.tool_use_id !== undefined) {
        parts.push({
          functionResponse: {
            name: block.tool_use_id,
            response: {
              content: block.content ?? ''
            }
          }
        })
        continue
      }

      if (block.type === 'tool_use' && block.name !== undefined) {
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input ?? {}
          }
        })
      }
    }
  }

  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: parts as unknown as Content['parts']
  }
}

function extractGeminiContent(response: { candidates?: Array<{ content?: { parts?: Array<unknown> } }> }): LlmContent[] {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  const content: LlmContent[] = []

  for (const part of parts) {
    if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text })
      continue
    }

    if (typeof part === 'object' && part !== null && 'functionCall' in part && isFunctionCall(part.functionCall)) {
      content.push({
        type: 'tool_use',
        id: part.functionCall.name,
        name: part.functionCall.name,
        input: normalizeRecord(part.functionCall.args)
      })
    }
  }

  return content
}

function isFunctionCall(value: unknown): value is FunctionCall {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
