import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'

import type { BaseMemoryClient } from '../basememory/client.js'
import {
  codebaseSearch,
  symbolInfo,
  type SymbolInfoResponse,
  type SearchResponse
} from '../basememory/tools.js'
import type { IntakeResult } from '../intake/index.js'
import type { ContextChunk } from '../memory/context-db/schema.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { withLlmTranscriptContext } from '../utils/llm-transcript.js'
import { extractJson, parseJsonResponse } from '../intake/llm.js'

/**
 * Static panel member configuration.
 */
export interface PanelMemberConfig {
  memberId: string
  model: string
  role: 'primary' | 'secondary' | 'tertiary' | 'quaternary'
}

/**
 * Input required to run a single panel member.
 */
export interface PanelMemberInput {
  intake: IntakeResult
  config: PanelMemberConfig
  rts: RawTraceStore
  client: BaseMemoryClient
  priorChunks?: ContextChunk[]
  fallbackModel?: string
}

/**
 * A single cited claim emitted by a panel member.
 */
export interface CitedClaim {
  claim: string
  chunkIds: string[]
  confidence: number
  claimType: 'root_cause' | 'affected_area' | 'suggested_approach' | 'risk' | 'constraint' | 'context'
}

/**
 * Final structured output of one panel member.
 */
export interface PanelMemberAnalysis {
  memberId: string
  model: string
  taskUnderstanding: string
  rootCauses: CitedClaim[]
  affectedSymbols: string[]
  suggestedApproaches: CitedClaim[]
  risks: CitedClaim[]
  constraints: CitedClaim[]
  retrievedChunkIds: string[]
  analysisTimestamp: string
  tokensUsed: number
  costUsd: number
}

/**
 * Mockable provider used by a panel member analysis call.
 */
export interface PanelMemberLlmProvider {
  /**
   * Produces structured analysis text plus usage metadata.
   */
  analyze(
    prompt: string,
    model: string
  ): Promise<{ text: string; tokensUsed: number; costUsd: number }>
}

/**
 * Zod-validated shape of the panel member LLM response.
 */
const ChunkIdSchema = z.string().regex(/^.+:\d+-\d+$/)

export const PanelMemberAnalysisLlmResponseSchema = z.object({
  taskUnderstanding: z.string(),
  rootCauses: z.array(z.object({
    claim: z.string(),
    chunkIds: z.array(ChunkIdSchema),
    confidence: z.number().min(0).max(1)
  })),
  suggestedApproaches: z.array(z.object({
    claim: z.string(),
    chunkIds: z.array(ChunkIdSchema),
    confidence: z.number().min(0).max(1)
  })),
  risks: z.array(z.object({
    claim: z.string(),
    chunkIds: z.array(ChunkIdSchema),
    confidence: z.number().min(0).max(1)
  })),
  constraints: z.array(z.object({
    claim: z.string(),
    chunkIds: z.array(ChunkIdSchema),
    confidence: z.number().min(0).max(1)
  }))
})

const NOISE_SYMBOLS = new Set([
  'from',
  'import',
  'export',
  'type',
  'interface',
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'async',
  'await',
  'true',
  'false',
  'null',
  'undefined',
  'new',
  'this',
  'super',
  'extends',
  'implements',
  't',
  'k',
  'v',
  'trouter',
  'tinput',
  'toutput'
])
const LOOKUP_STOPWORDS = new Set([
  'implement',
  'github',
  'the',
  'add',
  'update',
  'feature',
  'issue',
  'server',
  'side',
  'client',
  'behavior',
  'types',
  'index',
  'test',
  'tests',
  'create-wrapper'
])

/**
 * Runs a single panel member over intake data and live BaseMemory retrieval.
 *
 * BaseMemory failures and LLM failures are converted into minimal analyses.
 * This function never throws.
 */
