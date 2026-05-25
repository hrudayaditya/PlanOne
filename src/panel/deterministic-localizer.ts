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

    const fileLineHints = extractLineHintsForFile(input.problemStatement, input.traceback, entry.file)

    for (const symbol of entry.symbols) {
      const match = selectBestSkeletonSymbolMatch(
        skeleton.symbols,
        symbol.name,
        symbol.type,
        fileLineHints
      )

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

  if (verified.length === 0 && input.skeletons.length > 0) {
    const primarySkeleton = input.skeletons[0]
    if (primarySkeleton !== undefined) {
      const fallbackSymbols = selectSkeletonFallbackSymbols(
        primarySkeleton.symbols,
        extractLineHintsForFile(input.problemStatement, input.traceback, primarySkeleton.path),
        5
      )
      const preferredSymbols = extractPreferredFallbackSymbols(
        input.problemStatement,
        input.traceback,
        primarySkeleton
      )
      const fallbackWithPreferred = [...fallbackSymbols]

      for (const symbol of preferredSymbols) {
        if (fallbackWithPreferred.some((candidate) => candidate.name === symbol.name && candidate.type === symbol.type)) {
          continue
        }
        fallbackWithPreferred.push(symbol)
      }

      for (const symbol of fallbackWithPreferred) {
        verified.push({
          file: primarySkeleton.path,
          name: symbol.name,
          type: symbol.type,
          lineNumber: symbol.lineNumber
        })
      }

      logWarn('panel:localizer', '[Localizer] Symbol verification produced no results. Using skeleton fallback.', {
        file: primarySkeleton.path,
        symbolCount: fallbackWithPreferred.length
      })
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
  const backticked = [...text.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? '')
    .flatMap((value) => value.split('\n'))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (backticked.length > 0) {
    return backticked.slice(0, MAX_LOCALIZATION_FILES)
  }

  const stripped = text
    .replace(/^```[a-z]*\n?/im, '')
    .replace(/\n?```$/im, '')
    .trim()

  return stripped
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
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
      'symbols = []',
      '',
      'def walk(node):',
      '    if isinstance(node, ast.ClassDef):',
      '        symbols.append(("class", node.name, node.lineno))',
      '        for item in node.body:',
      '            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):',
      '                symbols.append(("function", item.name, item.lineno))',
      '        for item in node.body:',
      '            if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):',
      '                walk(item)',
      '        return',
      '',
      '    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):',
      '        symbols.append(("function", node.name, node.lineno))',
      '        return',
      '',
      '    for child in ast.iter_child_nodes(node):',
      '        walk(child)',
      '',
      'walk(tree)',
      'for symbol_type, name, lineno in symbols:',
      '    print(f"{symbol_type}\\t{name}\\t{lineno}")'
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
    const symbols: SkeletonSymbol[] = []
    const classIndents: number[] = []

    for (const [index, line] of source.split('\n').entries()) {
      if (line.trim().length === 0) {
        continue
      }

      const indentMatch = line.match(/^[ \t]*/)
      const indent = indentMatch?.[0]?.replace(/\t/g, '    ').length ?? 0

      while (classIndents.length > 0 && indent <= (classIndents[classIndents.length - 1] ?? 0)) {
        classIndents.pop()
      }

      const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (classMatch?.[1] !== undefined) {
        symbols.push({ type: 'class', name: classMatch[1], lineNumber: index + 1 })
        classIndents.push(indent)
        continue
      }

      const functionMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (functionMatch?.[1] !== undefined && (classIndents.length > 0 || indent === 0)) {
        symbols.push({ type: 'function', name: functionMatch[1], lineNumber: index + 1 })
      }
    }

    return symbols
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
  const stripped = text
    .replace(/^```[a-z]*\n?/gim, '')
    .replace(/^```\n?/gim, '')
    .trim()

  const lines = stripped.split('\n')
  const entries: Array<{ file: string; symbols: Array<{ type: SkeletonSymbol['type']; name: string }> }> = []
  let currentFile: { file: string; symbols: Array<{ type: SkeletonSymbol['type']; name: string }> } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    const symbolMatch = trimmed.match(/^(?:\s+)?(function|method|class|variable):\s+(.+)$/i)
    if (symbolMatch?.[1] !== undefined && symbolMatch[2] !== undefined) {
      if (currentFile === null) {
        continue
      }

      let rawName = symbolMatch[2].trim().replace(/`/g, '').trim()
      if (rawName.includes('.')) {
        rawName = rawName.split('.').pop() ?? rawName
      }
      const rawType = symbolMatch[1].toLowerCase()
      const symbolType: SkeletonSymbol['type'] = rawType === 'class'
        ? 'class'
        : rawType === 'variable'
          ? 'variable'
          : 'function'

      currentFile.symbols.push({
        type: symbolType,
        name: rawName
      })
      continue
    }

    if (!line.startsWith(' ') && !line.startsWith('\t') && trimmed.length > 0) {
      currentFile = { file: trimmed.replace(/`/g, '').trim(), symbols: [] }
      entries.push(currentFile)
    }
  }

  return entries
}

