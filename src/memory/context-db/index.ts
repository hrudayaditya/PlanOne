import type { BaseMemoryClient } from '../../basememory/client.js'
import { checkAdmission, type AMACDecision } from './amac.js'
import { runMemoryUseGate, type GateResult } from './memory-use-gate.js'
import { routeQuery, type QueryInput, type QueryResult } from './query-router.js'
import type { ContextChunk } from './schema.js'

/**
 * Public Phase 1 in-process ContextDB interface.
 */
export class ContextDB {
  private readonly store: Map<string, ContextChunk>
  private readonly client: BaseMemoryClient

  /**
   * Creates an empty in-process ContextDB bound to a BaseMemory client.
   */
  constructor(client: BaseMemoryClient) {
    this.client = client
    this.store = new Map<string, ContextChunk>()
  }

  /**
   * Queries the in-process ContextDB using the routing ladder.
   */
  async query(input: QueryInput): Promise<QueryResult> {
    return routeQuery(input, this.store, this.client)
  }

  /**
   * Runs admission control and stores a candidate when admitted.
   */
  async admit(candidate: ContextChunk, verifierApproved: boolean): Promise<AMACDecision> {
    const decision = await checkAdmission(candidate, [...this.store.values()], verifierApproved)

    if (decision.admitted) {
      this.store.set(candidate.chunk_id, candidate)
    }

    return decision
  }

  /**
   * Validates a stored chunk through the Memory Use Gate.
   */
  async validate(chunk_id: string): Promise<GateResult | null> {
    const chunk = this.store.get(chunk_id)

    if (chunk === undefined) {
      return null
    }

    return runMemoryUseGate(chunk, this.client)
  }

  /**
   * Returns the current number of stored ContextDB chunks.
   */
  size(): number {
    return this.store.size
  }

  /**
   * Returns all stored chunks as a plain array.
   */
  getAll(): ContextChunk[] {
    return [...this.store.values()]
  }
}
