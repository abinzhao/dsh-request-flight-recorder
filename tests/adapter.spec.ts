import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  normalizeFlightObservation,
  registerHarnessAdapter,
} from '../src/harness-adapter.js'
import { FlightRecorderState } from '../src/recorder-state.js'

function fakeAgent(ctx: Context, id = 'session-a'): Agent {
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
    async runMaintenance<T>(
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      return task(new AbortController().signal)
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function stream(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

async function consume(
  source: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

function loopRequest(agent: Agent, signal?: AbortSignal): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    system: 'TOP_SECRET_SYSTEM',
    sessionId: agent.session.id,
    ...(signal === undefined ? {} : { signal }),
  })
}

async function prepare(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  turn = 1,
  step = 1,
): Promise<void> {
  const assembly: PromptAssembly = {
    sections: [{ name: 'persona', text: 'TOP_SECRET_PERSONA' }],
    contexts: [{ name: 'workspace', text: 'TOP_SECRET_CONTEXT' }],
    tools: [],
    variables: { cwd: 'TOP_SECRET_VARIABLE' },
  }
  await ctx.waterfall(
    'system-prompt/assemble',
    assembly,
    { agent, signal },
    async () => assembly,
  )
  await ctx.waterfall(
    'agent/request',
    { agent, turn, step, signal },
    async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  )
}

const contexts: Context[] = []

async function world() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: '',
  })
  await ctx.plugin(AgentRegistry)
  const state = new FlightRecorderState(8)
  registerHarnessAdapter(ctx, state)
  return { ctx, state, agent: fakeAgent(ctx) }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('registerHarnessAdapter', () => {
  it('normalizes terminal failure observations without raw failure fields', () => {
    expect(normalizeFlightObservation({
      kind: 'finished',
      finish: {
        kind: 'error',
        failure: { message: 'TOP_SECRET' },
      },
      totalMs: 10,
    })).toEqual({
      kind: 'threw',
      error: { kind: 'error' },
      totalMs: 10,
    })
    expect(normalizeFlightObservation({
      kind: 'finished',
      finish: {
        kind: 'aborted',
        failure: { message: 'TOP_SECRET' },
      },
      firstChunkMs: 2,
      totalMs: 10,
      usage: { inputTokens: 3, outputTokens: 4 },
    })).toEqual({
      kind: 'threw',
      error: { kind: 'error' },
      firstChunkMs: 2,
      totalMs: 10,
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })

  it('owns projection, correlation, attempts, and transparent settlement', async () => {
    const { ctx, state, agent } = await world()
    const chunks: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const signal = new AbortController().signal
      await prepare(ctx, agent, signal, 3, 2)
      const options = loopRequest(agent, signal)
      const downstream = stream(chunks)
      let received: GenerateOptions | undefined
      const observed = ctx.agents.withInitiator(agent, () => (
        ctx.waterfall('llm/stream', options, () => {
          received = options
          return downstream
        })
      ))

      expect(received).toBe(options)
      expect(await consume(observed)).toEqual(chunks)
      expect(state.latest()?.attempt).toBe(attempt)
    }

    const snapshot = state.snapshot()
    expect(snapshot).toMatchObject({
      revision: 4,
      health: {
        captured: 2,
        completed: 2,
        active: 0,
        correlationMisses: 0,
        projectionFailures: 0,
      },
    })
    expect(snapshot.records[0]).toMatchObject({
      turn: 3,
      step: 2,
      attempt: 2,
      request: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemCharacters: 17,
      },
      promptAssembly: {
        sections: [{ name: 'persona', characters: 18 }],
        contexts: [{ name: 'workspace', characters: 18 }],
        variables: ['cwd'],
      },
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('TOP_SECRET')
  })

  it('bypasses direct requests and counts strict correlation misses', async () => {
    const { ctx, state, agent } = await world()
    const downstream = stream([
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const direct: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: agent.session.id,
    }

    expect(ctx.waterfall('llm/stream', direct, () => downstream)).toBe(
      downstream,
    )
    await consume(ctx.waterfall(
      'llm/stream',
      loopRequest(agent),
      () => downstream,
    ))

    const missingPendingSignal = new AbortController().signal
    await consume(ctx.agents.withInitiator(agent, () => ctx.waterfall(
      'llm/stream',
      loopRequest(agent, missingPendingSignal),
      () => downstream,
    )))

    const agentSignal = new AbortController().signal
    await prepare(ctx, agent, agentSignal)
    const other = fakeAgent(ctx, 'session-b')
    await consume(ctx.agents.withInitiator(other, () => ctx.waterfall(
      'llm/stream',
      loopRequest(agent, agentSignal),
      () => downstream,
    )))

    const sessionSignal = new AbortController().signal
    await prepare(ctx, agent, sessionSignal)
    await consume(ctx.agents.withInitiator(agent, () => ctx.waterfall(
      'llm/stream',
      markAgentLoopRequest({
        ...loopRequest(agent, sessionSignal),
        sessionId: other.session.id,
      }),
      () => downstream,
    )))

    expect(state.snapshot()).toMatchObject({
      revision: 4,
      records: [],
      health: {
        captured: 0,
        correlationMisses: 4,
        correlationMissesByReason: {
          'missing-signal': 1,
          'missing-pending': 1,
          'agent-mismatch': 1,
          'session-mismatch': 1,
        },
      },
    })
  })

  it('contains projection failures and keeps event registration local', async () => {
    const { ctx, state, agent } = await world()
    const signal = new AbortController().signal
    await prepare(ctx, agent, signal)
    const options = loopRequest(agent, signal)
    Object.defineProperty(options, 'messages', {
      get() {
        throw new Error('TOP_SECRET_PROJECTION')
      },
    })
    const downstream = stream([
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    expect(ctx.agents.withInitiator(agent, () => (
      ctx.waterfall('llm/stream', options, () => downstream)
    ))).toBe(downstream)
    expect(state.snapshot()).toMatchObject({
      revision: 1,
      records: [],
      health: { projectionFailures: 1 },
    })

    const invalidPayload = {
      agent,
      turn: 1,
      step: 1,
    } as {
      agent: Agent
      turn: number
      step: number
      signal: AbortSignal
    }
    Object.defineProperty(invalidPayload, 'signal', {
      get() {
        throw new Error('TOP_SECRET_AGENT_REQUEST')
      },
    })
    await ctx.waterfall(
      'agent/request',
      invalidPayload,
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    )
    expect(state.health().projectionFailures).toBe(2)

    const sourceRoot = join(import.meta.dirname, '..', 'src')
    const files = (await readdir(sourceRoot))
      .filter(file => file.endsWith('.ts'))
      .sort()
    const registrations: string[] = []
    for (const file of files) {
      const source = await readFile(join(sourceRoot, file), 'utf8')
      if (/ctx\.on\(['"](?:system-prompt\/assemble|agent\/request|llm\/stream)/u.test(source)) {
        registrations.push(file)
      }
    }
    expect(registrations).toEqual(['harness-adapter.ts'])
  })
})
