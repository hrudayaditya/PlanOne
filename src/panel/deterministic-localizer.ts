import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

import { DEFAULT_INTAKE_MODEL, DEFAULT_INTAKE_PREFERRED_MODELS } from '../llm/models.js'
import type { IntakeResult } from '../intake/index.js'
import type { RawTraceStore } from '../memory/raw-trace-store/index.js'
import { logWarn } from '../utils/logger.js'
import type { PanelMemberLlmProvider } from './member.js'

const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build'])
const EXCLUDED_FILE_SUFFIXES = ['.pyc']
const MAX_LOCALIZATION_FILES = 5
const LOCALIZATION_MAX_RETRIES = 3
const LOCALIZATION_INITIAL_BACKOFF_MS = 2_000

export interface LocalizationInput {
  intake: IntakeResult
  provider: PanelMemberLlmProvider
  fallbackProvider?: PanelMemberLlmProvider
  rts: RawTraceStore
}

export interface VerifiedFile {
  path: string
  reason: string
}

export interface VerifiedSymbol {
  file: string
  name: string
  type: 'function' | 'class' | 'variable'
  lineNumber: number
}

export interface LocalizationResult {
  files: VerifiedFile[]
  symbols: VerifiedSymbol[]
  implementationContext: Map<string, string>
  localizationMethod: 'deterministic' | 'fallback'
  traceback: string | null
}

interface SkeletonSymbol {
  name: string
  type: 'function' | 'class' | 'variable'
  lineNumber: number
}

interface FileSkeleton {
  path: string
  symbols: SkeletonSymbol[]
  rendered: string
}

export async function runDeterministicLocalization(
  input: LocalizationInput
): Promise<LocalizationResult> {
  appendLocalizationTrace(input, 'deterministic_localization_start', {
    repoRoot: input.intake.repoContext.repoRoot,
    providerHasAnalyze: typeof input.provider.analyze === 'function'
  })

  const problemStatement = input.intake.enhancedTask.original
  const traceback = input.intake.reproductionResult?.traceback ?? extractTraceback(problemStatement)
  const repoRoot = input.intake.repoContext.repoRoot

  if (repoRoot.trim().length === 0) {
    const error = new Error('Deterministic localization requires a non-empty repo root.')
    appendLocalizationError(input, 'input_validation', error)
    throw error
  }

  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    const error = new Error(`Deterministic localization repo root is unavailable: ${repoRoot}`)
    appendLocalizationError(input, 'input_validation', error)
    throw error
  }

  if (typeof input.provider.analyze !== 'function') {
    const error = new Error('Deterministic localization provider is missing analyze().')
    appendLocalizationError(input, 'provider_validation', error)
    throw error
  }

  let fileTree: string
  try {
    fileTree = buildFileTree(repoRoot)
  } catch (error) {
    appendLocalizationError(input, 'build_file_tree', error)
    throw error
  }

  if (fileTree.trim().length === 0) {
    appendLocalizationTrace(input, 'deterministic_localization_file_tree_empty', {
      repoRoot
    })
  }

  const validFiles = await localizeFiles({
    repoRoot,
    provider: input.provider,
    fallbackProvider: input.fallbackProvider,
    taskId: input.intake.taskId,
    abMode: input.intake.abMode,
    rts: input.rts,
    problemStatement,
    traceback,
    fileTree
  })

  if (validFiles.length === 0) {
    appendLocalizationTrace(input, 'deterministic_localization_no_verified_files', {
      tracebackPresent: traceback !== null
    })
    return {
      files: [],
      symbols: [],
      implementationContext: new Map(),
      localizationMethod: 'fallback',
      traceback
    }
  }

  const skeletons = validFiles
    .map((file) => buildFileSkeleton(repoRoot, file.path, input.intake.repoContext.pythonBinary))
    .filter((skeleton): skeleton is FileSkeleton => skeleton !== null)

  if (skeletons.length === 0) {
    appendLocalizationTrace(input, 'deterministic_localization_no_skeletons', {
      fileCount: validFiles.length
    })
  }

  const verifiedSymbols = await localizeSymbols({
    provider: input.provider,
    fallbackProvider: input.fallbackProvider,
    taskId: input.intake.taskId,
    abMode: input.intake.abMode,
    rts: input.rts,
    problemStatement,
    traceback,
    skeletons
  })

  if (verifiedSymbols.length === 0) {
    appendLocalizationTrace(input, 'deterministic_localization_no_verified_symbols', {
      fileCount: validFiles.length,
      skeletonCount: skeletons.length
    })
    return {
      files: [],
      symbols: [],
      implementationContext: new Map(),
      localizationMethod: 'fallback',
      traceback
    }
  }

  const remainingFiles = validFiles.filter((file) => verifiedSymbols.some((symbol) => symbol.file === file.path))
  const implementationContext = extractImplementationContext(
    repoRoot,
    remainingFiles,
    verifiedSymbols
  )

  return {
    files: remainingFiles,
    symbols: verifiedSymbols,
    implementationContext,
    localizationMethod: 'deterministic',
    traceback
  }
}

