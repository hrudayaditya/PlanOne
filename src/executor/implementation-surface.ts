import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { BaseMemoryClient } from '../basememory/client.js'
import { symbolInfo } from '../basememory/tools.js'
import type { ExecutionPlan } from '../orchestrator/plan.js'
import type { EnrichedPacket } from '../panel/synthesis.js'
import { logInfo } from '../utils/logger.js'

const MAX_SURFACE_FILES = 5
const PRELOAD_MAX_LINES = 400
const TRUNCATION_SCAN_AHEAD = 80
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.rs', '.py', '.go', '.java', '.rb', '.php', '.c', '.cpp', '.h'
])
const PRIMARY_FILE_EXCLUDE_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)__pycache__\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.opencode\//,
  /(^|\/)skills\//,
  /(^|\/)package\.json$/,
  /(^|\/)README[^/]*$/i,
  /\.md$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.lock$/i
]
const TEST_FILE_PATTERNS = [
  /\.test\.[^/]+$/i,
  /\.spec\.[^/]+$/i
]

export interface ImplementationSurface {
  primaryFiles: PrioritizedFile[]
  symbols: ConfirmedSymbol[]
  fileContents: Map<string, string>
  searchHits: SearchHit[]
  relatedTestFiles: RelatedTestFile[]
}

export interface PrioritizedFile {
  path: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
  lineCount: number
}

export interface ConfirmedSymbol {
  name: string
  filePath: string
  startLine: number
  endLine: number
}

export interface SearchHit {
  file: string
  line: number
  match: string
}

export interface RelatedTestFile {
  path: string
  confidence: 'high' | 'medium'
  sourceFile: string
  reason: string
}

export type ApproachFocus = 'runtime' | 'type' | 'mixed'
export type FileImplementationRole = 'runtime' | 'type' | 'mixed'

interface FileCandidate {
  path: string
  sourceKeys: Set<string>
  reasons: string[]
}

export interface ApproachMentions {
  files: string[]
  symbols: string[]
}

const OUT_OF_PACKAGE_SOURCE_KEY = 'out_of_package'
const TASK_RELEVANCE_SOURCE_KEY = 'task_relevance'
const TASK_RELEVANCE_STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will',
  'when', 'then', 'should', 'must', 'into', 'only', 'both', 'each',
  'which', 'their', 'there', 'been', 'were', 'also', 'during', 'after',
  'before', 'within', 'without'
])

const NOISE_SYMBOLS = new Set([
  'Client', 'Server', 'Handler', 'Router', 'Request', 'Response',
  'Context', 'Options', 'Config', 'Props', 'State', 'Store',
  'Event', 'Error', 'Result', 'Data', 'Type', 'Interface',
  'T', 'K', 'V', 'E', 'R'
])

const KEYWORD_SYMBOLS = new Set([
  'from', 'import', 'export', 'const', 'let', 'var', 'type',
  'interface', 'class', 'function', 'return', 'async', 'await'
])

const TYPE_APPROACH_PATTERNS = [
  /\binterface\b/i,
  /\btype(?:\s+definition)?\b/i,
  /\bproperty\b/i,
  /\bfield\b/i,
  /\boption\b/i,
  /\bconfiguration\s+(?:object|shape)\b/i,
  /\bextend\s+the\s+type\b/i,
  /\badd\s+(?:an?\s+)?(?:optional\s+)?(?:boolean\s+)?(?:property|field|option)\b/i
]

const RUNTIME_APPROACH_PATTERNS = [
  /\boverride\b/i,
  /\bintercept\b/i,
  /\binitialize\b/i,
  /\binject\b/i,
  /\bexecution\b/i,
  /\bbehavior\b/i,
  /\bconfigure\b.*\bruntime\b/i,
  /\bserver-side\b/i,
  /\bforce\b/i,
  /\bduring\b/i,
  /\bwhen\b.+\btrue\b/i
]

