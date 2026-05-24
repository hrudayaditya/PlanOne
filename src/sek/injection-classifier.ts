/**
 * One prompt-injection pattern detected in retrieved or generated content.
 */
export interface InjectionPattern {
  type: string
  description: string
  matchedText: string
}

/**
 * Full result of a prompt-injection scan.
 */
export interface InjectionScanResult {
  clean: boolean
  patterns: InjectionPattern[]
}

const INJECTION_PATTERNS: Array<{
  pattern: RegExp
  type: string
  description: string
}> = [
  {
    pattern: /\/\/\s*(ignore previous|disregard|new instruction|system:|assistant:)/i,
    type: 'comment_injection',
    description: 'Instruction-like text in code comment'
  },
  {
    pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/i,
    type: 'prompt_tokens',
    description: 'LLM prompt formatting tokens in content'
  },
  {
    pattern: /^\s*(system|user|assistant)\s*:/im,
    type: 'role_injection',
    description: 'Role label injection attempt'
  },
  {
    pattern: /ignore (all |previous |above |prior )?(instructions?|prompts?|context)/i,
    type: 'indirect_instruction',
    description: 'Indirect instruction override attempt'
  }
]

/**
 * Scans content for known prompt-injection patterns.
 */
export function classifyInjection(content: string): InjectionScanResult {
  try {
    const patterns = INJECTION_PATTERNS.flatMap((candidate) => {
      const match = candidate.pattern.exec(content)

      if (match === null) {
        return []
      }

      return [{
        type: candidate.type,
        description: candidate.description,
        matchedText: match[0].slice(0, 100)
      }]
    })

    return {
      clean: patterns.length === 0,
      patterns
    }
  } catch {
    return {
      clean: true,
      patterns: []
    }
  }
}
