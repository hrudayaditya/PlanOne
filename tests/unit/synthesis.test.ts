import { describe, expect, it } from 'vitest'

import type { IntakeResult } from '../../src/intake/index.js'
import { synthesizeAnalyses } from '../../src/panel/synthesis.js'
import type { CitationVerificationResult } from '../../src/panel/citation-verifier.js'
import type { PanelMemberAnalysis } from '../../src/panel/member.js'

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
      always_escalate_if: ['changes auth logic'],
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

function makeAnalysis(): PanelMemberAnalysis {
  return {
    memberId: 'member-1',
    model: 'claude-opus-4-5',
    taskUnderstanding: 'Fix the auth path.',
    rootCauses: [{ claim: 'Broken login branch', chunkIds: ['chunk-1'], confidence: 0.9, claimType: 'root_cause' }],
    affectedSymbols: ['LoginService'],
    suggestedApproaches: [
      { claim: 'Patch LoginService branch', chunkIds: ['chunk-2'], confidence: 0.6, claimType: 'suggested_approach' },
      { claim: 'Add guard and fallback', chunkIds: ['chunk-3'], confidence: 0.8, claimType: 'suggested_approach' }
    ],
    risks: [{ claim: 'Regression risk', chunkIds: ['chunk-4'], confidence: 0.5, claimType: 'risk' }],
    constraints: [{ claim: 'Do not touch migrations', chunkIds: ['chunk-5'], confidence: 0.4, claimType: 'constraint' }],
    retrievedChunkIds: ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5'],
    analysisTimestamp: new Date().toISOString(),
    tokensUsed: 200,
    costUsd: 1
  }
}

function makeVerificationResult(): CitationVerificationResult {
  return {
    verifiedChunkIds: ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5'],
    rejectedChunkIds: [],
    rejectedClaims: [],
    partialClaims: [],
    verificationMethod: 'structural',
    verificationMethods: {
      'chunk-1': 'structural',
      'chunk-2': 'structural',
      'chunk-3': 'structural',
      'chunk-4': 'structural',
      'chunk-5': 'structural'
    },
    verifiedClaims: [
      { claim: 'Broken login branch', chunkIds: ['chunk-1'], confidence: 0.9, claimType: 'root_cause' },
      { claim: 'Patch LoginService branch', chunkIds: ['chunk-2'], confidence: 0.6, claimType: 'suggested_approach' },
      { claim: 'Add guard and fallback', chunkIds: ['chunk-3'], confidence: 0.8, claimType: 'suggested_approach' },
      { claim: 'Regression risk', chunkIds: ['chunk-4'], confidence: 0.5, claimType: 'risk' },
      { claim: 'Do not touch migrations', chunkIds: ['chunk-5'], confidence: 0.4, claimType: 'constraint' }
    ]
  }
}

describe('synthesis', () => {
  it('returns an empty packet for empty analyses', async () => {
    const result = await synthesizeAnalyses([], [], makeIntake())

    expect(result.rankedApproaches).toEqual([])
    expect(result.consensusConfidence).toBe(0)
    expect(result.citationVerificationDegraded).toBe(false)
  })

  it('maps a single verified analysis into the enriched packet', async () => {
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], makeIntake())

    expect(result.affectedSymbols).toEqual(['LoginService'])
    expect(result.primaryRootCause).toBe('Broken login branch')
    expect(result.identifiedRisks).toEqual(['Regression risk'])
    expect(result.citationVerificationDegraded).toBe(false)
  })

  it('sorts ranked approaches by confidence descending', async () => {
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], makeIntake())

    expect(result.rankedApproaches.map((approach) => approach.confidence)).toEqual([0.8, 0.6])
  })

  it('assigns rank 1 to the highest confidence approach', async () => {
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], makeIntake())
    expect(result.rankedApproaches[0]?.rank).toBe(1)
    expect(result.rankedApproaches[0]?.approach).toBe('Add guard and fallback')
  })

  it('averages verified claim confidence for consensusConfidence', async () => {
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], makeIntake())
    expect(result.consensusConfidence).toBe(0.64)
  })

  it('preserves rules verbatim from intake', async () => {
    const intake = makeIntake()
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], intake)
    expect(result.rules).toEqual(intake.rules)
  })

  it('returns a JSON-serializable packet', async () => {
    const result = await synthesizeAnalyses([makeAnalysis()], [makeVerificationResult()], makeIntake())
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})