export async function buildImplementationSurface(
  enrichedPacket: EnrichedPacket,
  plan: ExecutionPlan,
  repoRoot: string,
  client: BaseMemoryClient,
  seedFiles: string[] = []
): Promise<ImplementationSurface> {
  const candidates = new Map<string, FileCandidate>()
  const confirmedSymbols: ConfirmedSymbol[] = []
  const searchHits: SearchHit[] = []
  const filteredNoiseSymbols: string[] = []
  const approachMentions = extractMentionsFromApproach(plan.approach)
  const approachSymbolHints = [...new Set(approachMentions.symbols)]

  for (const filePath of seedFiles) {
    if (filePath.length > 0) {
      addCandidate(candidates, toRepoRelativePath(repoRoot, filePath), `seed:${filePath}`, 'seeded from prior cycle')
    }
  }

  for (const chunkId of enrichedPacket.verifiedChunkIds) {
    const filePath = extractFilePathFromChunkId(chunkId, repoRoot)
    if (filePath !== null) {
      addCandidate(candidates, filePath, `verified:${chunkId}`, 'panel verified chunk')
    }
  }

  for (const chunkId of enrichedPacket.rankedApproaches.flatMap((approach) => approach.supportingChunkIds)) {
    const filePath = extractFilePathFromChunkId(chunkId, repoRoot)
    if (filePath !== null) {
      addCandidate(candidates, filePath, `approach:${chunkId}`, 'ranked approach support')
    }
  }

  for (const filePath of plan.steps.flatMap((step) => step.affectedFiles)) {
    if (filePath.length > 0) {
      addCandidate(candidates, toRepoRelativePath(repoRoot, filePath), `plan:${filePath}`, 'orchestrator affected file')
    }
  }

  for (const filePath of approachMentions.files) {
    addCandidate(candidates, resolveApproachFilePath(candidates, filePath, repoRoot), `approach_file:${filePath}`, `approach explicitly names ${filePath}`)
  }

  const symbolsForLookup = [...new Set([...enrichedPacket.affectedSymbols, ...approachSymbolHints])].filter((symbolName) => {
    if (symbolName.trim().length === 0) {
      return false
    }

    if (isNoiseSymbol(symbolName)) {
      filteredNoiseSymbols.push(symbolName)
      return false
    }

    return true
  })

  if (filteredNoiseSymbols.length > 0) {
    logInfo('executor:surface', '[Surface] Filtered noise symbols', {
      symbols: filteredNoiseSymbols
    })
  }

  logInfo('executor:surface', '[Surface] Remaining symbols for lookup', {
    symbols: symbolsForLookup
  })

  if (seedFiles.length > 0) {
    logInfo('executor:surface', '[Surface] Seeding from prior cycle', {
      files: seedFiles.map((filePath) => toRepoRelativePath(repoRoot, filePath))
    })
  }

  for (const symbolName of symbolsForLookup) {
    if (symbolName.trim().length === 0) {
      continue
    }

    try {
      const info = await symbolInfo({ symbol: symbolName, limit: 3 }, client)

      for (const result of info.results) {
        const filePath = normalizeSymbolFilePath(repoRoot, result.file_path, result.relative_path)
        if (filePath === null) {
          continue
        }

        confirmedSymbols.push({
          name: result.name ?? result.symbol ?? symbolName,
          filePath,
          startLine: result.start_line ?? 1,
          endLine: result.end_line ?? result.start_line ?? 1
        })
        addCandidate(candidates, filePath, `symbol:${symbolName}`, `confirmed symbol ${symbolName}`)
      }
    } catch {
      // Keep the surface builder non-throwing.
    }

    for (const hit of searchForSymbolHits(repoRoot, symbolName)) {
      searchHits.push(hit)
      addCandidate(candidates, hit.file, `grep:${symbolName}:${hit.file}:${hit.line}`, `local search hit for ${symbolName}`)
    }
  }

  const targetPackage = extractTargetPackage(plan.approach, enrichedPacket, repoRoot)
  if (targetPackage !== null) {
    for (const candidate of candidates.values()) {
      if (!candidate.path.includes(targetPackage)) {
        candidate.sourceKeys.add(OUT_OF_PACKAGE_SOURCE_KEY)
        if (!candidate.reasons.includes(`outside target package ${targetPackage}`)) {
          candidate.reasons.push(`outside target package ${targetPackage}`)
        }
      }
    }
  }

  for (const candidate of candidates.values()) {
    const taskRelevanceBoost = getTaskRelevanceBoost(candidate.path, enrichedPacket.structuredDescription)
    if (taskRelevanceBoost > 0) {
      candidate.sourceKeys.add(`${TASK_RELEVANCE_SOURCE_KEY}:${taskRelevanceBoost}`)
      const taskRelevanceReason = `task relevance boost (+${taskRelevanceBoost})`
      if (!candidate.reasons.includes(taskRelevanceReason)) {
        candidate.reasons.push(taskRelevanceReason)
      }
    }
  }

  const primaryFiles = [...candidates.values()]
    .filter((candidate) => !candidate.sourceKeys.has(OUT_OF_PACKAGE_SOURCE_KEY))
    .map((candidate) => toPrioritizedFile(candidate, repoRoot))
    .sort((left, right) => comparePrioritizedFiles(left, right))
    .slice(0, MAX_SURFACE_FILES)

  const fileContents = new Map<string, string>()
  const deterministicContext = enrichedPacket.implementationContext ?? {}

  for (const file of primaryFiles) {
    if (file.confidence !== 'high') {
      continue
    }

    const prelocalizedContent = deterministicContext[file.path]
    if (typeof prelocalizedContent === 'string' && prelocalizedContent.length > 0) {
      fileContents.set(file.path, prelocalizedContent)
      continue
    }

    try {
      const absolutePath = resolve(repoRoot, file.path)
      const content = readFileSync(absolutePath, 'utf8')
      fileContents.set(file.path, truncateFileContent(content, PRELOAD_MAX_LINES))
    } catch {
      // Ignore unreadable files and preserve a non-throwing surface build.
    }
  }

  return {
    primaryFiles,
    symbols: dedupeConfirmedSymbols(confirmedSymbols),
    fileContents,
    searchHits: dedupeSearchHits(searchHits),
    relatedTestFiles: []
  }
}

