import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { emptyFlightRecordOmissions } from '../src/limits.js'
import { FlightRingStore } from '../src/ring-store.js'
import {
  FLIGHT_RECORD_SCHEMA_VERSION,
  type FlightRecord,
  type RequestAttemptId,
} from '../src/types.js'

function attemptId(value: string): RequestAttemptId {
  return value as RequestAttemptId
}

function sessionId(value: string): SessionId {
  return value as SessionId
}

function record(
  id: string,
  session: string,
  overrides: Partial<FlightRecord> = {},
): FlightRecord {
  const base: FlightRecord = {
    schemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
    id: attemptId(id),
    sessionId: sessionId(session),
    turn: 1,
    step: 1,
    attempt: 1,
    startedAt: 10,
    request: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: {
        total: 0,
        byRole: {},
        bySource: {},
        byBlockType: {},
      },
      systemCharacters: 0,
      tools: [],
    },
    outcome: { kind: 'running' },
    evidence: [{ kind: 'exact', source: 'llm/stream' }],
    omissions: emptyFlightRecordOmissions(),
  }
  return {
    ...base,
    ...overrides,
  }
}

describe('FlightRingStore', () => {
  it('evicts the oldest record when capacity is exceeded', () => {
    const store = new FlightRingStore(2)

    expect(store.size).toBe(0)
    expect(store.insert(record('a', 'session-a'))).toBeUndefined()
    expect(store.insert(record('b', 'session-a'))).toBeUndefined()
    expect(store.insert(record('c', 'session-b'))?.id).toBe('a')

    expect(store.list().map(item => item.id)).toEqual(['c', 'b'])
    expect(store.get(attemptId('a'))).toBeUndefined()
    expect(store.size).toBe(2)
  })

  it('filters by session without changing recency order', () => {
    const store = new FlightRingStore(3)

    store.insert(record('a', 'session-a'))
    store.insert(record('b', 'session-b'))
    store.insert(record('c', 'session-a'))

    expect(store.list({ sessionId: sessionId('session-a') }).map(item => item.id)).toEqual(['c', 'a'])
    expect(store.latest(sessionId('session-b'))?.id).toBe('b')
  })

  it('filters every query field conjunctively before applying limit', () => {
    const store = new FlightRingStore(4)
    const first = record('a', 'session-a', {
      turn: 1,
      step: 1,
    })
    const secondBase = record('b', 'session-a', {
      turn: 2,
      step: 1,
    })
    const second: FlightRecord = {
      ...secondBase,
      request: {
        ...secondBase.request,
        provider: 'openai',
        model: 'gpt-5',
      },
    }
    const thirdBase = record('c', 'session-a', {
      turn: 2,
      step: 2,
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        totalMs: 10,
      },
    })
    const third: FlightRecord = {
      ...thirdBase,
      request: {
        ...thirdBase.request,
        model: 'deepseek-reasoner',
      },
    }
    const fourth = record('d', 'session-b', {
      turn: 2,
      step: 2,
    })
    for (const item of [first, second, third, fourth]) store.insert(item)

    expect(store.list({ turn: 2 }).map(item => item.id)).toEqual(['d', 'c', 'b'])
    expect(store.list({ step: 1 }).map(item => item.id)).toEqual(['b', 'a'])
    expect(store.list({ provider: 'openai' }).map(item => item.id)).toEqual(['b'])
    expect(store.list({ model: 'deepseek-reasoner' }).map(item => item.id)).toEqual(['c'])
    expect(store.list({ outcome: 'finished' }).map(item => item.id)).toEqual(['c'])
    expect(store.list({
      sessionId: sessionId('session-a'),
      turn: 2,
      provider: 'deepseek',
      limit: 1,
    }).map(item => item.id)).toEqual(['c'])
  })

  it('rejects invalid query limits', () => {
    const store = new FlightRingStore(1)

    expect(() => store.list({ limit: 0 })).toThrow('limit must be a positive safe integer')
    expect(() => store.list({ limit: 1.5 })).toThrow('limit must be a positive safe integer')
  })

  it('updates a record without changing its insertion order', () => {
    const store = new FlightRingStore(2)
    store.insert(record('a', 'session-a'))
    store.insert(record('b', 'session-a'))

    store.update(attemptId('a'), current => ({
      ...current,
      outcome: { kind: 'finished', finish: { kind: 'stop' }, totalMs: 15 },
    }))

    expect(store.list().map(item => item.id)).toEqual(['b', 'a'])
    expect(store.get(attemptId('a'))?.outcome.kind).toBe('finished')

    expect(() => store.update(attemptId('missing'), () => {
      throw new Error('must not run')
    })).not.toThrow()
  })

  it('returns deeply frozen records and detached result arrays', () => {
    const store = new FlightRingStore(1)
    store.insert(record('a', 'session-a'))

    const first = store.list()
    const second = store.list()
    const stored = store.get(attemptId('a'))

    expect(first).not.toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored?.request)).toBe(true)
    expect(Object.isFrozen(stored?.request.tools)).toBe(true)
  })

  it('clears retained records and rejects invalid capacity', () => {
    expect(() => new FlightRingStore(0)).toThrow('capacity must be a positive safe integer')
    expect(() => new FlightRingStore(1.5)).toThrow('capacity must be a positive safe integer')

    const store = new FlightRingStore(1)
    store.insert(record('a', 'session-a'))
    store.clear()

    expect(store.list()).toEqual([])
    expect(store.latest()).toBeUndefined()
  })

  it('rejects duplicate request-attempt identities', () => {
    const store = new FlightRingStore(2)
    store.insert(record('a', 'session-a'))

    expect(() => store.insert(record('a', 'session-b'))).toThrow('request attempt already exists: a')
  })
})
