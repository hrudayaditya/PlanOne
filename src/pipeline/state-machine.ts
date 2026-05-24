import { assign, createActor, setup } from 'xstate'

import type { AbMode } from '../ab-test/index.js'
import type { EscalationPackage } from '../escalation/index.js'
import type {
  BudgetCheckResult,
  PermanentAnchorSet,
  WorkingContentItem
} from './context-budget.js'

/**
 * Planning metadata prepared before an execution step acts.
 */
export interface PreActionPlan {
  intendedAction: string
  affectedSymbols: string[]
  estimatedRiskLevel: 'low' | 'medium' | 'high'
  reasoning: string
}

function isCodeSymbol(value: string): boolean {
  if (value.length < 2) {
    return false
  }

  if (value.includes(' ')) {
    return false
  }

  return /^[a-zA-Z_$][a-zA-Z0-9_$.:>\-]*$/.test(value)
}

function sanitizePreActionPlan(plan: PreActionPlan): PreActionPlan {
  return {
    ...plan,
    affectedSymbols: plan.affectedSymbols.filter((symbol) => isCodeSymbol(symbol))
  }
}

/**
 * Structured output produced by a single execution step.
 */
export interface StepOutput {
  stepIndex: number
  producedContent: string
  affectedFiles: string[]
  causalDependencies: number[]
  baseMemoryChunksUsed: string[]
}

/**
 * Immutable actor input used to initialize a step machine instance.
 */
export interface StepMachineInput {
  taskId: string
  stepIndex: number
  model: string
  abMode: AbMode
}

/**
 * In-memory XState context for a single execution step.
 *
 * This is machine state only; it is not ContextDB and must preserve anchors
 * across eviction.
 */
export interface StepMachineContext {
  taskId: string
  stepIndex: number
  model: string
  abMode: AbMode
  anchors: PermanentAnchorSet | null
  anchorTokens: number
  preActionPlan: PreActionPlan | null
  vetoed: boolean
  vetoReason: string | null
  constraintReminder: string | null
  workingContent: WorkingContentItem[]
  budgetResult: BudgetCheckResult | null
  stepOutput: StepOutput | null
  error: Error | null
  escalationPackage: EscalationPackage | null
}

/**
 * All events accepted by the Week 2 step state machine.
 */
export type StepMachineEvent =
  | { type: 'STEP_START'; taskId: string; stepIndex: number; model: string; abMode: AbMode }
  | { type: 'ANCHORS_LOADED'; anchors: PermanentAnchorSet; anchorTokens: number }
  | { type: 'PRE_ACTION_PLAN_READY'; plan: PreActionPlan }
  | { type: 'VETO_RESULT'; vetoed: boolean; reason?: string; constraintReminder?: string }
  | { type: 'RETRIEVAL_COMPLETE'; items: WorkingContentItem[] }
  | { type: 'COMPRESSION_COMPLETE'; items: WorkingContentItem[] }
  | { type: 'BUDGET_APPROVED'; result: BudgetCheckResult }
  | { type: 'BUDGET_REJECTED'; result: BudgetCheckResult }
  | { type: 'EXECUTION_COMPLETE'; output: StepOutput }
  | { type: 'OUTPUT_WRITTEN' }
  | { type: 'EVICTION_COMPLETE' }
  | { type: 'ERROR_OCCURRED'; error: Error }
  | { type: 'ESCALATION_REQUIRED'; package: EscalationPackage }

/**
 * Type alias for a created step machine actor.
 */
export type StepActor = ReturnType<typeof createStepActor>

const stepMachineSetup = setup({
  types: {} as {
    context: StepMachineContext
    events: StepMachineEvent
    input: StepMachineInput
  },
  guards: {
    /**
     * Allows retrieval only when the monitor did not veto the step.
     */
    canProceedAfterVeto: ({ context, event }) => {
      if (event.type === 'VETO_RESULT') {
        return event.vetoed === false
      }

      return context.vetoed === false
    },
    /**
     * Allows execution only on an explicit budget approval event.
     */
    budgetApproved: ({ event }) => event.type === 'BUDGET_APPROVED'
  },
  actions: {
    /**
     * Entry action marker for the mandatory anchor-loading state.
     */
    loadAnchors: () => undefined,
    /**
     * Stores loaded permanent anchors and their token cost.
     */
    storeAnchors: assign(({ event }) => {
      if (event.type !== 'ANCHORS_LOADED') {
        return {}
      }

      return {
        anchors: event.anchors,
        anchorTokens: event.anchorTokens
      }
    }),
    /**
     * Stores the pre-action planning result for the current step.
     */
    storePreActionPlan: assign(({ event }) => {
      if (event.type !== 'PRE_ACTION_PLAN_READY') {
        return {}
      }

      return {
        preActionPlan: sanitizePreActionPlan(event.plan)
      }
    }),
    /**
     * Stores monitor veto metadata for the current step.
     */
    storeVetoResult: assign(({ event }) => {
      if (event.type !== 'VETO_RESULT') {
        return {}
      }

      return {
        vetoed: event.vetoed,
        vetoReason: event.reason ?? null,
        constraintReminder: event.constraintReminder ?? null
      }
    }),
    /**
     * Stores retrieved working content in machine context.
     */
    storeRetrievedContent: assign(({ event }) => {
      if (event.type !== 'RETRIEVAL_COMPLETE') {
        return {}
      }

      return {
        workingContent: event.items
      }
    }),
    /**
     * Replaces working content with the compressed item set.
     */
    storeCompressedContent: assign(({ event }) => {
      if (event.type !== 'COMPRESSION_COMPLETE') {
        return {}
      }

      return {
        workingContent: event.items
      }
    }),
    /**
     * Stores the approved or rejected budget decision.
     */
    storeBudgetResult: assign(({ event }) => {
      if (event.type !== 'BUDGET_APPROVED' && event.type !== 'BUDGET_REJECTED') {
        return {}
      }

      return {
        budgetResult: event.result
      }
    }),
    /**
     * Stores the executor output for the current step.
     */
    storeStepOutput: assign(({ event }) => {
      if (event.type !== 'EXECUTION_COMPLETE') {
        return {}
      }

      return {
        stepOutput: event.output
      }
    }),
    /**
     * Clears only working content during eviction.
     *
     * Permanent anchors remain untouched by design.
     */
    clearWorkingContent: assign(() => ({
      workingContent: []
    })),
    /**
     * Stores an unexpected terminal error.
     */
    storeError: assign(({ event }) => {
      if (event.type !== 'ERROR_OCCURRED') {
        return {}
      }

      return {
        error: event.error
      }
    }),
    /**
     * Converts a veto into a terminal machine error.
     */
    storeVetoError: assign(({ context }) => ({
      error: new Error(context.vetoReason ?? 'Monitor vetoed the step.')
    })),
    /**
     * Stores the structured escalation package for terminal escalation.
     */
    storeEscalationPackage: assign(({ event }) => {
      if (event.type !== 'ESCALATION_REQUIRED') {
        return {}
      }

      return {
        escalationPackage: event.package
      }
    })
  }
})

