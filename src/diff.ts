/**
 * Deterministic content-free request flight record comparison.
 * @module dsh-request-flight-recorder/diff
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type {
  FlightChange,
  FlightCounterField,
  FlightNamedField,
  FlightRecord,
  FlightRecordDiff,
  FlightScalarField,
  FlightScalarValue,
} from './types.js'

function finishKind(record: FlightRecord): string | null {
  return record.outcome.kind === 'finished'
    ? record.outcome.finish.kind
    : null
}

function timing(
  record: FlightRecord,
  key: 'firstChunkMs' | 'totalMs',
): number | null {
  if (record.outcome.kind === 'running') return null
  return record.outcome[key] ?? null
}

function usage(
  record: FlightRecord,
  key: 'inputTokens' | 'outputTokens',
): number | null {
  return 'usage' in record.outcome
    ? record.outcome.usage?.[key] ?? null
    : null
}

function addValue(
  changes: FlightChange[],
  field: FlightScalarField,
  before: FlightScalarValue,
  after: FlightScalarValue,
): void {
  if (before === after) return
  changes.push({ kind: 'value', field, before, after })
}

function addCounter(
  changes: FlightChange[],
  field: FlightCounterField,
  key: string | null,
  before: number | null,
  after: number | null,
): void {
  if (before === after) return
  changes.push({
    kind: 'counter',
    field,
    key,
    before,
    after,
    delta: before === null || after === null ? null : after - before,
  })
}

function addKeyedCounters(
  changes: FlightChange[],
  field: FlightCounterField,
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const key of keys) {
    addCounter(changes, field, key, before[key] ?? 0, after[key] ?? 0)
  }
}

function tools(record: FlightRecord): Map<string, number | null> {
  return new Map(record.request.tools.map(tool => [tool.name, tool.parameterNodes]))
}

function sections(record: FlightRecord): Map<string, number | null> {
  return new Map(
    (record.promptAssembly?.sections ?? [])
      .map(section => [section.name, section.characters]),
  )
}

function contexts(record: FlightRecord): Map<string, number | null> {
  return new Map(
    (record.promptAssembly?.contexts ?? [])
      .map(context => [context.name, context.characters]),
  )
}

function variables(record: FlightRecord): Map<string, number | null> {
  return new Map(
    (record.promptAssembly?.variables ?? [])
      .map(name => [name, null]),
  )
}

function addNamed(
  changes: FlightChange[],
  field: FlightNamedField,
  before: ReadonlyMap<string, number | null>,
  after: ReadonlyMap<string, number | null>,
): void {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const name of names) {
    const existedBefore = before.has(name)
    const existsAfter = after.has(name)
    const beforeSize = existedBefore ? before.get(name)! : null
    const afterSize = existsAfter ? after.get(name)! : null
    if (existedBefore && existsAfter && beforeSize === afterSize) continue
    changes.push({
      kind: 'named',
      field,
      name,
      change: !existedBefore ? 'added' : !existsAfter ? 'removed' : 'changed',
      beforeSize,
      afterSize,
    })
  }
}

/**
 * Compare two retained request attempts without accessing model-visible content.
 * @param from - earlier request attempt.
 * @param to - later request attempt.
 * @returns deeply frozen deterministic structural changes.
 */
export function diffFlightRecords(
  from: FlightRecord,
  to: FlightRecord,
): FlightRecordDiff {
  const changes: FlightChange[] = []

  addValue(changes, 'request.provider', from.request.provider, to.request.provider)
  addValue(changes, 'request.model', from.request.model, to.request.model)
  addValue(
    changes,
    'request.reasoningEffort',
    from.request.reasoningEffort ?? null,
    to.request.reasoningEffort ?? null,
  )
  addValue(
    changes,
    'request.temperature',
    from.request.temperature ?? null,
    to.request.temperature ?? null,
  )
  addValue(
    changes,
    'request.maxTokens',
    from.request.maxTokens ?? null,
    to.request.maxTokens ?? null,
  )
  addValue(changes, 'outcome.kind', from.outcome.kind, to.outcome.kind)
  addValue(changes, 'outcome.finish', finishKind(from), finishKind(to))

  addCounter(
    changes,
    'request.systemCharacters',
    null,
    from.request.systemCharacters,
    to.request.systemCharacters,
  )
  addCounter(
    changes,
    'messages.total',
    null,
    from.request.messages.total,
    to.request.messages.total,
  )
  addKeyedCounters(
    changes,
    'messages.byRole',
    from.request.messages.byRole,
    to.request.messages.byRole,
  )
  addKeyedCounters(
    changes,
    'messages.bySource',
    from.request.messages.bySource,
    to.request.messages.bySource,
  )
  addKeyedCounters(
    changes,
    'messages.byBlockType',
    from.request.messages.byBlockType,
    to.request.messages.byBlockType,
  )
  addCounter(
    changes,
    'timing.firstChunkMs',
    null,
    timing(from, 'firstChunkMs'),
    timing(to, 'firstChunkMs'),
  )
  addCounter(
    changes,
    'timing.totalMs',
    null,
    timing(from, 'totalMs'),
    timing(to, 'totalMs'),
  )
  addCounter(
    changes,
    'usage.inputTokens',
    null,
    usage(from, 'inputTokens'),
    usage(to, 'inputTokens'),
  )
  addCounter(
    changes,
    'usage.outputTokens',
    null,
    usage(from, 'outputTokens'),
    usage(to, 'outputTokens'),
  )

  addNamed(changes, 'tools', tools(from), tools(to))
  addNamed(changes, 'prompt.sections', sections(from), sections(to))
  addNamed(changes, 'prompt.contexts', contexts(from), contexts(to))
  addNamed(changes, 'prompt.variables', variables(from), variables(to))

  return deepFreeze({
    fromId: from.id,
    toId: to.id,
    changed: changes.length > 0,
    changes,
  })
}
