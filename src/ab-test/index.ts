/**
 * Immutable A/B mode identifiers for PlanOne task intake.
 */
export type AbMode = 'A' | 'B' | 'C' | 'D'

/**
 * Per-task A/B context propagated unchanged through the pipeline.
 */
export interface AbContext {
  taskId: string
  abMode: AbMode
  taskSequenceNumber: number
}

/**
 * Assigns the immutable A/B mode for a task sequence number.
 *
 * Tasks 1-9 default to `B`. Every 10th task cycles through `A`, `C`, and `D`
 * with `B` filling the tasks in between, matching the Week 1 rollout plan.
 */
export function assignAbMode(taskSequenceNumber: number): AbMode {
  if (taskSequenceNumber <= 0) {
    return 'B'
  }

  const remainder = taskSequenceNumber % 10

  if (remainder !== 0) {
    return 'B'
  }

  const blockIndex = Math.floor(taskSequenceNumber / 10)
  const cyclePosition = ((blockIndex - 1) % 3) + 1

  if (cyclePosition === 1) {
    return 'A'
  }

  if (cyclePosition === 2) {
    return 'C'
  }

  return 'D'
}
