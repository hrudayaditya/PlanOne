import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { scoreResult, setupEnvironment, teardownEnvironment, type SWEBenchTask } from '../../benchmarks/swe-bench/harness.js'

function createGitRepo(): { repoRoot: string; commit: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'planone-swebench-repo-'))
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    scripts: {
      test: 'node test.js'
    }
  }, null, 2))
  writeFileSync(join(repoRoot, 'test.js'), "console.log('auth-test passed')\n")
  writeFileSync(join(repoRoot, 'index.js'), "module.exports = 'ok'\n")
  execFileSync('git', ['init'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  execFileSync('git', ['add', '.'], { cwd: repoRoot })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

  return {
    repoRoot,
    commit,
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  }
}

function makeTask(repoRoot: string, commit: string): SWEBenchTask {
  return {
    instance_id: 'task-1',
    repo: repoRoot,
    base_commit: commit,
    problem_statement: 'Fix auth test',
    hints_text: null,
    created_at: new Date().toISOString(),
    patch: '',
    test_patch: '',
    fail_to_pass: ['auth-test'],
    pass_to_pass: []
  }
}

describe('swe-bench harness', () => {
  it('setupEnvironment clones the repo and checks out the commit', async () => {
    const fixture = createGitRepo()
    const workDir = mkdtempSync(join(tmpdir(), 'planone-swebench-work-'))

    try {
      const env = await setupEnvironment(makeTask(fixture.repoRoot, fixture.commit), workDir)
      const checkedOutCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.repoRoot, encoding: 'utf8' }).trim()

      expect(checkedOutCommit).toBe(fixture.commit)
      await teardownEnvironment(env)
    } finally {
      fixture.cleanup()
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('teardownEnvironment removes the cloned directory', async () => {
    const fixture = createGitRepo()
    const workDir = mkdtempSync(join(tmpdir(), 'planone-swebench-work-'))

    try {
      const env = await setupEnvironment(makeTask(fixture.repoRoot, fixture.commit), workDir)
      await teardownEnvironment(env)
      expect(existsSync(env.repoRoot)).toBe(false)
    } finally {
      fixture.cleanup()
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('scoreResult returns resolved false when no patch is applied', async () => {
    const fixture = createGitRepo()
    const workDir = mkdtempSync(join(tmpdir(), 'planone-swebench-work-'))

    try {
      const env = await setupEnvironment(makeTask(fixture.repoRoot, fixture.commit), workDir)
      const score = await scoreResult(env, null)

      expect(score.resolved).toBe(false)
      await teardownEnvironment(env)
    } finally {
      fixture.cleanup()
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('teardownEnvironment can be called after scoring errors without throwing', async () => {
    const fixture = createGitRepo()
    const workDir = mkdtempSync(join(tmpdir(), 'planone-swebench-work-'))

    try {
      const env = await setupEnvironment(makeTask(fixture.repoRoot, fixture.commit), workDir)
      const score = await scoreResult(env, 'not a patch')

      expect(score.resolved).toBe(false)
      await expect(teardownEnvironment(env)).resolves.toBeUndefined()
    } finally {
      fixture.cleanup()
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
