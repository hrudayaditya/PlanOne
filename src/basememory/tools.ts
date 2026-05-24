import { z } from 'zod'

import { getDefaultClient, type BaseMemoryClient } from './client.js'

/**
 * Shared cursor type used by paginated BaseMemory responses.
 */
export const CursorSchema = z.string().nullable().optional()

/**
 * Shared search match schema used across retrieval responses.
 */
export const SearchMatchSchema = z.object({
  id: z.string().optional(),
  symbol: z.string().optional(),
  symbol_id: z.string().optional(),
  file_path: z.string().optional(),
  content: z.string().optional(),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).passthrough()

/**
 * Shared search response schema for structured BaseMemory retrieval results.
 */
export const SearchResponseSchema = z.object({
  results: z.array(SearchMatchSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  cursor: CursorSchema,
  expandedContext: z.array(SearchMatchSchema).default([])
}).passthrough()

/**
 * Shared graph node schema preserving resolved/unresolved edge state.
 */
export const GraphNodeSchema = z.object({
  symbol: z.string().optional(),
  symbol_id: z.string().optional(),
  file_path: z.string().optional(),
  signature: z.string().optional(),
  kind: z.string().optional(),
  resolved: z.boolean().optional()
}).passthrough()

/**
 * Shared graph response schema used by callers/callees and related helpers.
 */
export const GraphResponseSchema = z.object({
  results: z.array(GraphNodeSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  cursor: CursorSchema
}).passthrough()

/**
 * Structured symbol metadata schema. `symbol_id` is used as the stable anchor
 * for all other graph operations.
 */
export const SymbolInfoItemSchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  symbol_id: z.string(),
  kind: z.string().optional(),
  signature: z.string().optional(),
  file_path: z.string().optional(),
  file_uri: z.string().optional(),
  relative_path: z.string().optional(),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
  chunk_kind: z.string().optional()
}).passthrough()

/**
 * Structured server response schema for `symbol_info`.
 */
export const SymbolInfoStructuredResponseSchema = z.object({
  symbols: z.array(SymbolInfoItemSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  ambiguous: z.boolean().optional()
}).passthrough()

/**
 * Normalized response schema for `symbol_info`.
 */
export const SymbolInfoResponseSchema = z.object({
  results: z.array(SymbolInfoItemSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  ambiguous: z.boolean().optional(),
  cursor: CursorSchema
}).passthrough()

/**
 * Structured response schema for generic metadata/status tools.
 */
export const GenericStructuredResponseSchema = z.object({}).passthrough()

/**
 * Structured call chain response schema.
 */
export const CallChainResponseSchema = z.object({
  path: z.array(GraphNodeSchema).default([]),
  total: z.number().int().nonnegative().optional()
}).passthrough()

/**
 * Structured call graph snapshot schema for divergence checks.
 */
export const CallGraphSnapshotSchema = z.object({
  symbolId: z.string(),
  callers: z.array(GraphNodeSchema),
  callees: z.array(GraphNodeSchema),
  callGraphHash: z.string().optional()
})

/**
 * Base search tool input schema.
 */
export const SearchToolArgsSchema = z.object({
  query: z.string().min(1),
  taskType: z.enum(['general', 'definition', 'bug', 'test_debug', 'semantic']).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
  graphDepth: z.union([z.literal(1), z.literal(2)]).optional(),
  filters: z.record(z.string(), z.unknown()).optional()
}).passthrough()

/**
 * Similarity lookup input schema.
 */
export const FindSimilarArgsSchema = z.object({
  snippet: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
  filters: z.record(z.string(), z.unknown()).optional()
}).passthrough()

/**
 * Symbol lookup input schema.
 */
export const SymbolLookupArgsSchema = z.object({
  symbol: z.string().min(1),
  filePath: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
  include_tests: z.boolean().optional()
}).passthrough()

/**
 * Index tool input schema.
 */
export const IndexCodebaseArgsSchema = z.object({
  paths: z.array(z.string()).optional(),
  full: z.boolean().optional()
}).passthrough()

/**
 * Log tool input schema.
 */
export const IndexLogsArgsSchema = z.object({
  category: z.string().optional(),
  level: z.string().optional(),
  limit: z.number().int().positive().optional()
}).passthrough()

/**
 * Call graph input schema.
 */
export const CallGraphArgsSchema = z.object({
  symbol: z.string().min(1),
  filePath: z.string().optional(),
  direction: z.enum(['callers', 'callees', 'both']).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
  include_tests: z.boolean().optional()
}).passthrough()

/**
 * Call chain input schema.
 */
export const CallChainArgsSchema = z.object({
  fromSymbol: z.string().min(1),
  toSymbol: z.string().min(1),
  maxDepth: z.number().int().positive().max(15).optional()
}).passthrough()

/**
 * Blast radius result schema built from composed BaseMemory calls.
 */
export const BlastRadiusResultSchema = z.object({
  symbol: z.string(),
  symbolId: z.string(),
  callerCount: z.number().int().nonnegative(),
  calleeCount: z.number().int().nonnegative(),
  callers: z.array(GraphNodeSchema),
  callees: z.array(GraphNodeSchema)
})

/**
 * Neighborhood result schema built from search plus graph expansion.
 */
export const NeighborhoodResultSchema = z.object({
  results: z.array(SearchMatchSchema),
  expandedContext: z.array(SearchMatchSchema)
})

/**
 * Search response type inferred from zod.
 */
export type SearchResponse = z.infer<typeof SearchResponseSchema>

/**
 * Search tool args type inferred from zod.
 */
export type SearchToolArgs = z.infer<typeof SearchToolArgsSchema>

/**
 * Graph response type inferred from zod.
 */
export type GraphResponse = z.infer<typeof GraphResponseSchema>

/**
 * Symbol info response type inferred from zod.
 */
export type SymbolInfoResponse = z.infer<typeof SymbolInfoResponseSchema>

/**
 * Generic structured response type inferred from zod.
 */
export type GenericStructuredResponse = z.infer<typeof GenericStructuredResponseSchema>

/**
 * Find similar args type inferred from zod.
 */
export type FindSimilarArgs = z.infer<typeof FindSimilarArgsSchema>

/**
 * Symbol lookup args type inferred from zod.
 */
export type SymbolLookupArgs = z.infer<typeof SymbolLookupArgsSchema>

/**
 * Index codebase args type inferred from zod.
 */
export type IndexCodebaseArgs = z.infer<typeof IndexCodebaseArgsSchema>

/**
 * Index logs args type inferred from zod.
 */
export type IndexLogsArgs = z.infer<typeof IndexLogsArgsSchema>

/**
 * Call graph args type inferred from zod.
 */
export type CallGraphArgs = z.infer<typeof CallGraphArgsSchema>

/**
 * Call chain args type inferred from zod.
 */
export type CallChainArgs = z.infer<typeof CallChainArgsSchema>

/**
 * Graph node type inferred from zod.
 */
export type GraphNode = z.infer<typeof GraphNodeSchema>

/**
 * Call graph snapshot type inferred from zod.
 */
export type CallGraphSnapshot = z.infer<typeof CallGraphSnapshotSchema>

/**
 * Blast radius result type inferred from zod.
 */
export type BlastRadiusResult = z.infer<typeof BlastRadiusResultSchema>

/**
 * Neighborhood result type inferred from zod.
 */
export type NeighborhoodResult = z.infer<typeof NeighborhoodResultSchema>

async function callStructuredTool<TSchema extends z.ZodTypeAny>(
  name: string,
  args: Record<string, unknown>,
  schema: TSchema,
  client?: BaseMemoryClient
): Promise<z.infer<TSchema>> {
  const resolvedClient = client ?? getDefaultClient()
  const result = await resolvedClient.callTool(name, args)
  return schema.parse(result.structuredContent ?? {})
}

/**
 * Calls `codebase_search` and returns validated structured search results.
 */
export async function codebaseSearch(args: SearchToolArgs, client?: BaseMemoryClient): Promise<SearchResponse> {
  const parsedArgs = SearchToolArgsSchema.parse(args)
  return callStructuredTool('codebase_search', parsedArgs, SearchResponseSchema, client)
}

/**
 * Calls `codebase_peek` and returns validated metadata-only search results.
 */
export async function codebasePeek(args: SearchToolArgs, client?: BaseMemoryClient): Promise<SearchResponse> {
  const parsedArgs = SearchToolArgsSchema.parse(args)
  return callStructuredTool('codebase_peek', parsedArgs, SearchResponseSchema, client)
}

/**
 * Calls `find_similar` and returns validated similarity matches.
 */
export async function findSimilar(args: FindSimilarArgs, client?: BaseMemoryClient): Promise<SearchResponse> {
  const parsedArgs = FindSimilarArgsSchema.parse(args)
  return callStructuredTool('find_similar', parsedArgs, SearchResponseSchema, client)
}

/**
 * Calls `implementation_lookup` and returns validated implementation matches.
 */
export async function implementationLookup(
  args: SymbolLookupArgs,
  client?: BaseMemoryClient
): Promise<SearchResponse> {
  const parsedArgs = SymbolLookupArgsSchema.parse(args)
  return callStructuredTool('implementation_lookup', parsedArgs, SearchResponseSchema, client)
}

/**
 * Calls `index_codebase` and returns the validated structured response.
 */
export async function indexCodebase(
  args: IndexCodebaseArgs = {},
  client?: BaseMemoryClient
): Promise<GenericStructuredResponse> {
  const parsedArgs = IndexCodebaseArgsSchema.parse(args)
  return callStructuredTool('index_codebase', parsedArgs, GenericStructuredResponseSchema, client)
}

/**
 * Calls `index_status` and returns the validated structured response.
 */
export async function indexStatus(client?: BaseMemoryClient): Promise<GenericStructuredResponse> {
  return callStructuredTool('index_status', {}, GenericStructuredResponseSchema, client)
}

/**
 * Calls `index_health_check` and returns the validated structured response.
 */
export async function indexHealthCheck(client?: BaseMemoryClient): Promise<GenericStructuredResponse> {
  return callStructuredTool('index_health_check', {}, GenericStructuredResponseSchema, client)
}

/**
 * Calls `index_coverage` and returns the validated structured response.
 */
export async function indexCoverage(client?: BaseMemoryClient): Promise<GenericStructuredResponse> {
  return callStructuredTool('index_coverage', {}, GenericStructuredResponseSchema, client)
}

/**
 * Calls `index_metrics` and returns the validated structured response.
 */
export async function indexMetrics(client?: BaseMemoryClient): Promise<GenericStructuredResponse> {
  return callStructuredTool('index_metrics', {}, GenericStructuredResponseSchema, client)
}

/**
 * Calls `index_logs` and returns the validated structured response.
 */
export async function indexLogs(
  args: IndexLogsArgs = {},
  client?: BaseMemoryClient
): Promise<GenericStructuredResponse> {
  const parsedArgs = IndexLogsArgsSchema.parse(args)
  return callStructuredTool('index_logs', parsedArgs, GenericStructuredResponseSchema, client)
}

/**
 * Calls `symbol_info` and returns validated structured symbol metadata.
 */
export async function symbolInfo(
  args: SymbolLookupArgs,
  client?: BaseMemoryClient
): Promise<SymbolInfoResponse> {
  const parsedArgs = SymbolLookupArgsSchema.parse(args)
  const resolvedClient = client ?? getDefaultClient()
  const result = await resolvedClient.callTool('symbol_info', parsedArgs)
  const structured = SymbolInfoStructuredResponseSchema.parse(result.structuredContent ?? {})

  return {
    results: structured.symbols.map((symbol) => ({
      ...symbol,
      symbol: symbol.symbol ?? symbol.name
    })),
    total: structured.total,
    ambiguous: structured.ambiguous,
    cursor: null
  }
}

/**
 * Calls `callers` and returns validated caller graph results.
 */
export async function callers(args: SymbolLookupArgs, client?: BaseMemoryClient): Promise<GraphResponse> {
  const parsedArgs = SymbolLookupArgsSchema.parse(args)
  return callStructuredTool('callers', parsedArgs, GraphResponseSchema, client)
}

/**
 * Calls `callees` and returns validated callee graph results while preserving
 * the BaseMemory `resolved` field exactly as returned.
 */
export async function callees(args: SymbolLookupArgs, client?: BaseMemoryClient): Promise<GraphResponse> {
  const parsedArgs = SymbolLookupArgsSchema.parse(args)
  return callStructuredTool('callees', parsedArgs, GraphResponseSchema, client)
}

/**
 * Calls `call_chain` and returns a validated shortest-path response.
 */
export async function callChain(
  args: CallChainArgs,
  client?: BaseMemoryClient
): Promise<z.infer<typeof CallChainResponseSchema>> {
  const parsedArgs = CallChainArgsSchema.parse(args)
  return callStructuredTool('call_chain', parsedArgs, CallChainResponseSchema, client)
}

/**
 * Calls `tests_for` and returns validated related-test search results.
 */
export async function testsFor(args: SymbolLookupArgs, client?: BaseMemoryClient): Promise<SearchResponse> {
  const parsedArgs = SymbolLookupArgsSchema.parse(args)
  return callStructuredTool('tests_for', parsedArgs, SearchResponseSchema, client)
}

/**
 * Calls the legacy `call_graph` tool and returns validated structured output if
 * the server exposes it.
 */
export async function callGraph(
  args: CallGraphArgs,
  client?: BaseMemoryClient
): Promise<GenericStructuredResponse> {
  const parsedArgs = CallGraphArgsSchema.parse(args)
  return callStructuredTool('call_graph', parsedArgs, GenericStructuredResponseSchema, client)
}

/**
 * Builds the conceptual blast radius helper from `symbol_info`, recursive
 * `callers`, and one-level `callees`.
 */
export async function blastRadius(
  symbol: string,
  filePath?: string,
  maxDepth = 3,
  client?: BaseMemoryClient
): Promise<BlastRadiusResult> {
  const symbolInfoResult = await symbolInfo({ symbol, filePath, limit: 1 }, client)
  const primarySymbol = symbolInfoResult.results[0]

  if (primarySymbol === undefined) {
    throw new Error(`Symbol "${symbol}" was not found.`)
  }

  const callerMap = new Map<string, GraphNode>()
  let cursor: string | undefined
  let depth = 0

  do {
    const page = await callers({ symbol, filePath, cursor, limit: 100 }, client)
    for (const caller of page.results) {
      const key = `${caller.symbol_id ?? caller.symbol ?? caller.file_path ?? JSON.stringify(caller)}`
      callerMap.set(key, caller)
    }
    cursor = page.cursor ?? undefined
    depth += 1
  } while (cursor !== undefined && depth < maxDepth)

  const calleePage = await callees({ symbol, filePath, limit: 100 }, client)

  return BlastRadiusResultSchema.parse({
    symbol,
    symbolId: primarySymbol.symbol_id,
    callerCount: callerMap.size,
    calleeCount: calleePage.results.length,
    callers: [...callerMap.values()],
    callees: calleePage.results
  })
}

/**
 * Builds the conceptual neighborhood helper from search plus `graphDepth`.
 */
export async function neighborhood(
  query: string,
  graphDepth: 1 | 2 = 1,
  metadataOnly = false,
  client?: BaseMemoryClient
): Promise<NeighborhoodResult> {
  const response = metadataOnly
    ? await codebasePeek({ query, graphDepth }, client)
    : await codebaseSearch({ query, graphDepth }, client)

  return NeighborhoodResultSchema.parse({
    results: response.results,
    expandedContext: response.expandedContext
  })
}

/**
 * Checks whether a symbol exists according to `symbol_info`.
 */
export async function symbolExists(
  symbol: string,
  filePath?: string,
  client?: BaseMemoryClient
): Promise<boolean> {
  const response = await symbolInfo({ symbol, filePath, limit: 1 }, client)
  return response.total > 0
}

/**
 * Computes a simple divergence score between a stored graph snapshot and the
 * current BaseMemory graph state.
 */
export async function callGraphDivergence(
  symbol: string,
  snapshot: CallGraphSnapshot,
  client?: BaseMemoryClient
): Promise<number> {
  const currentSymbol = await symbolInfo({ symbol, limit: 1 }, client)
  const currentCallers = await callers({ symbol, limit: 100 }, client)
  const currentCallees = await callees({ symbol, limit: 100 }, client)

  const symbolMismatch = currentSymbol.results[0]?.symbol_id === snapshot.symbolId ? 0 : 1

  if (snapshot.callGraphHash !== undefined && snapshot.callers.length === 0 && snapshot.callees.length === 0) {
    const currentHash = hashGraph(currentCallers.results, currentCallees.results)
    const hashMismatch = currentHash === snapshot.callGraphHash ? 0 : 0.5
    return Number(Math.min(1, symbolMismatch + hashMismatch).toFixed(4))
  }

  const callerDelta = normalizedSetDelta(snapshot.callers, currentCallers.results)
  const calleeDelta = normalizedSetDelta(snapshot.callees, currentCallees.results)

  return Number(((symbolMismatch + callerDelta + calleeDelta) / 3).toFixed(4))
}

function normalizedSetDelta(previous: GraphNode[], current: GraphNode[]): number {
  const previousKeys = new Set(previous.map(graphNodeKey))
  const currentKeys = new Set(current.map(graphNodeKey))
  const union = new Set([...previousKeys, ...currentKeys])

  if (union.size === 0) {
    return 0
  }

  let diffCount = 0

  for (const key of union) {
    if (!previousKeys.has(key) || !currentKeys.has(key)) {
      diffCount += 1
    }
  }

  return diffCount / union.size
}

function graphNodeKey(node: GraphNode): string {
  return `${node.symbol_id ?? ''}:${node.symbol ?? ''}:${node.file_path ?? ''}:${node.resolved ?? ''}`
}

function hashGraph(callersSet: GraphNode[], calleesSet: GraphNode[]): string {
  return [...callersSet, ...calleesSet]
    .map(graphNodeKey)
    .sort()
    .join('|')
}
