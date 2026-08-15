/**
 * Official DeepSeek Harness event boundary for request capture.
 * @module dsh-request-flight-recorder/harness-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  isAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export type HarnessStage =
  | 'system-prompt/assemble'
  | 'agent/request'
  | 'llm/stream'

export interface HarnessAssemblyInput {
  readonly assembly: PromptAssembly
  readonly agent: Agent
  readonly signal: AbortSignal
}

export interface HarnessRequestInput {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface HarnessStreamInput {
  readonly options: GenerateOptions
  readonly initiator: Agent | undefined
  readonly next: () => AsyncIterable<StreamChunk>
}

export interface HarnessCaptureHandlers {
  assembled(input: HarnessAssemblyInput): void
  requested(input: HarnessRequestInput): void
  streaming(input: HarnessStreamInput): AsyncIterable<StreamChunk>
  projectionFailed(stage: HarnessStage, error: unknown): void
}

/** Register transparent official Harness listeners for recorder-owned handlers. */
export function registerHarnessAdapter(
  ctx: Context,
  handlers: HarnessCaptureHandlers,
): void {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (context.signal === undefined || context.agent === undefined) return result
    try {
      handlers.assembled({
        assembly: result,
        agent: context.agent,
        signal: context.signal,
      })
    } catch (error) {
      handlers.projectionFailed('system-prompt/assemble', error)
    }
    return result
  })

  ctx.on('agent/request', async (payload, next) => {
    const result = await next()
    try {
      handlers.requested({
        agent: payload.agent,
        sessionId: payload.agent.session.id,
        turn: payload.turn,
        step: payload.step,
        signal: payload.signal,
      })
    } catch (error) {
      handlers.projectionFailed('agent/request', error)
    }
    return result
  })

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()
    return handlers.streaming({
      options,
      initiator: ctx.agents.currentInitiator(),
      next,
    })
  })
}
