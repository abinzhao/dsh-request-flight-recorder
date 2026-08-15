/**
 * DeepSeek Harness request flight recorder service.
 * @module dsh-request-flight-recorder
 */

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  Service,
  type Context,
} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  deepFreeze,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssemblySummary } from './types.js'
import z from '@deepseek-ai/schemastery'
import { registerFlightCommand } from './command.js'
import { diffFlightRecords } from './diff.js'
import { classifyFlightError } from './error.js'
import {
  registerHarnessAdapter,
  type HarnessStage,
} from './harness-adapter.js'
import {
  hasFlightRecordOmissions,
  mergeFlightRecordOmissions,
} from './limits.js'
import { observeStream } from './observe-stream.js'
import { projectPromptAssembly, projectRequest } from './project.js'
import { FlightRingStore } from './ring-store.js'
import { FlightSubscriptions } from './subscriptions.js'
import {
  FLIGHT_RECORDER_PROTOCOL_VERSION,
  FLIGHT_RECORD_SCHEMA_VERSION,
  RequestAttemptId,
  type CorrelationMissReason,
  type FlightOutcome,
  type FlightDiffResult,
  type FlightRecordOmissions,
  type FlightRecord,
  type FlightRecordQuery,
  type FlightRecorderHealth,
  type FlightRecorderInfo,
  type FlightRecorderListener,
  type FlightRecorderSnapshot,
  type FlightStreamObservation,
  type RequestAttemptId as RequestAttemptIdType,
} from './types.js'

export * from './public.js'

