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
  registerHarnessAdapter,
  type HarnessCaptureHandlers,
} from '../src/harness-adapter.js'

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

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('registerHarnessAdapter', () => {
  it('translates official payloads and preserves downstream identities', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      persona: '',
    })
    await ctx.plugin(AgentRegistry)
    const agent = fakeAgent(ctx)
    const signal = new AbortController().signal
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {},
    }
    const chunks: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
    const stream: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    const seen: Parameters<HarnessCaptureHandlers['assembled']>[0][] = []
    let requestInput: Parameters<HarnessCaptureHandlers['requested']>[0] | undefined
    let streamInput: Parameters<HarnessCaptureHandlers['streaming']>[0] | undefined
    let assemblyNext = 0
    let requestNext = 0
    let streamNext = 0

    registerHarnessAdapter(ctx, {
      assembled(input) {
        seen.push(input)
      },
      requested(input) {
        requestInput = input
      },
      streaming(input) {
        streamInput = input
        return input.next()
      },
      projectionFailed() {
        throw new Error('unexpected projection failure')
      },
    })

    const assembled = await ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent, signal },
      async () => {
        assemblyNext += 1
        return assembly
      },
    )
    const config = { provider: 'deepseek', model: 'deepseek-chat' }
    const requested = await ctx.waterfall(
      'agent/request',
      { agent, turn: 2, step: 3, signal },
      async () => {
        requestNext += 1
        return config
      },
    )
    const options = markAgentLoopRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: agent.session.id,
      signal,
    })
    const observed = ctx.agents.withInitiator(agent, () => (
      ctx.waterfall('llm/stream', options, () => {
        streamNext += 1
        return stream
      })
    ))

    expect(assembled).toBe(assembly)
    expect(requested).toBe(config)
    expect(await consume(observed)).toEqual(chunks)
    expect(assemblyNext).toBe(1)
    expect(requestNext).toBe(1)
    expect(streamNext).toBe(1)
    expect(seen).toEqual([{ assembly, agent, signal }])
    expect(requestInput).toEqual({
      agent,
      sessionId: agent.session.id,
      turn: 2,
      step: 3,
      signal,
    })
    expect(streamInput?.options).toBe(options)
    expect(streamInput?.initiator).toBe(agent)
  })

  it('bypasses unmarked streams and keeps event registration in the adapter', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      persona: '',
    })
    await ctx.plugin(AgentRegistry)
    let streamingCalls = 0
    let nextCalls = 0
    const handlers: HarnessCaptureHandlers = {
      assembled() {},
      requested() {},
      streaming(input) {
        streamingCalls += 1
        return input.next()
      },
      projectionFailed() {},
    }
    registerHarnessAdapter(ctx, handlers)
    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      sessionId: SessionId('session-a'),
      signal: new AbortController().signal,
    }
    await consume(ctx.waterfall('llm/stream', options, () => {
      nextCalls += 1
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        },
      }
    }))

    expect(streamingCalls).toBe(0)
    expect(nextCalls).toBe(1)

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

  it('reports request handler failures without replacing downstream config', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      persona: '',
    })
    await ctx.plugin(AgentRegistry)
    const agent = fakeAgent(ctx)
    const signal = new AbortController().signal
    const failure = new Error('request projection failed')
    const failures: Array<readonly [string, unknown]> = []
    registerHarnessAdapter(ctx, {
      assembled() {},
      requested() {
        throw failure
      },
      streaming(input) {
        return input.next()
      },
      projectionFailed(stage, error) {
        failures.push([stage, error])
      },
    })
    const config = { provider: 'deepseek', model: 'deepseek-chat' }

    const result = await ctx.waterfall(
      'agent/request',
      { agent, turn: 1, step: 1, signal },
      async () => config,
    )

    expect(result).toBe(config)
    expect(failures).toEqual([['agent/request', failure]])
  })
})
