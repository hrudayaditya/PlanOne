import { describe, expect, it } from 'vitest'

import type { IntakeResult } from '../../src/intake/index.js'
import type { CitationVerificationResult } from '../../src/panel/citation-verifier.js'
import type { PanelMemberAnalysis } from '../../src/panel/member.js'
import { synthesizeAnalyses } from '../../src/panel/synthesis.js'

function makeIntake(): IntakeResult {
  return {
    taskId: 'task-1',
    abMode: 'B',
    enhancedTask: {
      original: 'Fix auth bug',
      structured_description: 'Fix auth bug',
      task_type: 'bug_fix',
      affected_area: 'authentication',
      likely_files: [],
      symptom_vs_root_cause: '',
      complexity_hint: 'moderate',
      confidence: 0.8
    },
    classification: {
      complexity: 'COMPLEX',
      confidence: 0.7,
      rationale: 'multi-step',
      estimated_steps: 3,
      risk_flags: []
    },
    rules: {
      version: '1.0',
      repo_name: 'planone',
      never_touch: [],
      always_escalate_if: [],
      max_files_changed: 20,
      mutation_scope: 'changed_only'
    },
    repoContext: {
      repoRoot: '/repo',
      primaryLanguage: 'TypeScript',
      hasTests: true,
      testFramework: 'vitest',
      packageManager: 'npm'
    },
    intakeTimestamp: new Date().toISOString()
  }
}

function makeAnalysis(retrievedChunkIds: string[]): PanelMemberAnalysis {
  return {
    memberId: 'member-1',
    model: 'gemini-3.1-flash-lite-preview',
    taskUnderstanding: 'Fix the auth path.',
    rootCauses: [{ claim: 'Broken login branch', chunkIds: ['chunk-1'], confidence: 0.9, claimType: 'root_cause' }],
    affectedSymbols: ['createTRPCNext'],
    suggestedApproaches: [
      { claim: 'Add forceServerGcTimeInfinity option', chunkIds: ['chunk-2'], confidence: 0.8, claimType: 'suggested_approach' }
    ],
    risks: [],
    constraints: [],
    retrievedChunkIds,
    analysisTimestamp: new Date().toISOString(),
    tokensUsed: 100,
    costUsd: 0
  }
}

function makeVerificationResult(): CitationVerificationResult {
  return {
    verifiedChunkIds: [],
    rejectedChunkIds: ['chunk-1', 'chunk-2'],
    rejectedClaims: [
      { claim: 'Broken login branch', chunkIds: ['chunk-1'], confidence: 0.9, claimType: 'root_cause' },
      { claim: 'Add forceServerGcTimeInfinity option', chunkIds: ['chunk-2'], confidence: 0.8, claimType: 'suggested_approach' }
    ],
    partialClaims: [],
    verifiedClaims: [],
    verificationMethod: 'rejected',
    verificationMethods: {
      'chunk-1': 'rejected',
      'chunk-2': 'rejected'
    }
  }
}

describe('synthesis degraded mode', () => {
  it('uses degraded mode when verified claims are zero but retrieval succeeded', async () => {
    const result = await synthesizeAnalyses(
      [makeAnalysis(['packages/next/src/createTRPCNext.tsx:58-101'])],
      [makeVerificationResult()],
      makeIntake()
    )

    expect(result.citationVerificationDegraded).toBe(true)
    expect(result.consensusConfidence).toBe(0.3)
    expect(result.rankedApproaches).toHaveLength(1)
  })

  it('returns an empty packet when verified claims are zero and retrieval is empty', async () => {
    const result = await synthesizeAnalyses(
      [makeAnalysis([])],
      [makeVerificationResult()],
      makeIntake()
    )

    expect(result.citationVerificationDegraded).toBe(false)
    expect(result.rankedApproaches).toEqual([])
    expect(result.consensusConfidence).toBe(0)
  })

  it('uses the normal path when verified claims exist', async () => {
    const result = await synthesizeAnalyses(
      [makeAnalysis(['packages/next/src/createTRPCNext.tsx:58-101'])],
      [{
        ...makeVerificationResult(),
        verifiedChunkIds: ['chunk-2'],
        rejectedChunkIds: [],
        rejectedClaims: [],
        verifiedClaims: [
          { claim: 'Add forceServerGcTimeInfinity option', chunkIds: ['chunk-2'], confidence: 0.8, claimType: 'suggested_approach' }
        ],
        verificationMethod: 'structural',
        verificationMethods: { 'chunk-2': 'structural' }
      }],
      makeIntake()
    )

    expect(result.citationVerificationDegraded).toBe(false)
    expect(result.rankedApproaches).toHaveLength(1)
  })
})
