import type { BaseMemoryClient } from '../basememory/client.js'
import { resolve } from 'node:path'
import type { IntakeResult } from '../intake/index.js'
import { DEFAULT_INTAKE_MODEL } from '../llm/models.js'
import type { ContextDB } from '../memory/context-db/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { DEFAULT_PANEL_MODEL } from '../llm/models.js'
import { logInfo, logWarn } from '../utils/logger.js'
import { verifyCitations, type CitationVerificationResult } from './citation-verifier.js'
import { runDeterministicLocalization, type LocalizationResult } from './deterministic-localizer.js'
import {
  runPanelMember,
  type PanelMemberAnalysis,
  type PanelMemberConfig,
  type PanelMemberInput,
  type PanelMemberLlmProvider
} from './member.js'
import { synthesizeAnalyses, type EnrichedPacket } from './synthesis.js'

/**
 * Input payload for the Week 4 panel runner.
 */
export interface PanelInput {
  intake: IntakeResult
  rts: RawTraceStore
  client: BaseMemoryClient
  contextDb: ContextDB
  fallbackModel?: string
  localizationFallbackProvider?: PanelMemberLlmProvider
}

/**
 * Serializable output of the Week 4 panel.
 */
export interface PanelOutput {
  enrichedPacket: EnrichedPacket
  memberAnalyses: PanelMemberAnalysis[]
  citationResults: CitationVerificationResult[]
  panelDurationMs: number
}

/**
 * Runs the Phase 1 panel sequentially.
 *
 * This function never throws. Provider and BaseMemory failures degrade to empty
 * analyses and an empty enriched packet.
 */
