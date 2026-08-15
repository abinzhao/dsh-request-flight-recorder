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
import type { FlightMessages } from './locale.js'
import type {
  FlightExplanationFact,
  FlightWindowStats,
} from './diagnostics.js'

/** Maximum command-result text retained by the official command lifecycle. */
export const MAX_COMMAND_OUTPUT = 4096

function shortId(id: string): string {
  return id.slice(0, 8)
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.join(', ')
}

function outcome(record: FlightRecord, messages: FlightMessages): string {
  const value = record.outcome
  if (value.kind === 'running') {
    return `${messages.labels.outcome} ${messages.outcomes.running}`
  }
  const timing = [
    value.firstChunkMs === undefined
      ? undefined
      : `${messages.labels.ttft} ${value.firstChunkMs}ms`,
    `${messages.labels.total} ${value.totalMs}ms`,
    value.usage === undefined
      ? undefined
      : `${messages.labels.tokens} ${value.usage.inputTokens} ${messages.labels.input} / ${value.usage.outputTokens} ${messages.labels.output}`,
  ].filter((part): part is string => part !== undefined)
  const status = value.kind === 'finished'
    ? `${messages.outcomes.finished}:${messages.finishes[value.finish.kind]}`
    : value.kind === 'threw'
      ? `${messages.outcomes.threw}:${messages.errors[value.error.kind]}`
      : `${messages.outcomes.incomplete}:${messages.incomplete[value.reason]}`
  return `${messages.labels.outcome} ${status} · ${timing.join(' · ')}`
}

/**
 * Render one retained request attempt.
 * @param record - immutable structural request record.
 * @returns concise plain text with no ANSI sequences.
 */
export function formatRecord(
  record: FlightRecord,
  messages: FlightMessages,
): string {
  const prompt = record.promptAssembly
  return [
    messages.recordTitle(shortId(record.id)),
    `${messages.labels.turn} ${record.turn} · ${messages.labels.step} ${record.step} · ${messages.labels.attempt} ${record.attempt}`,
    `${messages.labels.model} ${record.request.provider}/${record.request.model}`,
    `${messages.labels.request} ${messages.messages(record.request.messages.total)} · ${messages.characters(record.request.systemCharacters)} · ${messages.toolCount(record.request.tools.length)}`,
    `${messages.labels.tools} ${list(record.request.tools.map(tool => `${tool.name}(${tool.parameterNodes})`))}`,
    `${messages.labels.prompt} ${messages.labels.sections} ${list(prompt?.sections.map(item => item.name) ?? [])} · ${messages.labels.contexts} ${list(prompt?.contexts.map(item => item.name) ?? [])} · ${messages.labels.variables} ${list(prompt?.variables ?? [])}`,
    outcome(record, messages),
  ].join('\n')
}

/**
 * Render compact rows for retained request attempts.
 * @param records - immutable records already scoped to the invoking Session.
 * @returns plain text containing only identity, coordinates, model, and outcome.
 */
export function formatRecordList(
  records: readonly FlightRecord[],
  messages: FlightMessages,
): string {
  return [
    messages.titles.list,
    ...records.map(record => (
      `${shortId(record.id)} · ${messages.labels.turn} ${record.turn} · ${messages.labels.step} ${record.step} · ${messages.labels.attempt} ${record.attempt} · ${record.request.provider}/${record.request.model} · ${messages.outcomes[record.outcome.kind]}`
    )),
  ].join('\n')
}

/**
 * Render process-local recorder health without Session detail.
 * @param health - immutable health snapshot.
 * @returns concise aggregate plain text.
 */
