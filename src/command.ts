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
  formatHealth,
  formatRecord,
  formatRecordList,
} from './format.js'
import type {
  FlightRecord,
  FlightRecorderReader,
  FlightRecorderSnapshot,
} from './types.js'

const USAGE = 'usage: /flight [latest|list [limit]|show <id>|diff [from] [to]|health]'

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function success(text: string): CommandResult {
  return { kind: 'success', text: boundCommandText(text) }
}

function resolvePrefix(
  records: readonly FlightRecord[],
  prefix: string,
): FlightRecord | CommandResult {
  const matches = records.filter(record => record.id.startsWith(prefix))
  if (matches.length === 0) {
    return error(`request id prefix "${prefix}" was not found in this Session`)
  }
  if (matches.length > 1) {
    return error(`request id prefix "${prefix}" is ambiguous in this Session`)
  }
  return matches[0]!
}

function isCommandResult(
  value: FlightRecord | CommandResult,
): value is CommandResult {
  return 'kind' in value
}

function latest(records: readonly FlightRecord[]): CommandResult {
  const record = records[0]
  return record === undefined
    ? error('no retained flight records for this Session')
    : success(formatRecord(record))
}

function listRecords(
  records: readonly FlightRecord[],
  limit: number,
): CommandResult {
  const selected = records.slice(0, limit)
  return selected.length === 0
    ? error('no retained flight records for this Session')
    : success(formatRecordList(selected))
}

function show(
  records: readonly FlightRecord[],
  prefix: string,
): CommandResult {
  const record = resolvePrefix(records, prefix)
  return isCommandResult(record) ? record : success(formatRecord(record))
}

function renderDiff(
  from: FlightRecord,
  to: FlightRecord,
): CommandResult {
  return success(formatDiff(diffFlightRecords(from, to)))
}

function implicitDiff(records: readonly FlightRecord[]): CommandResult {
  if (records.length < 2) {
    return error('diff requires at least two retained flight records for this Session')
  }
  return renderDiff(records[1]!, records[0]!)
}

function explicitDiff(
  records: readonly FlightRecord[],
  fromPrefix: string,
  toPrefix: string,
): CommandResult {
  const from = resolvePrefix(records, fromPrefix)
  if (isCommandResult(from)) return from
  const to = resolvePrefix(records, toPrefix)
  if (isCommandResult(to)) return to
  return renderDiff(from, to)
}

function execute(
  recorder: FlightRecorderReader,
  sessionId: SessionId,
  rawInput: string,
): CommandResult {
  const snapshot: FlightRecorderSnapshot = recorder.snapshot({ sessionId })
  const records = snapshot.records
  const input = rawInput.trim()
  if (input === '') return latest(records)
  const parts = input.split(/\s+/u)
  const [command, ...args] = parts

  if (command === 'latest' && args.length === 0) {
    return latest(records)
  }
  if (command === 'list' && args.length === 0) {
    return listRecords(records, 10)
  }
  if (command === 'list' && args.length === 1) {
    const limit = Number(args[0])
    if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 20) {
      return listRecords(records, limit)
    }
    return error(USAGE)
  }
  if (command === 'health' && args.length === 0) {
    return success(formatHealth(snapshot.health))
  }
  if (command === 'show' && args.length === 1) {
    return show(records, args[0]!)
  }
  if (command === 'diff' && args.length === 0) {
    return implicitDiff(records)
  }
  if (command === 'diff' && args.length === 2) {
    return explicitDiff(records, args[0]!, args[1]!)
  }
  return error(USAGE)
}

/**
 * Register `/flight` through the official human-command registry.
 * @param ctx - optional command-injected Cordis child context.
 * @param recorder - stable read-only flight recorder.
 */
export function registerFlightCommand(
  ctx: Context,
  recorder: FlightRecorderReader,
): void {
  ctx.commands.register({
    name: 'flight',
    description: 'Inspect content-free model request diagnostics',
    input: { hint: '[latest|list [limit]|show <id>|diff [from] [to]|health]' },
    recordInput: false,
    handler: ({ agent, rawInput }) => (
      execute(recorder, agent.session.id, rawInput)
    ),
  })
}
