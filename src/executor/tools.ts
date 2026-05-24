import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

import { z } from 'zod'

import type { AbMode } from '../ab-test/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import type { RepoContext } from '../intake/repo-context.js'

/**
 * Serializable Anthropic tool shape used by the executor loop.
 */
export interface AnthropicToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/**
 * Context shared by all executor tool executions.
 */
export interface ToolExecutionContext {
  repoRoot: string
  taskId: string
  stepIndex: number
  rts: RawTraceStore
  abMode: AbMode
  repoContext?: RepoContext
  rulesTestCommand?: string | null
  commandMode?: 'default' | 'pre_write' | 'post_write'
}

/**
 * Serialized tool result returned to the executor LLM.
 */
export interface ToolResult {
  success: boolean
  output: string
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Definition of one executor tool, including schema validation and execution.
 */
export interface ToolDefinition<TInput> {
  name: string
  description: string
  inputSchema: z.ZodSchema<TInput>
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>
}

const ReadFileInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
})

const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string()
})

const ApplyPatchInputSchema = z.object({
  patch: z.string().min(1)
})

const ReplaceInFileInputSchema = z.object({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string()
})

const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
})

const RunTestsInputSchema = z.object({
  testCommand: z.string().optional(),
  scope: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
})

const ListDirectoryInputSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().nonnegative().optional()
})

const SearchInFilesInputSchema = z.object({
  pattern: z.string().min(1),
  directory: z.string().optional(),
  fileType: z.string().optional()
})

const GitDiffInputSchema = z.object({
  staged: z.boolean().optional()
})

const GitStatusInputSchema = z.object({})

const PackageJsonSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid package.json JSON.'
    })
    return z.NEVER
  }
}).pipe(z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional()
}).passthrough())

const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+-rf\b/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /chmod\s+777\b/i,
  /curl\b.*\|\s*bash/i,
  /wget\b.*\|\s*bash/i,
  /rm\b.*>\s*\/dev\/null\s+2>&1/i
]
const DANGEROUS_PIPE_PATTERN = /\|\s*(head|tail|grep|sed|awk|cut|wc)\b/i
const INPLACE_EDIT_PATTERNS = [
  /\bsed\s+-[^\s]*i[^\s]*(?:\s|$)/i,
  /\bawk\s+.*-i\b/i,
  /\bperl\s+.*-i\b/i,
  /\bex\s+/i,
  /\bvi\s+/i,
  /\bvim\s+/i,
  /\bnano\s+/i,
  /\bemacs\s+/i,
  /\bpatch\s+/i
]
const VALIDATION_COMMAND_MARKERS = [
  'tsc',
  'tsc --noemit',
  ' test',
  'pnpm test',
  'npm test',
  'yarn test',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'cargo test',
  'go test'
]
const READ_ONLY_COMMAND_PATTERNS = [
  /^\s*grep\b/i,
  /^\s*rg\b/i,
  /^\s*echo\b/i,
  /^\s*printf\b/i,
  /^\s*sed\s+-n\b/i
]
const PRE_WRITE_INSPECTION_COMMAND_PATTERNS = [
  /^\s*cat\b/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /^\s*find\b/i,
  /^\s*ls\b/i,
  /^\s*wc\b/i
]
const PRE_WRITE_MUTATING_COMMAND_PATTERNS = [
  /^\s*(?:npm|pnpm|yarn)\s+install\b/i,
  /^\s*git\s+(?:checkout|switch|restore|reset|clean)\b/i,
  /^\s*(?:cp|mv|mkdir|rm|touch)\b/i
]

/**
 * All executor tools available to the Week 5 tool loop.
 */
