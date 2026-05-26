/**
 * Verified default model IDs for the current Phase 1 provider stack.
 *
 * These constants centralize model selection so individual pipeline stages do
 * not drift onto deprecated or quota-hostile aliases.
 */
export const DEFAULT_EXECUTOR_MODEL = 'z-ai/glm-5.1'
export const DEFAULT_PANEL_MODEL = 'gemini-3.1-flash-lite-preview'
export const DEFAULT_VERIFIER_MODEL = 'gemini-3.1-flash-lite-preview'
export const DEFAULT_INTAKE_MODEL = 'gemini-2.5-flash'
export const DEFAULT_COMPRESSION_MODEL = 'gemini-3-flash-preview'
export const DEFAULT_GROQ_EXECUTOR_MODEL = 'llama-3.3-70b-versatile'
export const DEFAULT_GROQ_INTAKE_MODEL = 'llama-3.1-8b-instant'
export const DEFAULT_GROQ_VERIFIER_MODEL = 'llama-3.1-8b-instant'

/**
 * Ordered model preferences used by the intake pipeline for JSON generation.
 *
 * The primary slot intentionally uses the current stable Gemini intake model,
 * with cross-family fallbacks behind it.
 */
export const DEFAULT_INTAKE_PREFERRED_MODELS = [
  DEFAULT_INTAKE_MODEL,
  'google/gemini-2.5-flash',
  'gpt-4o-mini'
] as const
