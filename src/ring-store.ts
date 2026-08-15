/**
 * Bounded in-memory retention for request flight records.
 * @module dsh-request-flight-recorder/ring-store
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  FlightRecord,
  FlightRecordQuery,
  RequestAttemptId,
} from './types.js'

/** Insertion-ordered bounded store with newest-first immutable queries. */
export class FlightRingStore {
  private readonly records = new Map<RequestAttemptId, FlightRecord>()
  private readonly order: RequestAttemptId[] = []

  /** Number of records currently retained. */
  get size(): number {
    return this.records.size
  }

  /**
   * Create a bounded record store.
   * @param capacity - maximum retained records.
   */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive safe integer')
    }
  }

  /**
   * Retain a new request record.
   * @param record - unique request-attempt record.
   */
  insert(record: FlightRecord): FlightRecord | undefined {
    if (this.records.has(record.id)) {
      throw new Error(`request attempt already exists: ${record.id}`)
    }
    this.records.set(record.id, deepFreeze(record))
    this.order.push(record.id)
    if (this.order.length <= this.capacity) return undefined
    const evictedId = this.order.shift()!
    const evicted = this.records.get(evictedId)!
    this.records.delete(evictedId)
    return evicted
  }

  /**
   * Replace one retained record without changing recency order.
   * @param id - retained request-attempt identity.
   * @param update - pure replacement callback.
   */
  update(
    id: RequestAttemptId,
    update: (record: FlightRecord) => FlightRecord,
  ): void {
    const current = this.records.get(id)
    if (current === undefined) return
    this.records.set(id, deepFreeze(update(current)))
  }

  /**
   * List retained records from newest to oldest.
   * @param query - optional session filter.
   * @returns a frozen detached array of immutable records.
   */
  list(query: FlightRecordQuery = {}): readonly FlightRecord[] {
    if (
      query.limit !== undefined
      && (!Number.isSafeInteger(query.limit) || query.limit <= 0)
    ) {
      throw new RangeError('limit must be a positive safe integer')
    }
    const result: FlightRecord[] = []
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index]!
      const record = this.records.get(id)!
      if (query.sessionId !== undefined && record.sessionId !== query.sessionId) continue
      if (query.turn !== undefined && record.turn !== query.turn) continue
      if (query.step !== undefined && record.step !== query.step) continue
      if (query.provider !== undefined && record.request.provider !== query.provider) continue
      if (query.model !== undefined && record.request.model !== query.model) continue
      if (query.outcome !== undefined && record.outcome.kind !== query.outcome) continue
      result.push(record)
      if (query.limit !== undefined && result.length >= query.limit) break
    }
    return Object.freeze(result)
  }

  /**
   * Read one retained record.
   * @param id - request-attempt identity.
   * @returns the immutable record when retained.
   */
  get(id: RequestAttemptId): FlightRecord | undefined {
    return this.records.get(id)
  }

  /**
   * Read the newest retained record.
   * @param sessionId - optional session filter.
   * @returns the newest matching immutable record.
   */
  latest(sessionId?: SessionId): FlightRecord | undefined {
    return this.list(sessionId === undefined ? {} : { sessionId })[0]
  }

  /** Remove every retained record. */
  clear(): void {
    this.records.clear()
    this.order.length = 0
  }
}
