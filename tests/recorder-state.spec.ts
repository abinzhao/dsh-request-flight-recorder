import { describe, expect, it } from 'vitest'
import { RequestAttemptId } from '../src/types.js'
import {
  FlightRecorderState,
  RECORDER_INFO,
} from '../src/recorder-state.js'
import { flightRecord } from './fixtures.js'

const finished = {
  kind: 'finished',
  finish: { kind: 'stop' },
  totalMs: 10,
} as const

async function flushDeliveries(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('FlightRecorderState', () => {
  it('starts empty and owns the frozen reader handshake', () => {
    const state = new FlightRecorderState(2)

    expect(state.snapshot()).toEqual({
      info: RECORDER_INFO,
      revision: 0,
      health: {
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
      },
      records: [],
    })
    expect(state.info()).toBe(RECORDER_INFO)
    expect(Object.isFrozen(state.snapshot())).toBe(true)
    expect(() => new FlightRecorderState(0)).toThrow(
      'capacity must be a positive safe integer',
    )
  })

  it('captures, queries, diffs, truncates, and evicts transactionally', () => {
    const state = new FlightRecorderState(2)
    const first = flightRecord('first')
    const second = flightRecord('second', {
      omissions: {
        ...flightRecord('omissions').omissions,
        requestTools: 1,
      },
    })
    const third = flightRecord('third')

    state.capture(first)
    state.capture(second)
    state.capture(third)

    expect(state.snapshot()).toMatchObject({
      revision: 3,
      health: {
        captured: 3,
        active: 3,
        retained: 2,
        evicted: 1,
        truncatedRecords: 1,
      },
    })
    expect(state.list().map(record => record.id)).toEqual([
      third.id,
      second.id,
    ])
    expect(state.latest()).toBe(third)
    expect(state.get(second.id)).toBe(second)
    expect(state.get(first.id)).toBeUndefined()
    expect(state.diff(second.id, third.id)).toMatchObject({
      kind: 'ok',
      diff: { fromId: second.id, toId: third.id },
    })
    expect(state.diff(first.id, third.id)).toEqual({
      kind: 'missing',
      ids: [first.id],
    })
    const missing = RequestAttemptId('missing')
    expect(state.diff(second.id, missing)).toEqual({
      kind: 'missing',
      ids: [missing],
    })
    expect(state.diff(first.id, missing)).toEqual({
      kind: 'missing',
      ids: [first.id, missing],
    })
    expect(() => state.capture({
      ...flightRecord('terminal'),
      outcome: finished,
    })).toThrow('captured record must be running')
    expect(() => state.capture(third)).toThrow(
      'request attempt already exists: third',
    )
  })

  it('settles active identities once including after record eviction', () => {
    const state = new FlightRecorderState(1)
    const first = flightRecord('first')
    const second = flightRecord('second')
    state.capture(first)
    state.capture(second)

    expect(state.settle(first.id, finished)).toBe(true)
    expect(state.settle(first.id, finished)).toBe(false)
    expect(state.settle(second.id, finished)).toBe(true)
    expect(state.snapshot()).toMatchObject({
      revision: 4,
      health: {
        captured: 2,
        completed: 2,
        active: 0,
        retained: 1,
        evicted: 1,
      },
      records: [{ id: second.id, outcome: finished }],
    })
  })

  it('counts every correlation reason and projection failure', () => {
    const state = new FlightRecorderState(2)

    for (const reason of [
      'missing-signal',
      'missing-pending',
      'agent-mismatch',
      'session-mismatch',
    ] as const) {
      state.correlationMiss(reason)
    }
    state.projectionFailed()

    expect(state.snapshot()).toMatchObject({
      revision: 5,
      health: {
        correlationMisses: 4,
        correlationMissesByReason: {
          'missing-signal': 1,
          'missing-pending': 1,
          'agent-mismatch': 1,
          'session-mismatch': 1,
        },
        projectionFailures: 1,
      },
    })
  })

  it('isolates subscriber failure without publishing recursively', async () => {
    const state = new FlightRecorderState(2)
    const revisions: number[] = []
    state.subscribe(() => {
      throw new Error('subscriber failed')
    })
    const unsubscribe = state.subscribe(change => {
      revisions.push(change.revision)
    })

    state.capture(flightRecord('first'))
    await flushDeliveries()

    expect(revisions).toEqual([1])
    expect(state.snapshot()).toMatchObject({
      revision: 1,
      health: { subscriberFailures: 1 },
    })
    unsubscribe()
    unsubscribe()
  })

  it('disposes to zero and ignores later transaction writes', async () => {
    const state = new FlightRecorderState(2)
    const revisions: number[] = []
    state.subscribe(change => {
      revisions.push(change.revision)
    })
    const record = flightRecord('first')
    state.capture(record)

    state.dispose()
    state.dispose()
    state.capture(flightRecord('after-dispose'))
    state.correlationMiss('missing-signal')
    state.projectionFailed()

    expect(state.settle(record.id, finished)).toBe(false)
    expect(state.settle(RequestAttemptId('missing'), finished)).toBe(false)
    await flushDeliveries()
    expect(revisions).toEqual([])
    expect(state.snapshot()).toMatchObject({
      revision: 0,
      records: [],
      health: {
        captured: 0,
        completed: 0,
        active: 0,
        retained: 0,
        evicted: 0,
        truncatedRecords: 0,
        correlationMisses: 0,
        projectionFailures: 0,
        subscriberFailures: 0,
      },
    })
  })
})
