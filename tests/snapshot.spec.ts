import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmCallConfig,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import RequestFlightRecorder from '../src/index.js'
import type {
  FlightRecorderChange,
  FlightRecorderListener,
  FlightRecorderSnapshot,
} from '../src/types.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function fakeAgent(ctx: Context): Agent {
  const session = Session.create(SessionId('session-a'))
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

interface TestWorld {
  readonly ctx: Context
  readonly recorderFiber: Awaited<ReturnType<Context['plugin']>>
  readonly recorder: RequestFlightRecorder
  readonly agent: Agent
}

async function createWorld(capacity = 8): Promise<TestWorld> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: '',
  })
  await ctx.plugin(AgentRegistry)
  const recorderFiber = await ctx.plugin(RequestFlightRecorder, { capacity })
  return {
    ctx,
    recorderFiber,
    recorder: ctx.requestFlightRecorder,
    agent: fakeAgent(ctx),
  }
}

async function prepareRequest(
  world: TestWorld,
  signal: AbortSignal,
  step = 1,
): Promise<void> {
  await world.ctx.waterfall(
    'agent/request',
    { agent: world.agent, turn: 1, step, signal },
    async (): Promise<LlmCallConfig> => ({
      provider: 'deepseek',
      model: 'deepseek-chat',
    }),
  )
}

function loopRequest(
  world: TestWorld,
  signal?: AbortSignal,
  tools?: ToolSchema[],
): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    sessionId: world.agent.session.id,
    ...(signal === undefined ? {} : { signal }),
    ...(tools === undefined ? {} : { tools }),
  })
}

function terminalStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 1 },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

async function flushDeliveries(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('FlightRecorderSnapshot', () => {
  it('starts as one deeply frozen atomic zero-state read', async () => {
    const { recorder } = await createWorld()
    const reader = recorder as RequestFlightRecorder & {
      snapshot?: () => FlightRecorderSnapshot
    }
    const snapshot = reader.snapshot?.()

    expect(snapshot).toEqual({
      info: recorder.info(),
      revision: 0,
      health: recorder.health(),
      records: [],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.health)).toBe(true)
    expect(Object.isFrozen(snapshot?.records)).toBe(true)
    expect(reader.snapshot?.()).not.toBe(snapshot)
  })

  it('increments once for insertion and once for terminal settlement', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const stream = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall(
        'llm/stream',
        loopRequest(world, signal),
        terminalStream,
      )
    ))[Symbol.asyncIterator]()

    expect(world.recorder.snapshot().revision).toBe(1)
    await stream.next()
    expect(world.recorder.snapshot().revision).toBe(1)
    await stream.next()
    expect(world.recorder.snapshot().revision).toBe(2)
    world.recorder.list()
    world.recorder.health()
    expect(world.recorder.snapshot().revision).toBe(2)
  })

  it('does not increment for direct requests', async () => {
    const world = await createWorld()
    await world.ctx.waterfall('llm/stream', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
    }, terminalStream)
    expect(world.recorder.snapshot().revision).toBe(0)

    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const observed = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world, signal), terminalStream)
    ))
    for await (const _chunk of observed) {}
    expect(world.recorder.snapshot().revision).toBe(2)
  })

  it('increments once for each correlation miss and projection failure', async () => {
    const world = await createWorld()
    await world.ctx.waterfall(
      'llm/stream',
      loopRequest(world),
      terminalStream,
    )
    expect(world.recorder.snapshot().revision).toBe(1)

    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const options = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: world.agent.session.id,
      signal,
    } as GenerateOptions
    Object.defineProperty(options, 'messages', {
      get() {
        throw new Error('projection failed')
      },
    })
    markAgentLoopRequest(options)
    await world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', options, terminalStream)
    ))

    expect(world.recorder.snapshot().revision).toBe(2)
  })

  it('folds eviction and truncation into one insertion revision', async () => {
    const world = await createWorld(1)
    const firstSignal = new AbortController().signal
    await prepareRequest(world, firstSignal, 1)
    world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall(
        'llm/stream',
        loopRequest(world, firstSignal),
        terminalStream,
      )
    ))
    expect(world.recorder.snapshot().revision).toBe(1)

    const tools: ToolSchema[] = Array.from({ length: 129 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'content',
      parameters: { type: 'object' },
    }))
    const secondSignal = new AbortController().signal
    await prepareRequest(world, secondSignal, 2)
    world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall(
        'llm/stream',
        loopRequest(world, secondSignal, tools),
        terminalStream,
      )
    ))

    const snapshot = world.recorder.snapshot()
    expect(snapshot.revision).toBe(2)
    expect(snapshot.health).toMatchObject({
      captured: 2,
      active: 2,
      retained: 1,
      evicted: 1,
      truncatedRecords: 1,
    })
  })

  it('coalesces subscriber invalidation outside the capture stack', async () => {
    const world = await createWorld()
    const changes: FlightRecorderChange[] = []
    const reader = world.recorder as RequestFlightRecorder & {
      subscribe?: (listener: FlightRecorderListener) => () => void
    }

    expect(typeof reader.subscribe).toBe('function')
    if (reader.subscribe === undefined) return
    const unsubscribe = reader.subscribe(change => {
      changes.push(change)
    })

    world.ctx.waterfall('llm/stream', loopRequest(world), terminalStream)
    world.ctx.waterfall('llm/stream', loopRequest(world), terminalStream)
    expect(changes).toEqual([])

    await flushDeliveries()
    expect(changes).toEqual([{ revision: 2 }])

    unsubscribe()
    unsubscribe()
    world.ctx.waterfall('llm/stream', loopRequest(world), terminalStream)
    await flushDeliveries()
    expect(changes).toEqual([{ revision: 2 }])
  })

  it('counts subscriber failure without revision or recursive delivery', async () => {
    const world = await createWorld()
    const revisions: number[] = []
    world.recorder.subscribe(() => {
      throw new Error('consumer failed')
    })
    world.recorder.subscribe(change => {
      revisions.push(change.revision)
    })

    world.ctx.waterfall('llm/stream', loopRequest(world), terminalStream)
    await flushDeliveries()

    expect(world.recorder.health()).toMatchObject({
      correlationMisses: 1,
      subscriberFailures: 1,
    })
    expect(world.recorder.snapshot().revision).toBe(1)
    expect(revisions).toEqual([1])
  })

  it('cancels queued subscriber delivery on service disposal', async () => {
    const world = await createWorld()
    const revisions: number[] = []
    world.recorder.subscribe(change => {
      revisions.push(change.revision)
    })
    world.ctx.waterfall('llm/stream', loopRequest(world), terminalStream)

    await world.recorderFiber.dispose()
    await flushDeliveries()

    expect(revisions).toEqual([])
    expect(world.recorder.snapshot().revision).toBe(0)
    expect(world.recorder.health().subscriberFailures).toBe(0)
  })
})