export function attachRelatedTestFiles(
  surface: ImplementationSurface,
  confirmedImplementationFiles: string[],
  repoRoot: string
): ImplementationSurface {
  return {
    ...surface,
    relatedTestFiles: discoverRelatedTestFiles(confirmedImplementationFiles, repoRoot)
  }
}

export function discoverRelatedTestFiles(
  confirmedImplementationFiles: string[],
  repoRoot: string
): RelatedTestFile[] {
  const repoFiles = listRepoFiles(repoRoot)
  const repoFileSet = new Set(repoFiles)
  const basenameCounts = new Map<string, number>()

  for (const filePath of repoFiles) {
    basenameCounts.set(
      basename(filePath, extname(filePath)).toLowerCase(),
      (basenameCounts.get(basename(filePath, extname(filePath)).toLowerCase()) ?? 0) + 1
    )
  }

  const discovered = new Map<string, RelatedTestFile>()

  for (const sourceFile of confirmedImplementationFiles) {
    const stem = basename(sourceFile, extname(sourceFile))
    const sourceDir = dirname(sourceFile)
    const basenameCount = basenameCounts.get(stem.toLowerCase()) ?? 0
    const mirroredDir = sourceDir === '.' ? 'tests' : join('tests', sourceDir)
    const candidates = [
      { path: join('tests', `test_${stem}.py`), specificity: 'root_python' as const },
      { path: join('tests', `unittest_${stem}.py`), specificity: 'root_python' as const },
      { path: join('tests', `${stem}_test.py`), specificity: 'root_python' as const },
      { path: join('test', `test_${stem}.py`), specificity: 'root_python' as const },
      { path: join('test', `unittest_${stem}.py`), specificity: 'root_python' as const },
      { path: join(sourceDir, `test_${stem}.py`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `unittest_${stem}.py`), specificity: 'same_dir' as const },
      { path: join(mirroredDir, `test_${stem}.py`), specificity: 'mirrored' as const },
      { path: join(mirroredDir, `unittest_${stem}.py`), specificity: 'mirrored' as const },
      { path: join(sourceDir, `${stem}.test.ts`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.test.tsx`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.test.js`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.test.jsx`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.spec.ts`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.spec.tsx`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.spec.js`), specificity: 'same_dir' as const },
      { path: join(sourceDir, `${stem}.spec.jsx`), specificity: 'same_dir' as const },
      { path: join('__tests__', `${stem}.test.ts`), specificity: 'root_js' as const },
      { path: join('__tests__', `${stem}.test.js`), specificity: 'root_js' as const },
      { path: join('__tests__', `${stem}.spec.ts`), specificity: 'root_js' as const },
      { path: join('__tests__', `${stem}.spec.js`), specificity: 'root_js' as const },
      { path: join('src', `${stem}.test.ts`), specificity: 'root_js' as const },
      { path: join('src', `${stem}.spec.ts`), specificity: 'root_js' as const }
    ]

    for (const candidate of candidates) {
      const normalizedCandidate = normalizeRelativePath(candidate.path)
      if (!repoFileSet.has(normalizedCandidate) || normalizedCandidate === normalizeRelativePath(sourceFile)) {
        continue
      }

      const candidateBasename = basename(normalizedCandidate)
      const isUniqueBasename = basenameCount <= 1
      const confidence: 'high' | 'medium' = isUniqueBasename ? 'high' : 'medium'
      const reason = `naming convention: ${candidateBasename} for ${basename(sourceFile)}`
      const existing = discovered.get(normalizedCandidate)

      if (existing === undefined || (existing.confidence === 'medium' && confidence === 'high')) {
        discovered.set(normalizedCandidate, {
          path: normalizedCandidate,
          confidence,
          sourceFile: normalizeRelativePath(sourceFile),
          reason
        })
      }
    }
  }

  return [...discovered.values()].sort((left, right) => {
    const confidenceDelta = compareConfidence(right.confidence) - compareConfidence(left.confidence)
    if (confidenceDelta !== 0) {
      return confidenceDelta
    }

    return left.path.localeCompare(right.path)
  })
}

