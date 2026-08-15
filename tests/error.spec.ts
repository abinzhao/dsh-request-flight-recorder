import { describe, expect, it } from 'vitest'
import { classifyFlightError } from '../src/error.js'
import type { FlightErrorKind } from '../src/types.js'

function namedError(name: string): Error {
  return Object.assign(new Error('TOP_SECRET_VALUE'), { name })
}

describe('classifyFlightError', () => {
  it.each([
    ['Error', 'error'],
    ['TypeError', 'type-error'],
    ['RangeError', 'range-error'],
    ['SyntaxError', 'syntax-error'],
    ['ReferenceError', 'reference-error'],
    ['URIError', 'uri-error'],
    ['EvalError', 'eval-error'],
    ['AggregateError', 'aggregate-error'],
    ['AbortError', 'abort-error'],
    ['TimeoutError', 'timeout-error'],
  ] satisfies ReadonlyArray<readonly [string, FlightErrorKind]>)(
    'maps %s to %s',
    (name, kind) => {
      expect(classifyFlightError(namedError(name))).toEqual({ kind })
    },
  )

  it('maps unknown and unreadable names to error', () => {
    expect(classifyFlightError(namedError('Provider_TOP_SECRET_VALUE'))).toEqual({
      kind: 'error',
    })

    const unreadable = new Error('TOP_SECRET_VALUE')
    Object.defineProperty(unreadable, 'name', {
      get() {
        throw new Error('TOP_SECRET_NAME')
      },
    })
    expect(classifyFlightError(unreadable)).toEqual({ kind: 'error' })
  })

  it('maps non-Error values without stringifying them', () => {
    const value = {
      toString() {
        throw new Error('must not stringify')
      },
    }

    expect(classifyFlightError(value)).toEqual({
      kind: 'non-error-thrown',
    })
  })

  it('returns frozen summaries without retained secret content', () => {
    const summary = classifyFlightError(namedError('TypeError'))

    expect(Object.isFrozen(summary)).toBe(true)
    expect(JSON.stringify(summary)).not.toContain('TOP_SECRET_VALUE')
  })
})