function appendLocalizationTrace(
  input: LocalizationInput,
  operation: string,
  details: Record<string, unknown>
): void {
  appendLocalizationTraceRaw(
    input.rts,
    input.intake.taskId,
    input.intake.abMode,
    'step_output',
    {
      operation,
      ...details
    }
  )
}

function appendLocalizationError(
  input: LocalizationInput,
  stage: string,
  error: unknown
): void {
  appendLocalizationTraceRaw(
    input.rts,
    input.intake.taskId,
    input.intake.abMode,
    'error',
    {
      message: 'Deterministic localization stage failed.',
      stage,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }
  )
}

function appendLocalizationTraceRaw(
  rts: RawTraceStore,
  taskId: string,
  abMode: IntakeResult['abMode'],
  eventType: 'step_output' | 'error',
  payload: Record<string, unknown>
): void {
  rts.append({
    task_id: taskId,
    ab_mode: abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: eventType,
    content_json: JSON.stringify(payload),
    tokens_used: null,
    cost_usd: null,
    created_at: new Date().toISOString()
  })
}

export function buildFileTree(repoRoot: string, maxDepth = 4): string {
  const lines: string[] = []

  function walk(currentPath: string, depth: number): void {
    if (depth > maxDepth) {
      return
    }

    let entries
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    const sortedEntries = entries
      .filter((entry) => !shouldExcludeEntry(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of sortedEntries) {
      const absolutePath = join(currentPath, entry.name)
      const indent = '    '.repeat(depth)
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`)
        walk(absolutePath, depth + 1)
      } else if (entry.isFile() && !EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        lines.push(`${indent}${entry.name}`)
      }
    }
  }

  walk(repoRoot, 0)
  return lines.join('\n')
}

function shouldExcludeEntry(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name) || EXCLUDED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

async function localizeFiles(input: {
  repoRoot: string
  provider: PanelMemberLlmProvider
  fallbackProvider?: PanelMemberLlmProvider
  taskId: string
  abMode: IntakeResult['abMode']
  rts: RawTraceStore
  problemStatement: string
  traceback: string | null
  fileTree: string
}): Promise<VerifiedFile[]> {
  const tracebackFiles = extractTracebackFilePaths(input.problemStatement, input.repoRoot)
  const prompts = [
    buildFileLocalizationPrompt(input.problemStatement, input.traceback, input.fileTree, false),
    buildFileLocalizationPrompt(input.problemStatement, input.traceback, input.fileTree, true)
  ]
  const modelPlans = buildLocalizationModelPlans(input.provider, input.fallbackProvider)

  for (const [attemptIndex, prompt] of prompts.entries()) {
    const response = await analyzeLocalizationPrompt(
      modelPlans,
      prompt,
      input.rts,
      input.taskId,
      input.abMode,
      'deterministic_file_localization'
    )
    input.rts.append({
      task_id: input.taskId,
      ab_mode: input.abMode,
      agent_role: 'panel',
      step_index: null,
      event_type: 'llm_call',
      content_json: JSON.stringify({
        operation: 'deterministic_file_localization',
        model: response.model,
        attempt: attemptIndex + 1,
        tokensUsed: response.tokensUsed,
        costUsd: response.costUsd
      }),
      tokens_used: response.tokensUsed,
      cost_usd: response.costUsd,
      created_at: new Date().toISOString()
    })

    const parsedFiles = parseBacktickedFilePaths(response.text)
    const verified = parsedFiles
      .map((filePath) => verifyFilePath(input.repoRoot, filePath))
      .filter((file): file is VerifiedFile => file !== null)

    for (const tracebackFile of tracebackFiles) {
      if (!verified.some((file) => file.path === tracebackFile)) {
        verified.unshift({
          path: tracebackFile,
          reason: 'traceback reference'
        })
      }
    }

    const deduped = dedupeFiles(verified).slice(0, MAX_LOCALIZATION_FILES)
    if (deduped.length > 0) {
      return deduped
    }

    for (const hallucinatedPath of parsedFiles) {
      if (verifyFilePath(input.repoRoot, hallucinatedPath) === null) {
        logWarn('panel:localizer', '[Localizer] Discarded hallucinated file path', {
          path: hallucinatedPath
        })
      }
    }
  }

  return tracebackFiles.map((filePath) => ({
    path: filePath,
    reason: 'traceback reference'
  }))
}

async function localizeSymbols(input: {
  provider: PanelMemberLlmProvider
  fallbackProvider?: PanelMemberLlmProvider
  taskId: string
  abMode: IntakeResult['abMode']
  rts: RawTraceStore
  problemStatement: string
  traceback: string | null
  skeletons: FileSkeleton[]
}): Promise<VerifiedSymbol[]> {
  const prompt = buildSymbolLocalizationPrompt(
    input.problemStatement,
    input.traceback,
    input.skeletons
  )
  const modelPlans = buildLocalizationModelPlans(input.provider, input.fallbackProvider)
  const response = await analyzeLocalizationPrompt(
    modelPlans,
    prompt,
    input.rts,
    input.taskId,
    input.abMode,
    'deterministic_symbol_localization'
  )
  input.rts.append({
    task_id: input.taskId,
    ab_mode: input.abMode,
    agent_role: 'panel',
    step_index: null,
    event_type: 'llm_call',
    content_json: JSON.stringify({
      operation: 'deterministic_symbol_localization',
      model: response.model,
      tokensUsed: response.tokensUsed,
      costUsd: response.costUsd
    }),
    tokens_used: response.tokensUsed,
    cost_usd: response.costUsd,
    created_at: new Date().toISOString()
  })

  const parsed = parseSymbolLocalizationResponse(response.text)
  const verified: VerifiedSymbol[] = []

  for (const entry of parsed) {
    const skeleton = input.skeletons.find((candidate) => candidate.path === entry.file)
    if (skeleton === undefined) {
      continue
    }

    for (const symbol of entry.symbols) {
      const match = skeleton.symbols.find((candidate) => (
        candidate.name === symbol.name && candidate.type === symbol.type
      ))

      if (match !== undefined) {
        verified.push({
          file: entry.file,
          name: match.name,
          type: match.type,
          lineNumber: match.lineNumber
        })
      } else {
        logWarn('panel:localizer', '[Localizer] Discarded invented symbol', {
          file: entry.file,
          symbol: symbol.name
        })
      }
    }
  }

  return dedupeSymbols(verified)
}

async function analyzeLocalizationPrompt(
  modelPlans: Array<{ provider: PanelMemberLlmProvider; model: string }>,
  prompt: string,
  rts: RawTraceStore,
  taskId: string,
  abMode: IntakeResult['abMode'],
  operation: 'deterministic_file_localization' | 'deterministic_symbol_localization'
): Promise<{ model: string; text: string; tokensUsed: number; costUsd: number }> {
  let lastError: unknown = null

  for (const [modelIndex, plan] of modelPlans.entries()) {
    const { provider, model } = plan
    for (let attempt = 1; attempt <= LOCALIZATION_MAX_RETRIES; attempt += 1) {
      try {
        const response = await provider.analyze(prompt, model)
        return {
          model,
          text: response.text,
          tokensUsed: response.tokensUsed,
          costUsd: response.costUsd
        }
      } catch (error) {
        lastError = error
        const retryable = isRetryableLocalizationError(error)
        const willRetrySameModel = retryable && attempt < LOCALIZATION_MAX_RETRIES
        const willTryFallbackModel = retryable && !willRetrySameModel && modelIndex < modelPlans.length - 1

        appendLocalizationTraceRaw(rts, taskId, abMode, 'step_output', {
          operation: 'deterministic_localization_attempt_failed',
          localizationOperation: operation,
          model,
          providerHint: provider.constructor?.name ?? 'unknown',
          attempt,
          retryable,
          willRetrySameModel,
          willTryFallbackModel
        })

        if (willRetrySameModel) {
          const delayMs = LOCALIZATION_INITIAL_BACKOFF_MS * (2 ** (attempt - 1))
          appendLocalizationTraceRaw(rts, taskId, abMode, 'step_output', {
            operation: 'deterministic_localization_retry_scheduled',
            localizationOperation: operation,
            model,
            nextAttempt: attempt + 1,
            delayMs
          })
          await sleep(delayMs)
          continue
        }

        if (willTryFallbackModel) {
          appendLocalizationTraceRaw(rts, taskId, abMode, 'step_output', {
            operation: 'deterministic_localization_model_fallback',
            localizationOperation: operation,
            fromModel: model,
            toModel: modelPlans[modelIndex + 1]?.model ?? null
          })
          break
        }

        throw error
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Deterministic localization exhausted all retry and fallback attempts.')
}

function buildLocalizationModelPlans(
  primaryProvider: PanelMemberLlmProvider,
  fallbackProvider?: PanelMemberLlmProvider
): Array<{ provider: PanelMemberLlmProvider; model: string }> {
  const plans: Array<{ provider: PanelMemberLlmProvider; model: string }> = [
    { provider: primaryProvider, model: DEFAULT_INTAKE_MODEL }
  ]

  if (fallbackProvider !== undefined) {
    for (const model of DEFAULT_INTAKE_PREFERRED_MODELS) {
      if (model === DEFAULT_INTAKE_MODEL) {
        continue
      }
      plans.push({ provider: fallbackProvider, model })
    }
  }

  return plans
}

function isRetryableLocalizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  if (/\b5\d\d\b/.test(message)) return true

  if (/\b429\b/.test(message)) return true
  if (/too many requests/i.test(message)) return true
  if (/quota exceeded/i.test(message)) return true
  if (/rate.?limit/i.test(message)) return true
  if (/retryDelay/i.test(message)) return true
  if (/resource exhausted/i.test(message)) return true
  if (/free.?tier/i.test(message)) return true

  if (/service unavailable/i.test(message)) return true
  if (/bad gateway/i.test(message)) return true
  if (/gateway timeout/i.test(message)) return true
  if (/temporarily unavailable/i.test(message)) return true

  return false
}

function sleep(ms: number): Promise<void> {
  const effectiveDelay = process.env.VITEST !== undefined ? 0 : ms
  return new Promise((resolve) => setTimeout(resolve, effectiveDelay))
}

function verifyFilePath(repoRoot: string, filePath: string): VerifiedFile | null {
  const normalizedPath = filePath.replace(/^`|`$/g, '').trim()
  if (normalizedPath.length === 0) {
    return null
  }

  const absolutePath = resolve(repoRoot, normalizedPath)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return null
  }

  return {
    path: normalizeRelativePath(repoRoot, absolutePath),
    reason: 'verified file localization'
  }
}

function parseBacktickedFilePaths(text: string): string[] {
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '').filter((value) => value.length > 0)
  if (backticked.length > 0) {
    return backticked
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LOCALIZATION_FILES)
}

function buildFileLocalizationPrompt(
  problemStatement: string,
  traceback: string | null,
  fileTree: string,
  broader: boolean
): string {
  return [
    'Please look through the following GitHub problem description and Repository structure and provide a list of files that one would need to edit to fix the problem.',
    '',
    '### GitHub Problem Description ###',
    problemStatement,
    ...(traceback === null ? [] : ['', '### Bug Reproduction Traceback ###', traceback]),
    '',
    '### Repository Structure ###',
    fileTree,
    '',
    broader
      ? 'Retry with a broader view if needed, but still only return real file paths from the repository structure.'
      : '',
    'Please only provide the full path and return at most 5 files.',
    'The returned files should be separated by new lines ordered by most to least important and wrapped with backticks.'
  ].filter((line) => line.length > 0).join('\n')
}

function buildSymbolLocalizationPrompt(
  problemStatement: string,
  traceback: string | null,
  skeletons: FileSkeleton[]
): string {
  return [
    'Please look through the following GitHub Problem Description and the Skeleton of Relevant Files. Identify all locations that need inspection or editing to fix the problem.',
    '',
    '### GitHub Problem Description ###',
    problemStatement,
    ...(traceback === null ? [] : ['', '### Bug Reproduction Traceback ###', traceback]),
    '',
    '### Skeleton of Relevant Files ###',
    skeletons.map((skeleton) => [
      skeleton.path,
      skeleton.rendered
    ].join('\n')).join('\n\n'),
    '',
    'Please provide the complete set of locations as either a class name, a function or method name, or a variable name.',
    '',
    'Format:',
    'path/to/file.py',
    '    function: my_function',
    '    class: MyClass',
    '    function: MyClass.my_method'
  ].join('\n')
}

function buildFileSkeleton(repoRoot: string, filePath: string, pythonBinary: string | null): FileSkeleton | null {
  const absolutePath = resolve(repoRoot, filePath)
  let source: string

  try {
    source = readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }

  const extension = extname(filePath)
  const symbols = extension === '.py'
    ? extractPythonSkeletonSymbols(absolutePath, source, pythonBinary)
    : extractRegexSkeletonSymbols(source)

  return {
    path: filePath,
    symbols,
    rendered: [
      `# ${filePath}`,
      ...symbols.map((symbol) => `${symbol.type}: ${symbol.name} (line ${symbol.lineNumber})`)
    ].join('\n')
  }
}

function extractPythonSkeletonSymbols(
  absolutePath: string,
  source: string,
  pythonBinary: string | null
): SkeletonSymbol[] {
  const binary = pythonBinary ?? 'python3'
  try {
    const script = [
      'import ast, sys',
      'tree = ast.parse(open(sys.argv[1]).read())',
      'for node in ast.walk(tree):',
      '    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):',
      '        print(f"function\\t{node.name}\\t{node.lineno}")',
      '    elif isinstance(node, ast.ClassDef):',
      '        print(f"class\\t{node.name}\\t{node.lineno}")'
    ].join('\n')
    const output = execFileSync(binary, ['-c', script, absolutePath], { encoding: 'utf8' })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [type, name, lineNumber] = line.split('\t')
        if (type === undefined || name === undefined || lineNumber === undefined) {
          return null
        }

        return {
          type: type as SkeletonSymbol['type'],
          name,
          lineNumber: Number.parseInt(lineNumber, 10)
        }
      })
      .filter((symbol): symbol is SkeletonSymbol => symbol !== null)
      .sort((left, right) => left.lineNumber - right.lineNumber)
  } catch {
    return source
      .split('\n')
      .flatMap((line, index): SkeletonSymbol[] => {
        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/)
        if (classMatch?.[1] !== undefined) {
          return [{ type: 'class', name: classMatch[1], lineNumber: index + 1 }]
        }
        const functionMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/)
        if (functionMatch?.[1] !== undefined) {
          return [{ type: 'function', name: functionMatch[1], lineNumber: index + 1 }]
        }
        return []
      })
  }
}

