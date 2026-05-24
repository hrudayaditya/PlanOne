import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { z } from 'zod'

/**
 * Minimal provider interface for Week 3 intake LLM calls.
 *
 * The interface is deliberately small so tests can inject deterministic mocks
 * without requiring real API credentials or network access.
 */
export interface IntakeLlmProvider {
  /**
   * Generates a JSON-only text response for an intake prompt.
   */
  generateJson(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }>
  /**
   * Generates a plain-text response for intake helper tasks.
   */
  generateText?(prompt: string, preferredModels: string[]): Promise<{ model: string; text: string }>
}

let overrideProvider: IntakeLlmProvider | null = null

/**
 * Overrides the shared intake LLM provider for tests.
 *
 * Passing `null` restores the default SDK-backed provider.
 */
export function setIntakeLlmProviderForTesting(provider: IntakeLlmProvider | null): void {
  overrideProvider = provider
}

/**
 * Returns the currently active intake LLM provider.
 *
 * Tests may replace this provider with a deterministic mock.
 */
export function getIntakeLlmProvider(): IntakeLlmProvider {
  return overrideProvider ?? defaultIntakeLlmProvider
}

/**
 * Parses a JSON text response with zod validation in one step.
 *
 * This avoids raw `JSON.parse()` without schema validation.
 */
export function parseJsonResponse<TSchema extends z.ZodTypeAny>(
  text: string,
  schema: TSchema
): z.infer<TSchema> {
  return z.string().transform((value, ctx) => {
    try {
      return JSON.parse(extractJson(value)) as unknown
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Model response was not valid JSON.'
      })
      return z.NEVER
    }
  }).pipe(schema).parse(text)
}

/**
 * Extracts the most likely JSON payload from model text that may contain
 * markdown fences or surrounding explanatory prose.
 */
export function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)

  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim()
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }

  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')

  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1)
  }

  return text
}

/**
 * Runs an async operation with a hard timeout.
 */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    operation
      .then((result) => {
        clearTimeout(timeoutHandle)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timeoutHandle)
        reject(error)
      })
  })
}

const defaultIntakeLlmProvider: IntakeLlmProvider = {
  async generateJson(prompt, preferredModels) {
    const env = process.env
    const anthropicModel = preferredModels.find((preferredModel) => preferredModel.startsWith('claude-'))
    const openAiModel = preferredModels.find((preferredModel) => (
      preferredModel.startsWith('gpt-')
      || preferredModel.startsWith('o1-')
      || preferredModel.startsWith('o3-')
    ))

    const geminiApiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY

    if (geminiApiKey !== undefined) {
      const client = new GoogleGenerativeAI(geminiApiKey)

      for (const preferredModel of preferredModels) {
        if (!preferredModel.startsWith('gemini-') && !preferredModel.startsWith('gemma-')) {
          continue
        }

        const model = client.getGenerativeModel({
          model: preferredModel,
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json'
          }
        })

        const response = await model.generateContent(prompt)
        return {
          model: preferredModel,
          text: response.response.text()
        }
      }
    }

    if (env.ANTHROPIC_API_KEY !== undefined && anthropicModel !== undefined) {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
      const response = await client.messages.create({
        model: anthropicModel,
        max_tokens: 1_000,
        temperature: 0,
        system: 'Return only valid JSON that matches the requested schema.',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })

      const textBlock = response.content.find((block) => block.type === 'text')

      if (textBlock === undefined || textBlock.type !== 'text') {
        throw new Error('Anthropic returned no text block.')
      }

      return {
        model: anthropicModel,
        text: textBlock.text
      }
    }

    if (env.OPENAI_API_KEY !== undefined && openAiModel !== undefined) {
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY })
      const response = await client.chat.completions.create({
        model: openAiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Return only valid JSON that matches the requested schema.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })

      const messageContent = response.choices[0]?.message.content

      if (messageContent === undefined || messageContent === null) {
        throw new Error('OpenAI returned no message content.')
      }

      return {
        model: openAiModel,
        text: messageContent
      }
    }

    throw new Error('No intake LLM provider credentials are configured.')
  },
  async generateText(prompt, preferredModels) {
    const env = process.env
    const anthropicModel = preferredModels.find((preferredModel) => preferredModel.startsWith('claude-'))
    const openAiModel = preferredModels.find((preferredModel) => (
      preferredModel.startsWith('gpt-')
      || preferredModel.startsWith('o1-')
      || preferredModel.startsWith('o3-')
    ))

    const geminiApiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY

    if (geminiApiKey !== undefined) {
      const client = new GoogleGenerativeAI(geminiApiKey)

      for (const preferredModel of preferredModels) {
        if (!preferredModel.startsWith('gemini-') && !preferredModel.startsWith('gemma-')) {
          continue
        }

        const model = client.getGenerativeModel({
          model: preferredModel,
          generationConfig: {
            temperature: 0
          }
        })

        const response = await model.generateContent(prompt)
        return {
          model: preferredModel,
          text: response.response.text()
        }
      }
    }

    if (env.ANTHROPIC_API_KEY !== undefined && anthropicModel !== undefined) {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
      const response = await client.messages.create({
        model: anthropicModel,
        max_tokens: 1_500,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })

      const textBlock = response.content.find((block) => block.type === 'text')

      if (textBlock === undefined || textBlock.type !== 'text') {
        throw new Error('Anthropic returned no text block.')
      }

      return {
        model: anthropicModel,
        text: textBlock.text
      }
    }

    if (env.OPENAI_API_KEY !== undefined && openAiModel !== undefined) {
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY })
      const response = await client.chat.completions.create({
        model: openAiModel,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })

      const messageContent = response.choices[0]?.message.content

      if (messageContent === undefined || messageContent === null) {
        throw new Error('OpenAI returned no message content.')
      }

      return {
        model: openAiModel,
        text: messageContent
      }
    }

    throw new Error('No intake LLM provider credentials are configured.')
  }
}
