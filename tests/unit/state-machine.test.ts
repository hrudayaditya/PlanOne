import { describe, expect, it } from 'vitest'

import {
  createStepActor,
  type PreActionPlan,
  type StepMachineInput,
  type StepOutput
} from '../../src/pipeline/state-machine.js'
import type {
  BudgetCheckResult,
  PermanentAnchorSet,
  WorkingContentItem
} from '../../src/pipeline/context-budget.js'

function makeInput(): StepMachineInput {
  return {
    taskId: 'task-1',
    stepIndex: 1,
    model: 'gpt-4o',
    abMode: 'B'
  }
}

function makeAnchors(): PermanentAnchorSet {
  return {
    taskDescription: 'Fix bug',
    enrichedPacket: '{}',
    userRepoRules: 'rules',
    currentStepDescription: 'Step 1'
  }
}

function makePlan(): PreActionPlan {
  return {
    intendedAction: 'update handler',
    affectedSymbols: ['handleRequest'],
    estimatedRiskLevel: 'medium',
    reasoning: 'Need to patch the request path.'
  }
}

function makeItems(): WorkingContentItem[] {
  return [
    { chunkId: 'chunk-1', content: 'const a = 1', source: 'basememory', tokens: 20 }
  ]
}

function makeBudgetResult(approved: boolean): BudgetCheckResult {
  return {
    approved,
    permanentTokens: 100,
    workingTokens: 20,
    totalTokens: approved ? 120 : 80_000,
    modelLimit: 128_000,
    capTokens: 76_800,
    utilizationPct: approved ? 0.0938 : 62.5,
    remainingTokens: approved ? 76_680 : -3_200,
    ...(approved ? {} : { rejectionReason: 'Overflow.' })
  }
}

function makeOutput(): StepOutput {
  return {
    stepIndex: 1,
    producedContent: 'patched code',
    affectedFiles: ['src/file.ts'],
    causalDependencies: [0],
    baseMemoryChunksUsed: ['chunk-1']
  }
}