export function extractFilePathFromChunkId(chunkId: string, repoRoot: string): string | null {
  const match = chunkId.match(/((?:[A-Za-z]:)?[^:]+?\.[A-Za-z0-9]+):\d+-\d+$/)

  if (match?.[1] === undefined) {
    return null
  }

  return toRepoRelativePath(repoRoot, match[1])
}

function normalizeSymbolFilePath(
  repoRoot: string,
  filePath?: string,
  relativePath?: string
): string | null {
  if (typeof relativePath === 'string' && relativePath.length > 0) {
    return toRepoRelativePath(repoRoot, relativePath)
  }

  if (typeof filePath === 'string' && filePath.length > 0) {
    return toRepoRelativePath(repoRoot, filePath)
  }

  return null
}

function addCandidate(
  candidates: Map<string, FileCandidate>,
  filePath: string,
  sourceKey: string,
  reason: string
): void {
  if (!isCodeFile(filePath) || isExcludedPrimaryFile(filePath)) {
    return
  }

  const existing = candidates.get(filePath)

  if (existing === undefined) {
    candidates.set(filePath, {
      path: filePath,
      sourceKeys: new Set([sourceKey]),
      reasons: [reason]
    })
    return
  }

  existing.sourceKeys.add(sourceKey)
  if (!existing.reasons.includes(reason)) {
    existing.reasons.push(reason)
  }
}

