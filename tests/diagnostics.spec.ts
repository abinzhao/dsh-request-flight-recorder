import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIAGNOSTIC_THRESHOLDS,
  explainFlightRecord,
  filterFlightRecords,
  median,
  nearestRank,
  summarizeFlightWindow,
} from '../src/diagnostics.js'
import { flightRecord } from './fixtures.js'

const thresholds = DEFAULT_DIAGNOSTIC_THRESHOLDS

describe('diagnostic record filters', () => {
  it('keeps newest-first order for finite failed, slow, and truncated subsets', () => {
    const running = flightRecord('running')
    const finished = flightRecord('finished', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 999,
        totalMs: 1_999,
      },
    })
    const slow = flightRecord('slow', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 1_000,
        totalMs: 2_000,
      },
    })
    const threw = flightRecord('threw', {
      outcome: {
        kind: 'threw',
        error: { kind: 'timeout-error' },
        totalMs: 10,
      },
    })
    const incomplete = flightRecord('incomplete', {
      outcome: {
        kind: 'incomplete',
        reason: 'consumer-returned',
        totalMs: 10,
      },
    })
    const truncated = flightRecord('truncated', {
      omissions: {
        ...running.omissions,
        promptSections: 1,
      },
    })
    const records = [running, finished, slow, threw, incomplete, truncated]

    expect(filterFlightRecords(records, 'all', thresholds)).toEqual(records)
    expect(filterFlightRecords(records, 'failed', thresholds)).toEqual([
      threw,
      incomplete,
    ])
    expect(filterFlightRecords(records, 'slow', thresholds)).toEqual([slow])
    expect(filterFlightRecords(records, 'truncated', thresholds)).toEqual([
      truncated,
    ])
  })
})

describe('flight explanation', () => {
  it('returns finite facts in deterministic diagnostic order', () => {
    const base = flightRecord('anomalous')
    const withPrompt = flightRecord('anomalous', {
      outcome: {
        kind: 'incomplete',
        reason: 'consumer-threw',
        firstChunkMs: 1_500,
        totalMs: 2_500,
      },
      omissions: {
        ...base.omissions,
        requestTools: 1,
        messageRoles: 2,
        promptSections: 3,
      },
    })
    const {
      promptAssembly: _discardedPrompt,
      ...record
    } = withPrompt

    expect(explainFlightRecord(record, thresholds)).toEqual([
      { kind: 'incomplete', reason: 'consumer-threw' },
      { kind: 'request-truncated', count: 3 },
      { kind: 'prompt-truncated', count: 3 },
      { kind: 'slow-first-chunk', milliseconds: 1_500 },
      { kind: 'slow-total', milliseconds: 2_500 },
      { kind: 'missing-prompt-assembly' },
    ])
  })

  it('classifies running and thrown records and uses no-anomaly alone', () => {
    expect(explainFlightRecord(flightRecord('running'), thresholds)).toEqual([
      { kind: 'running' },
    ])
    expect(explainFlightRecord(flightRecord('threw', {
      outcome: {
        kind: 'threw',
        error: { kind: 'type-error' },
        totalMs: 1,
      },
    }), thresholds)).toEqual([
      { kind: 'threw', error: 'type-error' },
    ])
    expect(explainFlightRecord(flightRecord('healthy', {
      outcome: {
        kind: 'finished',
        finish: { kind: 'stop' },
        firstChunkMs: 1,
        totalMs: 2,
      },
    }), thresholds)).toEqual([
      { kind: 'no-anomaly' },
    ])
  })
})

describe('retained-window statistics', () => {
  it('uses terminal success ratio, detached timing populations, and optional token sums', () => {
    const records = Object.freeze([
      flightRecord('running'),
      flightRecord('one', {
        outcome: {
          kind: 'finished',
          finish: { kind: 'stop' },
          firstChunkMs: 1,
          totalMs: 10,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      }),
      flightRecord('two', {
        outcome: {
          kind: 'finished',
          finish: { kind: 'tool-calls' },
          firstChunkMs: 3,
          totalMs: 20,
          usage: { inputTokens: 20, outputTokens: 4 },
        },
      }),
      flightRecord('three', {
        outcome: {
          kind: 'threw',
          error: { kind: 'error' },
          totalMs: 30,
        },
        omissions: {
          ...flightRecord('base').omissions,
          requestTools: 1,
        },
      }),
    ])
    const before = [...records]

    expect(summarizeFlightWindow(records)).toEqual({
      retained: 4,
      outcomes: {
        running: 1,
        finished: 2,
        threw: 1,
        incomplete: 0,
      },
      successRatio: 2 / 3,
      firstChunk: { median: 2, p95: 3 },
      total: { median: 20, p95: 30 },
      inputTokens: 30,
      outputTokens: 6,
      truncated: 1,
    })
    expect(records).toEqual(before)
    expect(Object.isFrozen(records)).toBe(true)
  })

  it('leaves unavailable values undefined for empty or running-only windows', () => {
    expect(summarizeFlightWindow([])).toEqual({
      retained: 0,
      outcomes: {
        running: 0,
        finished: 0,
        threw: 0,
        incomplete: 0,
      },
      successRatio: undefined,
      firstChunk: { median: undefined, p95: undefined },
      total: { median: undefined, p95: undefined },
      inputTokens: undefined,
      outputTokens: undefined,
      truncated: 0,
    })
    expect(summarizeFlightWindow([flightRecord('running')]).successRatio)
      .toBeUndefined()
  })
})

describe('diagnostic arithmetic', () => {
  it('calculates median and nearest-rank P95 without mutating values', () => {
    const values = Object.freeze([4, 1, 3, 2])

    expect(median(values)).toBe(2.5)
    expect(nearestRank(values, 0.95)).toBe(4)
    expect(values).toEqual([4, 1, 3, 2])
    expect(median([])).toBeUndefined()
    expect(nearestRank([], 0.95)).toBeUndefined()
  })

  it('rejects an invalid percentile', () => {
    for (const percentile of [0, 1.01, Number.NaN]) {
      expect(() => nearestRank([1], percentile)).toThrow(RangeError)
    }
  })
})