export async function runPanelMember(
  input: PanelMemberInput,
  provider: PanelMemberLlmProvider
): Promise<PanelMemberAnalysis> {
  logInfo('panel:member', '[Panel] Starting panel member', {
    memberId: input.config.memberId,
    model: input.config.model,
    fallbackModel: input.fallbackModel ?? null
  })
  const retrievedChunkIds = new Set<string>()
  const retrievedChunks: Array<{ chunkId: string; content: string; chunkType: string; name: string | null }> = []
  let hadBaseMemoryFailure = false

  const searchResponse = await safeRetrieval(
    input,
    'codebase_search',
    () => codebaseSearch({
      query: input.intake.enhancedTask.structured_description,
      taskType: 'general',
      limit: 5
    }, input.client)
  )

  if (searchResponse !== null) {
    logRetrievalResult(input, 'codebase_search', input.intake.enhancedTask.structured_description, searchResponse)

    for (const result of searchResponse.results) {
      const normalizedChunk = normalizeRetrievedChunk(result)

      if (normalizedChunk !== null) {
        retrievedChunkIds.add(normalizedChunk.chunkId)
        retrievedChunks.push(normalizedChunk)
      }
    }
  } else {
    hadBaseMemoryFailure = true
  }

  const directoryHint = extractDirectoryHint(input.intake)
  const implementationQueries = extractImplementationLookupQueries(input.intake, searchResponse).slice(0, 5)

  for (const symbolQuery of implementationQueries) {
    const lookupResponse = await safeSymbolRetrieval(
      input,
      'symbol_info',
      () => symbolInfo({
        symbol: normalizeLookupSymbol(symbolQuery),
        limit: 3
      }, input.client)
    )

    if (lookupResponse !== null) {
      logSymbolRetrievalResult(input, normalizeLookupSymbol(symbolQuery), lookupResponse)

      for (const result of lookupResponse.results) {
        const normalizedChunk = normalizeSymbolInfoChunk(result)

        if (normalizedChunk !== null) {
          if (directoryHint !== null && !normalizedChunk.chunkId.includes(`/${directoryHint}/`) && !normalizedChunk.chunkId.includes(`${directoryHint}:`)) {
            retrievedChunks.push(normalizedChunk)
          } else {
            retrievedChunks.unshift(normalizedChunk)
          }
          retrievedChunkIds.add(normalizedChunk.chunkId)
        }
      }
    } else {
      hadBaseMemoryFailure = true
    }
  }

  const localSignals = collectLocalRepoSignals(input, implementationQueries, directoryHint)
  const candidateSymbols = extractCandidateSymbols(input.intake, searchResponse)
  const verifiedAffectedSymbols = filterAffectedSymbols(await verifySymbols(candidateSymbols, input))
  const localAffectedSymbols = extractSymbolsFromLocalSignals(localSignals)
  const affectedSymbols = filterAffectedSymbols([...verifiedAffectedSymbols, ...localAffectedSymbols])

  if (localSignals.length > 0) {
    logLocalRepoSignals(input, localSignals)

    for (const signal of localSignals) {
      retrievedChunkIds.add(signal.chunkId)
      retrievedChunks.unshift(signal)
    }
  }

  if (hadBaseMemoryFailure && retrievedChunkIds.size === 0) {
    return buildMinimalAnalysis(input.config, retrievedChunkIds, affectedSymbols)
  }

  const prompt = buildPanelPrompt(input, deduplicateRetrievedChunks(retrievedChunks))

  try {
    const response = await analyzeWithRetryAndFallback(provider, prompt, input)
    const parsed = parsePanelMemberResponse(response.text)

    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'llm_call',
      content_json: JSON.stringify({
        memberId: input.config.memberId,
        model: input.config.model,
        tokensUsed: response.tokensUsed,
        costUsd: response.costUsd
      }),
      tokens_used: response.tokensUsed,
      cost_usd: response.costUsd,
      created_at: new Date().toISOString()
    })
    logInfo('panel:llm', '[Panel:LLM] Response received', {
      memberId: input.config.memberId,
      model: input.config.model,
      tokensUsed: response.tokensUsed,
      costUsd: response.costUsd,
      rootCauses: parsed.rootCauses.length,
      approaches: parsed.suggestedApproaches.length,
      risks: parsed.risks.length
    })

    return {
      memberId: input.config.memberId,
      model: input.config.model,
      taskUnderstanding: parsed.taskUnderstanding,
      rootCauses: parsed.rootCauses.map((claim) => ({ ...claim, claimType: 'root_cause' as const })),
      affectedSymbols,
      suggestedApproaches: parsed.suggestedApproaches.map((claim) => ({ ...claim, claimType: 'suggested_approach' as const })),
      risks: parsed.risks.map((claim) => ({ ...claim, claimType: 'risk' as const })),
      constraints: parsed.constraints.map((claim) => ({ ...claim, claimType: 'constraint' as const })),
      retrievedChunkIds: [...retrievedChunkIds],
      analysisTimestamp: new Date().toISOString(),
      tokensUsed: response.tokensUsed,
      costUsd: response.costUsd
    }
  } catch (error) {
    logError('panel-member', 'Panel member analysis failed; using minimal analysis.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      memberId: input.config.memberId
    })
    logWarn('panel:llm', '[Panel:LLM] FALLBACK — using minimal analysis', {
      memberId: input.config.memberId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        memberId: input.config.memberId,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })

    return buildMinimalAnalysis(input.config, retrievedChunkIds, affectedSymbols)
  }
}

