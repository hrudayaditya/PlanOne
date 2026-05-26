import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface LlmTranscriptContext {
  taskId?: string
  cycleNumber?: number | null
  stepIndex?: number | null
  stage?: string
  memberId?: string
}

export interface LlmTranscriptEntry {
  timestamp: string
  provider: 'openrouter' | 'gemini' | 'anthropic' | 'nvidia' | 'groq'
  operation: string
  model: string
  context?: LlmTranscriptContext
  request: Record<string, unknown>
  response?: Record<string, unknown>
  error?: Record<string, unknown>
}

const LOG_DIR = path.resolve(process.cwd(), 'logs')
const GLOBAL_LOG_FILE = path.join(LOG_DIR, 'llm-transcripts.jsonl')
const TRANSCRIPT_DIR = path.join(LOG_DIR, 'llm-transcripts')
const transcriptContextStorage = new AsyncLocalStorage<LlmTranscriptContext>()

export async function withLlmTranscriptContext<T>(
  context: LlmTranscriptContext,
  callback: () => Promise<T>
): Promise<T> {
  return await transcriptContextStorage.run(context, callback)
}

export function appendLlmTranscript(entry: Omit<LlmTranscriptEntry, 'timestamp'>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    mkdirSync(TRANSCRIPT_DIR, { recursive: true })
    const context = transcriptContextStorage.getStore()
    const payload: LlmTranscriptEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
      context
    }
    const taskId = sanitizePathSegment(context?.taskId ?? 'unknown-task')
    const taskJsonlFile = path.join(TRANSCRIPT_DIR, `${taskId}.jsonl`)
    const taskPrettyFile = path.join(TRANSCRIPT_DIR, `${taskId}.pretty.log`)

    appendFileSync(GLOBAL_LOG_FILE, `${JSON.stringify(payload)}\n`, 'utf8')
    appendFileSync(taskJsonlFile, `${JSON.stringify(payload)}\n`, 'utf8')
    appendFileSync(taskPrettyFile, formatPrettyTranscript(payload), 'utf8')
  } catch {
    // Transcript logging must never break the pipeline.
  }
}

function formatPrettyTranscript(entry: LlmTranscriptEntry): string {
  return [
    '============================================================',
    `${entry.timestamp}  ${entry.provider.toUpperCase()}  ${entry.operation}`,
    `model: ${entry.model}`,
    `task: ${entry.context?.taskId ?? 'unknown'}  cycle: ${entry.context?.cycleNumber ?? '-'}  step: ${entry.context?.stepIndex ?? '-'}  stage: ${entry.context?.stage ?? '-'}  member: ${entry.context?.memberId ?? '-'}`,
    '--- request ---',
    JSON.stringify(entry.request, null, 2),
    entry.response === undefined ? '' : [
      '--- response ---',
      JSON.stringify(entry.response, null, 2)
    ].join('\n'),
    entry.error === undefined ? '' : [
      '--- error ---',
      JSON.stringify(entry.error, null, 2)
    ].join('\n'),
    ''
  ].filter((part) => part.length > 0).join('\n')
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}