export function formatHealth(
  health: FlightRecorderHealth,
  messages: FlightMessages,
): string {
  return [
    messages.titles.health,
    `${messages.labels.captured} ${health.captured} · ${messages.labels.completed} ${health.completed} · ${messages.labels.active} ${health.active}`,
    `${messages.labels.retained} ${health.retained} · ${messages.labels.evicted} ${health.evicted}`,
    `${messages.labels.truncatedRecords} ${health.truncatedRecords} · ${messages.labels.projectionFailures} ${health.projectionFailures} · ${messages.labels.subscriberFailures} ${health.subscriberFailures}`,
    `${messages.labels.correlationMisses} ${health.correlationMisses}`,
    `${messages.correlation['missing-signal']} ${health.correlationMissesByReason['missing-signal']} · ${messages.correlation['missing-pending']} ${health.correlationMissesByReason['missing-pending']}`,
    `${messages.correlation['agent-mismatch']} ${health.correlationMissesByReason['agent-mismatch']} · ${messages.correlation['session-mismatch']} ${health.correlationMissesByReason['session-mismatch']}`,
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

function formatNamed(
  change: FlightNamedChange,
  messages: FlightMessages,
): string {
  return `${change.field} ${change.name}: ${messages.namedChanges[change.change]} (${scalar(change.beforeSize)} → ${scalar(change.afterSize)})`
}

function formatChange(
  change: FlightChange,
  messages: FlightMessages,
): string {
  if (change.kind === 'value') return formatValue(change)
  if (change.kind === 'counter') return formatCounter(change)
  return formatNamed(change, messages)
}

/**
 * Render a deterministic record diff.
 * @param diff - immutable structural diff.
 * @returns plain-text change list.
 */
export function formatDiff(
  diff: FlightRecordDiff,
  messages: FlightMessages,
): string {
  return [
    `${messages.titles.diff} ${shortId(diff.fromId)} → ${shortId(diff.toId)}`,
    ...(diff.changed
      ? diff.changes.map(change => formatChange(change, messages))
      : [messages.noStructuralChanges]),
  ].join('\n')
}

function formatFact(
  fact: FlightExplanationFact,
  messages: FlightMessages,
): string {
  if (fact.kind === 'running') return messages.facts.running
  if (fact.kind === 'incomplete') {
    return `${messages.facts.incomplete}: ${messages.incomplete[fact.reason]}`
  }
  if (fact.kind === 'threw') {
    return `${messages.facts.threw}: ${messages.errors[fact.error]}`
  }
  if (fact.kind === 'request-truncated') {
    return `${messages.facts.requestTruncated}: ${fact.count}`
  }
  if (fact.kind === 'prompt-truncated') {
    return `${messages.facts.promptTruncated}: ${fact.count}`
  }
  if (fact.kind === 'slow-first-chunk') {
    return `${messages.facts.slowFirstChunk}: ${fact.milliseconds}ms`
  }
  if (fact.kind === 'slow-total') {
    return `${messages.facts.slowTotal}: ${fact.milliseconds}ms`
  }
  if (fact.kind === 'missing-prompt-assembly') {
    return messages.facts.missingPromptAssembly
  }
  return messages.facts.noAnomaly
}

export function formatExplanation(
  record: FlightRecord,
  facts: readonly FlightExplanationFact[],
  messages: FlightMessages,
): string {
  return [
    `${messages.titles.explain} ${shortId(record.id)}`,
    ...facts.map(fact => `- ${formatFact(fact, messages)}`),
    `${messages.suggestions.title}:`,
    `- ${messages.suggestions.compare}`,
    `- ${messages.suggestions.inspectLifecycle}`,
  ].join('\n')
}

function metric(value: number | undefined, messages: FlightMessages): string {
  return value === undefined ? messages.unavailable : String(value)
}

function milliseconds(
  value: number | undefined,
  messages: FlightMessages,
): string {
  return value === undefined ? messages.unavailable : `${value}ms`
}

function ratio(value: number | undefined, messages: FlightMessages): string {
  if (value === undefined) return messages.unavailable
  return `${Math.round(value * 1_000) / 10}%`
}

export function formatWindowStats(
  stats: FlightWindowStats,
  messages: FlightMessages,
): string {
  return [
    `${messages.titles.stats} · ${messages.retainedWindow}`,
    `${messages.labels.retained} ${stats.retained} · ${messages.labels.truncatedRecords} ${stats.truncated}`,
    `${messages.outcomes.running} ${stats.outcomes.running} · ${messages.outcomes.finished} ${stats.outcomes.finished} · ${messages.outcomes.threw} ${stats.outcomes.threw} · ${messages.outcomes.incomplete} ${stats.outcomes.incomplete}`,
    `${messages.labels.successRatio} ${ratio(stats.successRatio, messages)}`,
    `${messages.labels.firstChunk}: ${messages.labels.median} ${milliseconds(stats.firstChunk.median, messages)} · ${messages.labels.p95} ${milliseconds(stats.firstChunk.p95, messages)}`,
    `${messages.labels.total}: ${messages.labels.median} ${milliseconds(stats.total.median, messages)} · ${messages.labels.p95} ${milliseconds(stats.total.p95, messages)}`,
    `${messages.labels.tokens}: ${messages.labels.input} ${metric(stats.inputTokens, messages)} · ${messages.labels.output} ${metric(stats.outputTokens, messages)}`,
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
  messages: FlightMessages,
  max = MAX_COMMAND_OUTPUT,
): string {
  const marker = messages.truncated
  if (
    !Number.isSafeInteger(max)
    || max <= marker.length
  ) {
    throw new RangeError('max must fit the truncation marker')
  }
  if (text.length <= max) return text
  let end = max - marker.length
  const finalCodeUnit = text.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1
  return text.slice(0, end) + marker
}