export const ALL_TOOLS: ToolDefinition<unknown>[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository, optionally limited to a line range.',
    inputSchema: ReadFileInputSchema,
    async execute(input: z.infer<typeof ReadFileInputSchema>, context) {
      try {
        const targetPath = resolveRepoPath(context.repoRoot, input.path)
        const fileContent = await readFile(targetPath, 'utf8')
        const lines = fileContent.endsWith('\n')
          ? fileContent.slice(0, -1).split('\n')
          : fileContent.split('\n')
        const totalLines = lines.length
        const startIndex = Math.max(0, (input.startLine ?? 1) - 1)
        const endIndex = Math.min(totalLines, input.endLine ?? totalLines)
        const selectedLines = lines.slice(startIndex, endIndex)
        const numberedLines = selectedLines
          .map((line, index) => `${startIndex + index + 1} | ${line}`)
          .join('\n')

        return {
          success: true,
          output: [
            `[PlanOne read_file: line numbers are display-only. Do not include the "N | " prefix in replace_in_file old_string.]`,
            numberedLines
          ].filter((part) => part.length > 0).join('\n')
        }
      } catch (error) {
        return toErrorResult('Unable to read file.', error)
      }
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a repository file, creating parent directories when needed.',
    inputSchema: WriteFileInputSchema,
    async execute(input: z.infer<typeof WriteFileInputSchema>, context) {
      try {
        const targetPath = resolveRepoPath(context.repoRoot, input.path)
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, input.content, 'utf8')
        return {
          success: true,
          output: `Written: ${input.path} (${Buffer.byteLength(input.content, 'utf8')} bytes)`
        }
      } catch (error) {
        return toErrorResult('Unable to write file.', error)
      }
    }
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified git patch to the repository.',
    inputSchema: ApplyPatchInputSchema,
    async execute(input: z.infer<typeof ApplyPatchInputSchema>, context) {
      const attempts: Array<{ label: string; args: string[] }> = [
        { label: 'strict', args: ['apply', '--index', '-'] },
        { label: 'recount', args: ['apply', '--recount', '-'] },
        { label: 'recount-unidiff-zero', args: ['apply', '--recount', '--unidiff-zero', '-'] }
      ]

      let result: Awaited<ReturnType<typeof runProcess>> = {
        success: false,
        output: '',
        stderr: '',
        exitCode: 1,
        timedOut: false
      }
      let successfulMode: string | null = null

      for (const attempt of attempts) {
        result = await runProcess('git', attempt.args, {
          cwd: context.repoRoot,
          stdin: input.patch
        })
        if (result.success) {
          successfulMode = attempt.label
          break
        }
      }

      if (result.success) {
        return {
          success: true,
          output: successfulMode === null || successfulMode === 'strict'
            ? 'Patch applied successfully'
            : `Patch applied successfully (${successfulMode} fallback)`
        }
      }

      return {
        success: false,
        output: '',
        error: [
          'Patch failed. Error details:',
          truncateOutput((result.stderr || result.output || 'git apply failed').split('\n').slice(0, 40).join('\n')),
          '',
          'Common causes of corrupt patches:',
          '- Context lines do not match the current file content',
          '- Line numbers are off (use read_file with startLine/endLine to get exact lines)',
          '- The old_string block has extra whitespace or wrong indentation',
          '',
          'Read the relevant section with exact line numbers, then retry apply_patch.'
        ].join('\n')
      }
    }
  },
  {
    name: 'replace_in_file',
    description: 'Replace an exact string in a file with a new string. Safer than apply_patch because it does not depend on line numbers.',
    inputSchema: ReplaceInFileInputSchema,
    async execute(input: z.infer<typeof ReplaceInFileInputSchema>, context) {
      try {
        const targetPath = resolveRepoPath(context.repoRoot, input.path)
        const fileContent = await readFile(targetPath, 'utf8')
        const exactMatchOccurrences = fileContent.split(input.old_string).length - 1
        let matchedOldString = input.old_string
        let replacementNewString = input.new_string
        let replacementPrefix = `Replaced in ${input.path}`

        if (exactMatchOccurrences === 0) {
          const indentationMatch = findIndentationAdjustedMatch(fileContent, input.old_string, input.new_string)
          if (indentationMatch !== null) {
            matchedOldString = indentationMatch.actualText
            replacementNewString = indentationMatch.adjustedNewText
            replacementPrefix = `Replaced in ${input.path} (auto-corrected indentation from the requested old_string)`
          } else {
            const contentOnlyMatch = findContentOnlyMatch(fileContent, input.old_string, input.new_string)
            if (contentOnlyMatch?.kind === 'matched') {
              if (isPythonFilePath(input.path)) {
                const replacementIndex = fileContent.indexOf(contentOnlyMatch.actualText)
                const nextContent = fileContent.replace(contentOnlyMatch.actualText, contentOnlyMatch.adjustedNewText)
                const indentationCheck = validatePythonReplacementContent(nextContent)

                if (!indentationCheck.valid) {
                  return {
                    success: false,
                    output: '',
                    error: [
                      'Content-only match succeeded but indentation validation failed.',
                      'The replacement would produce inconsistent indentation in a Python file.',
                      'Read the exact lines you want to replace and provide them with correct indentation.',
                      '',
                      `Closest match in file (${input.path}):`,
                      buildLineNumberSnippet(fileContent, replacementIndex, contentOnlyMatch.actualText),
                      '',
                      indentationCheck.error
                    ].join('\n')
                  }
                }
              }
              matchedOldString = contentOnlyMatch.actualText
              replacementNewString = contentOnlyMatch.adjustedNewText
              replacementPrefix = `Replaced in ${input.path} (matched by content and restored file indentation)`
            } else if (contentOnlyMatch?.kind === 'ambiguous') {
              return {
                success: false,
                output: '',
                error: `old_string matches multiple structurally similar blocks in ${input.path}. Provide more surrounding context so the replacement target is unique.`
              }
            }

            if (contentOnlyMatch?.kind !== 'matched') {
              const closestMatch = findClosestFileSection(fileContent, input.old_string)
              return {
                success: false,
                output: '',
                error: buildReplaceNotFoundError(input.path, input.old_string, closestMatch)
              }
            }
          }
        }

        const occurrences = fileContent.split(matchedOldString).length - 1
        if (occurrences > 1) {
          return {
            success: false,
            output: '',
            error: `old_string appears ${occurrences} times in ${input.path}. Provide more context to make it unique.`
          }
        }

        const replacementIndex = fileContent.indexOf(matchedOldString)
        const nextContent = fileContent.replace(matchedOldString, replacementNewString)
        await writeFile(targetPath, nextContent, 'utf8')
        return {
          success: true,
          output: [
            replacementPrefix,
            '',
            'Updated section:',
            buildLineNumberSnippet(nextContent, replacementIndex, replacementNewString)
          ].join('\n')
        }
      } catch (error) {
        return toErrorResult('Unable to replace text in file.', error)
      }
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command inside the repository with a timeout and command blocking.',
    inputSchema: RunCommandInputSchema,
    async execute(input: z.infer<typeof RunCommandInputSchema>, context) {
      if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(input.command))) {
        return {
          success: false,
          output: '',
          error: 'Command blocked by SEK hard limit'
        }
      }

      const normalizedCommand = input.command.trim()
      const lowerCommand = normalizedCommand.toLowerCase()
      const isValidationCommand = VALIDATION_COMMAND_MARKERS.some((marker) => lowerCommand.includes(marker))
      const commandMode = context.commandMode ?? 'default'
      const repoContext = context.repoContext

      if (INPLACE_EDIT_PATTERNS.some((pattern) => pattern.test(normalizedCommand))) {
        return {
          success: false,
          output: '',
          error: `[BLOCKED] In-place file editing via shell commands is not permitted.\nUse write_file or apply_patch tools instead.\nCommand blocked: ${normalizedCommand}`
        }
      }

      if (commandMode === 'pre_write') {
        if (PRE_WRITE_INSPECTION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizedCommand))) {
          return {
            success: false,
            output: '',
            error: `[BLOCKED] Pre-write file inspection via run_command is not permitted.\nUse read_file for file contents and list_directory for directory inspection.\nCommand blocked: ${normalizedCommand}`
          }
        }

        const isAllowedReadOnly = READ_ONLY_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizedCommand))
        if (!isAllowedReadOnly || PRE_WRITE_MUTATING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizedCommand))) {
          return {
            success: false,
            output: '',
            error: `[BLOCKED] Pre-write run_command is limited to read-only shell commands that do not duplicate first-class tools.\nUse read_file, list_directory, and search_in_files for repository inspection.\nCommand blocked: ${normalizedCommand}`
          }
        }
      }

      if (commandMode === 'post_write' && !isValidationCommand) {
        return {
          success: false,
          output: '',
          error: `[BLOCKED] Only test and type-check commands are permitted after implementation.\nCommand blocked: ${normalizedCommand}`
        }
      }

      if (DANGEROUS_PIPE_PATTERN.test(normalizedCommand) && isValidationCommand) {
        return {
          success: false,
          output: '',
          error: `[BLOCKED] Piped validation commands are not permitted because they mask the real exit code. Run the command directly:\n  ${normalizedCommand.split('|')[0]?.trim() ?? normalizedCommand}\nDo not pipe validation commands through head, tail, grep, or other filters.`
        }
      }

      if (repoContext?.language === 'python' && isValidationCommand && /\bnpm\b|\bpnpm\b|\byarn\b|\bnpx\b/i.test(normalizedCommand)) {
        return {
          success: false,
          output: '',
          error: `[BLOCKED] This repository is detected as Python. JavaScript package-manager test commands are not appropriate here.\nRun the Python test command instead:\n  ${repoContext.testCommand ?? `${repoContext.pythonBinary ?? 'python3'} -m pytest`}`
        }
      }

      const correctedCommand = repoContext?.language === 'python'
        ? autocorrectPythonBinary(normalizedCommand, repoContext.pythonBinary ?? 'python3')
        : normalizedCommand

      const beforeFiles = getRepoChangedFiles(context.repoRoot)
      const commandResult = await runProcess(
        process.platform === 'win32' ? 'cmd' : 'sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', correctedCommand] : ['-lc', correctedCommand],
        {
          cwd: input.cwd === undefined ? context.repoRoot : resolveRepoPath(context.repoRoot, input.cwd),
          timeoutMs: input.timeoutMs ?? 30_000
        }
      )

      if (lowerCommand.includes('tsc') && lowerCommand.includes('noemit')) {
        const combinedOutput = `${commandResult.output}\n${commandResult.stderr}`.trim()
        const hasTypeScriptErrors = combinedOutput.includes('error TS')
        if (hasTypeScriptErrors) {
          return {
            success: false,
            output: truncateOutput(combinedOutput),
            error: commandResult.exitCode === 0
              ? 'TypeScript errors detected despite exit 0'
              : buildCommandError(combinedOutput, commandResult.exitCode)
          }
        }
      }

      const afterFiles = getRepoChangedFiles(context.repoRoot)
      const unexpectedMutations = afterFiles.filter((filePath) => !beforeFiles.includes(filePath))
      const metadata = unexpectedMutations.length > 0
        ? {
            WARNING: 'Shell command mutated files outside write_file/apply_patch path',
            mutatedFiles: unexpectedMutations,
            command: correctedCommand
          }
        : undefined

      return commandResult.success
        ? { success: true, output: truncateOutput(commandResult.output), ...(metadata === undefined ? {} : { metadata }) }
        : {
          success: false,
          output: truncateOutput(`${commandResult.output}${commandResult.stderr.length > 0 ? `\n${commandResult.stderr}` : ''}`.trim() || '(no output)'),
          error: buildCommandError(`${commandResult.output}${commandResult.stderr.length > 0 ? `\n${commandResult.stderr}` : ''}`.trim(), commandResult.exitCode),
          ...(metadata === undefined ? {} : { metadata })
        }
    }
  },
  {
    name: 'run_tests',
    description: 'Run the repository test suite or a scoped subset of tests.',
    inputSchema: RunTestsInputSchema,
    async execute(input: z.infer<typeof RunTestsInputSchema>, context) {
      try {
        const command = input.testCommand ?? await detectDefaultTestCommand(context)
        const scopedCommand = input.scope === undefined ? command : `${command} ${input.scope}`
        const testResult = await runProcess(
          process.platform === 'win32' ? 'cmd' : 'sh',
          process.platform === 'win32' ? ['/d', '/s', '/c', scopedCommand] : ['-lc', scopedCommand],
          {
            cwd: context.repoRoot,
            timeoutMs: input.timeoutMs ?? 120_000
          }
        )
        const combinedOutput = `${testResult.output}${testResult.stderr.length > 0 ? `\n${testResult.stderr}` : ''}`.trim()
        const metadata = parseTestMetadata(combinedOutput)

        return {
          success: testResult.success,
          output: combinedOutput,
          ...(testResult.success ? {} : { error: buildCommandError(testResult.stderr, testResult.exitCode) }),
          metadata
        }
      } catch (error) {
        return toErrorResult('Unable to run tests.', error)
      }
    }
  },
  {
    name: 'list_directory',
    description: 'List repository directory contents in a tree-like format.',
    inputSchema: ListDirectoryInputSchema,
    async execute(input: z.infer<typeof ListDirectoryInputSchema>, context) {
      try {
        const startPath = resolveRepoPath(context.repoRoot, input.path)
        const recursive = input.recursive ?? false
        const maxDepth = input.maxDepth ?? 2
        const lines = await buildDirectoryTree(startPath, recursive, maxDepth, 0, context.repoRoot)
        return {
          success: true,
          output: lines.join('\n')
        }
      } catch (error) {
        return toErrorResult('Unable to list directory.', error)
      }
    }
  },
  {
    name: 'search_in_files',
    description: 'Search plain files using ripgrep when available and grep otherwise.',
    inputSchema: SearchInFilesInputSchema,
    async execute(input: z.infer<typeof SearchInFilesInputSchema>, context) {
      try {
        const directory = input.directory === undefined ? context.repoRoot : resolveRepoPath(context.repoRoot, input.directory)
        const rgCheck = await runProcess('sh', ['-lc', 'command -v rg >/dev/null 2>&1'])
        const command = rgCheck.success
          ? buildRipgrepCommand(input, directory)
          : buildGrepCommand(input, directory)
        const result = await runProcess('sh', ['-lc', command], {
          cwd: context.repoRoot,
          timeoutMs: 30_000
        })
        const lines = result.output.split('\n').filter((line) => line.trim().length > 0).slice(0, 50)
        return {
          success: result.success || lines.length > 0,
          output: lines.join('\n'),
          ...(result.success || lines.length > 0 ? {} : { error: result.stderr || 'No matches found.' })
        }
      } catch (error) {
        return toErrorResult('Unable to search files.', error)
      }
    }
  },
  {
    name: 'git_diff',
    description: 'Return the current repository diff, optionally staged only.',
    inputSchema: GitDiffInputSchema,
    async execute(input: z.infer<typeof GitDiffInputSchema>, context) {
      const result = await runProcess('git', input.staged === true ? ['diff', '--cached'] : ['diff'], {
        cwd: context.repoRoot
      })
      return result.success
        ? { success: true, output: result.output }
        : { success: false, output: '', error: buildCommandError(result.stderr, result.exitCode) }
    }
  },
  {
    name: 'git_status',
    description: 'Return git status in porcelain format.',
    inputSchema: GitStatusInputSchema,
    async execute(_input: z.infer<typeof GitStatusInputSchema>, context) {
      const result = await runProcess('git', ['status', '--porcelain'], {
        cwd: context.repoRoot
      })
      return result.success
        ? { success: true, output: result.output }
        : { success: false, output: '', error: buildCommandError(result.stderr, result.exitCode) }
    }
  }
]

