import { minimatch } from 'minimatch'

import type { AbMode } from '../ab-test/index.js'
import type { BaseMemoryClient } from '../basememory/client.js'
import type { PlanOneRules } from '../intake/rules.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { ExecutionStep } from '../orchestrator/plan.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import type { StepOutput } from '../pipeline/state-machine.js'
import { logInfo, logWarn } from '../utils/logger.js'
import type { CyclePlan } from '../executor/cycle-plan.js'
import type { PreActionPlan } from '../pipeline/state-machine.js'
import { generateConstraintReminders, type AnchorRecurrenceInput, type ConstraintReminder } from './anchor-recurrence.js'
import { checkVeto, type VetoInput, type VetoResult } from './veto.js'

/**
 * Shared monitor input used for pre-action and post-step review.
 */
export interface MonitorInput {
  currentStep: ExecutionStep
  cyclePlan?: CyclePlan | PreActionPlan
  preActionPlan?: CyclePlan | PreActionPlan
  enrichedPacket: EnrichedPacket
  confirmedFiles: string[]
  preloadedFileContents: Map<string, string>
  rules: PlanOneRules
  stepHistory: StepOutput[]
  taskId: string
  abMode: AbMode
  rts: RawTraceStore
  client: BaseMemoryClient
  repoRoot: string
}

/**
 * Structured pre-action monitor result.
 */
export interface MonitorPreActionResult {
  vetoResult: VetoResult
  constraintReminders: ConstraintReminder[]
  shouldProceed: boolean
  remindersAsText: string
}

/**
 * Structured post-step monitor result.
 */
export interface MonitorPostStepResult {
  approved: boolean
  concerns: string[]
  monitorNote: string
}

/**
 * Runs the Phase 1 pre-action monitor sequence and logs the outcome.
 */
export async function runPreActionMonitor(
  input: MonitorInput
): Promise<MonitorPreActionResult> {
  const vetoResult = await checkVeto(toVetoInput(input), input.client)
  const constraintReminders = generateConstraintReminders(toAnchorRecurrenceInput(input))
  const remindersAsText = constraintReminders
    .map((reminder) => `[${reminder.priority.toUpperCase()}] ${reminder.reminder}`)
    .join('\n')

  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'monitor',
    step_index: input.currentStep.stepIndex,
    event_type: 'monitor_review',
    content_json: JSON.stringify({
      phase: 'pre_action',
      vetoResult,
      reminderCount: constraintReminders.length
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
  if (vetoResult.vetoed) {
    logWarn('monitor', '[Monitor] Pre-action review vetoed', {
      stepIndex: input.currentStep.stepIndex,
      vetoType: vetoResult.vetoType,
      reason: vetoResult.reason
    })
  } else {
    logInfo('monitor', '[Monitor] Pre-action review approved', {
      stepIndex: input.currentStep.stepIndex,
      reminderCount: constraintReminders.length
    })
  }

  return {
    vetoResult,
    constraintReminders,
    shouldProceed: vetoResult.vetoed === false,
    remindersAsText
  }
}

/**
 * Runs the Phase 1 post-step monitor sequence and logs the outcome.
 */
export async function runPostStepMonitor(
  input: MonitorInput,
  stepOutput: StepOutput
): Promise<MonitorPostStepResult> {
  const concerns = stepOutput.affectedFiles
    .flatMap((filePath) => input.rules.never_touch
      .filter((pattern) => minimatch(filePath, pattern))
      .map(() => `Step modified never_touch file: ${filePath}`))
  const approved = concerns.length === 0
  const monitorNote = approved ? 'Post-step monitor approved the step.' : 'Post-step monitor detected concerns.'

  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'monitor',
    step_index: input.currentStep.stepIndex,
    event_type: 'monitor_review',
    content_json: JSON.stringify({
      phase: 'post_step',
      approved,
      concerns
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
  logInfo('monitor', '[Monitor] Post-step review complete', {
    stepIndex: input.currentStep.stepIndex,
    approved,
    concerns
  })

  return {
    approved,
    concerns,
    monitorNote
  }
}

function toVetoInput(input: MonitorInput): VetoInput {
  const cyclePlan = input.cyclePlan ?? input.preActionPlan
  if (cyclePlan === undefined) {
    throw new Error('MonitorInput requires cyclePlan')
  }

  return {
    cyclePlan,
    currentStep: input.currentStep,
    enrichedPacket: input.enrichedPacket,
    confirmedFiles: input.confirmedFiles,
    preloadedFileContents: input.preloadedFileContents,
    rules: input.rules,
    repoRoot: input.repoRoot
  }
}

function toAnchorRecurrenceInput(input: MonitorInput): AnchorRecurrenceInput {
  const cyclePlan = input.cyclePlan ?? input.preActionPlan
  if (cyclePlan === undefined) {
    throw new Error('MonitorInput requires cyclePlan')
  }

  return {
    currentStep: input.currentStep,
    cyclePlan,
    rules: input.rules,
    enrichedPacket: input.enrichedPacket,
    stepHistory: input.stepHistory
  }
}
