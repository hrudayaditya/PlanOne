import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RawTraceStore } from '../../src/memory/raw-trace-store/index.js'
import { executeTool, type ToolExecutionContext } from '../../src/executor/tools.js'

function makeContext(root: string): { context: ToolExecutionContext; cleanup: () => void } {
  const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
  return {
    context: {
      repoRoot: root,
      taskId: 'task-1',
      stepIndex: 0,
      rts: store,
      abMode: 'B'
    },
    cleanup: () => store.close()
  }
}

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'planone-tools-'))
  execSync('git init', { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { test: 'node -e "console.log(\'5 passed 0 failed\')"' }
  }))
  writeFileSync(join(root, 'file.txt'), 'line one\nline two\nline three\n')
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored')
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

describe('executor tools', () => {
  it('read_file returns content for an existing file', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('read_file', { path: 'file.txt' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('display-only')
      expect(result.output).toContain('1 | line one')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('normalizes leading slash paths relative to repo root', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('read_file', { path: '/file.txt' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('1 | line one')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('read_file respects startLine and endLine with numbered output', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('read_file', { path: 'file.txt', startLine: 2, endLine: 3 }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('[PlanOne read_file: line numbers are display-only.')
      expect(result.output).toContain('2 | line two')
      expect(result.output).toContain('3 | line three')
      expect(result.output.split('\n')).toHaveLength(3)
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('read_file returns success false for a missing file', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('read_file', { path: 'missing.txt' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toEqual(expect.any(String))
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('write_file creates files and parent directories', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('write_file', {
        path: 'nested/deep/output.txt',
        content: 'hello'
      }, context)
      const verify = await executeTool('read_file', { path: 'nested/deep/output.txt' }, context)
      expect(result.success).toBe(true)
      expect(verify.output).toContain('1 | hello')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('run_command blocks hard-limited commands', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'rm -rf /tmp/nope' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Command blocked by SEK hard limit')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('run_tests defaults to python3 -m pytest in a python repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planone-tools-python-'))
    execSync('git init', { cwd: root, stdio: 'ignore' })
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="fixture"\nrequires-python=">=3.10"\n')
    const fakePython = join(root, 'bin', 'python3')
    writeFileSync(fakePython, '#!/bin/sh\necho "pytest stub"\nexit 0\n')
    execSync('chmod +x python3', { cwd: join(root, 'bin') })
    const store = new RawTraceStore(join(root, '.planone', 'trace.db'))
    const context: ToolExecutionContext = {
      repoRoot: root,
      taskId: 'task-python',
      stepIndex: 0,
      rts: store,
      abMode: 'B',
      repoContext: {
        repoRoot: root,
        primaryLanguage: 'Python',
        hasTests: true,
        testFramework: 'pytest',
        packageManager: 'pip',
        language: 'python',
        pythonBinary: 'python3',
        testRunner: 'pytest',
        testFilePattern: 'test_*.py *_test.py',
        testCommand: `${fakePython} -m pytest`
      }
    }

    try {
      const result = await executeTool('run_tests', {}, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('pytest stub')
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('run_command blocks npm-based validation in a python repo', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.repoContext = {
      repoRoot: root,
      primaryLanguage: 'Python',
      hasTests: true,
      testFramework: 'pytest',
      packageManager: 'pip',
      language: 'python',
      pythonBinary: 'python3',
      testRunner: 'pytest',
      testFilePattern: 'test_*.py *_test.py',
      testCommand: 'python3 -m pytest'
    }

    try {
      const result = await executeTool('run_command', { command: 'npm test' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('This repository is detected as Python')
      expect(result.error).toContain('python3 -m pytest')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('run_command blocks npx-based validation in a python repo', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.repoContext = {
      repoRoot: root,
      primaryLanguage: 'Python',
      hasTests: true,
      testFramework: 'pytest',
      packageManager: 'pip',
      language: 'python',
      pythonBinary: 'python3',
      testRunner: 'pytest',
      testFilePattern: 'test_*.py *_test.py',
      testCommand: 'python3 -m pytest'
    }

    try {
      const result = await executeTool('run_command', { command: 'npx tsc --noEmit' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('This repository is detected as Python')
      expect(result.error).toContain('python3 -m pytest')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('run_command returns stdout in output', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'printf hello' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('hello')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('search_in_files grep fallback supports regex alternation', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'types.ts'), 'export type WithTRPCSSROptions = {}\nexport type Other = {}\n')
    const { context, cleanup: cleanupContext } = makeContext(root)
    const originalPath = process.env.PATH
    const shimBin = mkdtempSync(join(tmpdir(), 'planone-grep-only-'))

    try {
      const grepPath = execSync('command -v grep', { encoding: 'utf8' }).trim()
      const shPath = execSync('command -v sh', { encoding: 'utf8' }).trim()
      symlinkSync(grepPath, join(shimBin, 'grep'))
      symlinkSync(shPath, join(shimBin, 'sh'))
      process.env.PATH = shimBin

      const result = await executeTool('search_in_files', {
        directory: '.',
        pattern: 'WithTRPCSSROptions|WithTRPCNoSSROptions'
      }, context)

      expect(result.success).toBe(true)
      expect(result.output).toContain('WithTRPCSSROptions')
    } finally {
      process.env.PATH = originalPath
      cleanupContext()
      rmSync(shimBin, { recursive: true, force: true })
      cleanup()
    }
  })

  it('run_command returns failing command output instead of only exit code', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: `node -e "console.log('compile failed'); process.exit(1)"` }, context)
      expect(result.success).toBe(false)
      expect(result.output).toContain('compile failed')
      expect(result.error).toContain('exit code')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks piped validation commands that mask exit codes', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'npx tsc --noEmit | head -50' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Piped validation commands are not permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('allows direct tsc validation commands without pipes', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'npx tsc --noEmit' }, context)
      expect(typeof result.success).toBe('boolean')
      expect(result.error ?? '').not.toContain('Piped validation commands are not permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('allows non-validation piped commands', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'ls | head -10' }, context)
      expect(result.success).toBe(true)
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file replaces exact text once', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'file.txt',
        old_string: 'line two',
        new_string: 'updated line'
      }, context)
      const verify = await executeTool('read_file', { path: 'file.txt' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('Replaced in file.txt')
      expect(result.output).toContain('Updated section:')
      expect(result.output).toContain('1 | line one')
      expect(result.output).toContain('2 | updated line')
      expect(verify.output).toContain('2 | updated line')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file auto-corrects uniform indentation differences', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'indented.ts'), [
      'function demo() {',
      '    if (ready) {',
      '        work()',
      '    }',
      '}'
    ].join('\n'))
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'indented.ts',
        old_string: [
          '  if (ready) {',
          '      work()',
          '  }'
        ].join('\n'),
        new_string: [
          '  if (ready) {',
          '      work()',
          '      finish()',
          '  }'
        ].join('\n')
      }, context)
      const verify = await executeTool('read_file', { path: 'indented.ts' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('auto-corrected indentation')
      expect(verify.output).toContain('4 |         finish()')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file auto-corrects uniform indentation differences across blank lines', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'blank-lines.ts'), [
      'function demo() {',
      '    const config = parent.config({ ctx })',
      '',
      '    const queryClient = getQueryClient(config)',
      '    const trpcProp = {',
      '      queryClient',
      '    }',
      '}'
    ].join('\n'))
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'blank-lines.ts',
        old_string: [
          'const config = parent.config({ ctx })',
          '',
          'const queryClient = getQueryClient(config)',
          'const trpcProp = {'
        ].join('\n'),
        new_string: [
          'const config = parent.config({ ctx })',
          '',
          'const queryClient = getQueryClient(config)',
          'const trpcProp = {',
          '  gcTime: Infinity,'
        ].join('\n')
      }, context)
      const verify = await executeTool('read_file', { path: 'blank-lines.ts' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('auto-corrected indentation')
      expect(verify.output).toContain('6 |       gcTime: Infinity,')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file matches structurally with mixed indentation deltas', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'mixed-indent.ts'), [
      'function demo() {',
      '    const config = parent.config({ ctx })',
      '',
      '    const queryClient = getQueryClient(config)',
      '    const trpcProp = {',
      '      queryClient',
      '    }',
      '}'
    ].join('\n'))
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'mixed-indent.ts',
        old_string: [
          'const config = parent.config({ ctx })',
          '',
          '  const queryClient = getQueryClient(config)',
          '  const trpcProp = {'
        ].join('\n'),
        new_string: [
          'const config = parent.config({ ctx })',
          '',
          'const queryClient = getQueryClient(config)',
          'const trpcProp = {',
          '  gcTime: Infinity,'
        ].join('\n')
      }, context)
      const verify = await executeTool('read_file', { path: 'mixed-indent.ts' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('matched by content')
      expect(verify.output).toContain('6 |       gcTime: Infinity,')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file rejects a content-only Python rewrite that would produce invalid indentation', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'broken_indent.py'), [
      'def demo(items):',
      '    for attr in items:',
      '        if ready:',
      '            work()',
      '            continue',
      '',
      '        if other:',
      '            done()'
    ].join('\n'))
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'broken_indent.py',
        old_string: [
          'for attr in items:',
          '        if ready:',
          '            work()',
          '            continue',
          '',
          '    if other:'
        ].join('\n'),
        new_string: [
          'for attr in items:',
          '        if ready:',
          '            work()',
          '            continue',
          '',
          '                if other:',
          '                    done()'
        ].join('\n')
      }, context)
      const verify = readFileSync(join(root, 'broken_indent.py'), 'utf8')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Content-only match succeeded but indentation validation failed.')
      expect(verify).toContain('\n        if other:\n')
      expect(verify).not.toContain('\n            if other:\n')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file errors when old_string is not found', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'file.txt',
        old_string: 'missing text',
        new_string: 'updated line'
      }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('old_string not found')
      expect(result.error).toContain('Closest block found in the file:')
      expect(result.error).toContain('line one')
      expect(result.error).toContain('Copy this exactly as old_string and retry.')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file rejects ambiguous content-only matches', async () => {
    const { root, cleanup } = makeRepo()
    writeFileSync(join(root, 'ambiguous.ts'), [
      'function demo() {',
      '    const queryClient = getQueryClient(config)',
      '    const trpcProp = {',
      '      queryClient',
      '    }',
      '',
      '    const queryClient = getQueryClient(config)',
      '    const trpcProp = {',
      '      queryClient',
      '    }',
      '}'
    ].join('\n'))
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('replace_in_file', {
        path: 'ambiguous.ts',
        old_string: [
          'const queryClient = getQueryClient(config)',
          'const trpcProp = {',
          '  queryClient',
          '}'
        ].join('\n'),
        new_string: [
          'const queryClient = getQueryClient(config)',
          'const trpcProp = {',
          '  queryClient,',
          '  gcTime: Infinity,',
          '}'
        ].join('\n')
      }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('appears 2 times')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('replace_in_file errors when old_string is ambiguous', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      writeFileSync(join(root, 'dupe.txt'), 'same\nsame\n')
      const result = await executeTool('replace_in_file', {
        path: 'dupe.txt',
        old_string: 'same',
        new_string: 'updated'
      }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('appears 2 times')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('apply_patch succeeds with a recount fallback when hunk counts are wrong', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const patch = [
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,99 +1,99 @@',
        ' line one',
        '-line two',
        '+updated line',
        ' line three',
        ''
      ].join('\n')

      const result = await executeTool('apply_patch', { patch }, context)
      const verify = await executeTool('read_file', { path: 'file.txt' }, context)

      expect(result.success).toBe(true)
      expect(result.output).toContain('recount fallback')
      expect(verify.output).toContain('2 | updated line')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('apply_patch succeeds with a unidiff-zero fallback for zero-context hunks', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const patch = [
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -2 +2 @@',
        '-line two',
        '+updated line',
        ''
      ].join('\n')

      const result = await executeTool('apply_patch', { patch }, context)
      const verify = await executeTool('read_file', { path: 'file.txt' }, context)

      expect(result.success).toBe(true)
      expect(result.output).toContain('recount-unidiff-zero fallback')
      expect(verify.output).toContain('2 | updated line')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('run_command respects timeoutMs', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', {
        command: 'node -e "setTimeout(() => console.log(\'late\'), 200)"',
        timeoutMs: 50
      }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('exit code')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('list_directory excludes node_modules and .git', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('list_directory', { path: '.', recursive: true, maxDepth: 3 }, context)
      expect(result.output).not.toContain('node_modules')
      expect(result.output).not.toContain('.git')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('git_diff returns a string', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      writeFileSync(join(root, 'file.txt'), 'changed\n')
      const result = await executeTool('git_diff', {}, context)
      expect(typeof result.output).toBe('string')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('executeTool returns success false for an unknown tool', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('unknown_tool', {}, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown tool')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('git_status returns a string', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('git_status', {}, context)
      expect(typeof result.output).toBe('string')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks in-place sed edits through run_command', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: "sed -i '' -e 's/line/replaced/' file.txt" }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('In-place file editing via shell commands is not permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('allows read-only sed inspection through run_command', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'pre_write'
    try {
      const result = await executeTool('run_command', { command: "sed -n '1,2p' file.txt" }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('line one')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks interactive editors through run_command', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'vim file.txt' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('In-place file editing via shell commands is not permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks patch command through run_command', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'patch file.txt < changes.patch' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('In-place file editing via shell commands is not permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('logs unexpected mutations after run_command', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    try {
      const result = await executeTool('run_command', { command: 'touch created.txt' }, context)
      expect(result.success).toBe(true)
      expect(result.metadata?.WARNING).toContain('Shell command mutated files outside write_file/apply_patch path')
      expect(result.metadata?.mutatedFiles).toEqual(expect.arrayContaining(['created.txt']))
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks mutating pre-write commands', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'pre_write'
    try {
      const result = await executeTool('run_command', { command: 'npm install' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Pre-write run_command is limited to read-only shell commands that do not duplicate first-class tools')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks cat inspection before first write', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'pre_write'
    try {
      const result = await executeTool('run_command', { command: 'cat file.txt' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Use read_file for file contents')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('blocks directory inspection before first write', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'pre_write'
    try {
      const result = await executeTool('run_command', { command: 'find . -maxdepth 2 -type f' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Use read_file for file contents and list_directory for directory inspection')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('still allows pre-write search commands', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'pre_write'
    try {
      const result = await executeTool('run_command', { command: 'rg "line one" file.txt' }, context)
      expect(result.success).toBe(true)
      expect(result.output).toContain('line one')
    } finally {
      cleanupContext()
      cleanup()
    }
  })

  it('allows test commands after a write in post-write mode', async () => {
    const { root, cleanup } = makeRepo()
    const { context, cleanup: cleanupContext } = makeContext(root)
    context.commandMode = 'post_write'
    try {
      const result = await executeTool('run_command', { command: 'pnpm test' }, context)
      expect(typeof result.success).toBe('boolean')
      expect(result.error ?? '').not.toContain('Only test and type-check commands are permitted')
    } finally {
      cleanupContext()
      cleanup()
    }
  })
})
