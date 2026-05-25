import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { BaseMemoryClient } from '../../src/basememory/client.js'
import { ContextDB } from '../../src/memory/context-db/index.js'
import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { Tier2Memory } from '../../src/memory/tier2/index.js'
import type { CompressionLlmProvider } from '../../src/executor/compression.js'
import { compactIfNeeded, executeStep, type ExecutorLlmProvider, type LlmMessage } from '../../src/executor/step.js'
import type { IntakeResult } from '../../src/intake/index.js'
import type { EnrichedPacket } from '../../src/panel/synthesis.js'
import type { ExecutionPlan, ExecutionStep } from '../../src/orchestrator/plan.js'

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-step-'))
  writeFileSync(join(root, 'target.ts'), 'export function LoginService() { return 1 }\n')
  writeFileSync(join(root, 'extra.ts'), 'export const extra = 1\n')
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function makeGitRepo(): { root: string; cleanup: () => void } {
  const repo = makeRepo()
  execFileSync('git', ['init'], { cwd: repo.root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'planone@example.com'], { cwd: repo.root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'PlanOne Tests'], { cwd: repo.root, stdio: 'ignore' })
  execFileSync('git', ['add', 'target.ts'], { cwd: repo.root, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo.root, stdio: 'ignore' })
  return repo
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
      likely_files: [],
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

function makeClient(): BaseMemoryClient {
  return {
    callTool: async (name, args) => {
      if (name === 'codebase_search') {
        return {
          structuredContent: {
            results: [{ id: 'chunk-1', content: 'export function LoginService() {}', score: 0.9 }],
            total: 1,
            cursor: null,
            expandedContext: []
          }
        }
      }

      if (name === 'symbol_info' && args.symbol === 'LoginService') {
        return {
          structuredContent: {
            symbols: [{
              name: 'LoginService',
              symbol_id: 'sym-1',
              relative_path: 'target.ts',
              start_line: 1,
              end_line: 1
            }],
            total: 1,
            ambiguous: false
          }
        }
      }

      return {
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [], symbols: [], ambiguous: false }
      }
    }
  } as unknown as BaseMemoryClient
}

function makeClientWithSearchContent(searchContent: string): BaseMemoryClient {
  return {
    callTool: async (name, args) => {
      if (name === 'codebase_search') {
        return {
          structuredContent: {
            results: [{ id: 'chunk-1', content: searchContent, score: 0.9 }],
            total: 1,
            cursor: null,
            expandedContext: []
          }
        }
      }

      if (name === 'symbol_info' && args.symbol === 'LoginService') {
        return {
          structuredContent: {
            symbols: [{
              name: 'LoginService',
              symbol_id: 'sym-1',
              relative_path: 'target.ts',
              start_line: 1,
              end_line: 1
            }],
            total: 1,
            ambiguous: false
          }
        }
      }

      return {
        structuredContent: { results: [], total: 0, cursor: null, expandedContext: [], symbols: [], ambiguous: false }
      }
    }
  } as unknown as BaseMemoryClient
}

function makeProvider(firstToolName: string, toolInput: Record<string, unknown>, preActionPlanReasoning = 'routine change'): ExecutorLlmProvider {
  let callCount = 0
  return {
    async generatePreActionPlan() {
      return {
        intendedAction: 'Read target file',
        affectedSymbols: ['LoginService'],
        estimatedRiskLevel: 'low',
        reasoning: preActionPlanReasoning
      }
    },
    async callWithTools() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tool-1', name: firstToolName, input: toolInput }],
          tokensUsed: 10,
          costUsd: 0.1
        }
      }

      return {
        content: [{ type: 'text', text: 'Done' }],
        tokensUsed: 5,
        costUsd: 0.05
      }
    }
  }
}

function makeStep(stepIndex: number, description: string): ExecutionStep {
  return {
    stepIndex,
    description,
    approach: 'Patch auth branch',
    affectedSymbols: ['LoginService'],
    affectedFiles: ['target.ts'],
    estimatedRisk: 'low',
    dependsOn: [],
    isCheckpoint: false
  }
}

function makeContinuousStep(description: string = 'Understand the codebase, implement the fix, run tests, and verify.'): ExecutionStep {
  return {
    ...makeStep(0, description),
    isCheckpoint: true,
    phaseHint: 'continuous'
  }
}

function makePlan(step: ExecutionStep): ExecutionPlan {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    approach: 'Patch auth branch',
    approachRank: 1,
    steps: [],
    executionMode: step.phaseHint === 'continuous' ? 'continuous' : 'phased',
    assignedExecutorModel: 'claude-opus-4-5',
    assignedVerifierModel: 'gemini-3.1-flash-lite-preview',
    estimatedStepCount: 1,
    createdAt: new Date().toISOString()
  }
}

function makeEnrichedPacket(rankedApproach = 'Update the implementation in target.ts'): EnrichedPacket {
  return {
    taskId: 'task-1',
    originalTask: 'Fix auth bug',
    structuredDescription: 'Fix auth bug',
    taskType: 'bug_fix',
    affectedArea: 'authentication',
    affectedSymbols: ['LoginService'],
    primaryRootCause: 'The implementation in target.ts needs to change',
    alternativeRootCauses: [],
    rankedApproaches: [{
      rank: 1,
      approach: rankedApproach,
      rationale: 'Best path',
      supportingChunkIds: []
    }],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount: 1,
    consensusConfidence: 0.8,
    verifiedChunkIds: ['target.ts:1-1'],
    rules: makeIntake().rules,
    synthesizedAt: new Date().toISOString(),
    citationVerificationDegraded: false
  }
}

