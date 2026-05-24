import { access } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { logInfo } from '../utils/logger.js'

/**
 * Preferred coding patterns the executor should follow for a repository.
 */
export const PreferredPatternsSchema = z.object({
  testing: z.string().optional(),
  error_handling: z.string().optional(),
  naming: z.string().optional(),
  imports: z.string().optional()
}).optional()

/**
 * Per-repository rules that constrain what PlanOne may do.
 *
 * These rules are loaded once at intake and then serialized into permanent
 * anchor context for every execution step.
 */
export const PlanOneRulesSchema = z.object({
  version: z.string(),
  repo_name: z.string(),
  never_touch: z.array(z.string()),
  always_escalate_if: z.array(z.string()),
  preferred_patterns: PreferredPatternsSchema,
  forbidden_patterns: z.array(z.string()).optional(),
  escalation_contacts: z.array(z.string()).optional(),
  max_files_changed: z.number().int().positive().optional().default(20),
  test_command: z.string().optional(),
  mutation_scope: z.enum(['changed_only', 'full_repo']).optional().default('changed_only')
})

/**
 * TypeScript type inferred from the repository rules schema.
 */
export type PlanOneRules = z.infer<typeof PlanOneRulesSchema>

/**
 * Loads and validates `PLANONE.rules.yaml` from a repository root.
 *
 * When the file does not exist, this returns a safe default rules object. When
 * the file exists but is invalid, a detailed validation error is thrown listing
 * every failing field.
 */
export async function loadRules(repoRoot: string): Promise<PlanOneRules> {
  const rulesPath = resolve(repoRoot, 'PLANONE.rules.yaml')

  try {
    await access(rulesPath)
  } catch {
    return buildDefaultRules(repoRoot)
  }

  let parsedYaml: unknown

  try {
    const fileContent = await import('node:fs/promises').then(({ readFile }) => readFile(rulesPath, 'utf8'))
    parsedYaml = parseYaml(fileContent)
  } catch (error) {
    throw new Error(`Failed to parse PLANONE.rules.yaml: ${error instanceof Error ? error.message : 'Unknown YAML error'}`)
  }

  const parsedRules = PlanOneRulesSchema.safeParse(parsedYaml)

  if (parsedRules.success) {
    logInfo('intake:rules', '[Rules] Loaded PLANONE.rules.yaml', {
      repoName: parsedRules.data.repo_name,
      testCommand: parsedRules.data.test_command ?? null,
      neverTouchCount: parsedRules.data.never_touch.length
    })
    return parsedRules.data
  }

  const validationMessage = parsedRules.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')

  throw new Error(`Invalid PLANONE.rules.yaml: ${validationMessage}`)
}

/**
 * Serializes validated rules into stable JSON for anchor injection.
 */
export function serializeRules(rules: PlanOneRules): string {
  return JSON.stringify(rules, null, 2)
}

function buildDefaultRules(repoRoot: string): PlanOneRules {
  return PlanOneRulesSchema.parse({
    version: '1.0',
    repo_name: basename(repoRoot),
    never_touch: [],
    always_escalate_if: [],
    max_files_changed: 20,
    mutation_scope: 'changed_only'
  })
}