/**
 * Converts all executor tools into Claude-compatible tool definitions.
 */
export function getToolDefinitions(): AnthropicToolDefinition[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodObjectToAnthropicSchema(tool.inputSchema)
  }))
}

/**
 * Validates and executes one executor tool by name.
 *
 * This function never throws.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name)

  if (tool === undefined) {
    return {
      success: false,
      output: '',
      error: `Unknown tool: ${name}`
    }
  }

  try {
    const parsedInput = tool.inputSchema.parse(input)
    return await tool.execute(parsedInput, context)
  } catch (error) {
    return toErrorResult(`Tool execution failed for ${name}.`, error)
  }
}

function zodObjectToAnthropicSchema(schema: z.ZodSchema<unknown>): AnthropicToolDefinition['input_schema'] {
  if (!(schema instanceof z.ZodObject)) {
    return { type: 'object', properties: {}, required: [] }
  }

  const shape = schema.shape
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const optional = value instanceof z.ZodOptional
    const unwrapped = optional ? value.unwrap() : value
    properties[key] = zodFieldToJsonSchema(unwrapped)

    if (!optional) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    required
  }
}

function zodFieldToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    return { type: 'string' }
  }

  if (schema instanceof z.ZodNumber) {
    return { type: 'number' }
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: [...schema.options] }
  }

  return { type: 'string' }
}

function resolveRepoPath(repoRoot: string, targetPath: string): string {
  const repoRootAbsolute = resolve(repoRoot)
  const absoluteTarget = resolveAbsoluteOrRepoRelativePath(repoRootAbsolute, targetPath)
  const relativeTarget = relative(repoRoot, absoluteTarget)

  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(`Path escapes repository root after normalization: ${targetPath}`)
  }

  return absoluteTarget
}

function resolveAbsoluteOrRepoRelativePath(repoRootAbsolute: string, targetPath: string): string {
  if (isAbsolute(targetPath)) {
    const resolvedTargetPath = resolve(targetPath)
    const relativeToRepo = relative(repoRootAbsolute, resolvedTargetPath)

    if (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo)) {
      return resolvedTargetPath
    }
  }

  const stripped = targetPath.replace(/^\/+/, '')
  return resolve(repoRootAbsolute, stripped.length > 0 ? stripped : '.')
}

async function detectDefaultTestCommand(context: ToolExecutionContext): Promise<string> {
  if (typeof context.rulesTestCommand === 'string' && context.rulesTestCommand.trim().length > 0) {
    return context.rulesTestCommand
  }

  if (context.repoContext?.testCommand !== null && context.repoContext?.testCommand !== undefined) {
    return context.repoContext.testCommand
  }

  const packageJsonPath = join(context.repoRoot, 'package.json')

  try {
    const packageJson = PackageJsonSchema.parse(await readFile(packageJsonPath, 'utf8'))

    if (typeof packageJson.scripts?.test === 'string') {
      return 'npm test'
    }

    if (typeof packageJson.devDependencies?.vitest === 'string') {
      return 'npx vitest run'
    }
  } catch {
    // Fall through to the default command below.
  }

  return 'npm test'
}

function autocorrectPythonBinary(command: string, pythonBinary: string): string {
  return command.replace(/(^|[;&(]\s*)python(\s+-m\s+pytest\b)/g, (_match, prefix: string, suffix: string) => {
    return `${prefix}${pythonBinary}${suffix}`
  })
}

function getRepoChangedFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output
      .split('\n')
      .map(parseGitStatusPath)
      .filter((line): line is string => line !== null && line.length > 0)
  } catch {
    return []
  }
}

function parseGitStatusPath(line: string): string | null {
  const trimmedLine = line.trimEnd()
  if (trimmedLine.length < 4) {
    return null
  }

  const rawPath = trimmedLine.slice(3).trim()
  if (rawPath.length === 0) {
    return null
  }

  const renamedPath = rawPath.includes(' -> ')
    ? rawPath.split(' -> ').at(-1) ?? rawPath
    : rawPath

  return renamedPath.replace(/^"(.*)"$/, '$1')
}

async function buildDirectoryTree(
  currentPath: string,
  recursive: boolean,
  maxDepth: number,
  depth: number,
  repoRoot: string
): Promise<string[]> {
  if (depth > maxDepth) {
    return []
  }

  const entries = await readdir(currentPath, { withFileTypes: true })
  const visibleEntries = entries
    .filter((entry) => !['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const lines: string[] = []

  for (const entry of visibleEntries) {
    const absolutePath = join(currentPath, entry.name)
    const relativePath = relative(repoRoot, absolutePath) || '.'
    lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '[D]' : '[F]'} ${relativePath}`)

    if (recursive && entry.isDirectory()) {
      lines.push(...await buildDirectoryTree(absolutePath, recursive, maxDepth, depth + 1, repoRoot))
    }
  }

  return lines
}

function buildRipgrepCommand(input: z.infer<typeof SearchInFilesInputSchema>, directory: string): string {
  const fileTypeArg = input.fileType === undefined ? '' : ` -g '*.${escapeSingleQuotes(input.fileType)}'`
  return `rg -n --no-heading -m 50${fileTypeArg} '${escapeSingleQuotes(input.pattern)}' '${escapeSingleQuotes(directory)}'`
}

function buildGrepCommand(input: z.infer<typeof SearchInFilesInputSchema>, directory: string): string {
  const fileTypeArg = input.fileType === undefined ? '' : ` --include='*.${escapeSingleQuotes(input.fileType)}'`
  return `grep -E -R -n -m 50${fileTypeArg} '${escapeSingleQuotes(input.pattern)}' '${escapeSingleQuotes(directory)}'`
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

function parseTestMetadata(output: string): Record<string, unknown> {
  const passedMatch = /(\d+)\s+passed\b/i.exec(output)
  const failedMatch = /(\d+)\s+failed\b/i.exec(output)
  const failures = output
    .split('\n')
    .filter((line) => /fail/i.test(line) && /[A-Za-z0-9]/.test(line))
    .slice(0, 20)

  return {
    passed: passedMatch === null ? 0 : Number(passedMatch[1]),
    failed: failedMatch === null ? 0 : Number(failedMatch[1]),
    failures
  }
}

function truncateOutput(output: string): string {
  return output.length > 10_000 ? output.slice(0, 10_000) : output
}

function getLeadingWhitespace(line: string): string {
  const match = /^(\s*)/.exec(line)
  return match === null ? '' : match[1]
}

function splitContentLines(content: string): string[] {
  return content.split('\n')
}

function findIndentationAdjustedMatch(
  fileContent: string,
  oldString: string,
  newString: string = oldString
): { actualText: string; adjustedNewText: string } | null {
  const oldLines = splitContentLines(oldString)
  const fileLines = splitContentLines(fileContent)

  if (oldLines.length === 0 || oldLines.length > fileLines.length) {
    return null
  }

  for (let start = 0; start <= fileLines.length - oldLines.length; start += 1) {
    const candidateLines = fileLines.slice(start, start + oldLines.length)
    if (candidateLines.some((line, index) => line.trimStart() !== oldLines[index]?.trimStart())) {
      continue
    }

    let indentDelta: string | null = null
    let valid = true

    for (let index = 0; index < oldLines.length; index += 1) {
      const expectedLine = oldLines[index] ?? ''
      const actualLine = candidateLines[index] ?? ''

      // Blank separator lines should not participate in indent delta detection.
      if (expectedLine.trim().length === 0 && actualLine.trim().length === 0) {
        continue
      }

      const expectedIndent = getLeadingWhitespace(expectedLine)
      const actualIndent = getLeadingWhitespace(actualLine)

      if (!actualIndent.endsWith(expectedIndent)) {
        valid = false
        break
      }

      const currentDelta = actualIndent.slice(0, actualIndent.length - expectedIndent.length)
      if (indentDelta === null) {
        indentDelta = currentDelta
      } else if (indentDelta !== currentDelta) {
        valid = false
        break
      }
    }

    if (valid) {
      const prefix = indentDelta ?? ''
      const adjustedNewText = splitContentLines(newString)
        .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
        .join('\n')
      return {
        actualText: candidateLines.join('\n'),
        adjustedNewText
      }
    }
  }

  return null
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripLeadingWhitespacePreservingBlankLines(value: string): string[] {
  return splitContentLines(value).map((line) => (line.trim().length === 0 ? '' : line.replace(/^\s+/, '')))
}

function getBaseIndent(lines: string[]): string {
  const nonBlankLines = lines.filter((line) => line.trim().length > 0)
  if (nonBlankLines.length === 0) {
    return ''
  }

  const indents = nonBlankLines.map((line) => getLeadingWhitespace(line))
  return indents.reduce((shortest, current) => current.length < shortest.length ? current : shortest)
}

function transferIndentation(fileWindowLines: string[], modelNewStringLines: string[]): string[] {
  const fileBaseIndent = getBaseIndent(fileWindowLines)
  const modelBaseIndent = getBaseIndent(modelNewStringLines)

  return modelNewStringLines.map((line) => {
    if (line.trim().length === 0) {
      return line
    }

    const relativeIndent = line.startsWith(modelBaseIndent)
      ? getLeadingWhitespace(line.slice(modelBaseIndent.length))
      : getLeadingWhitespace(line)

    return `${fileBaseIndent}${relativeIndent}${line.trimStart()}`
  })
}

function reindentNewStringFromMatchedWindow(newString: string, matchedLines: string[]): string {
  return transferIndentation(matchedLines, splitContentLines(newString)).join('\n')
}

function isPythonFilePath(filePath: string): boolean {
  return filePath.endsWith('.py')
}

function validatePythonIndentationStructure(content: string): string | null {
  const lines = content.split('\n')
  const indentStack = [0]
  let previousRelevantLine = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }

    const indent = getLeadingWhitespace(line).length
    const currentIndent = indentStack[indentStack.length - 1] ?? 0

    if (indent > currentIndent) {
      if (!previousRelevantLine.trimEnd().endsWith(':')) {
        return `Unexpected indentation increase before line: ${trimmed}`
      }
      indentStack.push(indent)
    } else if (indent < currentIndent) {
      while (indentStack.length > 1 && indent < (indentStack[indentStack.length - 1] ?? 0)) {
        indentStack.pop()
      }

      if (indent !== (indentStack[indentStack.length - 1] ?? 0)) {
        return `Indentation dedent does not match an existing block before line: ${trimmed}`
      }
    }

    previousRelevantLine = line
  }

  return null
}

function validatePythonReplacementContent(content: string): { valid: true } | { valid: false; error: string } {
  const structuralError = validatePythonIndentationStructure(content)
  if (structuralError !== null) {
    return {
      valid: false,
      error: structuralError
    }
  }

  try {
    execFileSync(
      'python3',
      ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
      {
        input: content,
        encoding: 'utf8',
        stdio: ['pipe', 'ignore', 'pipe']
      }
    )

    return { valid: true }
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : error instanceof Error
        ? error.message
        : 'Python syntax validation failed.'

    return {
      valid: false,
      error: stderr.length > 0 ? stderr : 'Python syntax validation failed.'
    }
  }
}

function findContentOnlyMatch(
  fileContent: string,
  oldString: string,
  newString: string
): { kind: 'matched'; actualText: string; adjustedNewText: string } | { kind: 'ambiguous' } | null {
  const oldLines = splitContentLines(oldString)
  const fileLines = splitContentLines(fileContent)

  if (oldLines.length === 0 || oldLines.length > fileLines.length) {
    return null
  }

  const normalizedOldLines = stripLeadingWhitespacePreservingBlankLines(oldString)
  const matches: Array<{ actualText: string; adjustedNewText: string }> = []

  for (let start = 0; start <= fileLines.length - oldLines.length; start += 1) {
    const candidateLines = fileLines.slice(start, start + oldLines.length)
    const normalizedCandidateLines = stripLeadingWhitespacePreservingBlankLines(candidateLines.join('\n'))
    if (normalizedCandidateLines.length !== normalizedOldLines.length) {
      continue
    }

    const matchesByContent = normalizedCandidateLines.every((line, index) => line === (normalizedOldLines[index] ?? ''))
    if (!matchesByContent) {
      continue
    }

    matches.push({
      actualText: candidateLines.join('\n'),
      adjustedNewText: reindentNewStringFromMatchedWindow(newString, candidateLines)
    })
    if (matches.length > 1) {
      return { kind: 'ambiguous' }
    }
  }

  if (matches.length === 1) {
    return { kind: 'matched', ...matches[0]! }
  }

  return null
}

function scoreNormalizedOverlap(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) {
    return 0
  }

  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 0))
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 0))
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return union === 0 ? 0 : overlap / union
}

function findClosestFileSection(fileContent: string, oldString: string): { text: string; startLine: number; endLine: number } | null {
  const queryLines = splitContentLines(oldString)
  const fileLines = splitContentLines(fileContent)
  if (queryLines.length === 0 || fileLines.length === 0) {
    return null
  }

  const normalizedQuery = normalizeComparisonText(oldString)
  const candidateWindowSizes = [...new Set([
    Math.max(1, queryLines.length - 1),
    queryLines.length,
    Math.min(fileLines.length, queryLines.length + 1)
  ])]

  let bestMatch: { text: string; startLine: number; endLine: number; score: number } | null = null

  for (const windowSize of candidateWindowSizes) {
    for (let start = 0; start <= fileLines.length - windowSize; start += 1) {
      const text = fileLines.slice(start, start + windowSize).join('\n')
      const score = scoreNormalizedOverlap(normalizeComparisonText(text), normalizedQuery)
      if (bestMatch === null || score > bestMatch.score) {
        bestMatch = {
          text,
          startLine: start + 1,
          endLine: start + windowSize,
          score
        }
      }
    }
  }

  return bestMatch === null ? null : {
    text: bestMatch.text,
    startLine: bestMatch.startLine,
    endLine: bestMatch.endLine
  }
}

function formatNumberedSnippet(content: string, startLine: number): string {
  return splitContentLines(content)
    .map((line, index) => `${startLine + index} | ${line}`)
    .join('\n')
}

function buildReplaceNotFoundError(
  filePath: string,
  requestedOldString: string,
  closestMatch: { text: string; startLine: number; endLine: number } | null
): string {
  return [
    `old_string not found in ${filePath}. The text must match exactly including whitespace and newlines.`,
    '',
    'You provided:',
    requestedOldString,
    '',
    ...(closestMatch === null
      ? ['No close match was found in the file. Read the file again to confirm the exact text.']
      : [
        'old_string did not match. Closest block found in the file:',
        '',
        closestMatch.text,
        '',
        'Copy this exactly as old_string and retry.'
      ])
  ].join('\n')
}

function buildLineNumberSnippet(content: string, startIndex: number, insertedText: string): string {
  const lines = splitContentLines(content)
  const safeIndex = Math.max(0, Math.min(startIndex, content.length))
  const lineBeforeReplacement = content.slice(0, safeIndex).split('\n').length
  const replacementLineCount = Math.max(1, splitContentLines(insertedText).length)
  const snippetStartLine = Math.max(1, lineBeforeReplacement - 5)
  const snippetEndLine = Math.min(lines.length, lineBeforeReplacement + replacementLineCount + 4)
  return lines
    .slice(snippetStartLine - 1, snippetEndLine)
    .map((line, index) => `${snippetStartLine + index} | ${line}`)
    .join('\n')
}

function buildCommandError(stderr: string, exitCode: number | null): string {
  const detail = stderr.trim().length > 0 ? stderr.trim() : 'Command failed'
  return `${detail} (exit code: ${exitCode ?? 'unknown'})`
}

function toErrorResult(prefix: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return {
    success: false,
    output: '',
    error: `${prefix} ${message}`
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string
    timeoutMs?: number
    stdin?: string
  } = {}
): Promise<{ success: boolean; output: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'pipe'
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeoutMs = options.timeoutMs ?? 30_000
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolvePromise({
        success: false,
        output: stdout,
        stderr: `${stderr}${stderr.length > 0 ? '\n' : ''}${error.message}`,
        exitCode: null,
        timedOut
      })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolvePromise({
        success: timedOut === false && code === 0,
        output: stdout,
        stderr: timedOut ? `${stderr}\nProcess timed out after ${timeoutMs}ms.`.trim() : stderr,
        exitCode: code,
        timedOut
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin)
    }

    child.stdin.end()
  })
}