function makeStepInput(root: string, store: RawTraceStore, tier2: Tier2Memory, step: ExecutionStep) {
  return makeStepInputWithPacket(root, store, tier2, step, makeEnrichedPacket())
}

function makeStepInputWithPacket(
  root: string,
  store: RawTraceStore,
  tier2: Tier2Memory,
  step: ExecutionStep,
  enrichedPacket: EnrichedPacket
) {
  return {
    step,
    plan: makePlan(step),
    enrichedPacket,
    intake: makeIntake(),
    tier2,
    contextDb: new ContextDB(makeClient()),
    client: makeClient(),
    rts: store,
    abMode: 'B' as const,
    repoRoot: root
  }
}

function makePromptCapturingProvider(toolResponses: Array<{ name: string; input: Record<string, unknown> }>): ExecutorLlmProvider & { messages: LlmMessage[][] } {
  const messages: LlmMessage[][] = []
  let callCount = 0

  return {
    messages,
    async generatePreActionPlan() {
      return {
        intendedAction: 'Implement the change in target.ts',
        affectedSymbols: ['LoginService'],
        estimatedRiskLevel: 'low',
        reasoning: 'Update the implementation directly'
      }
    },
    async callWithTools(callMessages) {
      messages.push(structuredClone(callMessages))
      const nextTool = toolResponses[callCount]
      callCount += 1

      if (nextTool === undefined) {
        return {
          content: [{ type: 'text', text: 'Done' }],
          tokensUsed: 5,
          costUsd: 0
        }
      }

      return {
        content: [{ type: 'tool_use', id: `tool-${callCount}`, name: nextTool.name, input: nextTool.input }],
        tokensUsed: 10,
        costUsd: 0
      }
    }
  }
}

