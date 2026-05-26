import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import process from 'node:process'

import { generateAbReport } from './ab-test/reporter.js'
import { createClient } from './basememory/client.js'
import { indexHealthCheck, indexStatus } from './basememory/tools.js'
import { RawTraceStore } from './memory/raw-trace-store/index.js'
import { runPipeline } from './pipeline/index.js'
import { runSWEBenchDataset, runSWEBenchTask } from '../benchmarks/swe-bench/runner.js'
import type { SWEBenchTask } from '../benchmarks/swe-bench/harness.js'
import {
  DEFAULT_COMPRESSION_MODEL,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_INTAKE_MODEL,
  DEFAULT_PANEL_MODEL,
  DEFAULT_VERIFIER_MODEL
} from './llm/models.js'
import type { ProviderConfig } from './llm/router.js'
import { loadEnvFiles } from './utils/env.js'
import { logError } from './utils/logger.js'

/**
 * Parses long-form CLI flags into a serializable record.
 *
 * Supported forms are `--flag value` and bare `--flag`.
 */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]

    if (!current.startsWith('--')) {
      continue
    }

    const key = current.slice(2)
    const next = argv[index + 1]

    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next
      index += 1
      continue
    }

    parsed[key] = true
  }

  return parsed
}

/**
 * Main Week 6 CLI entrypoint.
 */
async function main(): Promise<void> {
  loadEnvFiles()
  const [, , command = 'run', ...rest] = process.argv
  const args = parseArgs(rest)

  if (command === 'run') {
    await handleRun(args)
    return
  }

  if (command === 'status') {
    await handleStatus(args)
    return
  }

  if (command === 'ab-report') {
    handleAbReport()
    return
  }

  if (command === 'eval') {
    await handleEval(args)
    return
  }

  printUnknownCommandUsage()
  process.exit(1)
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  logError('cli', '[CLI] Unhandled rejection', { error: message })

  try {
    const rts = new RawTraceStore()
    rts.append({
      task_id: 'cli:unhandled-rejection',
      ab_mode: 'A',
      agent_role: 'escalation',
      step_index: null,
      event_type: 'error',
      content_json: JSON.stringify({
        message: 'Unhandled rejection at CLI boundary.',
        error: message
      }),
      tokens_used: null,
      cost_usd: null,
      created_at: new Date().toISOString()
    })
    rts.close()
  } catch {
    // Last-resort handler must never throw.
  }

  process.exit(1)
})

