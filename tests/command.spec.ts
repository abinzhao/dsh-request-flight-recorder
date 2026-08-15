import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { registerFlightCommand } from '../src/command.js'
import RequestFlightRecorder from '../src/index.js'
import { RECORDER_INFO } from '../src/recorder-state.js'
import {
  type FlightRecord,
  type FlightRecorderHealth,
  type FlightRecorderReader,
} from '../src/types.js'
import { flightRecord } from './fixtures.js'

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
    async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function reader(records: readonly FlightRecord[]): {
  readonly value: FlightRecorderReader
  readonly snapshotCalls: () => number
} {
  let calls = 0
  const health: FlightRecorderHealth = Object.freeze({
    captured: records.length,
    completed: records.filter(record => record.outcome.kind !== 'running').length,
    active: records.filter(record => record.outcome.kind === 'running').length,
    retained: records.length,
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
  const secondaryRead = (): never => {
    throw new Error('command performed a secondary recorder read')
  }
  const value: FlightRecorderReader = {
    info: () => RECORDER_INFO,
    snapshot(query = {}) {
      calls += 1
      return Object.freeze({
        info: RECORDER_INFO,
        revision: calls,
        health,
        records: Object.freeze(records.filter(record => (
          query.sessionId === undefined || record.sessionId === query.sessionId
        ))),
      })
    },
    subscribe: () => () => {},
    list: secondaryRead,
    get: secondaryRead,
    latest: secondaryRead,
    diff: secondaryRead,
    health: secondaryRead,
  }
  return { value, snapshotCalls: () => calls }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function commandWorld(records: readonly FlightRecord[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(CommandRuntime)
  const agent = fakeAgent(ctx)
  const recorder = reader(records)
  registerFlightCommand(ctx, recorder.value)
  return { ctx, agent, snapshotCalls: recorder.snapshotCalls }
}

describe('optional flight command lifecycle', () => {
  it('appears and disappears with the optional Commands service while core stays active', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      persona: '',
    })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(RequestFlightRecorder, { capacity: 8 })
    const recorder = ctx.requestFlightRecorder
    const agent = fakeAgent(ctx)
    expect(recorder.health().retained).toBe(0)

    const commandsFiber = await ctx.plugin(CommandRuntime)
    const commands = ctx.commands
    expect(commands.list(agent)).toContainEqual({
      name: 'flight',
      description: 'Inspect content-free model request diagnostics',
      input: { hint: '[latest|list [limit]|show <id>|diff [from] [to]|health]' },
    })
    expect(commands.find(agent, 'flight')?.recordInput).toBe(false)

    await commandsFiber.dispose()
    expect(commands.list(agent)).not.toContainEqual(
      expect.objectContaining({ name: 'flight' }),
    )
    expect(recorder.health().retained).toBe(0)

    await ctx.plugin(CommandRuntime)
    expect(ctx.commands.find(agent, 'flight')).toBeDefined()
  })
})

describe('/flight', () => {
  const current = flightRecord('abcdef12-current')
  const previousBase = flightRecord('12345678-previous', {
    step: 0,
    outcome: {
      kind: 'finished',
      finish: { kind: 'stop' },
      totalMs: 10,
    },
  })
  const previous = {
    ...previousBase,
    request: {
      ...previousBase.request,
      systemCharacters: 8,
    },
  }
  const otherSession = flightRecord('ffffeeee-other', {
    sessionId: SessionId('session-b'),
  })

  it('lists only the invoking Session with default and explicit limits', async () => {
    const currentSession = Array.from({ length: 11 }, (_, index) => (
      flightRecord(`${String(index).padStart(8, '0')}-record`, {
        turn: index + 1,
      })
    ))
    const { ctx, agent } = await commandWorld([...currentSession, otherSession])
    const signal = new AbortController().signal

    const defaults = await ctx.commands.execute(agent, '/flight list', signal)
    const one = await ctx.commands.execute(agent, '/flight list 1', signal)
    const twenty = await ctx.commands.execute(agent, '/flight list 20', signal)

    expect(defaults?.result).toMatchObject({ kind: 'success' })
    expect((defaults?.result.text ?? '').split('\n')).toHaveLength(11)
    expect((one?.result.text ?? '').split('\n')).toHaveLength(2)
    expect((twenty?.result.text ?? '').split('\n')).toHaveLength(12)
    expect(twenty?.result.text ?? '').not.toContain('ffffeeee')
    expect(twenty?.result.text ?? '').not.toContain('session-b')
  })

  it('rejects invalid list limits with stable usage and reports an empty list', async () => {
    const { ctx, agent } = await commandWorld([])
    const signal = new AbortController().signal
    const usage = 'usage: /flight [latest|list [limit]|show <id>|diff [from] [to]|health]'

    for (const input of ['0', '21', '1.5', 'nope', '1 extra']) {
      const result = await ctx.commands.execute(agent, `/flight list ${input}`, signal)
      expect(result?.result).toEqual({ kind: 'error', text: usage })
    }
    expect((await ctx.commands.execute(agent, '/flight list', signal))?.result).toEqual({
      kind: 'error',
      text: 'no retained flight records for this Session',
    })
  })

  it('supports empty input, latest, show, implicit diff, explicit diff, and health', async () => {
    const { ctx, agent } = await commandWorld([current, previous, otherSession])
    const signal = new AbortController().signal

    const empty = await ctx.commands.execute(agent, '/flight', signal)
    const latest = await ctx.commands.execute(agent, '/flight latest', signal)
    const show = await ctx.commands.execute(agent, '/flight show abcdef', signal)
    const implicitDiff = await ctx.commands.execute(agent, '/flight diff', signal)
    const explicitDiff = await ctx.commands.execute(
      agent,
      '/flight diff 123456 abcdef',
      signal,
    )
    const health = await ctx.commands.execute(agent, '/flight health', signal)

    expect(empty?.result).toEqual(latest?.result)
    expect(show?.result).toEqual(expect.objectContaining({
      kind: 'success',
      text: expect.stringContaining('flight abcdef12'),
    }))
    expect(implicitDiff?.result).toEqual(expect.objectContaining({
      kind: 'success',
      text: expect.stringContaining('flight diff 12345678 → abcdef12'),
    }))
    expect(explicitDiff?.result).toEqual(implicitDiff?.result)
    expect(health?.result).toEqual(expect.objectContaining({
      kind: 'success',
      text: expect.stringContaining('flight health'),
    }))
  })

  it('fails closed for malformed, missing, ambiguous, and cross-Session identifiers', async () => {
    const ambiguousA = flightRecord('abc11111-one')
    const ambiguousB = flightRecord('abc22222-two')
    const { ctx, agent } = await commandWorld([
      ambiguousA,
      ambiguousB,
      otherSession,
    ])
    const signal = new AbortController().signal

    const unknown = await ctx.commands.execute(agent, '/flight unknown', signal)
    const malformedShow = await ctx.commands.execute(agent, '/flight show', signal)
    const malformedDiff = await ctx.commands.execute(agent, '/flight diff abc', signal)
    const missing = await ctx.commands.execute(agent, '/flight show missing', signal)
    const ambiguous = await ctx.commands.execute(agent, '/flight show abc', signal)
    const crossSession = await ctx.commands.execute(agent, '/flight show ffffeeee', signal)
    const missingTo = await ctx.commands.execute(
      agent,
      '/flight diff abc11111 missing',
      signal,
    )

    for (const result of [
      unknown,
      malformedShow,
      malformedDiff,
      missing,
      ambiguous,
      crossSession,
      missingTo,
    ]) {
      expect(result?.result.kind).toBe('error')
    }
    expect(ambiguous?.result).toEqual({
      kind: 'error',
      text: 'request id prefix "abc" is ambiguous in this Session',
    })
    expect(crossSession?.result).toEqual({
      kind: 'error',
      text: 'request id prefix "ffffeeee" was not found in this Session',
    })
  })

  it('reports empty latest and requires two records for implicit diff', async () => {
    const emptyWorld = await commandWorld([])
    const signal = new AbortController().signal
    expect((await emptyWorld.ctx.commands.execute(
      emptyWorld.agent,
      '/flight',
      signal,
    ))?.result).toEqual({
      kind: 'error',
      text: 'no retained flight records for this Session',
    })

    const oneWorld = await commandWorld([current])
    expect((await oneWorld.ctx.commands.execute(
      oneWorld.agent,
      '/flight diff',
      signal,
    ))?.result).toEqual({
      kind: 'error',
      text: 'diff requires at least two retained flight records for this Session',
    })
  })

  it('bounds success output and omits raw command arguments from lifecycle events', async () => {
    const manyTools = Array.from({ length: 500 }, (_, index) => ({
      name: `tool_${index}`,
      parameterNodes: index,
    }))
    const base = flightRecord('abcdef12-long')
    const long = {
      ...base,
      request: {
        ...base.request,
        tools: manyTools,
      },
    }
    const { ctx, agent } = await commandWorld([long])

    const execution = await ctx.commands.execute(
      agent,
      '/flight show abcdef12',
      new AbortController().signal,
    )

    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text?.length).toBeLessThanOrEqual(4096)
    const commandRun = agent.session.events.find(event => event.type === 'command/run')
    expect(commandRun?.data).not.toHaveProperty('args')
  })

  it('never exposes a record from another Session through explicit diff', async () => {
    const { ctx, agent } = await commandWorld([current, previous, otherSession])

    const execution = await ctx.commands.execute(
      agent,
      '/flight diff ffffeeee abcdef',
      new AbortController().signal,
    )

    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).not.toContain(otherSession.sessionId)
  })

  it('reads exactly one atomic Snapshot for every command execution', async () => {
    const { ctx, agent, snapshotCalls } = await commandWorld([
      current,
      previous,
    ])
    const signal = new AbortController().signal

    for (const input of [
      '/flight',
      '/flight list',
      '/flight show abcdef',
      '/flight diff',
      '/flight diff 123456 abcdef',
      '/flight health',
    ]) {
      const before = snapshotCalls()
      await ctx.commands.execute(agent, input, signal)
      expect(snapshotCalls()).toBe(before + 1)
    }
  })
})