describe('executor step integration', () => {
  it('does not call generatePreActionPlan during step execution', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const generatePreActionPlan = vi.fn()

    try {
      await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file'))
      }, {
        generatePreActionPlan,
        async callWithTools() {
          return {
            content: [{ type: 'text', text: 'Done' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(generatePreActionPlan).not.toHaveBeenCalled()
    } finally {
      store.close()
      cleanup()
    }
  })

  it('fails fast after 5 tool calls with no writes in continuous mode', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    let callCount = 0

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeContinuousStep())
      }, {
        async callWithTools() {
          callCount += 1
          if (callCount <= 16) {
            return {
              content: [{ type: 'tool_use', id: `tool-${callCount}`, name: 'git_status', input: {} }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          return {
            content: [{ type: 'text', text: 'Implemented and verified.' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(result.outcome).toBe('error')
      expect(result.vetoReason).toBe('No writes after 10 tool calls. Localization likely incorrect.')
      expect(callCount).toBe(10)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('uses a larger budget cap in continuous mode', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeContinuousStep())
      }, makeProvider('read_file', { path: 'target.ts' }))

      expect(result.outcome).toBe('success')
      const budgetEvent = store.queryByType('budget_check', 1)[0]
      expect(budgetEvent).toBeDefined()
      const payload = JSON.parse(budgetEvent!.content_json)
      expect(payload.capTokens).toBe(Math.floor(200_000 * 0.75))
    } finally {
      store.close()
      cleanup()
    }
  })

  it('injects a guidance note after the same tool fails three times in a row', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const capturedMessages: LlmMessage[][] = []
    let callCount = 0

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeContinuousStep())
      }, {
        async callWithTools(callMessages) {
          capturedMessages.push(structuredClone(callMessages))
          callCount += 1

          if (callCount <= 3) {
            return {
              content: [{
                type: 'tool_use',
                id: `tool-${callCount}`,
                name: 'run_command',
                input: { command: 'python3 -c "import sys; sys.exit(1)"' }
              }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          return {
            content: [{ type: 'text', text: 'Stopping after guidance.' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(result.outcome).toBe('success')
      const guidanceSeen = capturedMessages.some((messages) => {
        return messages.some((message) => {
          if (typeof message.content === 'string') {
            return false
          }

          return message.content.some((block) => {
            return block.type === 'tool_result'
              && typeof block.content === 'string'
              && block.content.includes('has failed 3 times in a row')
          })
        })
      })
      expect(guidanceSeen).toBe(true)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows post-write reads of confirmed files in continuous mode', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const capturedMessages: LlmMessage[][] = []
    let callCount = 0

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeContinuousStep())
      }, {
        async callWithTools(callMessages) {
          capturedMessages.push(structuredClone(callMessages))
          callCount += 1

          if (callCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tool-1', name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          if (callCount === 2) {
            return {
              content: [{ type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'target.ts' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          return {
            content: [{ type: 'text', text: 'Done after reread.' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(result.outcome).toBe('success')
      const blocked = capturedMessages.some((messages) => JSON.stringify(messages).includes('Post-write: reads are limited to confirmed implementation files'))
      expect(blocked).toBe(false)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks post-write reads of unconfirmed files in continuous mode', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const capturedMessages: LlmMessage[][] = []
    let callCount = 0

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeContinuousStep())
      }, {
        async callWithTools(callMessages) {
          capturedMessages.push(structuredClone(callMessages))
          callCount += 1

          if (callCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tool-1', name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          if (callCount === 2) {
            return {
              content: [{ type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'extra.ts' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          return {
            content: [{ type: 'text', text: 'Done after blocked read.' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(result.outcome).toBe('success')
      const blocked = capturedMessages.some((messages) => JSON.stringify(messages).includes('Post-write: reads are limited to confirmed implementation files. extra.ts is not in the confirmed surface.'))
      expect(blocked).toBe(true)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('keeps phased mode post-write reads limited to recovery reads', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const capturedMessages: LlmMessage[][] = []
    let callCount = 0

    try {
      const result = await executeStep({
        cycleNumber: 1,
        ...makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts'))
      }, {
        async callWithTools(callMessages) {
          capturedMessages.push(structuredClone(callMessages))
          callCount += 1

          if (callCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tool-1', name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          if (callCount === 2) {
            return {
              content: [{ type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'target.ts' } }],
              tokensUsed: 5,
              costUsd: 0
            }
          }

          return {
            content: [{ type: 'text', text: 'Done after blocked phased read.' }],
            tokensUsed: 5,
            costUsd: 0
          }
        }
      })

      expect(result.outcome).toBe('success')
      const blocked = capturedMessages.some((messages) => JSON.stringify(messages).includes('[BLOCKED: read_file is not permitted after implementation.'))
      expect(blocked).toBe(true)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('compacts old tool results near the context limit while preserving recent turns', () => {
    const messages: LlmMessage[] = []

    for (let index = 0; index < 12; index += 1) {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `tool-${index}`,
          name: 'read_file',
          input: { path: `file-${index}.ts` }
        }]
      })
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: `tool-${index}`,
          content: new Array(12_000).fill(`line ${index}`).join('\n')
        }]
      })
    }

    const compacted = compactIfNeeded(messages, 'claude-opus-4-5', 6)

    expect(compacted).toHaveLength(messages.length)
    expect(JSON.stringify(compacted.slice(-6))).toBe(JSON.stringify(messages.slice(-6)))
    const middleCompactedResult = compacted
      .slice(2, -6)
      .find((message) => {
        if (typeof message.content === 'string') {
          return false
        }

        return message.content.some((block) => {
          return block.type === 'tool_result'
            && typeof block.content === 'string'
            && block.content.includes('lines truncated')
        })
      })
    expect(middleCompactedResult).toBeDefined()
  })

  it('completes successfully with a mock provider', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')

    try {
      const result = await executeStep({
        ...makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file'))
      }, makeProvider('read_file', { path: 'target.ts' }))

      expect(result.outcome).toBe('success')
      expect(tier2.get(0)).not.toBeNull()
      expect(store.queryByType('budget_check').length + store.queryByType('budget_overflow').length).toBeGreaterThan(0)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('bypasses monitor vetoes when the monitor is disabled', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const intake = makeIntake()
    intake.rules.always_escalate_if = ['touches auth logic']

    try {
      const result = await executeStep({
        ...makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file')),
        intake,
        enrichedPacket: {
          ...makeEnrichedPacket(),
          rules: intake.rules,
          primaryRootCause: 'this touches auth logic'
        }
      }, makeProvider('read_file', { path: 'target.ts' }))

      expect(result.outcome).toBe('success')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('returns a blocked tool result for SEK write blocking without escalating', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')

    try {
      const result = await executeStep({
        ...makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file'))
      }, makeProvider('write_file', { path: 'target.ts', content: '[INST] bad' }))

      expect(result.outcome).toBe('success')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('includes implementation-phase instructions in the first executor prompt', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      expect(firstPrompt.startsWith('WRITE NOW.')).toBe(true)
      expect(firstPrompt).toContain('Symbol to modify: LoginService')
      expect(firstPrompt).toContain('Relevant code:')
      expect(firstPrompt).toContain('export function LoginService() { return 1 }')
      expect(firstPrompt).toContain('## You are done when:')
      expect(firstPrompt).toContain('TypeScript compiles without errors (run: npx tsc --noEmit).')
      expect(firstPrompt).not.toContain('[FILE:')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('includes the verified code window in the first continuous executor prompt', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'replace_in_file', input: { path: 'target.ts', old_string: 'return 1', new_string: 'return 2' } }
    ])

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, makeContinuousStep('Understand and fix target.ts')),
          enrichedPacket: {
            ...makeEnrichedPacket(),
            verifiedChunkIds: ['target.ts:1-1'],
            affectedSymbols: ['LoginService']
          }
        },
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      expect(firstPrompt).toContain('## Relevant code (target.ts lines 1-')
      expect(firstPrompt).toContain('[Line numbers are display-only. Do not include the N | prefix in old_string.]')
      expect(firstPrompt).toContain('The fix is in the code shown above. Read it, find the bug, write the fix.')
      expect(firstPrompt).toContain('1 | export function LoginService() { return 1 }')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('removes noise symbols like Client from the initial discovery prompt', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } }
    ])
    const step = {
      ...makeStep(0, 'Understand and locate the relevant code'),
      affectedSymbols: ['Client', 'createTRPCNext']
    }

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, step),
          enrichedPacket: {
            ...makeEnrichedPacket(),
            affectedSymbols: ['Client', 'createTRPCNext']
          }
        },
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      expect(firstPrompt).not.toContain('Client')
      expect(firstPrompt).toContain('createTRPCNext')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('includes discovery shortlist guidance and does not push write-now language in discovery prompts', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Understand and locate the relevant code')),
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      expect(firstPrompt).toContain('Discovery task: confirm the implementation target from these candidate files.')
      expect(firstPrompt).toContain('Candidate files:')
      expect(firstPrompt).toContain('- [high] target.ts')
      expect(firstPrompt).not.toContain('[FILE:')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('discovery confirm_surface completes the step with confirmed files', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'confirm_surface', input: { confirmed_files: ['target.ts'], additional_files: [], ready_to_implement: true } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Understand and locate the relevant code')),
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.stepOutput?.affectedFiles).toContain('target.ts')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('discovery confirm_surface with ready_to_implement false keeps discovery running when calls remain', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'confirm_surface', input: { confirmed_files: [], additional_files: ['target.ts'], ready_to_implement: false } },
      { name: 'confirm_surface', input: { confirmed_files: ['target.ts'], additional_files: [], ready_to_implement: true } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Understand and locate the relevant code')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(result.stepOutput?.affectedFiles).toContain('target.ts')
      expect(provider.messages).toHaveLength(2)
      expect(secondPrompt).toContain('Surface updated, but discovery will continue.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('discovery auto-confirms the shortlist after 5 tool calls', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'list_directory', input: { path: '.', maxDepth: 1 } },
      { name: 'search_in_files', input: { pattern: 'LoginService' } },
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Understand and locate the relevant code')),
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.stepOutput?.affectedFiles).toContain('target.ts')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('auto-confirm carries forward all files actually read during discovery', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'extra-a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'extra-b.ts'), 'export const b = 2\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'read_file', input: { path: 'extra-a.ts' } },
      { name: 'read_file', input: { path: 'extra-b.ts' } },
      { name: 'search_in_files', input: { pattern: 'export' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, makeStep(0, 'Understand and locate the relevant code')),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the implementation in target.ts'),
            verifiedChunkIds: ['target.ts:1-1', 'extra-a.ts:1-1', 'extra-b.ts:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.stepOutput?.affectedFiles).toEqual(expect.arrayContaining(['target.ts', 'extra-a.ts', 'extra-b.ts']))
    } finally {
      store.close()
      cleanup()
    }
  })

  it('returns cached preloaded content when implementation rereads a file already in context', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('WRITE NOW. Call write_file with your change.')
      expect(secondPrompt).toContain('This file is already in your context above. Write your change now.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('replays tool results as user turns so the tool conversation alternates correctly', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      expect(result.outcome).toBe('success')
      expect(provider.messages[1]?.[1]).toEqual(expect.objectContaining({ role: 'assistant' }))
      expect(provider.messages[1]?.[2]).toEqual(expect.objectContaining({ role: 'user' }))
    } finally {
      store.close()
      cleanup()
    }
  })

  it('adds validation guidance after a successful write_file', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('Written: target.ts')
      expect(secondPrompt).toContain('Write successful. Now validate the change:')
      expect(secondPrompt).toContain('If validation FAILS: you may re-read and repair the same file')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows replace_in_file when the target file was read this step', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'replace_in_file', input: { path: 'withTRPC.tsx', old_string: 'export const withTRPC = false\n', new_string: 'export const withTRPC = true\n' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.writeCount).toBe(1)
      expect(readFileSync(join(root, 'withTRPC.tsx'), 'utf8')).toContain('true')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks replace_in_file when the target file was not read this step', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['target.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'replace_in_file', input: { path: 'withTRPC.tsx', old_string: 'export const withTRPC = maybe\n', new_string: 'export const withTRPC = true\n' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['target.ts']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['target.ts:1-1']
          }
        },
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(result.writeCount).toBe(0)
      expect(secondPrompt).toContain('[BLOCKED] replace_in_file requires reading the file first.')
      expect(secondPrompt).toContain('Read the file first: read_file({ path: \\"withTRPC.tsx\\", startLine: 1, endLine: 80 })')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('adds a clean copy-ready block after read_file', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'withTRPC.tsx', startLine: 1, endLine: 1 } }
    ])

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1']
          }
        },
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(secondPrompt).toContain('[Exact content for editing — no line number prefix, copy as-is for old_string:]')
      expect(secondPrompt).toContain('```typescript')
      expect(secondPrompt).toContain('export const withTRPC = false')
      expect(secondPrompt).toContain('```typescript\\nexport const withTRPC = false\\n```')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('preloads full implementation file content up to the configured cap', async () => {
    const { root, cleanup } = makeRepo()
    const longFile = Array.from({ length: 80 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join('\n') + '\n'
    writeFileSync(join(root, 'withTRPC.tsx'), longFile)
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([])

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-80']
          }
        },
        provider
      )

      const firstPrompt = JSON.stringify(provider.messages[0] ?? [])
      expect(firstPrompt).toContain('[PlanOne read_file: line numbers are display-only.')
      expect(firstPrompt).toContain('1 | export const line1 = 1')
      expect(firstPrompt).toContain('80 | export const line80 = 80')
      expect(firstPrompt).not.toContain('discovery context trimmed after 20 lines')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks apply_patch when patch context was not read this step', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const patch = [
      'diff --git a/target.ts b/target.ts',
      '--- a/target.ts',
      '+++ b/target.ts',
      '@@ -1 +1 @@',
      '-export function MissingService() { return 1 }',
      '+export function MissingService() { return 2 }',
      ''
    ].join('\n')
    const provider = makePromptCapturingProvider([
      { name: 'apply_patch', input: { patch } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('[BLOCKED] apply_patch requires the exact text from a file read.')
      expect(secondPrompt).toContain('Do not retype patch context from memory.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks replace_in_file when the preloaded file changed before the edit', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const messages: LlmMessage[][] = []
    let callCount = 0
    const provider: ExecutorLlmProvider & { messages: LlmMessage[][] } = {
      messages,
      async callWithTools(callMessages) {
        messages.push(structuredClone(callMessages))
        if (callCount === 0) {
          callCount += 1
          writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = changed\n')
          const future = new Date(Date.now() + 5_000)
          utimesSync(join(root, 'withTRPC.tsx'), future, future)
          return {
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'replace_in_file',
              input: {
                path: 'withTRPC.tsx',
                old_string: 'export const withTRPC = false\n',
                new_string: 'export const withTRPC = true\n'
              }
            }],
            tokensUsed: 10,
            costUsd: 0
          }
        }

        return {
          content: [{ type: 'text', text: 'Done' }],
          tokensUsed: 5,
          costUsd: 0
        }
      }
    }

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1']
          }
        },
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('[BLOCKED] replace_in_file requires a fresh read of withTRPC.tsx.')
      expect(readFileSync(join(root, 'withTRPC.tsx'), 'utf8')).toContain('changed')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('adds validation guidance after a successful apply_patch', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const patch = [
      'diff --git a/target.ts b/target.ts',
      '--- a/target.ts',
      '+++ b/target.ts',
      '@@ -1 +1 @@',
      '-export function LoginService() { return 1 }',
      '+export function LoginService() { return 2 }',
      ''
    ].join('\n')
    const provider = makePromptCapturingProvider([
      { name: 'apply_patch', input: { patch } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('Patch applied successfully')
      expect(secondPrompt).toContain('Write successful. Now validate the change:')
      expect(secondPrompt).toContain('If validation PASSES: respond with plain text describing what you changed')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('does not add validation guidance to read_file results', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).not.toContain('Implementation complete. Your next action must be one of:')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('does not contain the old implementation complete message in step.ts', () => {
    const source = readFileSync(join(process.cwd(), 'src/executor/step.ts'), 'utf8')
    expect(source).not.toContain('Implementation complete. Your next action must be one of:')
    expect(source).toContain('Write successful. Now validate the change:')
  })

  it('blocks read_file after a successful write and forces validation actions', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } },
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'run_tests', input: {} }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(result.outcome).toBe('success')
      expect(thirdPrompt).toContain('[BLOCKED: read_file is not permitted after implementation.')
      expect(thirdPrompt).toContain('Call run_tests to verify')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('reopens same-file repair after failed validation and closes it after validation passes', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export function LoginService() { return 2 }\n' } },
      { name: 'run_tests', input: { testCommand: 'python3 -c "import sys; print(\'IndentationError\'); sys.exit(1)"' } },
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'replace_in_file', input: { path: 'target.ts', old_string: 'export function LoginService() { return 2 }\n', new_string: 'export function LoginService() { return 3 }\n' } },
      { name: 'run_tests', input: { testCommand: 'python3 -c "print(\'ok\')"' } },
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      const seventhPrompt = JSON.stringify(provider.messages[6] ?? [])
      expect(result.outcome).toBe('success')
      expect(fourthPrompt).toContain('1 | export function LoginService() { return 2 }')
      expect(fourthPrompt).not.toContain('[BLOCKED: read_file is not permitted after implementation.')
      expect(readFileSync(join(root, 'target.ts'), 'utf8')).toContain('return 3')
      expect(seventhPrompt).toContain('[BLOCKED: read_file is not permitted after implementation.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks search_in_files after a successful write', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } },
      { name: 'search_in_files', input: { pattern: 'LoginService' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(result.outcome).toBe('success')
      expect(thirdPrompt).toContain('[BLOCKED: search_in_files is not permitted after implementation.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows one post-write recovery read on a confirmed file after a failed replace_in_file', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() {\n  return 0\n  return 0\n}\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'replace_in_file', input: { path: 'ssrPrepass.ts', old_string: 'return 0', new_string: 'return 1' } },
      { name: 'read_file', input: { path: 'ssrPrepass.ts', startLine: 1, endLine: 2 } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1']
          }
        },
        provider
      )

      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      expect(result.outcome).toBe('success')
      expect(fourthPrompt).toContain('1 | export function ssrPrepass() {')
      expect(fourthPrompt).not.toContain('[BLOCKED: read_file is not permitted after implementation.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('still blocks post-write read_file on a different file after a failed replace_in_file', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() {\n  return 0\n}\n')
    writeFileSync(join(root, 'other.ts'), 'export const other = 0\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'replace_in_file', input: { path: 'ssrPrepass.ts', old_string: 'missing', new_string: 'updated' } },
      { name: 'read_file', input: { path: 'other.ts' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1']
          }
        },
        provider
      )

      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      expect(result.outcome).toBe('success')
      expect(fourthPrompt).toContain('[BLOCKED: read_file is not permitted after implementation.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks post-write read_file on a file after successful replace_in_file', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() {\n  return 0\n}\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'replace_in_file', input: { path: 'ssrPrepass.ts', old_string: 'return 0', new_string: 'return 1' } },
      { name: 'read_file', input: { path: 'ssrPrepass.ts' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1']
          }
        },
        provider
      )

      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      expect(result.outcome).toBe('success')
      expect(fourthPrompt).toContain('[BLOCKED: read_file is not permitted after implementation.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows run_command type-checks after a successful write and blocks arbitrary commands', async () => {
    const { root, cleanup } = makeRepo()
    const tscPath = join(root, 'fake-tsc.sh')
    writeFileSync(tscPath, '#!/bin/sh\nexit 0\n')
    chmodSync(tscPath, 0o755)
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } },
      { name: 'run_command', input: { command: 'echo hello' } },
      { name: 'run_command', input: { command: './fake-tsc.sh --tsc --noEmit' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      expect(result.outcome).toBe('success')
      expect(thirdPrompt).toContain('[BLOCKED: Only test commands and type-check commands are allowed after implementation.')
      expect(fourthPrompt).toContain('"command":"./fake-tsc.sh --tsc --noEmit"')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows a confirmed file to recover with write_file after apply_patch fails twice', async () => {
    const { root, cleanup } = makeGitRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['target.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const invalidPatchOne = [
      '*** Update File: target.ts',
      '@@ invalid hunk',
      '-export function LoginService() { return 1 }',
      '+export function LoginService() { return 2 }',
      ''
    ].join('\n')
    const invalidPatchTwo = [
      '*** Update File: target.ts',
      '@@ still invalid',
      '-export function LoginService() { return 1 }',
      '+export function LoginService() { return 3 }',
      ''
    ].join('\n')
    const provider = makePromptCapturingProvider([
      { name: 'apply_patch', input: { patch: invalidPatchOne } },
      { name: 'apply_patch', input: { patch: invalidPatchTwo } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const recoveryPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(result.outcome).toBe('success')
      expect(recoveryPrompt).toContain('apply_patch failed twice on confirmed file target.ts.')
      expect(recoveryPrompt).toContain('Use write_file to make ONLY the targeted change described in your plan.')
      expect(result.writeCount).toBe(1)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('still fails the step after apply_patch fails twice on an unconfirmed file', async () => {
    const { root, cleanup } = makeGitRepo()
    writeFileSync(join(root, 'ghost.ts'), 'export const ghost = 1\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const invalidPatchOne = [
      '*** Update File: ghost.ts',
      '@@ invalid hunk',
      '-export const ghost = 1',
      '+export const ghost = 2',
      ''
    ].join('\n')
    const invalidPatchTwo = [
      '*** Update File: ghost.ts',
      '@@ still invalid',
      '-export const ghost = 1',
      '+export const ghost = 3',
      ''
    ].join('\n')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'ghost.ts' } },
      { name: 'apply_patch', input: { patch: invalidPatchOne } },
      { name: 'apply_patch', input: { patch: invalidPatchTwo } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      expect(result.outcome).toBe('error')
      expect(result.vetoReason).toContain('off-target full file rewrite')
      expect(provider.messages).toHaveLength(3)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('replays conversation summaries as user context, not fabricated assistant output', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      const firstMessages = provider.messages.map((messages) => String(messages[0]?.content ?? ''))
      expect(result.outcome).toBe('success')
      expect(firstMessages.length).toBeGreaterThan(1)
      expect(firstMessages.every((message) => message === firstMessages[0])).toBe(true)
      expect(firstMessages[0]).not.toContain('[FILE:')
      expect(provider.messages[0]?.some((message) => message.role === 'assistant')).toBe(true)
      expect(provider.messages[0]?.some((message) => message.role === 'user' && Array.isArray(message.content))).toBe(true)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('returns cached content for duplicate read_file calls in the same discovery step', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file')),
        provider
      )

      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(result.outcome).toBe('success')
      expect(thirdPrompt).toContain('target.ts was already read earlier in this step. Reuse it and write your change now.')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('bypasses the duplicate-read cache for ranged read_file requests', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'multi.ts'), [
      'export const line1 = 1',
      'export const line2 = 2',
      'export const line3 = 3',
      'export const line4 = 4'
    ].join('\n'))
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'multi.ts' } },
      { name: 'read_file', input: { path: 'multi.ts', startLine: 2, endLine: 3 } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file')),
        provider
      )

      const lastToolResultMessage = provider.messages[2]?.at(-1)
      const rangedReadResult = Array.isArray(lastToolResultMessage?.content)
        ? lastToolResultMessage.content.find((block) => block.type === 'tool_result')?.content
        : ''
      expect(result.outcome).toBe('success')
      expect(typeof rangedReadResult).toBe('string')
      expect(rangedReadResult).toContain('2 | export const line2 = 2')
      expect(rangedReadResult).toContain('3 | export const line3 = 3')
      expect(rangedReadResult).not.toContain('already read earlier in this step')
      expect(rangedReadResult).not.toContain('1 | export const line1 = 1')
      expect(rangedReadResult).not.toContain('4 | export const line4 = 4')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows broad recursive repo scans during discovery and returns the result normally', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'list_directory', input: { path: '.', recursive: true, maxDepth: 5 } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(0, 'Inspect the target file')),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('.planone/trace.db')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('does not compress implementation context when working content is under budget', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const compressionProvider: CompressionLlmProvider & { getDefaultModel: () => string } = {
      getDefaultModel: () => 'gemini-2.5-flash',
      async distill(content) {
        return `${content}\n// compressed`
      }
    }
    const distillSpy = vi.spyOn(compressionProvider, 'distill')

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        makeProvider('write_file', { path: 'target.ts', content: 'export const value = 2\n' }),
        compressionProvider
      )

      expect(result.outcome).toBe('success')
      expect(distillSpy).not.toHaveBeenCalled()
    } finally {
      store.close()
      cleanup()
    }
  })

  it('uses the compression provider default model only for over-budget non-preload content', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const modelsSeen: string[] = []
    const distilledInputs: string[] = []
    const compressionProvider: CompressionLlmProvider & { getDefaultModel: () => string } = {
      getDefaultModel: () => 'gemini-2.5-flash',
      async distill(content, _taskContext, model) {
        modelsSeen.push(model)
        distilledInputs.push(content)
        return `${content.slice(0, 200)}\n// compressed`
      }
    }

    try {
      const largeSearchContent = 'function helper() { return "context"; }\n'.repeat(40_000)
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
          client: makeClientWithSearchContent(largeSearchContent),
          contextDb: new ContextDB(makeClientWithSearchContent(largeSearchContent))
        },
        makeProvider('write_file', { path: 'target.ts', content: 'export const value = 2\n' }),
        compressionProvider
      )

      expect(result.outcome).toBe('success')
      expect(modelsSeen).toContain('gemini-2.5-flash')
      expect(modelsSeen).not.toContain('claude-opus-4-5')
      expect(distilledInputs.every((content) => !content.includes('export function LoginService() { return 1 }'))).toBe(true)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('marks successful tsc run_command validation as typeCheckPassed', async () => {
    const { root, cleanup } = makeRepo()
    const tscPath = join(root, 'fake-tsc.sh')
    writeFileSync(tscPath, '#!/bin/sh\nexit 0\n')
    chmodSync(tscPath, 0o755)
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } },
      { name: 'run_command', input: { command: './fake-tsc.sh --tsc --noEmit' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeStep(1, 'Implement the fix in target.ts')),
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.typeCheckPassed).toBe(true)
      expect(result.writeCount).toBe(1)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('preloads all confirmed implementation files and names them in the first prompt', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export interface WithTRPCSSROptions { forceServerGcTimeInfinity?: boolean }\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() { return null }\n')
    writeFileSync(join(root, 'createTRPCNext.tsx'), 'export function createTRPCNext() { return null }\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'ssrPrepass.ts', content: 'export function ssrPrepass() { return 1 }\n' } }
    ])

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the SSR runtime behavior'),
            approach: 'Update ssrPrepass.ts to use forceServerGcTimeInfinity and keep withTRPC.tsx aligned',
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts', 'createTRPCNext.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update ssrPrepass.ts to use forceServerGcTimeInfinity and keep withTRPC.tsx aligned'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1', 'createTRPCNext.tsx:1-1'],
            affectedSymbols: ['WithTRPCSSROptions', 'ssrPrepass']
          }
        },
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      const serializedMessages = JSON.stringify(provider.messages[0] ?? [])
      expect(firstPrompt).toContain('The following files were confirmed during discovery and are preloaded:')
      expect(firstPrompt).toContain('withTRPC.tsx')
      expect(firstPrompt).toContain('ssrPrepass.ts')
      expect(firstPrompt).toContain('createTRPCNext.tsx')
      expect(firstPrompt).toContain('use the preloaded code and the approach to decide whether this file needs changes')
      expect(serializedMessages).toContain('withTRPC.tsx')
      expect(serializedMessages).toContain('ssrPrepass.ts')
      expect(serializedMessages).toContain('createTRPCNext.tsx')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('merges files actually read during discovery into explicit confirm_surface results', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = true\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() { return null }\n')
    writeFileSync(join(root, 'createTRPCNext.tsx'), 'export function createTRPCNext() { return null }\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'read_file', input: { path: 'withTRPC.tsx' } },
      { name: 'read_file', input: { path: 'ssrPrepass.ts' } },
      { name: 'read_file', input: { path: 'createTRPCNext.tsx' } },
      { name: 'confirm_surface', input: { confirmed_files: ['withTRPC.tsx'], additional_files: [], ready_to_implement: true } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(0, 'Confirm the implementation surface'),
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts', 'createTRPCNext.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the next integration runtime behavior'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1', 'createTRPCNext.tsx:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.stepOutput?.affectedFiles).toEqual(expect.arrayContaining([
        'withTRPC.tsx',
        'ssrPrepass.ts',
        'createTRPCNext.tsx'
      ]))
    } finally {
      store.close()
      cleanup()
    }
  })

  it('omits a symbol target when the approach symbol does not appear in the preloaded file content', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'createTRPCNext.tsx'), 'export function createTRPCNext() { return null }\n')
    writeFileSync(join(root, 'withTRPC.tsx'), 'export interface TRPCNextOptions { forceServerGcTimeInfinity?: boolean }\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['createTRPCNext.tsx', 'withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'createTRPCNext.tsx', content: 'export function createTRPCNext() { return 1 }\n' } }
    ])

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix in createTRPCNext.tsx'),
            approach: 'Update TRPCNextOptions in createTRPCNext.tsx',
            affectedFiles: ['createTRPCNext.tsx', 'withTRPC.tsx'],
            affectedSymbols: ['createTRPCNext']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update TRPCNextOptions in createTRPCNext.tsx'),
            verifiedChunkIds: ['createTRPCNext.tsx:1-1', 'withTRPC.tsx:1-1'],
            affectedSymbols: ['createTRPCNext']
          }
        },
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      expect(firstPrompt).not.toContain('Symbol to modify: TRPCNextOptions')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('prefers runtime-heavy confirmed files first for runtime-oriented approaches', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'runtime.ts'), [
      'export function runServerLogic() {',
      '  const queryClient = getQueryClient()',
      '  if (queryClient) {',
      '    return queryClient',
      '  }',
      '  return null',
      '}'
    ].join('\n'))
    writeFileSync(join(root, 'options.ts'), [
      'export interface RuntimeOptions {',
      '  enabled?: boolean',
      '}',
      'export type RuntimeConfig = RuntimeOptions & {',
      '  name: string',
      '}'
    ].join('\n'))
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['options.ts', 'runtime.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const messages: LlmMessage[][] = []
    const provider: ExecutorLlmProvider & { messages: LlmMessage[][] } = {
      messages,
      async generatePreActionPlan() {
        return {
          intendedAction: 'Implement the runtime behavior in the confirmed files',
          affectedSymbols: ['RuntimeOptions'],
          estimatedRiskLevel: 'low',
          reasoning: ''
        }
      },
      async callWithTools(turnMessages) {
        messages.push(turnMessages)
        return {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'write_file',
            input: { path: 'runtime.ts', content: 'export function runServerLogic() { return 1 }\n' }
          }]
        }
      }
    }

    try {
      await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the runtime behavior'),
            approach: 'Override the query client behavior during server-side execution',
            affectedFiles: ['options.ts', 'runtime.ts'],
            affectedSymbols: ['RuntimeOptions']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Override the query client behavior during server-side execution'),
            structuredDescription: 'Override query client behavior during server-side execution without changing the type shape',
            verifiedChunkIds: ['options.ts:1-1', 'runtime.ts:1-1'],
            affectedSymbols: ['RuntimeOptions']
          }
        },
        provider
      )

      const firstPrompt = String(provider.messages[0]?.[0]?.content ?? '')
      const runtimeIndex = firstPrompt.indexOf('- runtime.ts:')
      const typeIndex = firstPrompt.indexOf('- options.ts:')
      expect(runtimeIndex).toBeGreaterThan(-1)
      expect(typeIndex).toBeGreaterThan(-1)
      expect(runtimeIndex).toBeLessThan(typeIndex)
    } finally {
      store.close()
      cleanup()
    }
  })

  it('allows a second write to a different confirmed file after the first write', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    writeFileSync(join(root, 'ssrPrepass.ts'), 'export function ssrPrepass() { return 0 }\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'write_file', input: { path: 'ssrPrepass.ts', content: 'export function ssrPrepass() { return 1 }\n' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix across confirmed files'),
            affectedFiles: ['withTRPC.tsx', 'ssrPrepass.ts']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation files'),
            verifiedChunkIds: ['withTRPC.tsx:1-1', 'ssrPrepass.ts:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.writeCount).toBe(2)
      expect(readFileSync(join(root, 'withTRPC.tsx'), 'utf8')).toContain('true')
      expect(readFileSync(join(root, 'ssrPrepass.ts'), 'utf8')).toContain('return 1')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks a second write to the same file after the first write', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = false\n' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix in the confirmed file'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation file'),
            verifiedChunkIds: ['withTRPC.tsx:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.writeCount).toBe(1)
      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(thirdPrompt).toContain('Do not rewrite the same file twice')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks a post-write write to an unconfirmed file', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'withTRPC.tsx'), 'export const withTRPC = false\n')
    writeFileSync(join(root, 'unconfirmed.ts'), 'export const hidden = 0\n')
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    tier2.record({
      stepIndex: 0,
      producedContent: 'Implementation surface confirmed.',
      affectedFiles: ['withTRPC.tsx'],
      causalDependencies: [],
      baseMemoryChunksUsed: []
    })
    const provider = makePromptCapturingProvider([
      { name: 'write_file', input: { path: 'withTRPC.tsx', content: 'export const withTRPC = true\n' } },
      { name: 'write_file', input: { path: 'unconfirmed.ts', content: 'export const hidden = 1\n' } }
    ])

    try {
      const result = await executeStep(
        {
          ...makeStepInput(root, store, tier2, {
            ...makeStep(1, 'Implement the fix in the confirmed file'),
            affectedFiles: ['withTRPC.tsx']
          }),
          enrichedPacket: {
            ...makeEnrichedPacket('Update the confirmed implementation file'),
            verifiedChunkIds: ['withTRPC.tsx:1-1']
          }
        },
        provider
      )

      expect(result.outcome).toBe('success')
      expect(result.writeCount).toBe(1)
      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(thirdPrompt).toContain('is not in the confirmed implementation surface')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('adds a pivot note after two consecutive empty searches in implementation', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'read_file', input: { path: 'target.ts' } }
    ])

    try {
      const packet = {
        ...makeEnrichedPacket(),
        verifiedChunkIds: []
      }
      const result = await executeStep(
        makeStepInputWithPacket(root, store, tier2, makeStep(1, 'Implement the fix in target.ts'), packet),
        provider
      )

      const thirdPrompt = JSON.stringify(provider.messages[2] ?? [])
      expect(result.outcome).toBe('success')
      expect(thirdPrompt).toContain('2 consecutive searches returned no results')
      expect(thirdPrompt).toContain('write your change now')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks the third consecutive empty search during implementation', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const packet = {
        ...makeEnrichedPacket(),
        verifiedChunkIds: []
      }
      const result = await executeStep(
        makeStepInputWithPacket(root, store, tier2, makeStep(1, 'Implement the fix in target.ts'), packet),
        provider
      )

      const fourthPrompt = JSON.stringify(provider.messages[3] ?? [])
      expect(result.outcome).toBe('success')
      expect(fourthPrompt).toContain('[BLOCKED: Third consecutive empty search. Searching is no longer permitted.')
      expect(fourthPrompt).toContain('Call write_file, replace_in_file, or apply_patch now')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('blocks search_in_files before any write when a verified code window is available', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'search_in_files', input: { pattern: 'LoginService', directory: '.' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const result = await executeStep(
        makeStepInput(root, store, tier2, makeContinuousStep()),
        provider
      )

      const secondPrompt = JSON.stringify(provider.messages[1] ?? [])
      expect(result.outcome).toBe('success')
      expect(secondPrompt).toContain('[BLOCKED] The relevant code is already shown in the initial message.')
      expect(secondPrompt).toContain('make your change directly')
    } finally {
      store.close()
      cleanup()
    }
  })

  it('resets the empty-search counter after a non-search tool call', async () => {
    const { root, cleanup } = makeRepo()
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const tier2 = new Tier2Memory('task-1')
    const provider = makePromptCapturingProvider([
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'read_file', input: { path: 'target.ts' } },
      { name: 'search_in_files', input: { pattern: 'TRPCNextOptions', directory: '.' } },
      { name: 'write_file', input: { path: 'target.ts', content: 'export const value = 2\n' } }
    ])

    try {
      const packet = {
        ...makeEnrichedPacket(),
        verifiedChunkIds: []
      }
      const result = await executeStep(
        makeStepInputWithPacket(root, store, tier2, makeStep(1, 'Implement the fix in target.ts'), packet),
        provider
      )

      const fifthPrompt = JSON.stringify(provider.messages[4] ?? [])
      expect(result.outcome).toBe('success')
      expect(fifthPrompt).not.toContain('Third consecutive empty search')
      expect(fifthPrompt).toContain('"tool_use_id":"tool-4","content":"ERROR: No matches found.\\n\\n[PlanOne note: Writes: 0. Call write_file now.]"')
    } finally {
      store.close()
      cleanup()
    }
  })

})