async function handleRun(args: Record<string, string | boolean>): Promise<void> {
  const task = typeof args.task === 'string' ? args.task : null
  const repo = typeof args.repo === 'string' ? args.repo : null
  const configPath = typeof args.config === 'string' ? args.config : undefined
  const sequence = typeof args.seq === 'string' ? Number(args.seq) : 1

  if (task === null || repo === null || !isAbsolute(repo) || Number.isNaN(sequence)) {
    printRunUsage()
    process.exit(1)
  }

  const result = await runPipeline({
    taskId: randomUUID(),
    rawTask: task,
    config: {
      repoRoot: repo,
      configPath,
      continuousLoop: process.env.CONTINUOUS_LOOP === 'true',
      providerConfig: {
        anthropicApiKey: typeof args['anthropic-key'] === 'string' ? args['anthropic-key'] : process.env.ANTHROPIC_API_KEY,
        geminiApiKey: typeof args['gemini-key'] === 'string' ? args['gemini-key'] : process.env.GEMINI_API_KEY,
        groqApiKey: process.env.GROQ_API_KEY,
        nvidiaApiKey: typeof args['nvidia-key'] === 'string' ? args['nvidia-key'] : process.env.NVIDIA_API_KEY,
        openrouterApiKey: typeof args['openrouter-key'] === 'string' ? args['openrouter-key'] : process.env.OPENROUTER_API_KEY,
        openrouterPath: typeof args['openrouter-path'] === 'string' && args['openrouter-path'] === 'paid' ? 'paid' : 'free',
        executorModel: DEFAULT_EXECUTOR_MODEL,
        verifierModel: DEFAULT_VERIFIER_MODEL,
        intakeModel: DEFAULT_INTAKE_MODEL,
        panelModel: DEFAULT_PANEL_MODEL,
        compressionModel: DEFAULT_COMPRESSION_MODEL
      }
    },
    taskSequenceNumber: sequence
  })

  if (result.outcome === 'success' && result.verifierResult !== null && result.executorResult !== null) {
    console.log('✓ Task completed successfully')
    console.log('  Verifier verdict:', result.verifierResult.verdict)
    console.log('  Confidence:', result.verifierResult.confidence.calibrated)
    console.log('  Cycles used:', result.executorResult.completedCycles.length)
    console.log('  Tokens used:', result.totalTokensUsed)
    console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`)
    process.exit(0)
  }

  if (result.outcome === 'escalated') {
    console.error('⚠ Task escalated — human review required')
    console.error('  Check .planone/trace.db for escalation details')
    process.exit(2)
  }

  if (result.outcome === 'all_cycles_exhausted') {
    console.error('✗ All retry cycles exhausted without success')
    console.error('  Check .planone/trace.db for details')
    process.exit(1)
  }

  console.error('✗ Pipeline error:', result.errorMessage)
  process.exit(1)
}

async function handleStatus(args: Record<string, string | boolean>): Promise<void> {
  const repo = typeof args.repo === 'string' ? args.repo : null

  if (repo === null || !isAbsolute(repo)) {
    console.error('Usage: planone status --repo /path/to/repo')
    process.exit(1)
  }

  let client: Awaited<ReturnType<typeof createClient>> | null = null

  try {
    client = await createClient({ projectRoot: repo })
    const health = await indexHealthCheck(client)
    const status = await indexStatus(client)
    console.log('BaseMemory status:', status)
    console.log('Index health:', health)

    const rts = new RawTraceStore()

    try {
      console.log('Recent tasks:', rts.queryByType('task_start').length)
    } finally {
      rts.close()
    }

    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  } finally {
    if (client !== null) {
      try {
        await client.disconnect()
      } catch {
        // Status command ignores disconnect failures.
      }
    }
  }
}

function handleAbReport(): void {
  const rts = new RawTraceStore()

  try {
    const report = generateAbReport(rts)
    console.log('=== PlanOne A/B Report ===')
    console.log('Generated:', report.generatedAt)
    console.log('Total tasks:', report.totalTasks)
    console.log(`Total cost: $${report.totalCost.toFixed(4)}`)
    console.log('')

    for (const mode of report.modes) {
      console.log(`Mode ${mode.mode}:`)
      console.log('  Tasks:', mode.taskCount)
      console.log(`  Success rate: ${(mode.successRate * 100).toFixed(1)}%`)
      console.log('  Escalations:', mode.escalationCount)
      console.log(`  Avg cost: $${mode.avgCostPerTask.toFixed(4)}`)
    }

    console.log('')
    console.log('Recommendation:', report.recommendation)
    process.exit(0)
  } finally {
    rts.close()
  }
}

async function handleEval(args: Record<string, string | boolean>): Promise<void> {
  const datasetPath = typeof args.dataset === 'string' ? args.dataset : null
  const taskId = typeof args['task-id'] === 'string' ? args['task-id'] : null
  const workDir = typeof args.workdir === 'string' ? args.workdir : '.planone/swe-bench'
  const providerConfig: ProviderConfig = {
    anthropicApiKey: typeof args['anthropic-key'] === 'string' ? args['anthropic-key'] : process.env.ANTHROPIC_API_KEY,
    geminiApiKey: typeof args['gemini-key'] === 'string' ? args['gemini-key'] : process.env.GEMINI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    nvidiaApiKey: typeof args['nvidia-key'] === 'string' ? args['nvidia-key'] : process.env.NVIDIA_API_KEY,
    openrouterApiKey: typeof args['openrouter-key'] === 'string' ? args['openrouter-key'] : process.env.OPENROUTER_API_KEY,
    openrouterPath: typeof args['openrouter-path'] === 'string' && args['openrouter-path'] === 'paid' ? 'paid' : 'free',
    executorModel: DEFAULT_EXECUTOR_MODEL,
    verifierModel: DEFAULT_VERIFIER_MODEL,
    intakeModel: DEFAULT_INTAKE_MODEL,
    panelModel: DEFAULT_PANEL_MODEL,
    compressionModel: DEFAULT_COMPRESSION_MODEL
  }

  if (datasetPath === null) {
    console.error('Usage: planone eval --dataset <path> [--task-id <id>]')
    process.exit(1)
  }

  try {
    if (taskId !== null) {
      const tasks = await readDatasetTasks(datasetPath)
      const task = tasks.find((entry) => entry.instance_id === taskId)

      if (task === undefined) {
        console.error(`Task ${taskId} not found in dataset results.`)
        process.exit(1)
      }

      const result = await runSWEBenchTask(task, workDir, providerConfig, 1)
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    }

    const result = await runSWEBenchDataset(datasetPath, workDir, providerConfig, {})
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

function printRunUsage(): void {
  console.error('Usage: planone run --task "description" --repo /path/to/repo [--config /path/to/config] [--seq N] [--nvidia-key KEY] [--openrouter-key KEY] [--openrouter-path free|paid]')
  console.error('Zero-cost defaults:')
  console.error(`  Executor: ${DEFAULT_EXECUTOR_MODEL} via NVIDIA_API_KEY`)
  console.error(`  Panel: ${DEFAULT_PANEL_MODEL} via GEMINI_API_KEY`)
  console.error(`  Verifier: ${DEFAULT_VERIFIER_MODEL} via GEMINI_API_KEY`)
  console.error(`  Intake: ${DEFAULT_INTAKE_MODEL} via GEMINI_API_KEY`)
  console.error(`  Compression: ${DEFAULT_COMPRESSION_MODEL} via GEMINI_API_KEY`)
}

function printUnknownCommandUsage(): void {
  console.error('Unknown command. Usage:')
  console.error('  planone run --task "..." --repo /path')
  console.error('  planone status --repo /path')
  console.error('  planone ab-report')
  console.error('  planone eval --dataset <path>')
}

async function readDatasetTasks(datasetPath: string): Promise<SWEBenchTask[]> {
  const jsonl = await readFile(datasetPath, 'utf8')

  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SWEBenchTask)
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main()
}
