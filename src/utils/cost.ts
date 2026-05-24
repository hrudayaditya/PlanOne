interface Pricing {
  inputPerMillion: number
  outputPerMillion: number
}

const PRICING_BY_MODEL: Record<string, Pricing> = {
  'claude-opus-4-5': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'gpt-4o': { inputPerMillion: 5, outputPerMillion: 15 },
  'gemini-2.0-flash': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-2.5-flash': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-3-flash-preview': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemini-3.1-flash-lite-preview': { inputPerMillion: 0, outputPerMillion: 0 },
  'gemma-3-27b-it': { inputPerMillion: 0, outputPerMillion: 0 }
}

/**
 * Calculates per-call LLM cost in USD using hardcoded model pricing.
 *
 * Unknown models are billed as zero until explicit pricing is added, which is
 * safe for Week 1 tracing because it never inflates cost numbers.
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const normalizedModel = model.trim().toLowerCase()
  const pricing = PRICING_BY_MODEL[normalizedModel]

  if (pricing === undefined) {
    return 0
  }

  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * pricing.inputPerMillion
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * pricing.outputPerMillion

  return Number((inputCost + outputCost).toFixed(6))
}