function toPrioritizedFile(candidate: FileCandidate, repoRoot: string): PrioritizedFile {
  const sourceCount = candidate.sourceKeys.size
  const points = scoreCandidate(candidate)
  const confidence = points >= 3 ? 'high' : points >= 1 ? 'medium' : 'low'
  const lineCount = countFileLines(repoRoot, candidate.path)

  return {
    path: candidate.path,
    confidence,
    reason: `${candidate.reasons[0] ?? 'selected by controller'} (${sourceCount} source${sourceCount === 1 ? '' : 's'}, ${points} point${points === 1 ? '' : 's'})`,
    lineCount
  }
}

function scoreCandidate(candidate: FileCandidate): number {
  if (candidate.sourceKeys.has(OUT_OF_PACKAGE_SOURCE_KEY)) {
    return 0
  }

  let points = 0

  for (const sourceKey of candidate.sourceKeys) {
    if (sourceKey.startsWith('seed:')) {
      points += 10
      continue
    }

    if (sourceKey.startsWith('verified:') || sourceKey.startsWith('approach:') || sourceKey.startsWith('symbol:')) {
      points += 2
      continue
    }

    if (sourceKey.startsWith('approach_file:')) {
      points += 3
      continue
    }

    if (sourceKey.startsWith(`${TASK_RELEVANCE_SOURCE_KEY}:`)) {
      const boost = Number(sourceKey.split(':')[1] ?? '0')
      points += Number.isFinite(boost) ? boost : 0
      continue
    }

    if (sourceKey.startsWith('grep:') || sourceKey.startsWith('plan:')) {
      points += 1
    }
  }

  return points
}

export function extractTargetPackage(approach: string, enrichedPacket: EnrichedPacket, repoRoot?: string): string | null {
  const packageMatch = approach.match(/packages\/([a-z-]+)\//i)
  if (packageMatch?.[1] !== undefined) {
    return `packages/${packageMatch[1]}/`
  }

  const affectedAreaPackage = extractPackageFromAffectedArea(enrichedPacket.affectedArea, repoRoot)
  if (affectedAreaPackage !== null) {
    return affectedAreaPackage
  }

  for (const chunkPath of enrichedPacket.verifiedChunkIds.map((chunkId) => chunkId.split(':')[0] ?? '')) {
    const normalizedPath = chunkPath.replace(/\\/g, '/')
    const packagePathMatch = normalizedPath.match(/(?:^|\/)(packages|apps)\/([^/]+)\//i)
    if (packagePathMatch !== null) {
      return `${packagePathMatch[1]}/${packagePathMatch[2]}/`
    }
  }

  return null
}

export function getTaskRelevanceBoost(filePath: string, taskDescription: string): number {
  const rawTaskWords = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TASK_RELEVANCE_STOP_WORDS.has(word))
  const significantTaskWords = rawTaskWords.filter((word) => word.length > 3 || /^[a-z]{3}$/.test(word))
  const fileTokens = tokenizePathWords(filePath)
  const compactFilePath = filePath.toLowerCase().replace(/[^a-z0-9]/g, '')
  const exactMatches = new Set(significantTaskWords.filter((word) => fileTokens.has(word)))
  const shortSpecificMatches = [...exactMatches].filter((word) => word.length <= 3)
  const acronymMatches = buildTaskAcronyms(rawTaskWords)
    .filter((acronym) => acronym.length >= 3 && compactFilePath.includes(acronym))

  if (exactMatches.size >= 2 || acronymMatches.length > 0 || shortSpecificMatches.length > 0) {
    return 3
  }

  if (exactMatches.size === 1) {
    return 1
  }

  return 0
}

function extractPackageFromAffectedArea(affectedArea: string, repoRoot?: string): string | null {
  const scopedPackageMatch = affectedArea.match(/@[\w-]+\/([\w-]+)/)
  if (scopedPackageMatch?.[1] !== undefined) {
    const packageName = scopedPackageMatch[1]
    const candidates = [
      `packages/${packageName}/`,
      `apps/${packageName}/`
    ]

    for (const candidate of candidates) {
      if (repoRoot === undefined || existsSync(resolve(repoRoot, candidate))) {
        return candidate
      }
    }
  }

  return null
}

export function classifyApproachFocus(approach: string): ApproachFocus {
  const typeSignals = TYPE_APPROACH_PATTERNS.filter((pattern) => pattern.test(approach)).length
  const runtimeSignals = RUNTIME_APPROACH_PATTERNS.filter((pattern) => pattern.test(approach)).length

  if (runtimeSignals > typeSignals) {
    return 'runtime'
  }

  if (typeSignals > runtimeSignals) {
    return 'type'
  }

  return 'mixed'
}

export function classifyFileImplementationRole(content: string): FileImplementationRole {
  const strippedLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))

  let typeScore = 0
  let runtimeScore = 0

  for (const line of strippedLines) {
    if (/^(?:export\s+)?interface\b/.test(line) || /^(?:export\s+)?type\b/.test(line)) {
      typeScore += 2
    }

    if (/\b(?:function|return|await|if|for|while|switch|throw|new)\b/.test(line)) {
      runtimeScore += 2
    }

    if (/^(?:export\s+)?const\b/.test(line) || /=>/.test(line)) {
      runtimeScore += 1
    }
  }

  if (runtimeScore > typeScore) {
    return 'runtime'
  }

  if (typeScore > runtimeScore) {
    return 'type'
  }

  return 'mixed'
}