/**
 * Inspectable XState v5 machine definition for a single execution step.
 *
 * The state order enforces the Week 2 invariant that anchors are always loaded
 * before planning, retrieval, compression, budget checking, or execution.
 */
export const stepMachine = stepMachineSetup.createMachine({
  id: 'planone-step-machine',
  initial: 'IDLE',
  context: ({ input }) => ({
    taskId: input.taskId,
    stepIndex: input.stepIndex,
    model: input.model,
    abMode: input.abMode,
    anchors: null,
    anchorTokens: 0,
    preActionPlan: null,
    vetoed: false,
    vetoReason: null,
    constraintReminder: null,
    workingContent: [],
    budgetResult: null,
    stepOutput: null,
    error: null,
    escalationPackage: null
  }),
  states: {
    IDLE: {
      on: {
        STEP_START: {
          target: 'LOAD_ANCHORS',
          actions: assign(({ event }) => {
            if (event.type !== 'STEP_START') {
              return {}
            }

            return {
              taskId: event.taskId,
              stepIndex: event.stepIndex,
              model: event.model,
              abMode: event.abMode,
              anchors: null,
              anchorTokens: 0,
              preActionPlan: null,
              vetoed: false,
              vetoReason: null,
              constraintReminder: null,
              workingContent: [],
              budgetResult: null,
              stepOutput: null,
              error: null,
              escalationPackage: null
            }
          })
        }
      }
    },
    LOAD_ANCHORS: {
      entry: ['loadAnchors'],
      on: {
        ANCHORS_LOADED: {
          target: 'PRE_ACTION_PLAN',
          actions: ['storeAnchors']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    PRE_ACTION_PLAN: {
      on: {
        PRE_ACTION_PLAN_READY: {
          target: 'MONITOR_VETO',
          actions: ['storePreActionPlan']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    MONITOR_VETO: {
      on: {
        VETO_RESULT: [
          {
            target: 'RETRIEVE',
            guard: 'canProceedAfterVeto',
            actions: ['storeVetoResult']
          },
          {
            target: 'ERROR',
            actions: ['storeVetoResult', 'storeVetoError']
          }
        ],
        ESCALATION_REQUIRED: {
          target: 'ESCALATION',
          actions: ['storeEscalationPackage']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    RETRIEVE: {
      on: {
        RETRIEVAL_COMPLETE: {
          target: 'COMPRESS',
          actions: ['storeRetrievedContent']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    COMPRESS: {
      after: {
        0: 'BUDGET_CHECK'
      },
      on: {
        COMPRESSION_COMPLETE: {
          actions: ['storeCompressedContent']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    BUDGET_CHECK: {
      on: {
        BUDGET_APPROVED: {
          target: 'EXECUTE',
          guard: 'budgetApproved',
          actions: ['storeBudgetResult']
        },
        BUDGET_REJECTED: {
          target: 'ESCALATION',
          actions: ['storeBudgetResult']
        },
        ESCALATION_REQUIRED: {
          target: 'ESCALATION',
          actions: ['storeEscalationPackage']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    EXECUTE: {
      on: {
        EXECUTION_COMPLETE: {
          target: 'WRITE_OUTPUT',
          actions: ['storeStepOutput']
        },
        ESCALATION_REQUIRED: {
          target: 'ESCALATION',
          actions: ['storeEscalationPackage']
        },
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    WRITE_OUTPUT: {
      on: {
        OUTPUT_WRITTEN: 'EVICT',
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    EVICT: {
      entry: ['clearWorkingContent'],
      on: {
        EVICTION_COMPLETE: 'STEP_END',
        ERROR_OCCURRED: {
          target: 'ERROR',
          actions: ['storeError']
        }
      }
    },
    STEP_END: {
      type: 'final'
    },
    ERROR: {
      type: 'final'
    },
    ESCALATION: {
      type: 'final'
    }
  }
})

/**
 * Creates a running actor for the step machine.
 *
 * The returned actor is inspectable through XState's standard actor options.
 */
export function createStepActor(input: StepMachineInput) {
  return createActor(stepMachine, { input })
}
