import type { IntakeResult } from '../intake/index.js'
import type { PlanOneRules } from '../intake/rules.js'
import type { CitedClaim, PanelMemberAnalysis } from './member.js'
import type { CitationVerificationResult } from './citation-verifier.js'

/**
 * Ranked approach carried from panel synthesis into the orchestrator.
 */
export interface RankedApproach {
  approach: string
  confidence: number
  rank: number
  supportingChunkIds: string[]
  estimatedRisk: 'low' | 'medium' | 'high'
}

/**
 * Stable contract between the panel and the orchestrator.
 */
export interface EnrichedPacket {
  taskId: string
  originalTask: string
  structuredDescription: string
  taskType: IntakeResult['enhancedTask']['task_type']
  affectedArea: string
  affectedSymbols: string[]
  primaryRootCause: string
  alternativeRootCauses: string[]
  rankedApproaches: RankedApproach[]
  identifiedRisks: string[]
  activeConstraints: string[]
  memberCount: number
  consensusConfidence: number
  verifiedChunkIds: string[]
  citationVerificationDegraded: boolean
  implementationContext?: Record<string, string>
  rules: PlanOneRules
  synthesizedAt: string
}

/**
 * Synthesizes verified panel analyses into a single enriched packet.
 *
 * Phase 1 is single-member oriented but keeps the multi-member contract stable.
 */
export async function synthesizeAnalyses(
  analyses: PanelMemberAnalysis[],
  verificationResults: CitationVerificationResult[],
  intake: IntakeResult
): Promise<EnrichedPacket> {
  const allVerifiedClaims = verificationResults.flatMap((result) => result.verifiedClaims)
  const allRetrievedChunkIds = [...new Set(analyses.flatMap((analysis) => analysis.retrievedChunkIds))]

  if (analyses.length === 0) {
    return buildEmptyPacket(intake, analyses.length)
  }

  if (allVerifiedClaims.length === 0) {
    if (allRetrievedChunkIds.length === 0) {
      return buildEmptyPacket(intake, analyses.length)
    }

    return synthesizeFromClaims(
      analyses,
      [
        ...analyses.flatMap((analysis) => analysis.rootCauses),
        ...analyses.flatMap((analysis) => analysis.suggestedApproaches),
        ...analyses.flatMap((analysis) => analysis.risks),
        ...analyses.flatMap((analysis) => analysis.constraints)
      ],
      [],
      intake,
      true,
      0.3
    )
  }

  return synthesizeFromClaims(
    analyses,
    allVerifiedClaims,
    [...new Set(verificationResults.flatMap((result) => result.verifiedChunkIds))],
    intake,
    false
  )
}

function synthesizeFromClaims(
  analyses: PanelMemberAnalysis[],
  claims: CitedClaim[],
  verifiedChunkIds: string[],
  intake: IntakeResult,
  citationVerificationDegraded: boolean,
  consensusConfidenceOverride?: number
): EnrichedPacket {
  const affectedSymbols = [...new Set(analyses.flatMap((analysis) => analysis.affectedSymbols))]
  const rootCauseClaims = claims.filter((claim) => claim.claimType === 'root_cause').sort(byConfidenceDesc)
  const approachClaims = claims.filter((claim) => claim.claimType === 'suggested_approach').sort(byConfidenceDesc)
  const riskClaims = claims.filter((claim) => claim.claimType === 'risk')
  const constraintClaims = claims.filter((claim) => claim.claimType === 'constraint')
  const primaryRootCause = rootCauseClaims[0]?.claim ?? approachClaims[0]?.claim ?? ''
  const alternativeRootCauses = rootCauseClaims.slice(1).map((claim) => claim.claim)
  const identifiedRisks = [...new Set(riskClaims.map((claim) => claim.claim))]
  const activeConstraints = [
    ...new Set([
      ...constraintClaims.map((claim) => claim.claim),
      ...intake.rules.always_escalate_if
    ])
  ]
  const rankedApproaches = approachClaims.map((claim, index) => ({
    approach: claim.claim,
    confidence: claim.confidence,
    rank: index + 1,
    supportingChunkIds: claim.chunkIds,
    estimatedRisk: inferApproachRisk(identifiedRisks, intake.classification.complexity)
  }))
  const consensusConfidence = consensusConfidenceOverride ?? Number((
    claims.reduce((sum, claim) => sum + claim.confidence, 0) / claims.length
  ).toFixed(4))

  return {
    taskId: intake.taskId,
    originalTask: intake.enhancedTask.original,
    structuredDescription: intake.enhancedTask.structured_description,
    taskType: intake.enhancedTask.task_type,
    affectedArea: intake.enhancedTask.affected_area,
    affectedSymbols,
    primaryRootCause,
    alternativeRootCauses,
    rankedApproaches,
    identifiedRisks,
    activeConstraints,
    memberCount: analyses.length,
    consensusConfidence,
    verifiedChunkIds,
    citationVerificationDegraded,
    implementationContext: {},
    rules: intake.rules,
    synthesizedAt: new Date().toISOString()
  }
}

function buildEmptyPacket(intake: IntakeResult, memberCount: number): EnrichedPacket {
  return {
    taskId: intake.taskId,
    originalTask: intake.enhancedTask.original,
    structuredDescription: intake.enhancedTask.structured_description,
    taskType: intake.enhancedTask.task_type,
    affectedArea: intake.enhancedTask.affected_area,
    affectedSymbols: [],
    primaryRootCause: '',
    alternativeRootCauses: [],
    rankedApproaches: [],
    identifiedRisks: [],
    activeConstraints: [],
    memberCount,
    consensusConfidence: 0,
    verifiedChunkIds: [],
    citationVerificationDegraded: false,
    implementationContext: {},
    rules: intake.rules,
    synthesizedAt: new Date().toISOString()
  }
}

function byConfidenceDesc(left: CitedClaim, right: CitedClaim): number {
  return right.confidence - left.confidence
}

function inferApproachRisk(
  identifiedRisks: string[],
  complexity: IntakeResult['classification']['complexity']
): 'low' | 'medium' | 'high' {
  if (identifiedRisks.length > 0) {
    return 'high'
  }

  return complexity === 'COMPLEX' ? 'medium' : 'low'
}
