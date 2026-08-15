/**
 * DeepSeek Harness request flight recorder service.
 * @module dsh-request-flight-recorder
 */

import {
  Service,
  type Context,
} from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { registerFlightCommand } from './command.js'
import { registerHarnessAdapter } from './harness-adapter.js'
import { FlightRecorderState } from './recorder-state.js'
import type {
  FlightDiffResult,
  FlightRecord,
  FlightRecordQuery,
  FlightRecorderHealth,
  FlightRecorderInfo,
  FlightRecorderListener,
  FlightRecorderReader,
  FlightRecorderSnapshot,
  RequestAttemptId,
} from './types.js'

export * from './public.js'

/** Validated plugin configuration. */
export interface RequestFlightRecorderConfig {
  /** Maximum records retained in process memory. */
  capacity: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** In-process structural request diagnostics. */
    requestFlightRecorder: RequestFlightRecorder
  }
}

/** Content-free recorder for loop-built model requests and stream outcomes. */
export default class RequestFlightRecorder
  extends Service
  implements FlightRecorderReader
{
  static inject = ['llm', 'agents', 'systemPrompt']

  static Config = z.object({
    capacity: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
  })

  private readonly state: FlightRecorderState

  /**
   * Register the recorder service and its effect-owned waterfall listeners.
   * @param ctx - Cordis context carrying the required DSH services.
   * @param config - validated bounded-retention configuration.
   */
  constructor(ctx: Context, config: RequestFlightRecorderConfig) {
    super(ctx, 'requestFlightRecorder')
    this.state = new FlightRecorderState(config.capacity)
    ctx.effect(() => () => {
      this.state.dispose()
    })
    registerHarnessAdapter(ctx, this.state)
    ctx.inject(['commands'], commandCtx => {
      registerFlightCommand(commandCtx, this)
    })
  }

  /** Return the stable protocol, schema, and capability handshake. */
  info(): FlightRecorderInfo {
    return this.state.info()
  }

  /** Read one deeply frozen atomic view of recorder state. */
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot {
    return this.state.snapshot(query)
  }

  /** Subscribe to coalesced out-of-stack recorder invalidations. */
  subscribe(listener: FlightRecorderListener): () => void {
    return this.state.subscribe(listener)
  }

  /**
   * List retained records from newest to oldest.
   * @param query - optional record filters.
   * @returns a frozen detached array of immutable records.
   */
  list(query?: FlightRecordQuery): readonly FlightRecord[] {
    return this.state.list(query)
  }

  /**
   * Read one retained request attempt.
   * @param id - request-attempt identity.
   * @returns the immutable record when it remains retained.
   */
  get(id: RequestAttemptId): FlightRecord | undefined {
    return this.state.get(id)
  }

  /**
   * Read the newest retained request attempt.
   * @param sessionId - optional session filter.
   * @returns the newest matching immutable record.
   */
  latest(sessionId?: SessionId): FlightRecord | undefined {
    return this.state.latest(sessionId)
  }

  /**
   * Compare two retained attempts without exceptional missing-id control flow.
   * @param fromId - earlier retained request-attempt identity.
   * @param toId - later retained request-attempt identity.
   * @returns a frozen structural diff or exact missing identities.
   */
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult {
    return this.state.diff(fromId, toId)
  }

  /**
   * Read a fresh process-local health snapshot.
   * @returns frozen capture, settlement, retention, and failure counters.
   */
  health(): FlightRecorderHealth {
    return this.state.health()
  }
}