function extractRegexSkeletonSymbols(source: string): SkeletonSymbol[] {
  return source
    .split('\n')
    .flatMap((line, index) => {
      const patterns: Array<{ regex: RegExp; type: SkeletonSymbol['type'] }> = [
        { regex: /^\s*export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'function' },
        { regex: /^\s*export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'class' },
        { regex: /^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'class' },
        { regex: /^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'variable' },
        { regex: /^\s*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'variable' },
        { regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'function' },
        { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'class' }
      ]

      for (const pattern of patterns) {
        const match = line.match(pattern.regex)
        if (match?.[1] !== undefined) {
          return [{ type: pattern.type, name: match[1], lineNumber: index + 1 }]
        }
      }

      return []
    })
}

function parseSymbolLocalizationResponse(text: string): Array<{
  file: string
  symbols: Array<{ type: SkeletonSymbol['type']; name: string }>
}> {
  const lines = text.split('\n')
  const entries: Array<{ file: string; symbols: Array<{ type: SkeletonSymbol['type']; name: string }> }> = []
  let currentFile: { file: string; symbols: Array<{ type: SkeletonSymbol['type']; name: string }> } | null = null

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed.trim().length === 0) {
      continue
    }

    if (!trimmed.startsWith(' ') && !trimmed.startsWith('\t') && !trimmed.includes(': ')) {
      currentFile = { file: trimmed.trim(), symbols: [] }
      entries.push(currentFile)
      continue
    }

    const symbolMatch = trimmed.match(/^\s*(function|class|variable):\s+(.+)$/)
    if (symbolMatch?.[1] !== undefined && symbolMatch[2] !== undefined && currentFile !== null) {
      currentFile.symbols.push({
        type: symbolMatch[1] as SkeletonSymbol['type'],
        name: symbolMatch[2].trim()
      })
    }
  }

  return entries
}

