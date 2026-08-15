import { SessionId } from '@deepseek-ai/dsh-session'
import { emptyFlightRecordOmissions } from '../src/limits.js'
import {
  FLIGHT_RECORD_SCHEMA_VERSION,
  RequestAttemptId,
  type FlightRecord,
} from '../src/types.js'

export function flightRecord(
  id: string,
  overrides: Partial<FlightRecord> = {},
): FlightRecord {
  const base: FlightRecord = {
      schemaVersion: FLIGHT_RECORD_SCHEMA_VERSION,
    id: RequestAttemptId(id),
    sessionId: SessionId('session-a'),
    turn: 1,
    step: 1,
    attempt: 1,
    startedAt: 10,
    request: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: {
        total: 1,
        byRole: { user: 1 },
        bySource: { user: 1 },
        byBlockType: { text: 1 },
      },
      systemCharacters: 10,
      tools: [{
        name: 'read_file',
        parameterNodes: 2,
      }],
    },
    promptAssembly: {
      sections: [{ name: 'identity', characters: 10 }],
      contexts: [{ name: 'workspace', characters: 20 }],
      tools: ['read_file'],
      variables: ['cwd'],
    },
    outcome: { kind: 'running' },
    evidence: [
      { kind: 'exact', source: 'llm/stream' },
      { kind: 'exact', source: 'agent/request' },
      { kind: 'derived', source: 'system-prompt/assemble' },
    ],
      omissions: emptyFlightRecordOmissions(),
  }
  return {
    ...base,
    ...overrides,
  }
}
