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

  info(): FlightRecorderInfo {
    return this.state.info()
  }

  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot {
    return this.state.snapshot(query)
  }

  subscribe(listener: FlightRecorderListener): () => void {
    return this.state.subscribe(listener)
  }

  list(query?: FlightRecordQuery): readonly FlightRecord[] {
    return this.state.list(query)
  }

  get(id: RequestAttemptId): FlightRecord | undefined {
    return this.state.get(id)
  }

  latest(sessionId?: SessionId): FlightRecord | undefined {
    return this.state.latest(sessionId)
  }

  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult {
    return this.state.diff(fromId, toId)
  }

  health(): FlightRecorderHealth {
    return this.state.health()
  }
}
