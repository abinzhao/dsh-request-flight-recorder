/**
 * Transactional process-local state for request flight records.
 * @module dsh-request-flight-recorder/recorder-state
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { diffFlightRecords } from './diff.js'
import { hasFlightRecordOmissions } from './limits.js'
import { FlightRingStore } from './ring-store.js'
import { FlightSubscriptions } from './subscriptions.js'
import {
  FLIGHT_RECORDER_PROTOCOL_VERSION,
  FLIGHT_RECORD_SCHEMA_VERSION,
  type CorrelationMissReason,
  type FlightDiffResult,
  type FlightOutcome,
  type FlightRecord,
  type FlightRecordQuery,
  type FlightRecorderHealth,
  type FlightRecorderInfo,
  type FlightRecorderListener,
  type FlightRecorderReader,
  type FlightRecorderSnapshot,
  type RequestAttemptId,
} from './types.js'

export const RECORDER_INFO: FlightRecorderInfo = deepFreeze({
  protocolVersion: FLIGHT_RECORDER_PROTOCOL_VERSION,
  recordSchemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
  capabilities: ['diff', 'health', 'query', 'snapshot', 'subscribe'],
})

function emptyCorrelationMissesByReason(): Record<CorrelationMissReason, number> {
  return {
    'missing-signal': 0,
    'missing-pending': 0,
    'agent-mismatch': 0,
    'session-mismatch': 0,
  }
}

/** Internal transaction owner behind the stable read-only service. */
export class FlightRecorderState implements FlightRecorderReader {
  private readonly store: FlightRingStore
  private readonly subscriptions: FlightSubscriptions
  private readonly activeIds = new Set<RequestAttemptId>()
  private captured = 0
  private completed = 0
  private evicted = 0
  private truncatedRecords = 0
  private correlationMisses = 0
  private correlationMissesByReason = emptyCorrelationMissesByReason()
  private projectionFailures = 0
  private subscriberFailures = 0
  private revision = 0
  private disposed = false

  constructor(capacity: number) {
    this.store = new FlightRingStore(capacity)
    this.subscriptions = new FlightSubscriptions(() => {
      this.subscriberFailures += 1
    })
  }

  info(): FlightRecorderInfo {
    return RECORDER_INFO
  }

  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot {
    return deepFreeze({
      info: this.info(),
      revision: this.revision,
      health: this.health(),
      records: this.store.list(query),
    })
  }

  subscribe(listener: FlightRecorderListener): () => void {
    return this.subscriptions.subscribe(listener)
  }

  list(query?: FlightRecordQuery): readonly FlightRecord[] {
    return this.store.list(query)
  }

  get(id: RequestAttemptId): FlightRecord | undefined {
    return this.store.get(id)
  }

  latest(sessionId?: SessionId): FlightRecord | undefined {
    return this.store.latest(sessionId)
  }

  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult {
    const from = this.store.get(fromId)
    const to = this.store.get(toId)
    if (from === undefined || to === undefined) {
      return deepFreeze({
        kind: 'missing',
        ids: [
          ...(from === undefined ? [fromId] : []),
          ...(to === undefined ? [toId] : []),
        ],
      })
    }
    return deepFreeze({
      kind: 'ok',
      diff: diffFlightRecords(from, to),
    })
  }

  health(): FlightRecorderHealth {
    return Object.freeze({
      captured: this.captured,
      completed: this.completed,
      active: this.activeIds.size,
      retained: this.store.size,
      evicted: this.evicted,
      truncatedRecords: this.truncatedRecords,
      correlationMisses: this.correlationMisses,
      correlationMissesByReason: Object.freeze({
        ...this.correlationMissesByReason,
      }),
      projectionFailures: this.projectionFailures,
      subscriberFailures: this.subscriberFailures,
    })
  }

  capture(record: FlightRecord): void {
    if (this.disposed) return
    if (record.outcome.kind !== 'running') {
      throw new Error('captured record must be running')
    }
    const evicted = this.store.insert(record)
    this.captured += 1
    this.activeIds.add(record.id)
    if (evicted !== undefined) this.evicted += 1
    if (hasFlightRecordOmissions(record.omissions)) {
      this.truncatedRecords += 1
    }
    this.change()
  }

  settle(id: RequestAttemptId, outcome: FlightOutcome): boolean {
    if (this.disposed || !this.activeIds.delete(id)) return false
    this.completed += 1
    this.store.update(id, record => ({ ...record, outcome }))
    this.change()
    return true
  }

  correlationMiss(reason: CorrelationMissReason): void {
    if (this.disposed) return
    this.correlationMisses += 1
    this.correlationMissesByReason[reason] += 1
    this.change()
  }

  projectionFailed(): void {
    if (this.disposed) return
    this.projectionFailures += 1
    this.change()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.store.clear()
    this.activeIds.clear()
    this.subscriptions.clear()
    this.captured = 0
    this.completed = 0
    this.evicted = 0
    this.truncatedRecords = 0
    this.correlationMisses = 0
    this.correlationMissesByReason = emptyCorrelationMissesByReason()
    this.projectionFailures = 0
    this.subscriberFailures = 0
    this.revision = 0
  }

  private change(): void {
    this.revision = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.revision + 1,
    )
    this.subscriptions.publish(this.revision)
  }
}
