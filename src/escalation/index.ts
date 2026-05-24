import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'

/**
 * Supported escalation triggers for the Week 1 exit path.
 */
export const EscalationTriggerSchema = z.enum([
  'sek_diff_policy_violation',
  'retry_exhaustion',
  'panel_critical_disagreement',
  'memory_contradiction_unresolved',
  'monitor_architectural_decision',
  'security_verifier_finding',
  'context_budget_insufficient'
])

/**
 * Execution history entry recorded in an escalation package.
 */
export const ExecutionCycleSchema = z.object({
  cycle: z.number().int(),
  approach: z.string(),
  steps_taken: z.number().int(),
  monitor_interventions: z.number().int(),
  verifier_verdict: z.string(),
  blocking_issue: z.string()
})

/**
 * Structured escalation package surfaced to the top-level pipeline.
 */
export const EscalationPackageSchema = z.object({
  escalation_id: z.uuid(),
  trigger: EscalationTriggerSchema,
  task_id: z.string().min(1),
  task: z.string(),
  enriched_packet: z.unknown(),
  execution_history: z.array(ExecutionCycleSchema),
  memory_contradictions_detected: z.array(z.unknown()),
  suggested_actions: z.array(z.string()),
  created_at: z.string().datetime({ offset: true })
})

/**
 * Input extras used to build a complete escalation package.
 */
export const BuildEscalationExtrasSchema = z.object({
  enriched_packet: z.unknown().default(null),
  execution_history: z.array(ExecutionCycleSchema).default([]),
  memory_contradictions_detected: z.array(z.unknown()).default([]),
  suggested_actions: z.array(z.string()).default([])
})

/**
 * Week 1 execution cycle type inferred from zod.
 */
export type ExecutionCycle = z.infer<typeof ExecutionCycleSchema>

/**
 * Week 1 escalation trigger type inferred from zod.
 */
export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>

/**
 * Week 1 escalation package type inferred from zod.
 */
export type EscalationPackage = z.infer<typeof EscalationPackageSchema>

/**
 * Error thrown to exit the pipeline through the structured escalation path.
 */
export class EscalationRequired extends Error {
  escalation_id: string
  package: EscalationPackage

  /**
   * Creates an escalation error carrying the full structured package.
   */
  constructor(pkg: EscalationPackage) {
    super(`Escalation required: ${pkg.trigger}`)
    this.name = 'EscalationRequired'
    this.escalation_id = pkg.escalation_id
    this.package = pkg
  }
}

/**
 * Builds a validated escalation package with a fresh UUID and UTC timestamp.
 */
export function buildEscalationPackage(
  trigger: EscalationTrigger,
  taskId: string,
  task: string,
  extras: z.input<typeof BuildEscalationExtrasSchema>
): EscalationPackage {
  const parsedExtras = BuildEscalationExtrasSchema.parse(extras)

  return EscalationPackageSchema.parse({
    escalation_id: randomUUID(),
    trigger,
    task_id: taskId,
    task,
    ...parsedExtras,
    created_at: new Date().toISOString()
  })
}

/**
 * Appends the escalation event synchronously to the raw trace store and then
 * throws `EscalationRequired`.
 *
 * This function never returns normally.
 */
export function escalate(pkg: EscalationPackage, rts: RawTraceStore, abMode: AbMode): never {
  const parsedPackage = EscalationPackageSchema.parse(pkg)

  rts.append({
    task_id: parsedPackage.task_id,
    ab_mode: abMode,
    agent_role: 'escalation',
    step_index: null,
    event_type: 'ESCALATION',
    content_json: JSON.stringify(parsedPackage),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })

  throw new EscalationRequired(parsedPackage)
}
