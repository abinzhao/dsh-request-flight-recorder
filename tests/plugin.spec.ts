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
import SystemPrompt, { type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import RequestFlightRecorder from '../src/index.js'
import { RequestAttemptId } from '../src/types.js'

function fakeAgent(ctx: Context, id: string): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
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

function completedStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'usage',
        usage: { inputTokens: 12, outputTokens: 4 },
      }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
      }
    },
  }
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

interface TestWorld {
  readonly ctx: Context
  readonly recorderFiber: Awaited<ReturnType<Context['plugin']>>
  readonly recorder: RequestFlightRecorder
  readonly agent: Agent
}

const worlds: Context[] = []

async function createWorld(capacity = 8): Promise<TestWorld> {
  const ctx = new Context()
  worlds.push(ctx)
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
    agent: fakeAgent(ctx, 'session-a'),
  }
}

async function prepareRequest(
  world: TestWorld,
  signal: AbortSignal,
  turn = 1,
  step = 1,
): Promise<PromptAssembly> {
  const assembly: PromptAssembly = {
    sections: [{ name: 'persona', text: 'You are concise.' }],
    contexts: [{ name: 'workspace', text: 'Repository context.' }],
    tools: [],
    variables: { cwd: '/workspace' },
  }
  await world.ctx.waterfall(
    'system-prompt/assemble',
    assembly,
    { agent: world.agent, signal },
    async () => assembly,
  )
  const config: LlmCallConfig = {
    provider: 'deepseek',
    model: 'deepseek-chat',
  }
  await world.ctx.waterfall(
    'agent/request',
    { agent: world.agent, turn, step, signal },
    async () => config,
  )
  return assembly
}

