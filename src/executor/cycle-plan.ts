import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

import type { EnrichedPacket } from '../panel/synthesis.js'
import type { ExecutionPlan } from '../orchestrator/plan.js'

export interface CyclePlan {
  targetFiles: string[]
  targetSymbols: string[]
  primaryFile: string
  primarySymbol: string | null
  estimatedRisk: 'low' | 'medium' | 'high'
  allowedScope: string[]
  intendedAction: string
  reasoning: string
}

export function buildCyclePlan(
  plan: ExecutionPlan,
  enrichedPacket: EnrichedPacket,
  confirmedFiles: string[],
  preloadedFileContents: Map<string, string>
): CyclePlan {
  const targetFiles = confirmedFiles.filter((filePath, index, items) => items.indexOf(filePath) === index)
  const contentSymbols = [...new Set(targetFiles.flatMap((filePath) => extractSymbolsFromContent(preloadedFileContents.get(filePath) ?? '')))]
  const targetSymbols = [...new Set([
    ...sanitizeSymbols(enrichedPacket.affectedSymbols),
    ...sanitizeSymbols(plan.steps.flatMap((step) => step.affectedSymbols)),
    ...contentSymbols
  ])]
  const primaryFile = targetFiles[0] ?? plan.steps.flatMap((step) => step.affectedFiles)[0] ?? ''
  const primarySymbol = contentSymbols[0]
    ?? targetSymbols.find((symbol) => {
      if (primaryFile.length === 0) {
        return false
      }

      const stem = basename(primaryFile, extname(primaryFile)).toLowerCase()
      const normalizedSymbol = symbol.toLowerCase()
      return normalizedSymbol.includes(stem) || stem.includes(normalizedSymbol)
    })
    ?? targetSymbols[0]
    ?? null

  return {
    targetFiles,
    targetSymbols,
    primaryFile,
    primarySymbol,
    estimatedRisk: deriveEstimatedRisk(plan),
    allowedScope: [...new Set([...targetFiles, ...targetSymbols])],
    intendedAction: plan.approach.length > 0 ? plan.approach : plan.steps[0]?.description ?? enrichedPacket.structuredDescription,
    reasoning: enrichedPacket.primaryRootCause
  }
}

export function loadConfirmedFileContents(repoRoot: string, confirmedFiles: string[]): Map<string, string> {
  const contents = new Map<string, string>()

  for (const filePath of confirmedFiles) {
    try {
      contents.set(filePath, readFileSync(resolve(repoRoot, filePath), 'utf8'))
    } catch {
      continue
    }
  }

  return contents
}

function deriveEstimatedRisk(plan: ExecutionPlan): 'low' | 'medium' | 'high' {
  if (plan.steps.some((step) => step.estimatedRisk === 'high')) {
    return 'high'
  }

  if (plan.steps.some((step) => step.estimatedRisk === 'medium')) {
    return 'medium'
  }

  return 'low'
}

function sanitizeSymbols(symbols: string[]): string[] {
  return symbols
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length >= 2 && !symbol.includes(' ') && /^[a-zA-Z_$][a-zA-Z0-9_$.:>\-]*$/.test(symbol))
}

function extractSymbolsFromContent(content: string): string[] {
  const patterns = [
    /\bexport\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
    /\bexport\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bexport\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
    /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  ]
  const matches = new Set<string>()

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const symbol = match[1]
      if (symbol !== undefined) {
        matches.add(symbol)
      }
    }
  }

  return [...matches]
}