function tokenizePathWords(filePath: string): Set<string> {
  const segments = filePath
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .flatMap((segment) => splitCamelCase(segment))
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0)
  return new Set(segments)
}

function splitCamelCase(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
}

function listRepoFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync('rg', ['--files', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    return output
      .split('\n')
      .map((line) => normalizeRelativePath(line))
      .filter((line) => line.length > 0)
  } catch {
    return walkRepoFiles(repoRoot)
  }
}

function walkRepoFiles(repoRoot: string, currentDir = ''): string[] {
  const absoluteDir = currentDir.length > 0 ? resolve(repoRoot, currentDir) : repoRoot
  const entries = readdirSync(absoluteDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const relativePath = normalizeRelativePath(currentDir.length > 0 ? join(currentDir, entry.name) : entry.name)

    if (entry.isDirectory()) {
      if (PRIMARY_FILE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(`${relativePath}/`))) {
        continue
      }
      files.push(...walkRepoFiles(repoRoot, relativePath))
      continue
    }

    files.push(relativePath)
  }

  return files
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function compareConfidence(confidence: 'high' | 'medium'): number {
  return confidence === 'high' ? 2 : 1
}

function buildTaskAcronyms(words: string[]): string[] {
  const acronyms = new Set<string>()

  for (let start = 0; start < words.length; start += 1) {
    for (let size = 2; size <= 4 && start + size <= words.length; size += 1) {
      const slice = words.slice(start, start + size)
      if (slice.some((word) => word.length === 0)) {
        continue
      }
      acronyms.add(slice.map((word) => word[0]).join(''))
    }
  }

  return [...acronyms]
}

function isNoiseSymbol(name: string): boolean {
  if (name.length < 4) {
    return true
  }

  if (NOISE_SYMBOLS.has(name)) {
    return true
  }

  return KEYWORD_SYMBOLS.has(name)
}

export function isCodeFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return CODE_EXTENSIONS.has(ext)
}

