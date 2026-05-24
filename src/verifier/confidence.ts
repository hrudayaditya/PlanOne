import type { FunctionalGateResult } from './gates/functional.js'
import type { MutationGateResult } from './gates/mutation.js'

/**
 * Calibrated verifier confidence score.
 */
export interface ConfidenceScore {
  raw: number
  calibrated: number
  calibrationMethod: 'platt' | 'identity'
}

/**
 * Computes the Phase 1 verifier confidence score.
 */
export function computeConfidence(
  functionalResult: FunctionalGateResult,
  mutationResult: MutationGateResult
): ConfidenceScore {
  let raw = 0

  if (functionalResult.passed === false) {
    raw = 0
  } else if (mutationResult.verdict === 'FAIL') {
    raw = 0.4
  } else if (mutationResult.verdict === 'LOW_CONFIDENCE_PASS') {
    raw = 0.7
  } else if (mutationResult.verdict === 'NOT_RUN') {
    raw = 0.6
  } else {
    raw = 0.9
  }

  return {
    raw,
    calibrated: raw,
    calibrationMethod: 'identity'
  }
}