function selectBestSkeletonSymbolMatch(
  candidates: SkeletonSymbol[],
  symbolName: string,
  symbolType: SkeletonSymbol['type'],
  fileLineHints: number[]
): SkeletonSymbol | undefined {
  const matches = candidates.filter((candidate) => (
    candidate.name === symbolName && candidate.type === symbolType
  ))

  if (matches.length <= 1) {
    return matches[0]
  }

  if (fileLineHints.length === 0) {
    return matches[matches.length - 1]
  }

  return [...matches].sort((left, right) => {
    const leftDistance = minimumLineDistance(left.lineNumber, fileLineHints)
    const rightDistance = minimumLineDistance(right.lineNumber, fileLineHints)
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }

    return right.lineNumber - left.lineNumber
  })[0]
}

function minimumLineDistance(lineNumber: number, hints: number[]): number {
  return hints.reduce((best, hint) => Math.min(best, Math.abs(lineNumber - hint)), Number.POSITIVE_INFINITY)
}

function selectSkeletonFallbackSymbols(
  symbols: SkeletonSymbol[],
  lineHints: number[],
  limit = 3
): SkeletonSymbol[] {
  const functions = symbols.filter((symbol) => symbol.type === 'function')
  if (functions.length <= limit) {
    return functions
  }

  if (lineHints.length === 0) {
    return functions.slice(0, limit)
  }

  return [...functions]
    .sort((left, right) => compareFallbackCandidates(left, right, lineHints))
    .slice(0, limit)
}

function compareFallbackCandidates(
  left: SkeletonSymbol,
  right: SkeletonSymbol,
  lineHints: number[]
): number {
  const leftScore = contextualLineDistance(left.lineNumber, lineHints)
  const rightScore = contextualLineDistance(right.lineNumber, lineHints)

  if (leftScore !== rightScore) {
    return leftScore - rightScore
  }

  return right.lineNumber - left.lineNumber
}

function contextualLineDistance(lineNumber: number, hints: number[]): number {
  let best = Number.POSITIVE_INFINITY

  for (const hint of hints) {
    const score = lineNumber <= hint
      ? hint - lineNumber
      : (lineNumber - hint) + 80
    best = Math.min(best, score)
  }

  return best
}

function extractLineHintsForFile(
  problemStatement: string,
  traceback: string | null,
  filePath: string
): number[] {
  const hints = new Set<number>()
  const normalizedFilePath = escapeRegex(filePath.replace(/\\/g, '/'))
  const normalizedBasename = escapeRegex(filePath.split('/').at(-1) ?? filePath)
  const linePatterns = [
    new RegExp(`${normalizedFilePath}#L(\\d+)(?:-L?(\\d+))?`, 'gi'),
    new RegExp(`${normalizedBasename}#L(\\d+)(?:-L?(\\d+))?`, 'gi'),
    new RegExp(`File "\\/?[^"\\n]*${normalizedFilePath}", line (\\d+)`, 'gi'),
    new RegExp(`File "\\/?[^"\\n]*${normalizedBasename}", line (\\d+)`, 'gi')
  ]

  for (const source of [problemStatement, traceback ?? '']) {
    const barePattern = /#L(\d+)(?:-L?(\d+))?/gi
    for (const match of source.matchAll(barePattern)) {
      const first = Number.parseInt(match[1] ?? '', 10)
      const second = Number.parseInt(match[2] ?? '', 10)

      if (Number.isFinite(first) && first > 0) {
        hints.add(first)
      }

      if (Number.isFinite(second) && second > 0) {
        for (let line = first; line <= second; line += 1) {
          hints.add(line)
        }
      }
    }

    for (const pattern of linePatterns) {
      for (const match of source.matchAll(pattern)) {
        const first = Number.parseInt(match[1] ?? '', 10)
        const second = Number.parseInt(match[2] ?? '', 10)

        if (Number.isFinite(first) && first > 0) {
          hints.add(first)
        }

        if (Number.isFinite(second) && second > 0) {
          hints.add(second)
        }
      }
    }
  }

  return [...hints]
}

function extractPreferredFallbackSymbols(
  problemStatement: string,
  traceback: string | null,
  skeleton: FileSkeleton
): SkeletonSymbol[] {
  const preferredNames = new Set<string>()

  for (const source of [problemStatement, traceback ?? '']) {
    for (const match of source.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
      if (match[1] !== undefined) {
        preferredNames.add(match[1])
      }
    }

    for (const match of source.matchAll(/\bin ([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      if (match[1] !== undefined) {
        preferredNames.add(match[1])
      }
    }
  }

  return skeleton.symbols.filter((symbol) => (
    symbol.type === 'function' && preferredNames.has(symbol.name)
  ))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