async function safeRetrieval(
  input: PanelMemberInput,
  operation: string,
  retrieval: () => Promise<SearchResponse>
): Promise<SearchResponse | null> {
  try {
    return await retrieval()
  } catch (error) {
    logError('panel-member', 'BaseMemory retrieval failed; continuing with partial context.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      operation,
      memberId: input.config.memberId
    })
    logWarn('panel:retrieval', `[Panel:Retrieval] ${operation} failed`, {
      memberId: input.config.memberId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        memberId: input.config.memberId,
        operation,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    return null
  }
}

async function safeSymbolRetrieval(
  input: PanelMemberInput,
  operation: string,
  retrieval: () => Promise<Pick<SymbolInfoResponse, 'results' | 'total'>>
): Promise<Pick<SymbolInfoResponse, 'results' | 'total'> | null> {
  try {
    return await retrieval()
  } catch (error) {
    logError('panel-member', 'BaseMemory retrieval failed; continuing with partial context.', {
      error: error instanceof Error ? error.message : 'Unknown error',
      operation,
      memberId: input.config.memberId
    })
    logWarn('panel:retrieval', `[Panel:Retrieval] ${operation} failed`, {
      memberId: input.config.memberId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
    input.rts.append({
      task_id: input.intake.taskId,
      ab_mode: input.intake.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        memberId: input.config.memberId,
        operation,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    return null
  }
}

async function verifySymbols(
  candidateSymbols: string[],
  input: PanelMemberInput
): Promise<string[]> {
  const verifiedSymbols: string[] = []

  for (const symbol of candidateSymbols) {
    try {
      const normalizedSymbol = normalizeLookupSymbol(symbol)

      if (normalizedSymbol.length === 0) {
        continue
      }

      const response = await symbolInfo({ symbol: normalizedSymbol, limit: 1 }, input.client)

      if (response.total > 0) {
        verifiedSymbols.push(normalizedSymbol)
      }
    } catch {
      continue
    }
  }

  return verifiedSymbols
}

function extractCandidateSymbols(intake: IntakeResult, searchResponse: SearchResponse | null): string[] {
  const candidates = new Set<string>()
  const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g

  for (const text of [
    intake.enhancedTask.original,
    intake.enhancedTask.structured_description,
    intake.enhancedTask.affected_area
  ]) {
    for (const match of text.match(identifierPattern) ?? []) {
      candidates.add(match)
    }
  }

  for (const result of searchResponse?.results ?? []) {
    if (result.symbol !== undefined) {
      candidates.add(result.symbol)
    }
  }

  return [...candidates]
}

function buildPanelPrompt(
  input: PanelMemberInput,
  chunks: Array<{ chunkId: string; content: string; chunkType: string; name: string | null }>
): string {
  const priorContextSection = input.priorChunks !== undefined && input.priorChunks.length > 0
    ? [
      '## Prior Context From Similar Tasks',
      'The following entries were retrieved from institutional memory.',
      'Use them to inform your analysis but do not treat them as ground truth.',
      'Always verify claims against the live codebase via BaseMemory.',
      input.priorChunks.map((chunk) => JSON.stringify(chunk, null, 2)).join('\n\n')
    ].join('\n')
    : null

  return [
    '## CITATION RULES - READ CAREFULLY',
    'Every claim you make must cite the exact chunk ID from the code context below.',
    'Chunk IDs are shown in this format at the start of each code block:',
    '',
    '  [CHUNK: /path/to/file.tsx:startLine-endLine]',
    '',
    'You MUST use the COMPLETE chunk ID including the path, colon, and line range.',
    'Example of a VALID citation: "/Users/.../component.tsx:58-101"',
    'Example of an INVALID citation: "/Users/.../component.tsx" (missing line range)',
    'Example of an INVALID citation: "component.tsx" (missing full path)',
    'Example of an INVALID citation: "ComponentName" (just a symbol name)',
    '',
    'If you cannot identify a specific chunk ID that supports a claim,',
    'DO NOT make that claim. It is better to make fewer claims with valid',
    'citations than many claims with invalid ones.',
    'Analyze this engineering task and return only valid JSON.',
    'Every claim must cite chunk IDs that support it.',
    'If you cannot cite a chunk ID, do not make the claim.',
    'Schema:',
    JSON.stringify(z.toJSONSchema(PanelMemberAnalysisLlmResponseSchema)),
    'Task:',
    input.intake.enhancedTask.structured_description,
    ...(input.intake.reproductionResult?.traceback === undefined || input.intake.reproductionResult.traceback === null ? [] : [
      '## Bug Reproduction Traceback',
      'The following error was produced when running a minimal reproducer from the issue. Use it to identify the exact function and file responsible for the bug:',
      '',
      input.intake.reproductionResult.traceback
    ]),
    'Rules summary:',
    JSON.stringify({
      never_touch: input.intake.rules.never_touch,
      always_escalate_if: input.intake.rules.always_escalate_if
    }, null, 2),
    ...(priorContextSection === null ? [] : [priorContextSection]),
    'Retrieved code chunks:',
    chunks.map((chunk) => [
      `[CHUNK: ${chunk.chunkId}]`,
      `Type: ${chunk.chunkType}`,
      `Symbol: ${chunk.name ?? 'anonymous'}`,
      '```language',
      chunk.content,
      '```'
    ].join('\n')).join('\n\n')
  ].join('\n')
}

function normalizeRetrievedChunk(result: Record<string, unknown>): {
  chunkId: string
  content: string
  chunkType: string
  name: string | null
} | null {
  const filePath = typeof result.file_path === 'string' ? result.file_path : null
  const startLine = typeof result.start_line === 'number' ? result.start_line : null
  const endLine = typeof result.end_line === 'number' ? result.end_line : null
  const content = typeof result.content === 'string' ? result.content : null

  if (filePath === null || startLine === null || endLine === null || content === null) {
    return null
  }

  return {
    chunkId: `${filePath}:${startLine}-${endLine}`,
    content,
    chunkType: typeof result.chunk_type === 'string' ? result.chunk_type : 'unknown',
    name: typeof result.name === 'string' ? result.name : null
  }
}

function normalizeSymbolInfoChunk(result: SymbolInfoResponse['results'][number]): {
  chunkId: string
  content: string
  chunkType: string
  name: string | null
} | null {
  const filePath = typeof result.file_path === 'string'
    ? result.file_path
    : typeof result.relative_path === 'string'
      ? result.relative_path
      : null
  const startLine = typeof result.start_line === 'number' ? result.start_line : 1
  const endLine = typeof result.end_line === 'number' ? result.end_line : startLine

  if (filePath === null) {
    return null
  }

  const symbolName = typeof result.name === 'string'
    ? result.name
    : typeof result.symbol === 'string'
      ? result.symbol
      : null

  const summary = [
    `Symbol: ${symbolName ?? 'unknown'}`,
    `Kind: ${result.kind ?? 'unknown'}`,
    `Signature: ${result.signature ?? 'unknown'}`,
    `File: ${filePath}`
  ].join('\n')

  return {
    chunkId: `${filePath}:${startLine}-${endLine}`,
    content: summary,
    chunkType: result.chunk_kind ?? result.kind ?? 'symbol',
    name: symbolName
  }
}

export function extractDirectoryHint(intake: IntakeResult): string | null {
  const haystacks = [
    intake.enhancedTask.affected_area,
    intake.enhancedTask.structured_description,
    intake.enhancedTask.original
  ]

  for (const text of haystacks) {
    const scopedPackageMatch = text.match(/@[\w-]+\/([\w-]+)/)
    if (scopedPackageMatch?.[1] !== undefined) {
      const packageName = scopedPackageMatch[1]
      const candidates = [
        `packages/${packageName}/src`,
        `packages/${packageName}`,
        `src/${packageName}`,
        `lib/${packageName}`
      ]
      for (const candidate of candidates) {
        if (pathExists(path.join(intake.repoContext.repoRoot, candidate))) {
          return candidate
        }
      }
    }

    const directoryMatch = text.match(/\b(?:src|lib|packages|apps)\/[\w/-]+/)
    if (directoryMatch?.[0] !== undefined) {
      return directoryMatch[0]
    }
  }

  return null
}

function collectLocalRepoSignals(
  input: PanelMemberInput,
  implementationQueries: string[],
  directoryHint: string | null
): Array<{ chunkId: string; content: string; chunkType: string; name: string | null }> {
  const repoRoot = input.intake.repoContext.repoRoot
  const candidateDirectories = [
    directoryHint,
    '.'
  ].filter((value, index, array): value is string => value !== null && array.indexOf(value) === index)

  const chunkMap = new Map<string, { chunkId: string; content: string; chunkType: string; name: string | null }>()

  for (const directory of candidateDirectories) {
    for (const filePath of listRepoFiles(repoRoot, directory)) {
      const relativePath = relativizeRepoPath(repoRoot, filePath)

      if (!chunkMap.has(relativePath)) {
        chunkMap.set(relativePath, {
          chunkId: `${relativePath}:1-1`,
          content: `Local file candidate from repo scan.\nFile: ${relativePath}`,
          chunkType: 'file_candidate',
          name: path.basename(relativePath, path.extname(relativePath))
        })
      }
    }
  }

  for (const query of implementationQueries.slice(0, 5)) {
    const normalizedQuery = normalizeLookupSymbol(query)

    if (normalizedQuery.length === 0) {
      continue
    }

    for (const directory of candidateDirectories) {
      for (const match of grepRepoForSymbol(repoRoot, directory, normalizedQuery)) {
        const relativePath = relativizeRepoPath(repoRoot, match.filePath)
        chunkMap.set(`${relativePath}:${match.lineNumber}`, {
          chunkId: `${relativePath}:${match.lineNumber}-${match.lineNumber}`,
          content: `Local grep match for "${normalizedQuery}" in ${relativePath}:${match.lineNumber}\n${match.lineText}`,
          chunkType: 'local_grep',
          name: normalizedQuery
        })
      }
    }
  }

  return [...chunkMap.values()].slice(0, 12)
}

function extractSymbolsFromLocalSignals(
  signals: Array<{ chunkId: string; content: string; chunkType: string; name: string | null }>
): string[] {
  const symbols = new Set<string>()
  const symbolPattern = /\b(?:[A-Z][A-Za-z0-9_]*(?:<[A-Za-z0-9_,\s]+>)?|[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g

  for (const signal of signals) {
    if (signal.name !== null) {
      const normalizedName = normalizeLookupSymbol(signal.name)

      if (normalizedName.length > 0) {
        symbols.add(normalizedName)
      }
    }

    for (const match of signal.content.match(symbolPattern) ?? []) {
      const normalizedMatch = normalizeLookupSymbol(match)

      if (normalizedMatch.length > 0) {
        symbols.add(normalizedMatch)
      }
    }
  }

  return [...symbols]
}

function extractImplementationLookupQueries(intake: IntakeResult, searchResponse: SearchResponse | null): string[] {
  const candidates = new Set<string>()
  const symbolPattern = /\b(?:[A-Z][A-Za-z0-9_]*(?:<[A-Za-z0-9_,\s]+>)?|[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g

  for (const likelyFile of intake.enhancedTask.likely_files) {
    const basename = path.basename(likelyFile, path.extname(likelyFile))

    if (basename.length > 0 && !basename.includes('/') && isLikelyLookupSymbol(basename)) {
      candidates.add(basename)
    }
  }

  for (const result of searchResponse?.results ?? []) {
    const name = typeof result.name === 'string' ? result.name : null
    const symbol = typeof result.symbol === 'string' ? result.symbol : null

    if (name !== null && isLikelyLookupSymbol(name)) {
      candidates.add(name)
    }

    if (symbol !== null && isLikelyLookupSymbol(symbol)) {
      candidates.add(symbol)
    }
  }

  for (const text of [
    intake.enhancedTask.structured_description,
    intake.enhancedTask.affected_area,
    intake.enhancedTask.original
  ]) {
    for (const match of text.match(symbolPattern) ?? []) {
      if (isLikelyLookupSymbol(match)) {
        candidates.add(match)
      }
    }
  }

  return [...candidates]
}

function isLikelyLookupSymbol(value: string): boolean {
  const normalized = normalizeLookupSymbol(value)

  if (normalized.length < 4) {
    return false
  }

  if (LOOKUP_STOPWORDS.has(normalized.toLowerCase())) {
    return false
  }

  return /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(normalized)
}

function normalizeLookupSymbol(value: string): string {
  return value
    .replace(/\(\)\s*$/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function listRepoFiles(repoRoot: string, directory: string): string[] {
  try {
    const output = execFileSync('rg', ['--files', directory], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.(ts|tsx|js|jsx)$/.test(line))
      .slice(0, 8)
      .map((line) => path.resolve(repoRoot, line))
  } catch {
    return []
  }
}

function pathExists(candidatePath: string): boolean {
  return existsSync(candidatePath)
}

function grepRepoForSymbol(
  repoRoot: string,
  directory: string,
  symbol: string
): Array<{ filePath: string; lineNumber: number; lineText: string }> {
  try {
    const output = execFileSync('rg', ['-n', '-m', '3', symbol, directory], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 4)
      .flatMap((line) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(line)

        if (match === null) {
          return []
        }

        return [{
          filePath: path.resolve(repoRoot, match[1] ?? ''),
          lineNumber: Number(match[2] ?? '1'),
          lineText: (match[3] ?? '').trim()
        }]
      })
  } catch {
    return []
  }
}

function relativizeRepoPath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(repoRoot, filePath)
  return relativePath.length === 0 ? path.basename(filePath) : relativePath
}

function logLocalRepoSignals(
  input: PanelMemberInput,
  signals: Array<{ chunkId: string; content: string; chunkType: string; name: string | null }>
): void {
  const filePaths = signals
    .map((signal) => signal.chunkId.replace(/:\d+-\d+$/, ''))
    .filter((value, index, array) => array.indexOf(value) === index)
  const symbolNames = signals
    .map((signal) => signal.name)
    .filter((value): value is string => value !== null)

  logInfo('panel:retrieval', '[Panel:Retrieval] local_repo_search', {
    query: input.intake.enhancedTask.structured_description,
    resultsCount: signals.length,
    filePaths,
    symbolNames
  })

  input.rts.append({
    task_id: input.intake.taskId,
    ab_mode: input.intake.abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: 'tool_call',
    content_json: JSON.stringify({
      tool: 'local_repo_search',
      query: input.intake.enhancedTask.structured_description,
      resultsCount: signals.length,
      filePaths,
      symbolNames
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

async function analyzeWithRetryAndFallback(
  provider: PanelMemberLlmProvider,
  prompt: string,
  input: PanelMemberInput
): Promise<{ text: string; tokensUsed: number; costUsd: number }> {
  const retryDelaysMs = [3_000, 6_000]
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      logInfo('panel:llm', '[Panel:LLM] Calling panel model', {
        memberId: input.config.memberId,
        model: input.config.model,
        attempt: `${attempt + 1}/${retryDelaysMs.length + 1}`
      })
      return await withLlmTranscriptContext(
        {
          taskId: input.intake.taskId,
          stage: 'panel:analyze',
          memberId: input.config.memberId
        },
        async () => await provider.analyze(prompt, input.config.model)
      )
    } catch (error) {
      lastError = error

      if (!isRetriableProviderError(error) || attempt === retryDelaysMs.length) {
        break
      }

      logWarn('panel:llm', `[Panel:LLM] RETRY ${attempt + 1}`, {
        memberId: input.config.memberId,
        model: input.config.model,
        error: error instanceof Error ? error.message : String(error),
        waitMs: retryDelaysMs[attempt] ?? 0
      })
      await waitMs(retryDelaysMs[attempt] ?? 0)
    }
  }

  if (
    input.fallbackModel !== undefined &&
    input.fallbackModel !== input.config.model &&
    isRetriableProviderError(lastError)
  ) {
    logWarn('panel:llm', `[Panel] Primary model unavailable, falling back to ${input.fallbackModel}`, {
      memberId: input.config.memberId,
      primaryModel: input.config.model,
      fallbackModel: input.fallbackModel
    })
    return await withLlmTranscriptContext(
      {
        taskId: input.intake.taskId,
        stage: 'panel:analyze:fallback',
        memberId: input.config.memberId
      },
      async () => await provider.analyze(prompt, input.fallbackModel!)
    )
  }

  throw lastError instanceof Error ? lastError : new Error('Panel analysis failed.')
}

function isRetriableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:429|500|502|503)\b/.test(message)
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function deduplicateRetrievedChunks(
  chunks: Array<{ chunkId: string; content: string; chunkType: string; name: string | null }>
): Array<{ chunkId: string; content: string; chunkType: string; name: string | null }> {
  const seen = new Set<string>()

  return chunks.filter((chunk) => {
    if (seen.has(chunk.chunkId)) {
      return false
    }

    seen.add(chunk.chunkId)
    return true
  })
}

function parsePanelMemberResponse(text: string): z.infer<typeof PanelMemberAnalysisLlmResponseSchema> {
  const rawPayload = parseJsonResponse(extractJson(text), z.unknown())
  return PanelMemberAnalysisLlmResponseSchema.parse(stripInvalidCitationChunkIds(rawPayload))
}

function stripInvalidCitationChunkIds(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }

  const payload = value as Record<string, unknown>

  for (const key of ['rootCauses', 'suggestedApproaches', 'risks', 'constraints'] as const) {
    const claims = payload[key]

    if (Array.isArray(claims)) {
      payload[key] = claims.map((claim) => {
        if (typeof claim !== 'object' || claim === null) {
          return claim
        }

        const claimRecord = claim as Record<string, unknown>
        const chunkIds = Array.isArray(claimRecord.chunkIds)
          ? claimRecord.chunkIds.filter((chunkId): chunkId is string => (
            typeof chunkId === 'string' && /^.+:\d+-\d+$/.test(chunkId)
          ))
          : []

        return {
          ...claimRecord,
          chunkIds
        }
      })
    }
  }

  return payload
}

function filterAffectedSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.filter((symbol) => {
    if (symbol.length < 4) {
      return false
    }

    if (NOISE_SYMBOLS.has(symbol.toLowerCase())) {
      return false
    }

    if (/^(?:T|K|V|TRouter|TInput|TOutput)$/.test(symbol)) {
      return false
    }

    return /[A-Z][a-z]/.test(symbol)
  }))]
}

function logRetrievalResult(
  input: PanelMemberInput,
  tool: 'codebase_search',
  query: string,
  response: SearchResponse
): void {
  logInfo('panel:retrieval', `[Panel:Retrieval] ${tool}`, {
    query,
    resultsCount: response.results.length,
    filePaths: response.results
      .map((result) => result.file_path)
      .filter((filePath): filePath is string => typeof filePath === 'string')
      .slice(0, 10),
    symbolNames: response.results
      .map((result) => result.name)
      .filter((name): name is string => typeof name === 'string')
      .slice(0, 10)
  })
  input.rts.append({
    task_id: input.intake.taskId,
    ab_mode: input.intake.abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: 'tool_call',
    content_json: JSON.stringify({
      tool,
      query,
      resultsCount: response.results.length,
      filePaths: response.results
        .map((result) => result.file_path)
        .filter((filePath): filePath is string => typeof filePath === 'string'),
      symbolNames: response.results
        .map((result) => result.name)
        .filter((name): name is string => typeof name === 'string')
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

function logSymbolRetrievalResult(
  input: PanelMemberInput,
  query: string,
  response: Pick<SymbolInfoResponse, 'results' | 'total'>
): void {
  logInfo('panel:retrieval', '[Panel:Retrieval] symbol_info', {
    query,
    resultsCount: response.results.length,
    filePaths: response.results
      .map((result) => result.file_path ?? result.relative_path)
      .filter((filePath): filePath is string => typeof filePath === 'string')
      .slice(0, 10),
    symbolNames: response.results
      .map((result) => result.name ?? result.symbol)
      .filter((name): name is string => typeof name === 'string')
      .slice(0, 10)
  })
  input.rts.append({
    task_id: input.intake.taskId,
    ab_mode: input.intake.abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: 'tool_call',
    content_json: JSON.stringify({
      tool: 'symbol_info',
      query,
      resultsCount: response.results.length,
      filePaths: response.results
        .map((result) => result.file_path ?? result.relative_path)
        .filter((filePath): filePath is string => typeof filePath === 'string'),
      symbolNames: response.results
        .map((result) => result.name ?? result.symbol)
        .filter((name): name is string => typeof name === 'string')
    }),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

function buildMinimalAnalysis(
  config: PanelMemberConfig,
  retrievedChunkIds: Set<string>,
  affectedSymbols: string[]
): PanelMemberAnalysis {
  return {
    memberId: config.memberId,
    model: config.model,
    taskUnderstanding: '',
    rootCauses: [],
    affectedSymbols,
    suggestedApproaches: [],
    risks: [],
    constraints: [],
    retrievedChunkIds: [...retrievedChunkIds],
    analysisTimestamp: new Date().toISOString(),
    tokensUsed: 0,
    costUsd: 0
  }
}
