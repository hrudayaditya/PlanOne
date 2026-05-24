/**
 * Supported structured log levels.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/**
 * JSON-line payload written by the structured logger.
 */
export interface LogEntry {
  timestamp: string
  level: LogLevel
  component: string
  message: string
  data?: Record<string, unknown>
}

/**
 * Writes a structured JSON log line to stderr only.
 *
 * This logger never writes to stdout because stdout is reserved for pipeline
 * output and machine-readable command responses.
 */
export function log(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...(data === undefined ? {} : { data })
  }

  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

/**
 * Logs an error-level message to stderr as a JSON line.
 */
export function logError(component: string, message: string, data?: Record<string, unknown>): void {
  log('error', component, message, data)
}

/**
 * Logs a warning-level message to stderr as a JSON line.
 */
export function logWarn(component: string, message: string, data?: Record<string, unknown>): void {
  log('warn', component, message, data)
}

/**
 * Logs an info-level message to stderr as a JSON line.
 */
export function logInfo(component: string, message: string, data?: Record<string, unknown>): void {
  log('info', component, message, data)
}

/**
 * Logs a debug-level message to stderr as a JSON line.
 */
export function logDebug(component: string, message: string, data?: Record<string, unknown>): void {
  log('debug', component, message, data)
}