const RECORDER_INFO: FlightRecorderInfo = deepFreeze({
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

/** Validated plugin configuration. */
export interface RequestFlightRecorderConfig {
  /** Maximum records retained in process memory. */
  capacity: number
}

interface CapturedAssembly {
  readonly agent: Agent
  readonly summary: PromptAssemblySummary
  readonly omissions: FlightRecordOmissions
}

interface PendingRequest {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly promptAssembly?: PromptAssemblySummary
  readonly promptOmissions?: FlightRecordOmissions
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** In-process structural request diagnostics. */
    requestFlightRecorder: RequestFlightRecorder
  }
}

/** Content-free recorder for loop-built model requests and stream outcomes. */
export default class RequestFlightRecorder extends Service {
  static inject = ['llm', 'agents', 'systemPrompt']

  static Config = z.object({
    capacity: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
  })

  private readonly store: FlightRingStore
  private promptBySignal = new WeakMap<AbortSignal, CapturedAssembly>()
  private pendingBySignal = new WeakMap<AbortSignal, PendingRequest>()
  private attemptsByAgent = new WeakMap<Agent, Map<string, number>>()
  private activeIds = new Set<RequestAttemptIdType>()
  private readonly subscriptions: FlightSubscriptions
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

  /**
   * Register the recorder service and its effect-owned waterfall listeners.
   * @param ctx - Cordis context carrying the required DSH services.
   * @param config - validated bounded-retention configuration.
   */
  constructor(ctx: Context, config: RequestFlightRecorderConfig) {
    super(ctx, 'requestFlightRecorder')
    this.store = new FlightRingStore(config.capacity)
    this.subscriptions = new FlightSubscriptions(() => {
      this.subscriberFailures += 1
    })

    registerHarnessAdapter(ctx, {
      assembled: ({ assembly, agent, signal }) => {
        if (this.disposed) return
        const projection = projectPromptAssembly(assembly)
        this.promptBySignal.set(signal, {
          agent,
          summary: projection.summary,
          omissions: projection.omissions,
        })
      },
      requested: ({ agent, sessionId, turn, step, signal }) => {
        if (this.disposed) return
        const assembly = this.promptBySignal.get(signal)
        this.promptBySignal.delete(signal)
        this.pendingBySignal.set(signal, {
          agent,
          sessionId,
          turn,
          step,
          ...(assembly?.agent === agent
            ? {
                promptAssembly: assembly.summary,
                promptOmissions: assembly.omissions,
              }
            : {}),
        })
      },
      streaming: ({ options, initiator, next }) => {
        if (options.signal === undefined) {
          this.miss('missing-signal')
          return next()
        }
        const pending = this.pendingBySignal.get(options.signal)
        if (pending === undefined) {
          this.miss('missing-pending')
          return next()
        }
        if (initiator !== pending.agent) {
          this.miss('agent-mismatch')
          return next()
        }
        if (options.sessionId !== pending.sessionId) {
          this.miss('session-mismatch')
          return next()
        }
        this.pendingBySignal.delete(options.signal)

        let id: RequestAttemptIdType
        let startedAt: number
        try {
          startedAt = performance.now()
          id = this.beginRecord(options, pending)
        } catch (error) {
          this.projectionFailures += 1
          this.change()
          this.warnCaptureFailure('llm/stream', error)
          return next()
        }

        let stream
        try {
          stream = next()
        } catch (error) {
          this.finishRecord(id, {
            kind: 'threw',
            error: classifyFlightError(error),
            totalMs: performance.now() - startedAt,
          })
          throw error
        }

        return observeStream(stream, observation => {
          if (this.disposed) return
          this.applyObservation(id, observation)
        })
      },
      projectionFailed: (stage, error) => {
        this.projectionFailures += 1
        this.change()
        this.warnCaptureFailure(stage, error)
      },
    })

    ctx.inject(['commands'], (commandCtx) => {
      registerFlightCommand(commandCtx, this)
    })

    ctx.effect(() => () => {
      this.disposed = true
      this.store.clear()
      this.promptBySignal = new WeakMap()
      this.pendingBySignal = new WeakMap()
      this.attemptsByAgent = new WeakMap()
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
    })
  }

  /** Return the stable protocol, schema, and capability handshake. */
  info(): FlightRecorderInfo {
    return RECORDER_INFO
  }

  /** Read one deeply frozen atomic view of recorder state. */
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot {
    return deepFreeze({
      info: this.info(),
      revision: this.revision,
      health: this.health(),
      records: this.store.list(query),
    })
  }

  /** Subscribe to coalesced out-of-stack recorder invalidations. */
  subscribe(listener: FlightRecorderListener): () => void {
    return this.subscriptions.subscribe(listener)
  }

  /**
   * List retained records from newest to oldest.
   * @param query - optional session filter.
   * @returns a frozen detached array of immutable records.
   */
  list(query?: FlightRecordQuery): readonly FlightRecord[] {
    return this.store.list(query)
  }

  /**
   * Read one retained request attempt.
   * @param id - request-attempt identity.
   * @returns the immutable record when it remains retained.
   */
  get(id: RequestAttemptIdType): FlightRecord | undefined {
    return this.store.get(id)
  }

  /**
   * Read the newest retained request attempt.
   * @param sessionId - optional session filter.
   * @returns the newest matching immutable record.
   */
  latest(sessionId?: SessionId): FlightRecord | undefined {
    return this.store.latest(sessionId)
  }

  /**
   * Compare two retained attempts without exceptional missing-id control flow.
   * @param fromId - earlier retained request-attempt identity.
   * @param toId - later retained request-attempt identity.
   * @returns a frozen structural diff or exact missing identities.
   */
  diff(
    fromId: RequestAttemptIdType,
    toId: RequestAttemptIdType,
  ): FlightDiffResult {
    const from = this.store.get(fromId)
    const to = this.store.get(toId)
    if (from === undefined || to === undefined) {
      const missing = [
        ...(from === undefined ? [fromId] : []),
        ...(to === undefined ? [toId] : []),
      ]
      return deepFreeze({ kind: 'missing', ids: missing })
    }
    return deepFreeze({
      kind: 'ok',
      diff: diffFlightRecords(from, to),
    })
  }

  /**
   * Read a fresh process-local health snapshot.
   * @returns frozen capture, settlement, retention, and failure counters.
   */
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

  private beginRecord(
    options: GenerateOptions,
    pending: PendingRequest,
  ): RequestAttemptIdType {
    const attempts = this.attemptsByAgent.get(pending.agent) ?? new Map<string, number>()
    if (!this.attemptsByAgent.has(pending.agent)) {
      this.attemptsByAgent.set(pending.agent, attempts)
    }
    const coordinate = `${pending.turn}:${pending.step}`
    const attempt = (attempts.get(coordinate) ?? 0) + 1
    attempts.set(coordinate, attempt)

    const id = RequestAttemptId(randomUUID())
    const request = projectRequest(options)
    const omissions = pending.promptOmissions === undefined
      ? request.omissions
      : mergeFlightRecordOmissions(request.omissions, pending.promptOmissions)
    const evicted = this.store.insert({
      schemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
      id,
      sessionId: pending.sessionId,
      turn: pending.turn,
      step: pending.step,
      attempt,
      startedAt: Date.now(),
      request: request.summary,
      ...(pending.promptAssembly === undefined
        ? {}
        : { promptAssembly: pending.promptAssembly }),
      outcome: { kind: 'running' },
      evidence: [
        { kind: 'exact', source: 'llm/stream' },
        { kind: 'exact', source: 'agent/request' },
        ...(pending.promptAssembly === undefined
          ? []
          : [{ kind: 'derived' as const, source: 'system-prompt/assemble' as const }]),
      ],
      omissions,
    })
    this.captured += 1
    if (hasFlightRecordOmissions(omissions)) this.truncatedRecords += 1
    this.activeIds.add(id)
    if (evicted !== undefined) this.evicted += 1
    this.change()
    return id
  }

  private miss(reason: CorrelationMissReason): void {
    this.correlationMisses += 1
    this.correlationMissesByReason[reason] += 1
    this.change()
  }

  private applyObservation(
    id: RequestAttemptIdType,
    observation: FlightStreamObservation,
  ): void {
    if (observation.kind === 'first-chunk' || observation.kind === 'usage') return
    if (observation.kind === 'threw') {
      this.finishRecord(id, {
        ...observation,
        error: classifyFlightError(observation.error),
      })
      return
    }
    this.finishRecord(id, observation)
  }

  private finishRecord(id: RequestAttemptIdType, outcome: FlightOutcome): void {
    if (!this.activeIds.delete(id)) return
    this.completed += 1
    this.store.update(id, record => ({
      ...record,
      outcome,
    }))
    this.change()
  }

  private change(): void {
    if (this.revision < Number.MAX_SAFE_INTEGER) {
      this.revision += 1
    }
    this.subscriptions.publish(this.revision)
  }

  private warnCaptureFailure(stage: HarnessStage, error: unknown): void {
    this.ctx.logger('request-flight-recorder').warn(
      'capture failed at %s: %s',
      stage,
      classifyFlightError(error).kind,
    )
  }
}