async function flushTimers(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('stepMachine transitions', () => {
  it('starts in IDLE', () => {
    const actor = createStepActor(makeInput())
    actor.start()
    expect(actor.getSnapshot().value).toBe('IDLE')
  })

  it('STEP_START transitions to LOAD_ANCHORS', () => {
    const actor = createStepActor(makeInput())
    actor.start()
    actor.send({ type: 'STEP_START', ...makeInput() })
    expect(actor.getSnapshot().value).toBe('LOAD_ANCHORS')
  })

  it('ANCHORS_LOADED transitions to PRE_ACTION_PLAN', () => {
    const actor = createStepActor(makeInput())
    actor.start()
    actor.send({ type: 'STEP_START', ...makeInput() })
    actor.send({ type: 'ANCHORS_LOADED', anchors: makeAnchors(), anchorTokens: 100 })
    expect(actor.getSnapshot().value).toBe('PRE_ACTION_PLAN')
  })

  it('PRE_ACTION_PLAN_READY transitions to MONITOR_VETO', () => {
    const actor = createReadyForPlanningActor()
    actor.send({ type: 'PRE_ACTION_PLAN_READY', plan: makePlan() })
    expect(actor.getSnapshot().value).toBe('MONITOR_VETO')
  })

  it('sanitizes non-symbol affectedSymbols when storing the pre-action plan', () => {
    const actor = createReadyForPlanningActor()
    actor.send({
      type: 'PRE_ACTION_PLAN_READY',
      plan: {
        ...makePlan(),
        affectedSymbols: ['handleRequest', 'ssr option handling logic', 'with TRPC']
      }
    })

    expect(actor.getSnapshot().context.preActionPlan?.affectedSymbols).toEqual(['handleRequest'])
  })

  it('VETO_RESULT false transitions to RETRIEVE', () => {
    const actor = createReadyForVetoActor()
    actor.send({ type: 'VETO_RESULT', vetoed: false })
    expect(actor.getSnapshot().value).toBe('RETRIEVE')
  })

  it('VETO_RESULT true transitions to ERROR', () => {
    const actor = createReadyForVetoActor()
    actor.send({ type: 'VETO_RESULT', vetoed: true, reason: 'unsafe' })
    expect(actor.getSnapshot().value).toBe('ERROR')
  })

  it('RETRIEVAL_COMPLETE transitions to COMPRESS', () => {
    const actor = createReadyForRetrieveActor()
    actor.send({ type: 'RETRIEVAL_COMPLETE', items: makeItems() })
    expect(actor.getSnapshot().value).toBe('COMPRESS')
  })

  it('COMPRESSION_COMPLETE transitions to BUDGET_CHECK', async () => {
    const actor = createReadyForRetrieveActor()
    actor.send({ type: 'RETRIEVAL_COMPLETE', items: makeItems() })
    actor.send({ type: 'COMPRESSION_COMPLETE', items: makeItems() })
    await flushTimers()
    expect(actor.getSnapshot().value).toBe('BUDGET_CHECK')
  })

  it('BUDGET_APPROVED transitions to EXECUTE', async () => {
    const actor = await createReadyForBudgetCheckActor()
    actor.send({ type: 'BUDGET_APPROVED', result: makeBudgetResult(true) })
    expect(actor.getSnapshot().value).toBe('EXECUTE')
  })

  it('BUDGET_REJECTED transitions to ESCALATION', async () => {
    const actor = await createReadyForBudgetCheckActor()
    actor.send({ type: 'BUDGET_REJECTED', result: makeBudgetResult(false) })
    expect(actor.getSnapshot().value).toBe('ESCALATION')
  })

  it('EXECUTION_COMPLETE transitions to WRITE_OUTPUT', async () => {
    const actor = await createReadyForExecuteActor()
    actor.send({ type: 'EXECUTION_COMPLETE', output: makeOutput() })
    expect(actor.getSnapshot().value).toBe('WRITE_OUTPUT')
  })

  it('OUTPUT_WRITTEN transitions to EVICT', async () => {
    const actor = await createReadyForWriteOutputActor()
    actor.send({ type: 'OUTPUT_WRITTEN' })
    expect(actor.getSnapshot().value).toBe('EVICT')
  })

  it('EVICTION_COMPLETE transitions to STEP_END', async () => {
    const actor = await createReadyForEvictActor()
    actor.send({ type: 'EVICTION_COMPLETE' })
    expect(actor.getSnapshot().value).toBe('STEP_END')
  })
})

describe('stepMachine invariants', () => {
  it('LOAD_ANCHORS fires on every STEP_START without exception', () => {
    const actorOne = createStepActor(makeInput())
    actorOne.start()
    actorOne.send({ type: 'STEP_START', ...makeInput() })

    const actorTwo = createStepActor({ ...makeInput(), taskId: 'task-2', stepIndex: 2 })
    actorTwo.start()
    actorTwo.send({ type: 'STEP_START', taskId: 'task-2', stepIndex: 2, model: 'gpt-4o', abMode: 'B' })

    expect(actorOne.getSnapshot().value).toBe('LOAD_ANCHORS')
    expect(actorTwo.getSnapshot().value).toBe('LOAD_ANCHORS')
  })

  it('clears workingContent after EVICTION_COMPLETE', async () => {
    const actor = await createReadyForEvictActor()
    actor.send({ type: 'EVICTION_COMPLETE' })
    expect(actor.getSnapshot().context.workingContent).toEqual([])
  })

  it('preserves anchors after EVICTION_COMPLETE', async () => {
    const actor = await createReadyForEvictActor()
    const anchorsBefore = actor.getSnapshot().context.anchors
    actor.send({ type: 'EVICTION_COMPLETE' })
    expect(actor.getSnapshot().context.anchors).toEqual(anchorsBefore)
  })

  it('cannot transition from IDLE to any state except LOAD_ANCHORS', () => {
    const actor = createStepActor(makeInput())
    actor.start()
    actor.send({ type: 'ANCHORS_LOADED', anchors: makeAnchors(), anchorTokens: 100 })
    expect(actor.getSnapshot().value).toBe('IDLE')
  })

  it('never reaches EXECUTE from BUDGET_REJECTED', async () => {
    const actor = await createReadyForBudgetCheckActor()
    actor.send({ type: 'BUDGET_REJECTED', result: makeBudgetResult(false) })
    expect(actor.getSnapshot().value).not.toBe('EXECUTE')
    expect(actor.getSnapshot().value).toBe('ESCALATION')
  })
})

describe('stepMachine context updates', () => {
  it('stores anchors after ANCHORS_LOADED', () => {
    const actor = createStepActor(makeInput())
    const anchors = makeAnchors()
    actor.start()
    actor.send({ type: 'STEP_START', ...makeInput() })
    actor.send({ type: 'ANCHORS_LOADED', anchors, anchorTokens: 100 })
    expect(actor.getSnapshot().context.anchors).toEqual(anchors)
  })

  it('stores working content after RETRIEVAL_COMPLETE', () => {
    const actor = createReadyForRetrieveActor()
    const items = makeItems()
    actor.send({ type: 'RETRIEVAL_COMPLETE', items })
    expect(actor.getSnapshot().context.workingContent).toEqual(items)
  })

  it('keeps working content empty after EVICTION_COMPLETE', async () => {
    const actor = await createReadyForEvictActor()
    actor.send({ type: 'EVICTION_COMPLETE' })
    expect(actor.getSnapshot().context.workingContent).toEqual([])
  })

  it('keeps anchors unchanged after EVICTION_COMPLETE', async () => {
    const actor = await createReadyForEvictActor()
    const anchorsBefore = actor.getSnapshot().context.anchors
    actor.send({ type: 'EVICTION_COMPLETE' })
    expect(actor.getSnapshot().context.anchors).toEqual(anchorsBefore)
  })

  it('stores the vetoed flag after VETO_RESULT', () => {
    const actor = createReadyForVetoActor()
    actor.send({ type: 'VETO_RESULT', vetoed: true, reason: 'unsafe' })
    expect(actor.getSnapshot().context.vetoed).toBe(true)
  })
})

function createReadyForPlanningActor() {
  const actor = createStepActor(makeInput())
  actor.start()
  actor.send({ type: 'STEP_START', ...makeInput() })
  actor.send({ type: 'ANCHORS_LOADED', anchors: makeAnchors(), anchorTokens: 100 })
  return actor
}

function createReadyForVetoActor() {
  const actor = createReadyForPlanningActor()
  actor.send({ type: 'PRE_ACTION_PLAN_READY', plan: makePlan() })
  return actor
}

function createReadyForRetrieveActor() {
  const actor = createReadyForVetoActor()
  actor.send({ type: 'VETO_RESULT', vetoed: false })
  return actor
}

function createReadyForCompressActor() {
  const actor = createReadyForRetrieveActor()
  actor.send({ type: 'RETRIEVAL_COMPLETE', items: makeItems() })
  return actor
}

async function createReadyForBudgetCheckActor() {
  const actor = createReadyForCompressActor()
  await flushTimers()
  return actor
}

async function createReadyForExecuteActor() {
  const actor = await createReadyForBudgetCheckActor()
  actor.send({ type: 'BUDGET_APPROVED', result: makeBudgetResult(true) })
  return actor
}

async function createReadyForWriteOutputActor() {
  const actor = await createReadyForExecuteActor()
  actor.send({ type: 'EXECUTION_COMPLETE', output: makeOutput() })
  return actor
}

async function createReadyForEvictActor() {
  const actor = await createReadyForWriteOutputActor()
  actor.send({ type: 'OUTPUT_WRITTEN' })
  return actor
}
