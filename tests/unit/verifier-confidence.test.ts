import { describe, expect, it } from 'vitest'

import { computeConfidence } from '../../src/verifier/confidence.js'

const functionalPass = {
  passed: true,
  passedCount: 1,
  failedCount: 0,
  regressions: [],
  newFailures: [],
  gateNote: ''
}

describe('verifier confidence', () => {
  it('returns 0.0 when functional fails', () => {
    expect(computeConfidence({ ...functionalPass, passed: false }, { passed: false, verdict: 'FAIL', killRate: 0, mutantsTotal: 0, mutantsKilled: 0, tool: 'unknown', gateNote: '' }).calibrated).toBe(0)
  })

  it('returns 0.4 when mutation fails', () => {
    expect(computeConfidence(functionalPass, { passed: false, verdict: 'FAIL', killRate: 0.1, mutantsTotal: 10, mutantsKilled: 1, tool: 'stryker', gateNote: '' }).calibrated).toBe(0.4)
  })

  it('returns 0.7 for low-confidence mutation pass', () => {
    expect(computeConfidence(functionalPass, { passed: true, verdict: 'LOW_CONFIDENCE_PASS', killRate: 0.65, mutantsTotal: 10, mutantsKilled: 6, tool: 'stryker', gateNote: '' }).calibrated).toBe(0.7)
  })

  it('returns 0.6 when mutation is not run', () => {
    expect(computeConfidence(functionalPass, { passed: true, verdict: 'NOT_RUN', killRate: 0, mutantsTotal: 0, mutantsKilled: 0, tool: 'unknown', gateNote: '' }).calibrated).toBe(0.6)
  })

  it('returns 0.9 when all gates pass', () => {
    expect(computeConfidence(functionalPass, { passed: true, verdict: 'PASS', killRate: 0.9, mutantsTotal: 10, mutantsKilled: 9, tool: 'stryker', gateNote: '' }).calibrated).toBe(0.9)
  })

  it('always uses identity calibration in Phase 1', () => {
    expect(computeConfidence(functionalPass, { passed: true, verdict: 'PASS', killRate: 0.9, mutantsTotal: 10, mutantsKilled: 9, tool: 'stryker', gateNote: '' }).calibrationMethod).toBe('identity')
  })
})
