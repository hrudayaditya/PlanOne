import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export interface EnvLoadResult {
  loadedFiles: string[]
  loadedKeys: string[]
}

export function loadEnvFiles(cwd: string = process.cwd()): EnvLoadResult {
  const loadedFiles: string[] = []
  const loadedKeys = new Set<string>()
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local')
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }

    const parsed = parseEnvFile(readFileSync(candidate, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] !== undefined) {
        continue
      }

      process.env[key] = value
      loadedKeys.add(key)
    }

    loadedFiles.push(candidate)
  }

  return {
    loadedFiles,
    loadedKeys: [...loadedKeys]
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()

    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separatorIndex = normalized.indexOf('=')

    if (separatorIndex <= 0) {
      continue
    }

    const key = normalized.slice(0, separatorIndex).trim()
    let value = normalized.slice(separatorIndex + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    } else {
      const commentIndex = value.indexOf(' #')
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim()
      }
    }

    if (key.length > 0) {
      entries[key] = value
    }
  }

  return entries
}
