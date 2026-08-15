/**
 * Privacy-safe finite classification of downstream failures.
 * @module dsh-request-flight-recorder/error
 */

import type { FlightErrorKind, FlightErrorSummary } from './types.js'

const ERROR_KINDS: Readonly<Record<string, FlightErrorKind>> = Object.freeze({
  Error: 'error',
  TypeError: 'type-error',
  RangeError: 'range-error',
  SyntaxError: 'syntax-error',
  ReferenceError: 'reference-error',
  URIError: 'uri-error',
  EvalError: 'eval-error',
  AggregateError: 'aggregate-error',
  AbortError: 'abort-error',
  TimeoutError: 'timeout-error',
})

/** Classify a thrown value without retaining arbitrary names or content. */
export function classifyFlightError(error: unknown): FlightErrorSummary {
  if (!(error instanceof Error)) {
    return Object.freeze({ kind: 'non-error-thrown' })
  }

  let name: string
  try {
    name = error.name
  } catch {
    return Object.freeze({ kind: 'error' })
  }

  return Object.freeze({
    kind: ERROR_KINDS[name] ?? 'error',
  })
}
