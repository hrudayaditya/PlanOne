import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

/**
 * One SWE-bench task entry consumed by the Week 6 harness.
 */
export interface SWEBenchTask {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  hints_text: string | null
  created_at: string
  patch: string
  test_patch: string
  fail_to_pass: string[]
  pass_to_pass: string[]
}

/**
 * Cloned execution environment for one SWE-bench task.
 */
export interface SWEBenchEnvironment {
  taskId: string
  repoRoot: string
  task: SWEBenchTask
}

/**
 * Score emitted after PlanOne's patch is re-applied and tested.
 */
export interface SWEBenchScore {
  instance_id: string
  resolved: boolean
  failToPassResults: Record<string, boolean>
  passToPassResults: Record<string, boolean>
  error: string | null
}

/**
 * Clones the requested repository and checks out the task's base commit.
 */
export async function setupEnvironment(task: SWEBenchTask, workDir: string): Promise<SWEBenchEnvironment> {
  await mkdir(workDir, { recursive: true })
  const repoRoot = resolve(workDir, task.instance_id)
  const repoSource = resolveRepoSource(task.repo)
  await runProcess('git', ['clone', repoSource, repoRoot], workDir)
  await runProcess('git', ['checkout', task.base_commit], repoRoot)

  return {
    taskId: task.instance_id,
    repoRoot,
    task
  }
}

/**
 * Removes a cloned SWE-bench environment and never throws.
 */
export async function teardownEnvironment(env: SWEBenchEnvironment): Promise<void> {
  try {
    await rm(env.repoRoot, { recursive: true, force: true })
  } catch {
    // Teardown is best-effort in Phase 1.
  }
}

/**
 * Applies the produced patch, runs tests, and scores the task heuristically.
 */
export async function scoreResult(
  env: SWEBenchEnvironment,
  appliedPatch: string | null
): Promise<SWEBenchScore> {
  if (appliedPatch === null) {
    return {
      instance_id: env.task.instance_id,
      resolved: false,
      failToPassResults: Object.fromEntries(env.task.fail_to_pass.map((testName) => [testName, false])),
      passToPassResults: Object.fromEntries(env.task.pass_to_pass.map((testName) => [testName, false])),
      error: null
    }
  }

  try {
    const tempPatchPath = join(await mkdtemp(join(tmpdir(), 'planone-swebench-patch-')), 'applied.patch')
    await writeFile(tempPatchPath, appliedPatch, 'utf8')
    await runProcess('git', ['apply', tempPatchPath], env.repoRoot)
    const testCommand = await detectTestCommand(env.repoRoot)
    const testResult = await runShellCommand(testCommand, env.repoRoot)
    const output = `${testResult.stdout}\n${testResult.stderr}`
    const failToPassResults = Object.fromEntries(env.task.fail_to_pass.map((testName) => [testName, didTestPass(output, testName)]))
    const passToPassResults = Object.fromEntries(env.task.pass_to_pass.map((testName) => [testName, didTestPass(output, testName)]))

    return {
      instance_id: env.task.instance_id,
      resolved: Object.values(failToPassResults).every(Boolean),
      failToPassResults,
      passToPassResults,
      error: testResult.success ? null : testResult.stderr || 'Test command failed'
    }
  } catch (error) {
    return {
      instance_id: env.task.instance_id,
      resolved: false,
      failToPassResults: Object.fromEntries(env.task.fail_to_pass.map((testName) => [testName, false])),
      passToPassResults: Object.fromEntries(env.task.pass_to_pass.map((testName) => [testName, false])),
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

function resolveRepoSource(repo: string): string {
  if (repo.startsWith('http://') || repo.startsWith('https://') || existsSync(repo)) {
    return repo
  }

  return `https://github.com/${repo}.git`
}

async function detectTestCommand(repoRoot: string): Promise<string> {
  const packageJsonPath = join(repoRoot, 'package.json')

  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
      }

      if (packageJson.scripts?.test !== undefined) {
        return 'npm test'
      }

      if (packageJson.devDependencies?.vitest !== undefined) {
        return 'npx vitest run'
      }
    } catch {
      // Fall through to generic defaults.
    }
  }

  if (existsSync(join(repoRoot, 'pytest.ini')) || existsSync(join(repoRoot, 'pyproject.toml'))) {
    return 'pytest'
  }

  return 'npm test'
}

function didTestPass(output: string, testName: string): boolean {
  if (output.length === 0) {
    return false
  }

  const lowerOutput = output.toLowerCase()
  const lowerTestName = testName.toLowerCase()

  if (!lowerOutput.includes(lowerTestName)) {
    return true
  }

  return !(
    lowerOutput.includes(`fail ${lowerTestName}`) ||
    lowerOutput.includes(`failed ${lowerTestName}`) ||
    lowerOutput.includes(`${lowerTestName} failed`)
  )
}

async function runShellCommand(command: string, cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const shell = process.platform === 'win32' ? 'cmd' : 'sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
  return runProcess(shell, args, cwd)
}

async function runProcess(command: string, args: string[], cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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
        resolvePromise({ success: true, stdout, stderr })
        return
      }

      reject(new Error(stderr || stdout || `${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
