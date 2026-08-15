/**
 * Optional official human-command consumer for request flight diagnostics.
 * @module dsh-request-flight-recorder/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  boundCommandText,
  formatDiff,
  formatHealth,
  formatRecord,
  formatRecordList,
} from './format.js'
import type {
  FlightDiffResult,
  FlightRecord,
  FlightRecordQuery,
  FlightRecorderHealth,
  RequestAttemptId,
} from './types.js'

/** Read-only diagnostics required by the optional command consumer. */
export interface FlightDiagnostics {
  list(query?: FlightRecordQuery): readonly FlightRecord[]
  latest(sessionId?: SessionId): FlightRecord | undefined
  health(): FlightRecorderHealth
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult
}

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

function latest(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
): CommandResult {
  const record = recorder.latest(sessionId)
  return record === undefined
    ? error('no retained flight records for this Session')
    : success(formatRecord(record))
}

function listRecords(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
  limit: number,
): CommandResult {
  const records = recorder.list({ sessionId, limit })
  return records.length === 0
    ? error('no retained flight records for this Session')
    : success(formatRecordList(records))
}

function show(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
  prefix: string,
): CommandResult {
  const record = resolvePrefix(recorder.list({ sessionId }), prefix)
  return isCommandResult(record) ? record : success(formatRecord(record))
}

function renderDiff(
  recorder: FlightDiagnostics,
  from: FlightRecord,
  to: FlightRecord,
): CommandResult {
  const result = recorder.diff(from.id, to.id)
  if (result.kind === 'missing') {
    return error('one or more request records were evicted before diff completed')
  }
  return success(formatDiff(result.diff))
}

function implicitDiff(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
): CommandResult {
  const records = recorder.list({ sessionId, limit: 2 })
  if (records.length < 2) {
    return error('diff requires at least two retained flight records for this Session')
  }
  return renderDiff(recorder, records[1]!, records[0]!)
}

function explicitDiff(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
  fromPrefix: string,
  toPrefix: string,
): CommandResult {
  const records = recorder.list({ sessionId })
  const from = resolvePrefix(records, fromPrefix)
  if (isCommandResult(from)) return from
  const to = resolvePrefix(records, toPrefix)
  if (isCommandResult(to)) return to
  return renderDiff(recorder, from, to)
}

function execute(
  recorder: FlightDiagnostics,
  sessionId: SessionId,
  rawInput: string,
): CommandResult {
  const input = rawInput.trim()
  if (input === '') return latest(recorder, sessionId)
  const parts = input.split(/\s+/u)
  const [command, ...args] = parts

  if (command === 'latest' && args.length === 0) {
    return latest(recorder, sessionId)
  }
  if (command === 'list' && args.length === 0) {
    return listRecords(recorder, sessionId, 10)
  }
  if (command === 'list' && args.length === 1) {
    const limit = Number(args[0])
    if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 20) {
      return listRecords(recorder, sessionId, limit)
    }
    return error(USAGE)
  }
  if (command === 'health' && args.length === 0) {
    return success(formatHealth(recorder.health()))
  }
  if (command === 'show' && args.length === 1) {
    return show(recorder, sessionId, args[0]!)
  }
  if (command === 'diff' && args.length === 0) {
    return implicitDiff(recorder, sessionId)
  }
  if (command === 'diff' && args.length === 2) {
    return explicitDiff(recorder, sessionId, args[0]!, args[1]!)
  }
  return error(USAGE)
}

/**
 * Register `/flight` through the official human-command registry.
 * @param ctx - optional command-injected Cordis child context.
 * @param recorder - read-only flight diagnostics service.
 */
export function registerFlightCommand(
  ctx: Context,
  recorder: FlightDiagnostics,
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