function loopRequest(agent: Agent, signal: AbortSignal): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    system: 'You are concise.',
    sessionId: agent.session.id,
    signal,
  })
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('RequestFlightRecorder', () => {
  it('validates positive safe-integer diagnostic thresholds with stable defaults', () => {
    expect(RequestFlightRecorder.Config({ capacity: 8 })).toEqual({
      capacity: 8,
      slowFirstChunkMs: 1_000,
      slowTotalMs: 2_000,
    })

    for (const value of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => RequestFlightRecorder.Config({
        capacity: 8,
        slowFirstChunkMs: value,
        slowTotalMs: value,
      })).toThrow()
    }
  })

  it('reports a frozen stable protocol and capability handshake', async () => {
    const world = await createWorld()
    const recorder = world.recorder as RequestFlightRecorder & {
      info?: () => unknown
    }

    const info = recorder.info?.()

    expect(info).toEqual({
      protocolVersion: 1,
      recordSchemaVersion: 1,
      capabilities: ['diff', 'health', 'query', 'snapshot', 'subscribe'],
    })
    expect(Object.isFrozen(info)).toBe(true)
    expect(Object.isFrozen(
      (info as { readonly capabilities: readonly string[] }).capabilities,
    )).toBe(true)
    expect(recorder.info?.()).toBe(info)
  })

  it('starts with a frozen zero health snapshot', async () => {
    const world = await createWorld()

    const health = world.recorder.health()

    expect(health).toEqual({
      captured: 0,
      completed: 0,
      active: 0,
      retained: 0,
      evicted: 0,
      truncatedRecords: 0,
      correlationMisses: 0,
      correlationMissesByReason: {
        'missing-signal': 0,
        'missing-pending': 0,
        'agent-mismatch': 0,
        'session-mismatch': 0,
      },
      projectionFailures: 0,
      subscriberFailures: 0,
    })
    expect(Object.isFrozen(health)).toBe(true)
    expect(Object.isFrozen(health.correlationMissesByReason)).toBe(true)
    expect(world.recorder.health()).not.toBe(health)
  })

  it('tracks capture and terminal settlement independently', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)

    const observed = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), completedStream)
    ))
    expect(world.recorder.health()).toMatchObject({
      captured: 1,
      completed: 0,
      active: 1,
      retained: 1,
    })

    await consume(observed)
    expect(world.recorder.health()).toMatchObject({
      captured: 1,
      completed: 1,
      active: 0,
      retained: 1,
    })
  })

  it('settles an active request after its retained record was evicted', async () => {
    const world = await createWorld(1)
    const firstSignal = new AbortController().signal
    await prepareRequest(world, firstSignal, 1, 1)
    const first = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, firstSignal), completedStream)
    ))
    const secondSignal = new AbortController().signal
    await prepareRequest(world, secondSignal, 1, 2)
    const second = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, secondSignal), completedStream)
    ))

    expect(world.recorder.health()).toMatchObject({
      captured: 2,
      completed: 0,
      active: 2,
      retained: 1,
      evicted: 1,
    })

    await consume(first)
    expect(world.recorder.health()).toMatchObject({
      completed: 1,
      active: 1,
      retained: 1,
    })
    await consume(second)
    expect(world.recorder.health()).toMatchObject({
      completed: 2,
      active: 0,
      retained: 1,
    })
  })

  it('counts marked correlation misses but ignores direct requests', async () => {
    const world = await createWorld()
    const directSignal = new AbortController().signal
    await consume(world.ctx.waterfall('llm/stream', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: world.agent.session.id,
      signal: directSignal,
    }, completedStream))

    const missingSignal = markAgentLoopRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: world.agent.session.id,
    })
    await consume(world.ctx.waterfall('llm/stream', missingSignal, completedStream))

    const missingPending = loopRequest(
      world.agent,
      new AbortController().signal,
    )
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', missingPending, completedStream)
    )))

    const agentMismatchSignal = new AbortController().signal
    await prepareRequest(world, agentMismatchSignal)
    const otherAgent = fakeAgent(world.ctx, 'session-b')
    await consume(world.ctx.agents.withInitiator(otherAgent, () => (
      world.ctx.waterfall(
        'llm/stream',
        loopRequest(world.agent, agentMismatchSignal),
        completedStream,
      )
    )))

    const sessionMismatchSignal = new AbortController().signal
    await prepareRequest(world, sessionMismatchSignal)
    const sessionMismatch = markAgentLoopRequest({
      ...loopRequest(world.agent, sessionMismatchSignal),
      sessionId: otherAgent.session.id,
    })
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', sessionMismatch, completedStream)
    )))

    const health = world.recorder.health()
    expect(health).toMatchObject({
      captured: 0,
      correlationMisses: 4,
      correlationMissesByReason: {
        'missing-signal': 1,
        'missing-pending': 1,
        'agent-mismatch': 1,
        'session-mismatch': 1,
      },
    })
    expect(health.correlationMisses).toBe(
      Object.values(health.correlationMissesByReason)
        .reduce((total, count) => total + count, 0),
    )
  })

  it('records one correlated loop request without replacing request or chunks', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal, 3, 2)
    const options = loopRequest(world.agent, signal)
    const downstream = completedStream()
    let receivedOptions: GenerateOptions | undefined

    const observed = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', options, () => {
        receivedOptions = options
        return downstream
      })
    ))
    const chunks = await consume(observed)

    expect(receivedOptions).toBe(options)
    expect(chunks).toHaveLength(2)
    const record = world.recorder.latest(world.agent.session.id)
    expect(record).toMatchObject({
      sessionId: world.agent.session.id,
      turn: 3,
      step: 2,
      attempt: 1,
      request: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemCharacters: 16,
      },
      promptAssembly: {
        sections: [{ name: 'persona', characters: 16 }],
        contexts: [{ name: 'workspace', characters: 19 }],
        variables: ['cwd'],
      },
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    })
    expect(world.recorder.get(record!.id)).toBe(record)
  })

  it.each(['error', 'aborted'] as const)(
    'redacts raw LLM failure fields from a %s finish',
    async (kind) => {
      const world = await createWorld()
      const signal = new AbortController().signal
      await prepareRequest(world, signal)
      const finish = {
        type: 'finish',
        reason: {
          kind,
          failure: {
            message: 'TOP_SECRET_FINISH_MESSAGE',
            code: 'TOP_SECRET_FINISH_CODE',
            requestId: 'TOP_SECRET_REQUEST_ID',
          },
        },
      } as StreamChunk
      const downstream = {
        async *[Symbol.asyncIterator]() {
          yield finish
        },
      }

      const chunks = await consume(world.ctx.agents.withInitiator(
        world.agent,
        () => world.ctx.waterfall(
          'llm/stream',
          loopRequest(world.agent, signal),
          () => downstream,
        ),
      ))

      expect(chunks).toEqual([finish])
      expect(chunks[0]).toBe(finish)
      expect(world.recorder.latest()?.outcome).toEqual({
        kind: 'threw',
        error: { kind: 'error' },
        firstChunkMs: expect.any(Number),
        totalMs: expect.any(Number),
      })
      expect(JSON.stringify(world.recorder.snapshot())).not.toContain(
        'TOP_SECRET',
      )
    },
  )

  it('stores schema version and merged request/prompt omissions', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    const tools: ToolSchema[] = Array.from({ length: 129 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'TOP_SECRET_VALUE',
      parameters: { type: 'object' },
    }))
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools,
      variables: {},
    }
    await world.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: world.agent, signal },
      async () => assembly,
    )
    await world.ctx.waterfall(
      'agent/request',
      { agent: world.agent, turn: 1, step: 1, signal },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    )
    const options = markAgentLoopRequest({
      ...loopRequest(world.agent, signal),
      tools,
    })

    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', options, completedStream)
    )))

    const record = world.recorder.latest()
    expect(record).toMatchObject({
      schemaVersion: 1,
      omissions: {
        requestTools: 1,
        promptTools: 1,
      },
    })
    expect(record?.request.tools).toHaveLength(128)
    expect(record?.promptAssembly?.tools).toHaveLength(128)
    expect(JSON.stringify(record)).not.toContain('TOP_SECRET_VALUE')
    expect(world.recorder.health()).toMatchObject({
      captured: 1,
      truncatedRecords: 1,
    })
  })

  it('increments attempts for repeated requests at the same coordinates', async () => {
    const world = await createWorld()

    for (let index = 0; index < 2; index += 1) {
      const signal = new AbortController().signal
      await prepareRequest(world, signal, 1, 1)
      const stream = world.ctx.agents.withInitiator(world.agent, () => (
        world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), completedStream)
      ))
      await consume(stream)
    }

    expect(world.recorder.list().map(record => record.attempt)).toEqual([2, 1])
  })

  it('diffs retained records and reports missing identities without throwing', async () => {
    const world = await createWorld()
    for (let index = 0; index < 2; index += 1) {
      const signal = new AbortController().signal
      await prepareRequest(world, signal, 1, index + 1)
      await consume(world.ctx.agents.withInitiator(world.agent, () => (
        world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), completedStream)
      )))
    }
    const [to, from] = world.recorder.list()

    expect(world.recorder.diff(from!.id, to!.id)).toMatchObject({
      kind: 'ok',
      diff: {
        fromId: from!.id,
        toId: to!.id,
      },
    })
    const missingA = RequestAttemptId('missing-a')
    const missingB = RequestAttemptId('missing-b')
    expect(world.recorder.diff(missingA, missingB)).toEqual({
      kind: 'missing',
      ids: [missingA, missingB],
    })
    expect(world.recorder.diff(from!.id, missingB)).toEqual({
      kind: 'missing',
      ids: [missingB],
    })
    expect(world.recorder.diff(missingA, to!.id)).toEqual({
      kind: 'missing',
      ids: [missingA],
    })
  })

  it('does not record non-loop requests or mismatched signals', async () => {
    const world = await createWorld()
    const expectedSignal = new AbortController().signal
    await prepareRequest(world, expectedSignal)

    const direct: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: world.agent.session.id,
      signal: expectedSignal,
    }
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', direct, completedStream)
    )))

    const mismatched = loopRequest(world.agent, new AbortController().signal)
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', mismatched, completedStream)
    )))

    expect(world.recorder.list()).toEqual([])
  })

  it('does not correlate a request to a different Agent or Session', async () => {
    const world = await createWorld()
    const otherAgent = fakeAgent(world.ctx, 'session-b')
    const agentMismatchSignal = new AbortController().signal
    await prepareRequest(world, agentMismatchSignal)

    await consume(world.ctx.agents.withInitiator(otherAgent, () => (
      world.ctx.waterfall(
        'llm/stream',
        loopRequest(world.agent, agentMismatchSignal),
        completedStream,
      )
    )))

    const sessionMismatchSignal = new AbortController().signal
    await prepareRequest(world, sessionMismatchSignal)
    const sessionMismatch = markAgentLoopRequest({
      ...loopRequest(world.agent, sessionMismatchSignal),
      sessionId: otherAgent.session.id,
    })
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', sessionMismatch, completedStream)
    )))

    expect(world.recorder.list()).toEqual([])
  })

  it('records a request without prompt evidence when no assembly was captured', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {},
    }

    await world.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: world.agent },
      async () => assembly,
    )
    await world.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { signal },
      async () => assembly,
    )
    await world.ctx.waterfall(
      'agent/request',
      { agent: world.agent, turn: 1, step: 1, signal },
      async () => ({
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
    )
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), completedStream)
    )))

    const record = world.recorder.latest()
    expect(record?.promptAssembly).toBeUndefined()
    expect(record?.evidence).toEqual([
      { kind: 'exact', source: 'llm/stream' },
      { kind: 'exact', source: 'agent/request' },
    ])
  })

  it('contains prompt projection failures and continues without prompt evidence', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {},
    }
    Object.defineProperty(assembly, 'sections', {
      get() {
        throw 'prompt projection failed'
      },
    })

    await world.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: world.agent, signal },
      async () => assembly,
    )
    await world.ctx.waterfall(
      'agent/request',
      { agent: world.agent, turn: 1, step: 1, signal },
      async () => ({
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
    )
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), completedStream)
    )))

    expect(world.recorder.latest()?.promptAssembly).toBeUndefined()
    expect(world.recorder.health().projectionFailures).toBe(1)
  })

  it('contains request projection failures and delegates exactly once', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const projectionError = new Error('request projection failed')
    const options = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: world.agent.session.id,
      signal,
    } as GenerateOptions
    Object.defineProperty(options, 'messages', {
      get() {
        throw projectionError
      },
    })
    markAgentLoopRequest(options)
    let delegated = 0

    const chunks = await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', options, () => {
        delegated += 1
        return completedStream()
      })
    )))

    expect(delegated).toBe(1)
    expect(chunks).toHaveLength(2)
    expect(world.recorder.list()).toEqual([])
    expect(world.recorder.health().projectionFailures).toBe(1)
  })

  it('records asynchronous non-Error stream failures and rethrows the same value', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const failure = 'provider failed'
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'usage',
          usage: { inputTokens: 1, outputTokens: 0 },
        }
        throw failure
      },
    }
    const observed = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), () => stream)
    ))

    await expect(consume(observed)).rejects.toBe(failure)
    expect(world.recorder.latest()?.outcome).toMatchObject({
      kind: 'threw',
      error: { kind: 'non-error-thrown' },
      usage: { inputTokens: 1, outputTokens: 0 },
    })
  })

  it('records a synchronous downstream failure and rethrows the same error', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const error = new Error('stream construction failed')

    expect(() => world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), () => {
        throw error
      })
    ))).toThrow(error)
    expect(world.recorder.latest()?.outcome).toMatchObject({
      kind: 'threw',
      error: { kind: 'error' },
    })
  })

  it('retains only a finite error kind without the upstream message', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    await prepareRequest(world, signal)
    const secret = 'TOP_SECRET_ERROR_MESSAGE'
    const error = new TypeError(secret)

    expect(() => world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, signal), () => {
        throw error
      })
    ))).toThrow(error)

    const outcome = world.recorder.latest()?.outcome
    expect(outcome).toMatchObject({
      kind: 'threw',
      error: { kind: 'type-error' },
    })
    expect(JSON.stringify(outcome)).not.toContain(secret)
  })

  it('clears records and removes listeners when its fiber is disposed', async () => {
    const world = await createWorld()
    const firstSignal = new AbortController().signal
    await prepareRequest(world, firstSignal)
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, firstSignal), completedStream)
    )))
    expect(world.recorder.list()).toHaveLength(1)

    const inFlightSignal = new AbortController().signal
    await prepareRequest(world, inFlightSignal, 2, 1)
    const inFlight = world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, inFlightSignal), completedStream)
    ))[Symbol.asyncIterator]()
    expect((await inFlight.next()).value?.type).toBe('usage')

    await world.recorderFiber.dispose()
    expect(world.recorder.list()).toEqual([])
    expect(world.recorder.health()).toEqual({
      captured: 0,
      completed: 0,
      active: 0,
      retained: 0,
      evicted: 0,
      truncatedRecords: 0,
      correlationMisses: 0,
      correlationMissesByReason: {
        'missing-signal': 0,
        'missing-pending': 0,
        'agent-mismatch': 0,
        'session-mismatch': 0,
      },
      projectionFailures: 0,
      subscriberFailures: 0,
    })
    expect((await inFlight.next()).value?.type).toBe('finish')

    const secondSignal = new AbortController().signal
    await prepareRequest(world, secondSignal)
    await consume(world.ctx.agents.withInitiator(world.agent, () => (
      world.ctx.waterfall('llm/stream', loopRequest(world.agent, secondSignal), completedStream)
    )))
    expect(world.recorder.list()).toEqual([])
  })

  it('does not publish async capture continuations after disposal', async () => {
    const world = await createWorld()
    const signal = new AbortController().signal
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {},
    }
    let releaseAssembly!: () => void
    let releaseRequest!: () => void
    const assemblyRun = world.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: world.agent, signal },
      () => new Promise<PromptAssembly>(resolve => {
        releaseAssembly = () => resolve(assembly)
      }),
    )
    const requestRun = world.ctx.waterfall(
      'agent/request',
      { agent: world.agent, turn: 1, step: 1, signal },
      () => new Promise<LlmCallConfig>(resolve => {
        releaseRequest = () => resolve({
          provider: 'deepseek',
          model: 'deepseek-chat',
        })
      }),
    )
    await Promise.resolve()

    await world.recorderFiber.dispose()
    releaseAssembly()
    releaseRequest()
    await Promise.all([assemblyRun, requestRun])

    expect(world.recorder.list()).toEqual([])
  })
})
