export interface RecoveredToolCall {
  name: string
  input: Record<string, unknown>
}

export function repairToolArgs(
  toolName: string,
  rawArgs: unknown,
  reasoning: string
): Record<string, unknown> {
  if (isNonEmptyObject(rawArgs)) {
    return rawArgs
  }

  const extracted = extractArgsFromReasoning(toolName, reasoning)
  if (extracted !== null) {
    return extracted
  }

  return {}
}

export function recoverPseudoToolCall(text: string): RecoveredToolCall | null {
  const match = text.match(/Tool call \(([\w-]+)\):\s*(\{[\s\S]+\})/m)

  if (match === null) {
    return null
  }

  try {
    const input = JSON.parse(match[2] ?? '{}') as unknown
    return {
      name: match[1] ?? '',
      input: typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    }
  } catch {
    return null
  }
}

function extractArgsFromReasoning(
  toolName: string,
  reasoning: string
): Record<string, unknown> | null {
  if (reasoning.trim().length === 0) {
    return null
  }

  if (toolName === 'list_directory') {
    const path = extractPath(reasoning, /(packages\/[^\s`'"]+|src\/[^\s`'"]+|tests?\/[^\s`'"]+|\.)/)
    return path === null ? null : { path }
  }

  if (toolName === 'read_file') {
    const path = extractPath(reasoning, /([A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js|json|md|yaml|yml|sh))/)
    return path === null ? null : { path }
  }

  if (toolName === 'search_in_files') {
    const quotedPattern = reasoning.match(/[`'"]([^`'"]+)[`'"]/)
    if (quotedPattern?.[1] !== undefined) {
      return { pattern: quotedPattern[1] }
    }

    const symbolPattern = reasoning.match(/\b(?:for|find|search(?:ing)?\s+for)\s+([A-Za-z0-9_./-]+)/i)
    if (symbolPattern?.[1] !== undefined) {
      return { pattern: symbolPattern[1] }
    }
  }

  if (toolName === 'write_file') {
    const path = extractPath(reasoning, /([A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js|json|md|yaml|yml|sh))/)
    return path === null ? null : { path }
  }

  return null
}

function extractPath(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern)
  return match?.[1] ?? null
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}
