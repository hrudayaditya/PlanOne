import type { AbMode } from '../../ab-test/index.js'
import { DEFAULT_EXECUTOR_MODEL } from '../../llm/models.js'
import type { RawTraceStore } from '../raw-trace-store/index.js'
import type { StepOutput } from '../../pipeline/state-machine.js'
import type { WorkingContentItem } from '../../pipeline/context-budget.js'
import { countTokens } from '../../utils/tokens.js'

/**
 * Serializable record of one completed step held in Tier2 working memory.
 */
export interface StepRecord {
  stepIndex: number
  producedContent: string
  affectedFiles: string[]
  causalDependencies: number[]
  baseMemoryChunksUsed: string[]
  completedAt: string
}

/**
 * In-process per-task working memory for completed step outputs.
 */
export class Tier2Memory {
  private readonly taskId: string
  private readonly steps: Map<number, StepRecord>

  /**
   * Creates an empty Tier2 memory for one task.
   */
  constructor(taskId: string) {
    this.taskId = taskId
    this.steps = new Map<number, StepRecord>()
  }

  /**
   * Records a step output as a stable Tier2 step record.
   *
   * This method never throws.
   */
  record(output: StepOutput): void {
    try {
      this.steps.set(output.stepIndex, {
        stepIndex: output.stepIndex,
        producedContent: output.producedContent,
        affectedFiles: output.affectedFiles,
        causalDependencies: output.causalDependencies,
        baseMemoryChunksUsed: output.baseMemoryChunksUsed,
        completedAt: new Date().toISOString()
      })
    } catch {
      // Tier2 recording is best-effort in Phase 1.
    }
  }

  /**
   * Retrieves one step record by step index.
   */
  get(stepIndex: number): StepRecord | null {
    return this.steps.get(stepIndex) ?? null
  }

  /**
   * Returns the recursive dependency chain for a step, including the step itself.
   *
   * The traversal is cycle-safe.
   */
  getDependencyChain(stepIndex: number): StepRecord[] {
    const visited = new Set<number>()
    const ordered: StepRecord[] = []

    const visit = (currentStepIndex: number): void => {
      if (visited.has(currentStepIndex)) {
        return
      }

      visited.add(currentStepIndex)
      const record = this.steps.get(currentStepIndex)

      if (record === undefined) {
        return
      }

      ordered.push(record)

      for (const dependency of record.causalDependencies) {
        visit(dependency)
      }
    }

    visit(stepIndex)

    return ordered
  }

  /**
   * Converts all stored step records into working content items.
   */
  toWorkingContentItems(): WorkingContentItem[] {
    return [...this.steps.values()]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((record) => {
        const content = JSON.stringify(record)
        return {
          chunkId: `tier2:${this.taskId}:${record.stepIndex}`,
          content,
          source: 'tier2',
          tokens: countTokens(content, DEFAULT_EXECUTOR_MODEL)
        }
      })
  }

  /**
   * Flushes all Tier2 records to the Raw Trace Store synchronously.
   */
  flush(rts: RawTraceStore, abMode: AbMode): void {
    rts.append({
      task_id: this.taskId,
      ab_mode: abMode,
      agent_role: 'executor',
      step_index: null,
      event_type: 'tier2_flush',
      content_json: JSON.stringify([...this.steps.values()].sort((left, right) => left.stepIndex - right.stepIndex)),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
  }

  /**
   * Clears all in-process step records after a successful flush.
   */
  clear(): void {
    this.steps.clear()
  }
}