export async function runPanel(
  input: PanelInput,
  memberConfigs: PanelMemberConfig[],
  memberProvider: PanelMemberLlmProvider
): Promise<PanelOutput> {
  const startedAt = Date.now()
  logInfo('panel', '[Panel] Starting panel run', {
    taskId: input.intake.taskId
  })
  const effectiveConfigs = memberConfigs.length > 0
    ? memberConfigs
    : [{ memberId: 'member-1', model: resolveDefaultPanelModel(memberProvider), role: 'primary' as const }]

  input.rts.append({
    task_id: input.intake.taskId,
    ab_mode: input.intake.abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: 'task_start',
    content_json: JSON.stringify({ memberCount: effectiveConfigs.length }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })

  try {
    const memberAnalyses: PanelMemberAnalysis[] = []
    const citationResults: CitationVerificationResult[] = []
    const localization = await safeDeterministicLocalization(input, memberProvider)
    const priorContextResult = await (async () => {
      try {
        return await input.contextDb.query({
          queryText: input.intake.enhancedTask.structured_description,
          currentRepo: input.intake.rules.repo_name,
          symbols: [],
          chunkTypes: ['task', 'approach'],
          abMode: input.intake.abMode,
          limit: 5
        })
      } catch {
        return null
      }
    })()

    const priorChunks = priorContextResult?.chunks
      .filter((scoredChunk) => (
        scoredChunk.gate_result.verdict === 'ACTIVE' ||
        scoredChunk.gate_result.verdict === 'DOWNRANK'
      ))
      .map((scoredChunk) => scoredChunk.chunk) ?? []

    for (const config of effectiveConfigs) {
      const analysis = await runPanelMember({
      intake: input.intake,
      config,
      rts: input.rts,
      client: input.client,
      priorChunks,
        fallbackModel: input.fallbackModel ?? DEFAULT_INTAKE_MODEL
      }, memberProvider)
      memberAnalyses.push(analysis)
      citationResults.push(await verifyCitations(analysis, input.client))
    }

    const enrichedPacket = applyDeterministicLocalization(
      await synthesizeAnalyses(memberAnalyses, citationResults, input.intake),
      localization,
      input.intake.repoContext.repoRoot
    )
    const panelOutput: PanelOutput = {
      enrichedPacket,
      memberAnalyses,
      citationResults,
      panelDurationMs: Date.now() - startedAt
    }

    if (panelOutput.enrichedPacket.citationVerificationDegraded) {
      logWarn('panel:synthesis', '[Panel:Synthesis] citationVerificationDegraded=true', {
        consensusConfidence: panelOutput.enrichedPacket.consensusConfidence,
        rankedApproaches: panelOutput.enrichedPacket.rankedApproaches.length,
        affectedSymbols: panelOutput.enrichedPacket.affectedSymbols
      })
      input.rts.append({
        task_id: input.intake.taskId,
        ab_mode: input.intake.abMode,
        agent_role: 'panel',
        step_index: null,
        event_type: 'error',
        content_json: JSON.stringify({
          message: 'Citation verification produced zero verified claims despite successful retrieval. Using unverified claims with degraded confidence.'
        }),
        tokens_used: null,
        cost_usd: null,
        created_at: new Date().toISOString()
      })
    }
    logInfo('panel:synthesis', '[Panel:Synthesis] Panel synthesis complete', {
      rankedApproaches: panelOutput.enrichedPacket.rankedApproaches.length,
      affectedSymbols: panelOutput.enrichedPacket.affectedSymbols,
      panelDurationMs: panelOutput.panelDurationMs
    })

    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'step_output',
      content_json: JSON.stringify(panelOutput),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    return panelOutput
  } catch {
    const enrichedPacket = await synthesizeAnalyses([], [], input.intake)
    return {
      enrichedPacket,
      memberAnalyses: [],
      citationResults: [],
      panelDurationMs: Date.now() - startedAt
    }
  }
}

async function safeDeterministicLocalization(
  input: PanelInput,
  memberProvider: PanelMemberLlmProvider
): Promise<LocalizationResult | null> {
  try {
    const localization = await runDeterministicLocalization({
      intake: input.intake,
      provider: memberProvider,
      fallbackProvider: input.localizationFallbackProvider,
      rts: input.rts
    })

    if (localization.localizationMethod === 'deterministic' && localization.files.length > 0 && localization.symbols.length > 0) {
      logInfo('panel:localizer', '[Panel:Localizer] Deterministic localization succeeded', {
        files: localization.files.map((file) => file.path),
        symbols: localization.symbols.map((symbol) => `${symbol.file}:${symbol.name}`)
      })
      return localization
    }

    logWarn('panel:localizer', '[Panel:Localizer] Falling back to panel synthesis localization', {
      method: localization.localizationMethod,
      fileCount: localization.files.length,
      symbolCount: localization.symbols.length
    })
    return null
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    logWarn('panel:localizer', '[Panel:Localizer] Deterministic localization failed; falling back', {
      error: errorMessage
    })
    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Deterministic localization threw an exception. Falling back to degraded panel.',
        error: errorMessage,
        stack: errorStack
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    return null
  }
}

function applyDeterministicLocalization(
  enrichedPacket: EnrichedPacket,
  localization: LocalizationResult | null,
  repoRoot: string
): EnrichedPacket {
  if (localization === null || localization.localizationMethod !== 'deterministic' || localization.files.length === 0 || localization.symbols.length === 0) {
    return enrichedPacket
  }

  const verifiedChunkIds = [...new Set(localization.symbols.map((symbol) => (
    `${resolve(repoRoot, symbol.file)}:${symbol.lineNumber}-${symbol.lineNumber}`
  )))]

  return {
    ...enrichedPacket,
    affectedSymbols: [...new Set(localization.symbols.map((symbol) => symbol.name))],
    verifiedChunkIds,
    citationVerificationDegraded: false,
    implementationContext: Object.fromEntries(localization.implementationContext.entries())
  }
}

function resolveDefaultPanelModel(provider: PanelMemberLlmProvider): string {
  const maybeProvider = provider as PanelMemberLlmProvider & { getDefaultModel?: () => string }
  const providerModel = maybeProvider.getDefaultModel?.()

  if (typeof providerModel === 'string' && providerModel.trim().length > 0) {
    return providerModel
  }

  return DEFAULT_PANEL_MODEL
}
