import { describe, expect, it } from 'vitest'

import type { BaseMemoryClient, BaseMemoryToolResult } from '../../src/basememory/client.js'
import type { IntakeResult } from '../../src/intake/index.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { OpenRouterProvider } from '../../src/llm/openrouter.js'
import { GeminiProvider } from '../../src/llm/gemini.js'
import { runPanel } from '../../src/panel/index.js'
import type { PanelMemberLlmProvider } from '../../src/panel/member.js'

function makeClient(
  responder: (name: string, args: Record<string, unknown>) => Promise<BaseMemoryToolResult>
): BaseMemoryClient {
  return {
    callTool: (name: string, args: Record<string, unknown> = {}) => responder(name, args)
  } as unknown as BaseMemoryClient
}

function makeIntake(): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'Fix auth bug',
      structured_description: 'Fix auth bug',
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: ['LoginService'],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.7,
      rationale: 'multi-step',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    repoContext: {
      repoRoot: '/repo',
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

describe('panel default model', () => {
  it('uses a Gemini model when memberConfigs are empty and GeminiProvider is supplied', async () => {
    const client = makeClient(async () => ({
      structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
    }))
    const contextDb = new ContextDB(client)
    const store = new RawTraceStore(':memory:')
    const provider = withAnalyzeOverride(new GeminiProvider('test-key'), async (_prompt, model) => {
      modelUsed = model
      return {
        text: JSON.stringify({
          taskUnderstanding: 'Fix auth.',
          rootCauses: [],
          suggestedApproaches: [],
          risks: [],
          constraints: []
        }),
        tokensUsed: 1,
        costUsd: 0
      }
    })
    let modelUsed = ''

    try {
      await runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)

      expect(modelUsed.startsWith('gemini-')).toBe(true)
      expect(modelUsed.includes('claude-')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('uses an OpenRouter namespaced model when memberConfigs are empty and OpenRouterProvider is supplied', async () => {
    const client = makeClient(async () => ({
      structuredContent: { results: [], total: 0, cursor: null, expandedContext: [] }
    }))
    const contextDb = new ContextDB(client)
    const store = new RawTraceStore(':memory:')
    const provider = withAnalyzeOverride(new OpenRouterProvider({
      apiKey: 'sk-or-v1-test',
      path: 'free',
      modelId: 'inclusionai/ling-2.6-1t:free'
    }), async (_prompt, model) => {
      modelUsed = model
      return {
        text: JSON.stringify({
          taskUnderstanding: 'Fix auth.',
          rootCauses: [],
          suggestedApproaches: [],
          risks: [],
          constraints: []
        }),
        tokensUsed: 1,
        costUsd: 0
      }
    })
    let modelUsed = ''

    try {
      await runPanel({ intake: makeIntake(), rts: store, client, contextDb }, [], provider)

      expect(modelUsed).toContain('inclusionai/')
      expect(modelUsed.includes('claude-')).toBe(false)
    } finally {
      store.close()
    }
  })
})

function withAnalyzeOverride(
  provider: PanelMemberLlmProvider,
  analyze: PanelMemberLlmProvider['analyze']
): PanelMemberLlmProvider {
  return new Proxy(provider as object, {
    get(target, property, receiver) {
      if (property === 'analyze') {
        return analyze
      }

      return Reflect.get(target, property, receiver)
    }
  }) as PanelMemberLlmProvider
}
