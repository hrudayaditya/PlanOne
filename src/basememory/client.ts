import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

import { logDebug } from '../utils/logger.js'

const DEFAULT_HTTP_URL = 'http://localhost:3000'
const DEFAULT_STDIO_COMMAND = 'npx'
const DEFAULT_STDIO_PACKAGE = 'opencode-codebase-index-mcp'

/**
 * BaseMemory client transport selection for Week 1.
 */
export type BaseMemoryTransport = 'http' | 'stdio'

/**
 * User-provided configuration for establishing a BaseMemory MCP connection.
 *
 * `projectRoot` and `configPath` are used to construct the default stdio MCP
 * launch command documented by BaseMemory. HTTP remains available only as an
 * explicit override for environments that add a separate transport layer.
 */
export interface BaseMemoryClientConfig {
  transport?: BaseMemoryTransport
  projectRoot?: string
  configPath?: string
  url?: string
  stdio?: StdioServerParameters
}

/**
 * Minimal structured tool result returned by the MCP client.
 */
export interface BaseMemoryToolResult {
  structuredContent?: Record<string, unknown>
  content?: unknown[]
  isError?: boolean
}

/**
 * Thin wrapper around the MCP SDK client with BaseMemory-aligned transport
 * behavior.
 */
export class BaseMemoryClient {
  private readonly client: Client
  private currentTransport: StreamableHTTPClientTransport | StdioClientTransport | null = null
  private connected = false

  /**
   * Creates a BaseMemory MCP client wrapper with stable client metadata.
   */
  constructor() {
    this.client = new Client(
      { name: 'planone', version: '0.1.0' },
      { capabilities: {} }
    )
  }

  /**
   * Connects to BaseMemory using stdio by default.
   *
   * This matches the documented BaseMemory usage model, where the MCP client
   * launches the BaseMemory CLI with `--project` and optional `--config`.
   * HTTP is supported only when explicitly requested by configuration.
   */
  async connect(config: BaseMemoryClientConfig = {}): Promise<void> {
    if (this.connected) {
      return
    }

    const transport = config.transport ?? 'stdio'

    if (transport === 'http') {
      await this.connectHttp(config.url ?? DEFAULT_HTTP_URL)
      return
    }

    await this.connectStdio(config)
  }

  /**
   * Disconnects from the current transport if connected.
   */
  async disconnect(): Promise<void> {
    if (this.currentTransport === null) {
      this.connected = false
      return
    }

    await this.currentTransport.close()
    this.currentTransport = null
    this.connected = false
  }

  /**
   * Reports whether the MCP client currently has an active connection.
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Calls a BaseMemory MCP tool through the shared client abstraction.
   *
   * All tool access must go through this method; direct MCP tool access is not
   * allowed in PlanOne.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<BaseMemoryToolResult> {
    if (!this.connected) {
      throw new Error('BaseMemory client is not connected.')
    }

    const result = await this.client.callTool({ name, arguments: args }, CallToolResultSchema)

    if ('toolResult' in result) {
      throw new Error(`BaseMemory tool "${name}" returned a compatibility payload without structured content.`)
    }

    return {
      structuredContent: result.structuredContent,
      content: result.content,
      isError: result.isError
    }
  }

  private async connectHttp(url: string): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await this.client.connect(transport)
    this.currentTransport = transport
    this.connected = true
    logDebug('basememory-client', 'Connected over HTTP transport.', { url })
  }

  private async connectStdio(config: BaseMemoryClientConfig): Promise<void> {
    const stdio = config.stdio ?? buildDefaultStdioParameters(config)
    const transport = new StdioClientTransport(stdio)

    await this.client.connect(transport)
    this.currentTransport = transport
    this.connected = true
    logDebug('basememory-client', 'Connected over stdio transport.', {
      command: stdio.command,
      args: stdio.args ?? []
    })
  }
}

/**
 * Builds the documented default stdio launch parameters for BaseMemory.
 *
 * The default command is `npx opencode-codebase-index-mcp --project
 * <projectRoot>`, with `--config <path>` added when `configPath` is provided.
 */
export function buildDefaultStdioParameters(config: BaseMemoryClientConfig = {}): StdioServerParameters {
  const projectRoot = config.projectRoot ?? process.cwd()
  const args = [DEFAULT_STDIO_PACKAGE, '--project', projectRoot]

  if (config.configPath !== undefined) {
    args.push('--config', config.configPath)
  }

  return {
    command: DEFAULT_STDIO_COMMAND,
    args,
    stderr: 'inherit'
  }
}

let defaultClient: BaseMemoryClient | null = null

/**
 * Creates, connects, and registers the process-wide default BaseMemory client.
 *
 * The default client is what the Week 1 tool wrappers use when no explicit
 * client is provided.
 */
export async function createClient(config: BaseMemoryClientConfig = {}): Promise<BaseMemoryClient> {
  const client = new BaseMemoryClient()
  await client.connect(config)
  defaultClient = client
  return client
}

/**
 * Returns the registered default BaseMemory client.
 *
 * Throws when `createClient()` has not been called yet.
 */
export function getDefaultClient(): BaseMemoryClient {
  if (defaultClient === null) {
    throw new Error('BaseMemory client has not been created. Call createClient() first.')
  }

  return defaultClient
}
