import { z } from 'zod'

/**
 * Supported ContextDB chunk discriminants.
 */
export const ChunkTypeSchema = z.enum([
  'task',
  'symbol',
  'approach',
  'pattern',
  'error',
  'test',
  'dependency',
  'convention'
])

/**
 * Snapshot of the BaseMemory state that existed when a ContextDB entry was
 * created.
 */
export const BaseMemorySnapshotSchema = z.object({
  chunk_ids: z.array(z.string()),
  symbol_ids: z.array(z.string()),
  call_graph_hash: z.string()
})

/**
 * Human-readable conditions that invalidate a ContextDB entry.
 */
export const InvalidationConditionSchema = z.object({
  type: z.enum([
    'symbol_deleted',
    'symbol_moved',
    'call_graph_changed',
    'file_deleted',
    'approach_failed',
    'contradiction_detected',
    'age_exceeded'
  ]),
  symbol: z.string().optional(),
  file: z.string().optional(),
  max_age_days: z.number().int().positive().optional(),
  description: z.string()
})

/**
 * Base schema shared by all ContextDB chunk types.
 */
export const ContextChunkBaseSchema = z.object({
  chunk_id: z.uuid(),
  chunk_type: ChunkTypeSchema,
  task_id_origin: z.string(),
  repo: z.string(),
  created_at: z.string().datetime({ offset: true }),
  last_validated_at: z.string().datetime({ offset: true }),
  memory_quality_score: z.number().min(0).max(1),
  symbols: z.array(z.string()),
  base_memory_snapshot: BaseMemorySnapshotSchema,
  invalid_if: z.array(InvalidationConditionSchema).min(1)
})

const StructuralSymbolsSchema = z.array(z.string()).min(1)

/**
 * Task memory chunk schema.
 */
export const TaskChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('task'),
  task_description: z.string(),
  outcome: z.enum(['success', 'failure', 'partial']),
  approach_used: z.string(),
  steps_taken: z.number().int().nonnegative(),
  verifier_verdict: z.string(),
  cycles_used: z.number().int().nonnegative(),
  tokens_total: z.number().nonnegative(),
  cost_usd: z.number().nonnegative()
})

/**
 * Symbol memory chunk schema.
 */
export const SymbolChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('symbol'),
  symbols: StructuralSymbolsSchema,
  symbol_name: z.string(),
  symbol_id: z.string(),
  file_path: z.string(),
  kind: z.string(),
  approach_notes: z.string(),
  test_coverage: z.array(z.string())
})

/**
 * Approach memory chunk schema.
 */
export const ApproachChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('approach'),
  symbols: StructuralSymbolsSchema,
  approach_description: z.string(),
  worked_for: z.array(z.string()),
  failed_for: z.array(z.string()),
  prerequisites: z.array(z.string()),
  contraindications: z.array(z.string())
})

/**
 * Pattern memory chunk schema.
 */
export const PatternChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('pattern'),
  symbols: StructuralSymbolsSchema,
  pattern_name: z.string(),
  pattern_description: z.string(),
  example_task_id: z.string(),
  code_template: z.string(),
  applicable_when: z.array(z.string())
})

/**
 * Error memory chunk schema.
 */
export const ErrorChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('error'),
  symbols: StructuralSymbolsSchema,
  error_signature: z.string(),
  root_cause: z.string(),
  fix_applied: z.string(),
  recurrence_count: z.number().int().nonnegative(),
  related_symbols: z.array(z.string())
})

/**
 * Test memory chunk schema.
 */
export const TestChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('test'),
  test_name: z.string(),
  test_file: z.string(),
  covers_symbols: z.array(z.string()),
  last_passed_at: z.string().datetime({ offset: true }),
  flaky: z.boolean(),
  flakiness_notes: z.string()
})

/**
 * Dependency memory chunk schema.
 */
export const DependencyChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('dependency'),
  dependency_name: z.string(),
  version: z.string(),
  usage_notes: z.string(),
  known_issues: z.array(z.string()),
  upgrade_notes: z.string()
})

/**
 * Convention memory chunk schema.
 */
export const ConventionChunkSchema = ContextChunkBaseSchema.extend({
  chunk_type: z.literal('convention'),
  convention_description: z.string(),
  applies_to: z.array(z.string()),
  enforcement: z.enum(['strict', 'preferred', 'advisory']),
  examples: z.array(z.string())
})

/**
 * Discriminated union covering all ContextDB chunk variants.
 */
export const ContextChunkSchema = z.discriminatedUnion('chunk_type', [
  TaskChunkSchema,
  SymbolChunkSchema,
  ApproachChunkSchema,
  PatternChunkSchema,
  ErrorChunkSchema,
  TestChunkSchema,
  DependencyChunkSchema,
  ConventionChunkSchema
])

/**
 * Helper list of structural chunk types that require non-empty symbols.
 */
export const STRUCTURAL_CHUNK_TYPES = ['symbol', 'approach', 'pattern', 'error'] as const

/**
 * ContextDB chunk type inferred from zod.
 */
export type ChunkType = z.infer<typeof ChunkTypeSchema>

/**
 * BaseMemory snapshot type inferred from zod.
 */
export type BaseMemorySnapshot = z.infer<typeof BaseMemorySnapshotSchema>

/**
 * Invalidation condition type inferred from zod.
 */
export type InvalidationCondition = z.infer<typeof InvalidationConditionSchema>

/**
 * Context chunk base type inferred from zod.
 */
export type ContextChunkBase = z.infer<typeof ContextChunkBaseSchema>

/**
 * Task chunk type inferred from zod.
 */
export type TaskChunk = z.infer<typeof TaskChunkSchema>

/**
 * Symbol chunk type inferred from zod.
 */
export type SymbolChunk = z.infer<typeof SymbolChunkSchema>

/**
 * Approach chunk type inferred from zod.
 */
export type ApproachChunk = z.infer<typeof ApproachChunkSchema>

/**
 * Pattern chunk type inferred from zod.
 */
export type PatternChunk = z.infer<typeof PatternChunkSchema>

/**
 * Error chunk type inferred from zod.
 */
export type ErrorChunk = z.infer<typeof ErrorChunkSchema>

/**
 * Test chunk type inferred from zod.
 */
export type TestChunk = z.infer<typeof TestChunkSchema>

/**
 * Dependency chunk type inferred from zod.
 */
export type DependencyChunk = z.infer<typeof DependencyChunkSchema>

/**
 * Convention chunk type inferred from zod.
 */
export type ConventionChunk = z.infer<typeof ConventionChunkSchema>

/**
 * Union type for all ContextDB chunk variants.
 */
export type ContextChunk = z.infer<typeof ContextChunkSchema>
