/**
 * Pure retained-window diagnostics derived from one atomic Snapshot.
 * @module dsh-request-flight-recorder/diagnostics
 */

import { hasFlightRecordOmissions } from './limits.js'
import type {
  FlightErrorKind,
  FlightOutcome,
  FlightRecord,
  IncompleteFlightOutcome,
} from './types.js'

export interface FlightDiagnosticThresholds {
  readonly slowFirstChunkMs: number
  readonly slowTotalMs: number
}

export const DEFAULT_DIAGNOSTIC_THRESHOLDS: FlightDiagnosticThresholds =
  Object.freeze({
    slowFirstChunkMs: 1_000,
    slowTotalMs: 2_000,
  })

export type FlightRecordFilter = 'all' | 'failed' | 'slow' | 'truncated'

export type FlightExplanationFact =
  | { readonly kind: 'running' }
  | {
    readonly kind: 'incomplete'
    readonly reason: IncompleteFlightOutcome['reason']
  }
  | { readonly kind: 'threw'; readonly error: FlightErrorKind }
  | { readonly kind: 'request-truncated'; readonly count: number }
  | { readonly kind: 'prompt-truncated'; readonly count: number }
  | { readonly kind: 'slow-first-chunk'; readonly milliseconds: number }
  | { readonly kind: 'slow-total'; readonly milliseconds: number }
  | { readonly kind: 'missing-prompt-assembly' }
  | { readonly kind: 'no-anomaly' }

export interface FlightWindowStats {
  readonly retained: number
  readonly outcomes: Readonly<Record<FlightOutcome['kind'], number>>
  readonly successRatio: number | undefined
  readonly firstChunk: {
    readonly median: number | undefined
    readonly p95: number | undefined
  }
  readonly total: {
    readonly median: number | undefined
    readonly p95: number | undefined
  }
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly truncated: number
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right)
}

export function nearestRank(
  values: readonly number[],
  percentile: number,
): number | undefined {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new RangeError('percentile must be greater than zero and at most one')
  }
  if (values.length === 0) return undefined
  const ordered = sorted(values)
  return ordered[Math.ceil(percentile * ordered.length) - 1]
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const ordered = sorted(values)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1]! + ordered[middle]!) / 2
}

function isTerminal(
  outcome: FlightOutcome,
): outcome is Exclude<FlightOutcome, { readonly kind: 'running' }> {
  return outcome.kind !== 'running'
}

function isSlow(
  record: FlightRecord,
  thresholds: FlightDiagnosticThresholds,
): boolean {
  const outcome = record.outcome
  return isTerminal(outcome) && (
    (
      outcome.firstChunkMs !== undefined
      && outcome.firstChunkMs >= thresholds.slowFirstChunkMs
    )
    || outcome.totalMs >= thresholds.slowTotalMs
  )
}

export function filterFlightRecords(
  records: readonly FlightRecord[],
  filter: FlightRecordFilter,
  thresholds: FlightDiagnosticThresholds,
): readonly FlightRecord[] {
  if (filter === 'all') return Object.freeze([...records])
  return Object.freeze(records.filter(record => {
    if (filter === 'failed') {
      return record.outcome.kind === 'threw'
        || record.outcome.kind === 'incomplete'
    }
    if (filter === 'slow') return isSlow(record, thresholds)
    return hasFlightRecordOmissions(record.omissions)
  }))
}

function requestOmissions(record: FlightRecord): number {
  const omissions = record.omissions
  return omissions.requestTools
    + omissions.messageRoles
    + omissions.messageSources
    + omissions.messageBlockTypes
    + omissions.oversizedNames
    + omissions.truncatedToolSchemas
}

function promptOmissions(record: FlightRecord): number {
  const omissions = record.omissions
  return omissions.promptTools
    + omissions.promptSections
    + omissions.promptContexts
    + omissions.promptVariables
}

export function explainFlightRecord(
  record: FlightRecord,
  thresholds: FlightDiagnosticThresholds,
): readonly FlightExplanationFact[] {
  const facts: FlightExplanationFact[] = []
  const outcome = record.outcome
  if (outcome.kind === 'running') {
    facts.push({ kind: 'running' })
  } else if (outcome.kind === 'incomplete') {
    facts.push({ kind: 'incomplete', reason: outcome.reason })
  } else if (outcome.kind === 'threw') {
    facts.push({ kind: 'threw', error: outcome.error.kind })
  }

  const requestCount = requestOmissions(record)
  if (requestCount > 0) {
    facts.push({ kind: 'request-truncated', count: requestCount })
  }
  const promptCount = promptOmissions(record)
  if (promptCount > 0) {
    facts.push({ kind: 'prompt-truncated', count: promptCount })
  }
  if (
    isTerminal(outcome)
    && outcome.firstChunkMs !== undefined
    && outcome.firstChunkMs >= thresholds.slowFirstChunkMs
  ) {
    facts.push({
      kind: 'slow-first-chunk',
      milliseconds: outcome.firstChunkMs,
    })
  }
  if (
    isTerminal(outcome)
    && outcome.totalMs >= thresholds.slowTotalMs
  ) {
    facts.push({ kind: 'slow-total', milliseconds: outcome.totalMs })
  }
  if (record.promptAssembly === undefined) {
    facts.push({ kind: 'missing-prompt-assembly' })
  }
  if (facts.length === 0) facts.push({ kind: 'no-anomaly' })
  return Object.freeze(facts)
}

export function summarizeFlightWindow(
  records: readonly FlightRecord[],
): FlightWindowStats {
  const outcomes: Record<FlightOutcome['kind'], number> = {
    running: 0,
    finished: 0,
    threw: 0,
    incomplete: 0,
  }
  const firstChunk: number[] = []
  const total: number[] = []
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let terminal = 0
  let truncated = 0

  for (const record of records) {
    const outcome = record.outcome
    outcomes[outcome.kind] += 1
    if (hasFlightRecordOmissions(record.omissions)) truncated += 1
    if (!isTerminal(outcome)) continue
    terminal += 1
    total.push(outcome.totalMs)
    if (outcome.firstChunkMs !== undefined) {
      firstChunk.push(outcome.firstChunkMs)
    }
    if (outcome.usage !== undefined) {
      inputTokens = (inputTokens ?? 0) + outcome.usage.inputTokens
      outputTokens = (outputTokens ?? 0) + outcome.usage.outputTokens
    }
  }

  return Object.freeze({
    retained: records.length,
    outcomes: Object.freeze(outcomes),
    successRatio: terminal === 0 ? undefined : outcomes.finished / terminal,
    firstChunk: Object.freeze({
      median: median(firstChunk),
      p95: nearestRank(firstChunk, 0.95),
    }),
    total: Object.freeze({
      median: median(total),
      p95: nearestRank(total, 0.95),
    }),
    inputTokens,
    outputTokens,
    truncated,
  })
}
