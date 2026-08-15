/**
 * DeepSeek Harness event and stream adapter.
 * @module dsh-request-flight-recorder/harness-adapter
 */

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  isAgentLoopRequest,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { classifyFlightError } from './error.js'
import { mergeFlightRecordOmissions } from './limits.js'
import {
  observeStream,
} from './observe-stream.js'
import {
  projectPromptAssembly,
  projectRequest,
} from './project.js'
import type { FlightRecorderState } from './recorder-state.js'
import {
  FLIGHT_RECORD_SCHEMA_VERSION,
  RequestAttemptId,
  type FlightOutcome,
  type FlightRecordOmissions,
  type FlightStreamObservation,
  type PromptAssemblySummary,
  type RequestAttemptId as RequestAttemptIdType,
} from './types.js'

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

export function normalizeFlightObservation(
  observation: FlightStreamObservation,
): FlightOutcome | undefined {
  if (observation.kind === 'first-chunk' || observation.kind === 'usage') {
    return undefined
  }
  if (
    observation.kind === 'finished'
    && (
      observation.finish.kind === 'aborted'
      || observation.finish.kind === 'error'
    )
  ) {
    return {
      kind: 'threw',
      error: { kind: 'error' },
      ...(observation.firstChunkMs === undefined
        ? {}
        : { firstChunkMs: observation.firstChunkMs }),
      totalMs: observation.totalMs,
      ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    }
  }
  if (observation.kind === 'threw') {
    return {
      ...observation,
      error: classifyFlightError(observation.error),
    }
  }
  return observation
}

/** Register the complete Harness capture boundary against one state owner. */
export function registerHarnessAdapter(
  ctx: Context,
  state: FlightRecorderState,
): void {
  let assemblies = new WeakMap<AbortSignal, CapturedAssembly>()
  let pendingRequests = new WeakMap<AbortSignal, PendingRequest>()
  let attemptsByAgent = new WeakMap<Agent, Map<string, number>>()
  let disposed = false
  const logger = ctx.logger('request-flight-recorder')

  const projectionFailed = (stage: string, error: unknown): void => {
    state.projectionFailed()
    logger.warn(
      'capture failed at %s: %s',
      stage,
      classifyFlightError(error).kind,
    )
  }

  const capture = (
    options: GenerateOptions,
    pending: PendingRequest,
  ): { readonly id: RequestAttemptIdType; readonly startedAt: number } => {
    const byCoordinate = attemptsByAgent.get(pending.agent) ?? new Map()
    attemptsByAgent.set(pending.agent, byCoordinate)
    const coordinate = `${pending.turn}:${pending.step}`
    const attempt = (byCoordinate.get(coordinate) ?? 0) + 1
    byCoordinate.set(coordinate, attempt)
    const projected = projectRequest(options)
    const id = RequestAttemptId(randomUUID())
    state.capture({
      schemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
      id,
      sessionId: pending.sessionId,
      turn: pending.turn,
      step: pending.step,
      attempt,
      startedAt: Date.now(),
      request: projected.summary,
      ...(pending.promptAssembly === undefined
        ? {}
        : { promptAssembly: pending.promptAssembly }),
      evidence: [
        { kind: 'exact', source: 'llm/stream' },
        { kind: 'exact', source: 'agent/request' },
        ...(pending.promptAssembly === undefined
          ? []
          : [{
              kind: 'derived' as const,
              source: 'system-prompt/assemble' as const,
            }]),
      ],
      omissions: pending.promptOmissions === undefined
        ? projected.omissions
        : mergeFlightRecordOmissions(
            projected.omissions,
            pending.promptOmissions,
          ),
      outcome: { kind: 'running' },
    })
    return { id, startedAt: performance.now() }
  }

  ctx.on('system-prompt/assemble', async (assembly, eventContext, next) => {
    const output = await next()
    if (disposed) return output
    if (
      eventContext.agent === undefined
      || eventContext.signal === undefined
    ) {
      return output
    }
    try {
      const projected = projectPromptAssembly(output as PromptAssembly)
      assemblies.set(eventContext.signal, {
        agent: eventContext.agent,
        summary: projected.summary,
        omissions: projected.omissions,
      })
    } catch (error) {
      projectionFailed('system-prompt/assemble', error)
    }
    return output
  })

  ctx.on('agent/request', async (payload, next) => {
    const output = await next()
    if (disposed) return output
    try {
      const assembly = assemblies.get(payload.signal)
      assemblies.delete(payload.signal)
      pendingRequests.set(payload.signal, {
        agent: payload.agent,
        sessionId: payload.agent.session.id,
        turn: payload.turn,
        step: payload.step,
        ...(assembly === undefined || assembly.agent !== payload.agent
          ? {}
          : {
              promptAssembly: assembly.summary,
              promptOmissions: assembly.omissions,
            }),
      })
    } catch (error) {
      projectionFailed('agent/request', error)
    }
    return output
  })

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()
    const signal = options.signal
    if (signal === undefined) {
      state.correlationMiss('missing-signal')
      return next()
    }
    const pending = pendingRequests.get(signal)
    if (pending === undefined) {
      state.correlationMiss('missing-pending')
      return next()
    }
    const initiator = ctx.agents.currentInitiator()
    if (initiator !== pending.agent) {
      state.correlationMiss('agent-mismatch')
      return next()
    }
    if (options.sessionId !== pending.sessionId) {
      state.correlationMiss('session-mismatch')
      return next()
    }
    pendingRequests.delete(signal)

    let captureState
    try {
      captureState = capture(options, pending)
    } catch (error) {
      projectionFailed('llm/stream', error)
      return next()
    }

    let downstream: AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>
    try {
      downstream = next()
    } catch (error) {
      state.settle(captureState.id, {
        kind: 'threw',
        error: classifyFlightError(error),
        totalMs: performance.now() - captureState.startedAt,
      })
      throw error
    }

    return observeStream(
      downstream,
      observation => {
        if (disposed) return
        const outcome = normalizeFlightObservation(observation)
        if (outcome !== undefined) state.settle(captureState.id, outcome)
      },
    )
  })

  ctx.effect(() => () => {
    disposed = true
    assemblies = new WeakMap()
    pendingRequests = new WeakMap()
    attemptsByAgent = new WeakMap()
  })
}
