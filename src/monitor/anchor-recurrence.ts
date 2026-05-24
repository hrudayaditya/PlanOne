import type { PlanOneRules } from '../intake/rules.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { StepOutput } from '../pipeline/state-machine.js'
import type { CyclePlan } from '../executor/cycle-plan.js'
import type { PreActionPlan } from '../pipeline/state-machine.js'

/**
 * Input required to generate constraint reminders for one step.
 */
export interface AnchorRecurrenceInput {
  currentStep: ExecutionStep
  cyclePlan?: CyclePlan | PreActionPlan
  preActionPlan?: CyclePlan | PreActionPlan
  rules: PlanOneRules
  enrichedPacket: EnrichedPacket
  stepHistory: StepOutput[]
}

/**
 * Serializable reminder injected back into executor context.
 */
export interface ConstraintReminder {
  trigger: string
  reminder: string
  priority: 'high' | 'medium' | 'low'
}

/**
 * Generates recurring constraint reminders for high-risk or drift-prone steps.
 */
export function generateConstraintReminders(
  input: AnchorRecurrenceInput
): ConstraintReminder[] {
  const reminders: ConstraintReminder[] = []

  if (input.currentStep.estimatedRisk === 'high') {
    reminders.push({
      trigger: 'high_blast_radius',
      reminder: `HIGH RISK STEP: ${input.currentStep.description}. Affected symbols: ${input.currentStep.affectedSymbols.join(', ')}. Verify each change does not break callers.`,
      priority: 'high'
    })
  }

  if (input.currentStep.isCheckpoint) {
    reminders.push({
      trigger: 'checkpoint',
      reminder: 'CHECKPOINT: Monitor review required after this step. Ensure: tests pass, no scope creep, changes are minimal.',
      priority: 'high'
    })
  }

  if (input.rules.never_touch.length > 0) {
    reminders.push({
      trigger: 'never_touch',
      reminder: `NEVER TOUCH these paths: ${input.rules.never_touch.join(', ')}`,
      priority: 'medium'
    })
  }

  if (input.stepHistory.length >= 2) {
    const previousFiles = new Set(input.stepHistory.at(-1)?.affectedFiles ?? [])
    const olderFiles = new Set(input.stepHistory.at(-2)?.affectedFiles ?? [])
    const overlap = [...previousFiles].filter((filePath) => olderFiles.has(filePath))

    if (overlap.length > 0) {
      reminders.push({
        trigger: 'repeated_approach',
        reminder: 'WARNING: Last 2 steps modified the same files. Verify you are not in a correction loop.',
        priority: 'high'
      })
    }
  }

  if (
    input.enrichedPacket.activeConstraints.length > 0
    && input.currentStep.stepIndex % 3 === 0
    && input.stepHistory.length > 0
  ) {
    reminders.push({
      trigger: 'constraint_carry_forward',
      reminder: `ACTIVE CONSTRAINTS: ${input.enrichedPacket.activeConstraints.join(' | ')}`,
      priority: 'medium'
    })
  }

  return reminders
}