export function extractMentionsFromApproach(approach: string): ApproachMentions {
  const fileMatches = [...approach.matchAll(/\b([\w./-]+\.(?:tsx?|jsx?))\b/g)]
    .map((match) => match[1] ?? '')
    .filter((value) => value.length > 0)
  const backtickedSymbols = [...approach.matchAll(/`([A-Za-z][A-Za-z0-9_]+)`/g)]
    .map((match) => match[1] ?? '')
  const contextualSymbols = [...approach.matchAll(/\b(?:to|in|for|the)\s+([A-Za-z][A-Za-z0-9_]+)\b/g)]
    .flatMap((match) => {
      const value = match[1] ?? ''
      const matchIndex = match.index ?? -1
      const trailingText = matchIndex >= 0
        ? approach.slice(matchIndex + match[0].length)
        : ''

      if (!/[A-Z]/.test(value) || trailingText.startsWith('.ts') || trailingText.startsWith('.js')) {
        return []
      }

      return [value]
    })

  return {
    files: [...new Set(fileMatches)],
    symbols: [...new Set([...backtickedSymbols, ...contextualSymbols])]
  }
}

function isExcludedPrimaryFile(filePath: string): boolean {
  if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return true
  }

  return PRIMARY_FILE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(filePath))
}

function resolveApproachFilePath(
  candidates: Map<string, FileCandidate>,
  filePath: string,
  repoRoot: string
): string {
  const normalizedPath = toRepoRelativePath(repoRoot, filePath)

  if (candidates.has(normalizedPath)) {
    return normalizedPath
  }

  const basename = filePath.split('/').at(-1) ?? filePath
  const existing = [...candidates.keys()].find((candidatePath) => candidatePath.endsWith(`/${basename}`) || candidatePath === basename)
  return existing ?? normalizedPath
}

function countFileLines(repoRoot: string, filePath: string): number {
  try {
    const content = readFileSync(resolve(repoRoot, filePath), 'utf8')
    return content.split('\n').length
  } catch {
    return 0
  }
}

function comparePrioritizedFiles(left: PrioritizedFile, right: PrioritizedFile): number {
  const confidenceScore = { high: 3, medium: 2, low: 1 }
  const confidenceDiff = confidenceScore[right.confidence] - confidenceScore[left.confidence]

  if (confidenceDiff !== 0) {
    return confidenceDiff
  }

  return left.path.localeCompare(right.path)
}

function truncateFileContent(content: string, maxLines: number): string {
  const lines = content.split('\n')

  if (lines.length <= maxLines) {
    return content
  }

  let endIndex = maxLines

  for (let index = maxLines; index < Math.min(lines.length, maxLines + TRUNCATION_SCAN_AHEAD); index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '' || /^}\)?[;,]?$/.test(line)) {
      endIndex = index + 1
      break
    }
  }

  return `${lines.slice(0, endIndex).join('\n')}\n/* truncated by PlanOne */`
}

function searchForSymbolHits(repoRoot: string, symbolName: string): SearchHit[] {
  const output = runSearchProcess('rg', ['-n', '--no-heading', '-m', '3', symbolName, repoRoot])
    ?? runSearchProcess('grep', ['-RIn', '-m', '3', symbolName, repoRoot])

  if (output === null || output.trim().length === 0) {
    return []
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/)
      if (match === null) {
        return []
      }

      return [{
        file: toRepoRelativePath(repoRoot, match[1] ?? ''),
        line: Number(match[2] ?? '1'),
        match: (match[3] ?? '').trim()
      }]
    })
}

function runSearchProcess(binary: string, args: string[]): string | null {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

function dedupeConfirmedSymbols(symbols: ConfirmedSymbol[]): ConfirmedSymbol[] {
  const seen = new Set<string>()
  const results: ConfirmedSymbol[] = []

  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.filePath}:${symbol.startLine}:${symbol.endLine}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    results.push(symbol)
  }

  return results
}

function dedupeSearchHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const results: SearchHit[] = []

  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}:${hit.match}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    results.push(hit)
  }

  return results
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  const repoRootAbsolute = resolve(repoRoot)
  const targetAbsolute = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(repoRootAbsolute, filePath)
  const relativeTarget = relative(repoRootAbsolute, targetAbsolute)

  if (relativeTarget.length === 0) {
    return '.'
  }

  if (!relativeTarget.startsWith('..') && !isAbsolute(relativeTarget)) {
    return relativeTarget
  }

  return filePath.replace(/^\/+/, '')
}
