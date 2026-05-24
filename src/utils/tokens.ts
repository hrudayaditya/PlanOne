import { encoding_for_model, get_encoding } from 'tiktoken'

const DEFAULT_ENCODING_NAME = 'cl100k_base'
const SAFE_ESTIMATE_DIVISOR = 4

const encoderCache = new Map<string, ReturnType<typeof get_encoding>>()

/**
 * Resolves and memoizes the best available tokenizer for a model.
 *
 * Falls back to a safe default encoding when the model is not known to
 * `tiktoken`, and finally returns `null` if encoder construction fails.
 */
function getEncoder(model: string): ReturnType<typeof get_encoding> | null {
  const normalizedModel = model.trim().toLowerCase()
  const cacheKey = normalizedModel || DEFAULT_ENCODING_NAME
  const cachedEncoder = encoderCache.get(cacheKey)

  if (cachedEncoder !== undefined) {
    return cachedEncoder
  }

  try {
    const encoder = normalizedModel
      ? encoding_for_model(normalizedModel as Parameters<typeof encoding_for_model>[0])
      : get_encoding(DEFAULT_ENCODING_NAME)

    encoderCache.set(cacheKey, encoder)
    return encoder
  } catch {
    try {
      const encoder = get_encoding(DEFAULT_ENCODING_NAME)
      encoderCache.set(cacheKey, encoder)
      return encoder
    } catch {
      return null
    }
  }
}

/**
 * Counts tokens synchronously for a piece of text and target model.
 *
 * Returns `0` for empty input. Unknown models never throw; they fall back to a
 * safe default tokenizer and then to a conservative character-based estimate.
 */
export function countTokens(text: string, model: string): number {
  if (text.length === 0) {
    return 0
  }

  const encoder = getEncoder(model)

  if (encoder !== null) {
    return encoder.encode(text).length
  }

  return Math.max(1, Math.ceil(text.length / SAFE_ESTIMATE_DIVISOR))
}
