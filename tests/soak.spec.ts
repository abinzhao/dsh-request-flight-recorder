import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import RequestFlightRecorder from '../src/index.js'

const contexts: Context[] = []

function fakeAgent(ctx: Context, id: string): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session,
    inbox: {} as Agent['inbox'],
    status: 'running',
    ctx,
    cancel() {},
    async whenIdle() {},
    async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function createRoot(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: '',
  })
  await ctx.plugin(AgentRegistry)
  return ctx
}

function terminalStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Consumption drives recorder settlement.
  }
}

async function prepare(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  step: number,
): Promise<void> {
  await ctx.waterfall(
    'agent/request',
    { agent, turn: 1, step, signal },
    async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  )
}

function loopRequest(agent: Agent, signal: AbortSignal): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    sessionId: agent.session.id,
    signal,
  })
}

async function flushDeliveries(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('recorder lifecycle and soak evidence', () => {
  it('survives 100 mount/dispose cycles without retained state or delivery', async () => {
    const ctx = await createRoot()
    const disposed: RequestFlightRecorder[] = []
    let deliveries = 0

    for (let index = 0; index < 100; index += 1) {
      const fiber = await ctx.plugin(RequestFlightRecorder, { capacity: 4 })
      const recorder = ctx.requestFlightRecorder
      recorder.subscribe(() => {
        deliveries += 1
      })
      ctx.waterfall(
        'llm/stream',
        markAgentLoopRequest({
          provider: 'deepseek',
          model: 'deepseek-chat',
          messages: [],
          sessionId: SessionId(`session-${index}`),
        }),
        terminalStream,
      )
      await fiber.dispose()
      disposed.push(recorder)
    }
    await flushDeliveries()

    expect(deliveries).toBe(0)
    for (const recorder of disposed) {
      expect(recorder.list()).toEqual([])
      expect(recorder.snapshot().revision).toBe(0)
      expect(recorder.health().active).toBe(0)
    }
  })

  it('isolates overlapping Agents and settles evicted active records', async () => {
    const ctx = await createRoot()
    await ctx.plugin(RequestFlightRecorder, { capacity: 1 })
    const recorder = ctx.requestFlightRecorder
    const firstAgent = fakeAgent(ctx, 'session-a')
    const secondAgent = fakeAgent(ctx, 'session-b')
    const firstSignal = new AbortController().signal
    const secondSignal = new AbortController().signal
    await prepare(ctx, firstAgent, firstSignal, 1)
    await prepare(ctx, secondAgent, secondSignal, 2)

    const first = ctx.agents.withInitiator(firstAgent, () => (
      ctx.waterfall('llm/stream', loopRequest(firstAgent, firstSignal), terminalStream)
    ))
    const second = ctx.agents.withInitiator(secondAgent, () => (
      ctx.waterfall('llm/stream', loopRequest(secondAgent, secondSignal), terminalStream)
    ))

    expect(recorder.health()).toMatchObject({
      captured: 2,
      active: 2,
      retained: 1,
      evicted: 1,
    })
    expect(recorder.latest()?.sessionId).toBe(secondAgent.session.id)

    await Promise.all([consume(first), consume(second)])
    expect(recorder.health()).toMatchObject({
      completed: 2,
      active: 0,
      retained: 1,
    })
  })

})
