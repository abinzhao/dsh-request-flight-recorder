/**
 * Optional official human-command consumer for request flight diagnostics.
 * @module dsh-request-flight-recorder/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { diffFlightRecords } from './diff.js'
import {
  boundCommandText,
  formatDiff,
  formatExplanation,
  formatHealth,
  formatRecord,
  formatRecordList,
  formatWindowStats,
} from './format.js'
import {
  FLIGHT_MESSAGES,
  type FlightLocale,
  type FlightMessages,
} from './locale.js'
import {
  explainFlightRecord,
  filterFlightRecords,
  summarizeFlightWindow,
  type FlightDiagnosticThresholds,
  type FlightRecordFilter,
} from './diagnostics.js'
import type {
  FlightRecord,
  FlightRecorderReader,
  FlightRecorderSnapshot,
} from './types.js'

export interface FlightCommandOptions {
  readonly startupLocale: FlightLocale
  readonly currentLocale: () => FlightLocale
  readonly thresholds: FlightDiagnosticThresholds
}

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function success(text: string, messages: FlightMessages): CommandResult {
  return { kind: 'success', text: boundCommandText(text, messages) }
}

function resolvePrefix(
  records: readonly FlightRecord[],
  prefix: string,
  messages: FlightMessages,
): FlightRecord | CommandResult {
  const matches = records.filter(record => record.id.startsWith(prefix))
  if (matches.length === 0) {
    return error(messages.notFound(prefix))
  }
  if (matches.length > 1) {
    return error(messages.ambiguous(prefix))
  }
  return matches[0]!
}

function isCommandResult(
  value: FlightRecord | CommandResult,
): value is CommandResult {
  return 'kind' in value
}

function latest(
  records: readonly FlightRecord[],
  messages: FlightMessages,
): CommandResult {
  const record = records[0]
  return record === undefined
    ? error(messages.noRecords)
    : success(formatRecord(record, messages), messages)
}

function listRecords(
  records: readonly FlightRecord[],
  filter: FlightRecordFilter,
  limit: number,
  thresholds: FlightDiagnosticThresholds,
  messages: FlightMessages,
): CommandResult {
  const selected = filterFlightRecords(records, filter, thresholds)
    .slice(0, limit)
  return selected.length === 0
    ? error(messages.noRecords)
    : success(formatRecordList(selected, messages), messages)
}

function parseLimit(value: string): number | undefined {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 20
    ? limit
    : undefined
}

function parseList(
  args: readonly string[],
): { readonly filter: FlightRecordFilter; readonly limit: number } | undefined {
  if (args.length === 0) return { filter: 'all', limit: 10 }
  if (args.length === 1) {
    const limit = parseLimit(args[0]!)
    if (limit !== undefined) return { filter: 'all', limit }
    const filter = args[0]
    if (
      filter === 'all'
      || filter === 'failed'
      || filter === 'slow'
      || filter === 'truncated'
    ) {
      return { filter, limit: 10 }
    }
    return undefined
  }
  if (args.length === 2) {
    const [filter, rawLimit] = args
    const limit = parseLimit(rawLimit!)
    if (
      limit !== undefined
      && (
        filter === 'all'
        || filter === 'failed'
        || filter === 'slow'
        || filter === 'truncated'
      )
    ) {
      return { filter, limit }
    }
  }
  return undefined
}

function show(
  records: readonly FlightRecord[],
  prefix: string,
  messages: FlightMessages,
): CommandResult {
  const record = resolvePrefix(records, prefix, messages)
  return isCommandResult(record)
    ? record
    : success(formatRecord(record, messages), messages)
}

function renderDiff(
  from: FlightRecord,
  to: FlightRecord,
  messages: FlightMessages,
): CommandResult {
  return success(
    formatDiff(diffFlightRecords(from, to), messages),
    messages,
  )
}

function implicitDiff(
  records: readonly FlightRecord[],
  messages: FlightMessages,
): CommandResult {
  if (records.length < 2) {
    return error(messages.diffNeedsTwo)
  }
  return renderDiff(records[1]!, records[0]!, messages)
}

function explicitDiff(
  records: readonly FlightRecord[],
  fromPrefix: string,
  toPrefix: string,
  messages: FlightMessages,
): CommandResult {
  const from = resolvePrefix(records, fromPrefix, messages)
  if (isCommandResult(from)) return from
  const to = resolvePrefix(records, toPrefix, messages)
  if (isCommandResult(to)) return to
  return renderDiff(from, to, messages)
}

function execute(
  recorder: FlightRecorderReader,
  sessionId: SessionId,
  rawInput: string,
  messages: FlightMessages,
  thresholds: FlightDiagnosticThresholds,
): CommandResult {
  const snapshot: FlightRecorderSnapshot = recorder.snapshot({ sessionId })
  const records = snapshot.records
  const input = rawInput.trim()
  if (input === '') return latest(records, messages)
  const parts = input.split(/\s+/u)
  const [command, ...args] = parts

  if (command === 'latest' && args.length === 0) {
    return latest(records, messages)
  }
  if (command === 'list') {
    const parsed = parseList(args)
    return parsed === undefined
      ? error(messages.usage)
      : listRecords(
        records,
        parsed.filter,
        parsed.limit,
        thresholds,
        messages,
      )
  }
  if (command === 'health' && args.length === 0) {
    return success(formatHealth(snapshot.health, messages), messages)
  }
  if (command === 'show' && args.length === 1) {
    return show(records, args[0]!, messages)
  }
  if (command === 'diff' && args.length === 0) {
    return implicitDiff(records, messages)
  }
  if (command === 'diff' && args.length === 2) {
    return explicitDiff(records, args[0]!, args[1]!, messages)
  }
  if (command === 'explain' && args.length === 1) {
    const record = resolvePrefix(records, args[0]!, messages)
    return isCommandResult(record)
      ? record
      : success(
        formatExplanation(
          record,
          explainFlightRecord(record, thresholds),
          messages,
        ),
        messages,
      )
  }
  if (command === 'stats' && args.length === 0) {
    return success(
      formatWindowStats(summarizeFlightWindow(records), messages),
      messages,
    )
  }
  return error(messages.usage)
}

/**
 * Register `/flight` through the official human-command registry.
 * @param ctx - optional command-injected Cordis child context.
 * @param recorder - stable read-only flight recorder.
 */
export function registerFlightCommand(
  ctx: Context,
  recorder: FlightRecorderReader,
  options: FlightCommandOptions,
): void {
  const startupMessages = FLIGHT_MESSAGES[options.startupLocale]
  ctx.commands.register({
    name: 'flight',
    description: startupMessages.description,
    input: { hint: startupMessages.hint },
    recordInput: false,
    handler: ({ agent, rawInput }) => {
      const messages = FLIGHT_MESSAGES[options.currentLocale()]
      return execute(
        recorder,
        agent.session.id,
        rawInput,
        messages,
        options.thresholds,
      )
    },
  })
}
