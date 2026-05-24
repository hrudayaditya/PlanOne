/**
 * One executor-visible step in a Phase 1 execution plan.
 */
export interface ExecutionStep {
  stepIndex: number
  description: string
  approach: string
  affectedSymbols: string[]
  affectedFiles: string[]
  estimatedRisk: 'low' | 'medium' | 'high'
  dependsOn: number[]
  isCheckpoint: boolean
  phaseHint?: 'discovery' | 'implementation' | 'testing' | 'verification' | 'continuous'
}

/**
 * Structured execution plan produced by the orchestrator.
 */
export interface ExecutionPlan {
  planId: string
  taskId: string
  approach: string
  approachRank: number
  steps: ExecutionStep[]
  executionMode?: 'phased' | 'continuous'
  assignedExecutorModel: string
  assignedVerifierModel: string
  estimatedStepCount: number
  createdAt: string
}

/**
 * Execution-cycle metadata tracked by the retry manager.
 */
export interface ExecutionCycle {
  cycle: number
  plan: ExecutionPlan
  startedAt: string
  completedAt: string | null
  outcome: 'success' | 'verifier_rejected' | 'escalated' | 'in_progress'
  blockedByIssue: string | null
  monitorInterventions: number
}