function extractImplementationContext(
  repoRoot: string,
  files: VerifiedFile[],
  symbols: VerifiedSymbol[]
): Map<string, string> {
  const context = new Map<string, string>()

  for (const file of files) {
    const absolutePath = resolve(repoRoot, file.path)
    let source: string
    try {
      source = readFileSync(absolutePath, 'utf8')
    } catch {
      continue
    }

    const lines = source.split('\n')
    const fileSymbols = symbols.filter((symbol) => symbol.file === file.path)
    const snippets = fileSymbols.map((symbol) => {
      const start = Math.max(0, symbol.lineNumber - 11)
      const end = Math.min(lines.length, symbol.lineNumber + 10)
      return [
        `# ${symbol.type}: ${symbol.name} (line ${symbol.lineNumber})`,
        lines.slice(start, end).join('\n')
      ].join('\n')
    })

    if (snippets.length > 0) {
      context.set(file.path, snippets.join('\n\n'))
    }
  }

  return context
}

function extractTraceback(task: string): string | null {
  const tracebackIndex = task.indexOf('Traceback')
  if (tracebackIndex >= 0) {
    return task.slice(tracebackIndex).trim()
  }
  return null
}

function extractTracebackFilePaths(task: string, repoRoot: string): string[] {
  const matches = [...task.matchAll(/([A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx))/g)]
  const verified = matches
    .map((match) => match[1] ?? '')
    .filter((candidate) => candidate.length > 0)
    .map((candidate) => {
      const absolutePath = resolve(repoRoot, candidate)
      return existsSync(absolutePath) ? normalizeRelativePath(repoRoot, absolutePath) : null
    })
    .filter((candidate): candidate is string => candidate !== null)

  return [...new Set(verified)]
}

function dedupeFiles(files: VerifiedFile[]): VerifiedFile[] {
  const byPath = new Map<string, VerifiedFile>()
  for (const file of files) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file)
    }
  }
  return [...byPath.values()]
}

function dedupeSymbols(symbols: VerifiedSymbol[]): VerifiedSymbol[] {
  const byKey = new Map<string, VerifiedSymbol>()
  for (const symbol of symbols) {
    const key = `${symbol.file}:${symbol.type}:${symbol.name}:${symbol.lineNumber}`
    if (!byKey.has(key)) {
      byKey.set(key, symbol)
    }
  }
  return [...byKey.values()]
}

function normalizeRelativePath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replace(/\\/g, '/')
}
