import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

import type { ProviderConfig } from '../../src/llm/router.js'
import { runPipeline, type PipelineResult } from '../../src/pipeline/index.js'
import { scoreResult, setupEnvironment, teardownEnvironment, type SWEBenchEnvironment, type SWEBenchScore, type SWEBenchTask } from './harness.js'

/**
 * Summary emitted after a full SWE-bench dataset run.
 */
export interface SWEBenchDatasetResult {
  runId: string
  totalTasks: number
  resolvedCount: number
  resolutionRate: number
  taskResults: Array<{ task: SWEBenchTask; score: SWEBenchScore; result: PipelineResult }>
  startedAt: string
  completedAt: string
}

/**
 * Runs PlanOne against a single SWE-bench task and always tears the repo down.
 */
export async function runSWEBenchTask(
  task: SWEBenchTask,
  workDir: string,
  providerConfig: ProviderConfig,
  taskSequenceNumber: number
): Promise<{ task: SWEBenchTask; score: SWEBenchScore; result: PipelineResult }> {
  const env = await setupEnvironment(task, workDir)

  try {
    const result = await runPipeline({
      taskId: task.instance_id,
      rawTask: task.problem_statement,
      config: {
        repoRoot: env.repoRoot,
        providerConfig
      },
      taskSequenceNumber
    })
    const appliedPatch = await captureGitDiff(env.repoRoot)
    const score = await scoreResult(env, appliedPatch.length > 0 ? appliedPatch : null)

    return { task, score, result }
  } finally {
    await teardownEnvironment(env)
  }
}

/**
 * Runs a JSONL SWE-bench dataset sequentially and writes incremental results.
 */
export async function runSWEBenchDataset(
  datasetPath: string,
  workDir: string,
  providerConfig: ProviderConfig,
  options: { maxTasks?: number; startFrom?: number }
): Promise<SWEBenchDatasetResult> {
  const startedAt = new Date().toISOString()
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const tasks = (await readDataset(datasetPath))
    .slice(options.startFrom ?? 0, options.maxTasks === undefined ? undefined : (options.startFrom ?? 0) + options.maxTasks)
  const taskResults: Array<{ task: SWEBenchTask; score: SWEBenchScore; result: PipelineResult }> = []

  await mkdir(resolve(process.cwd(), 'benchmarks/results'), { recursive: true })

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    const result = await runSWEBenchTask(task, workDir, providerConfig, index + 1)
    taskResults.push(result)
    await writeIncrementalResult(runId, {
      runId,
      totalTasks: taskResults.length,
      resolvedCount: taskResults.filter((entry) => entry.score.resolved).length,
      resolutionRate: taskResults.length === 0 ? 0 : taskResults.filter((entry) => entry.score.resolved).length / taskResults.length,
      taskResults,
      startedAt,
      completedAt: new Date().toISOString()
    })
  }

  const resolvedCount = taskResults.filter((entry) => entry.score.resolved).length

  return {
    runId,
    totalTasks: taskResults.length,
    resolvedCount,
    resolutionRate: taskResults.length === 0 ? 0 : resolvedCount / taskResults.length,
    taskResults,
    startedAt,
    completedAt: new Date().toISOString()
  }
}

async function readDataset(datasetPath: string): Promise<SWEBenchTask[]> {
  const jsonl = await readFile(datasetPath, 'utf8')

  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SWEBenchTask)
}

async function writeIncrementalResult(runId: string, result: SWEBenchDatasetResult): Promise<void> {
  const outputPath = resolve(process.cwd(), `benchmarks/results/run-${runId}.json`)
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8')
}

async function captureGitDiff(repoRoot: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['diff'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }

      reject(new Error(stderr || `git diff exited with code ${code ?? 'unknown'}`))
    })
  })
}
