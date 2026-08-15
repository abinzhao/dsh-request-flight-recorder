/**
 * Stable bounded plain-text rendering for human flight diagnostics.
 * @module dsh-request-flight-recorder/format
 */

import type {
  FlightChange,
  FlightCounterChange,
  FlightNamedChange,
  FlightRecord,
  FlightRecordDiff,
  FlightRecorderHealth,
  FlightValueChange,
} from './types.js'

/** Maximum command-result text retained by the official command lifecycle. */
export const MAX_COMMAND_OUTPUT = 4096

const TRUNCATION_MARKER = '\n… output truncated'

function shortId(id: string): string {
  return id.slice(0, 8)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.join(', ')
}

function outcome(record: FlightRecord): string {
  const value = record.outcome
  if (value.kind === 'running') return 'outcome running'
  const timing = [
    value.firstChunkMs === undefined ? undefined : `ttft ${value.firstChunkMs}ms`,
    `total ${value.totalMs}ms`,
    value.usage === undefined
      ? undefined
      : `tokens ${value.usage.inputTokens} in / ${value.usage.outputTokens} out`,
  ].filter((part): part is string => part !== undefined)
  const status = value.kind === 'finished'
    ? `finished:${value.finish.kind}`
    : value.kind === 'threw'
      ? `threw:${value.error.kind}`
      : `incomplete:${value.reason}`
  return `outcome ${status} · ${timing.join(' · ')}`
}

/**
 * Render one retained request attempt.
 * @param record - immutable structural request record.
 * @returns concise plain text with no ANSI sequences.
 */
export function formatRecord(record: FlightRecord): string {
  const prompt = record.promptAssembly
  return [
    `flight ${shortId(record.id)}`,
    `turn ${record.turn} · step ${record.step} · attempt ${record.attempt}`,
    `model ${record.request.provider}/${record.request.model}`,
    `request ${plural(record.request.messages.total, 'message')} · ${record.request.systemCharacters} system chars · ${plural(record.request.tools.length, 'tool')}`,
    `tools ${list(record.request.tools.map(tool => `${tool.name}(${tool.parameterNodes})`))}`,
    `prompt sections ${list(prompt?.sections.map(item => item.name) ?? [])} · contexts ${list(prompt?.contexts.map(item => item.name) ?? [])} · variables ${list(prompt?.variables ?? [])}`,
    outcome(record),
  ].join('\n')
}

/**
 * Render compact rows for retained request attempts.
 * @param records - immutable records already scoped to the invoking Session.
 * @returns plain text containing only identity, coordinates, model, and outcome.
 */
export function formatRecordList(records: readonly FlightRecord[]): string {
  return [
    'flight list',
    ...records.map(record => (
      `${shortId(record.id)} · turn ${record.turn} · step ${record.step} · attempt ${record.attempt} · ${record.request.provider}/${record.request.model} · ${record.outcome.kind}`
    )),
  ].join('\n')
}

/**
 * Render process-local recorder health without Session detail.
 * @param health - immutable health snapshot.
 * @returns concise aggregate plain text.
 */
export function formatHealth(health: FlightRecorderHealth): string {
  return [
    'flight health',
    `captured ${health.captured} · completed ${health.completed} · active ${health.active}`,
    `retained ${health.retained} · evicted ${health.evicted}`,
    `truncated records ${health.truncatedRecords} · projection failures ${health.projectionFailures} · subscriber failures ${health.subscriberFailures}`,
    `correlation misses ${health.correlationMisses}`,
    `missing-signal ${health.correlationMissesByReason['missing-signal']} · missing-pending ${health.correlationMissesByReason['missing-pending']}`,
    `agent-mismatch ${health.correlationMissesByReason['agent-mismatch']} · session-mismatch ${health.correlationMissesByReason['session-mismatch']}`,
  ].join('\n')
}

function scalar(value: string | number | null): string {
  return value === null ? '∅' : String(value)
}

function formatValue(change: FlightValueChange): string {
  return `${change.field}: ${scalar(change.before)} → ${scalar(change.after)}`
}

function formatCounter(change: FlightCounterChange): string {
  const field = change.key === null
    ? change.field
    : `${change.field}[${change.key}]`
  const delta = change.delta === null
    ? ''
    : ` (${change.delta >= 0 ? '+' : ''}${change.delta})`
  return `${field}: ${scalar(change.before)} → ${scalar(change.after)}${delta}`
}

function formatNamed(change: FlightNamedChange): string {
  return `${change.field} ${change.name}: ${change.change} (${scalar(change.beforeSize)} → ${scalar(change.afterSize)})`
}

function formatChange(change: FlightChange): string {
  if (change.kind === 'value') return formatValue(change)
  if (change.kind === 'counter') return formatCounter(change)
  return formatNamed(change)
}

/**
 * Render a deterministic record diff.
 * @param diff - immutable structural diff.
 * @returns plain-text change list.
 */
export function formatDiff(diff: FlightRecordDiff): string {
  return [
    `flight diff ${shortId(diff.fromId)} → ${shortId(diff.toId)}`,
    ...(diff.changed
      ? diff.changes.map(formatChange)
      : ['no structural changes']),
  ].join('\n')
}

/**
 * Bound command text without cutting a UTF-16 surrogate pair.
 * @param text - complete command-result text.
 * @param max - maximum UTF-16 code units including the marker.
 * @returns unchanged or safely truncated text.
 */
export function boundCommandText(
  text: string,
  max = MAX_COMMAND_OUTPUT,
): string {
  if (
    !Number.isSafeInteger(max)
    || max <= TRUNCATION_MARKER.length
  ) {
    throw new RangeError('max must fit the truncation marker')
  }
  if (text.length <= max) return text
  let end = max - TRUNCATION_MARKER.length
  const finalCodeUnit = text.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1
  return text.slice(0, end) + TRUNCATION_MARKER
}
