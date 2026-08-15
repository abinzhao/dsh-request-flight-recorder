/**
 * Public data types for request flight records.
 * @module dsh-request-flight-recorder/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable identity of one observed model-request attempt. */
export type RequestAttemptId = Branded<'RequestAttemptId'>

/** Stable schema carried by every v1 record. */
export const FLIGHT_RECORD_SCHEMA_VERSION = 1 as const

/** Stable in-process reader protocol version. */
export const FLIGHT_RECORDER_PROTOCOL_VERSION = 1 as const

/**
 * Brand a runtime string as a request-attempt identity.
 * @param value - unique request-attempt value.
 * @returns the same string with its compile-time brand.
 */
export function RequestAttemptId(value: string): RequestAttemptId {
  return value as RequestAttemptId
}

/** Evidence quality attached to one group of recorded facts. */
export type FlightEvidenceKind = 'exact' | 'derived' | 'inferred'

/** Provenance of one group of recorded facts. */
export interface FlightEvidence {
  readonly kind: FlightEvidenceKind
  readonly source: 'llm/stream' | 'agent/request' | 'system-prompt/assemble'
}

/** Structural summary of model-visible messages. */
export interface MessageSummary {
  readonly total: number
  readonly byRole: Readonly<Record<string, number>>
  readonly bySource: Readonly<Record<string, number>>
  readonly byBlockType: Readonly<Record<string, number>>
}

/** Structural summary of one model-visible tool. */
export interface ToolSummary {
  readonly name: string
  readonly parameterNodes: number
}

/** Content-free summary of one exact model request. */
export interface RequestSummary {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stopCount?: number
  readonly messages: MessageSummary
  readonly systemCharacters: number
  readonly tools: readonly ToolSummary[]
}

/** One named prompt contribution without its text. */
export interface PromptContributionSummary {
  readonly name: string
  readonly characters: number
}

/** Content-free summary of one authoritative prompt assembly. */
export interface PromptAssemblySummary {
  readonly sections: readonly PromptContributionSummary[]
  readonly contexts: readonly PromptContributionSummary[]
  readonly tools: readonly string[]
  readonly variables: readonly string[]
}

/** Structural observations omitted by hard per-record safety limits. */
export interface FlightRecordOmissions {
  readonly requestTools: number
  readonly promptTools: number
  readonly promptSections: number
  readonly promptContexts: number
  readonly promptVariables: number
  readonly messageRoles: number
  readonly messageSources: number
  readonly messageBlockTypes: number
  readonly oversizedNames: number
  readonly truncatedToolSchemas: number
}

/** Running request with no observed terminal outcome yet. */
export interface RunningFlightOutcome {
  readonly kind: 'running'
}

/** Request whose downstream stream emitted a terminal finish chunk. */
export interface FinishedFlightOutcome {
  readonly kind: 'finished'
  readonly finish: FinishReason
  readonly firstChunkMs?: number
  readonly totalMs: number
  readonly usage?: TokenUsage
}

/** Finite error categories retained without arbitrary upstream text. */
export type FlightErrorKind =
  | 'error'
  | 'type-error'
  | 'range-error'
  | 'syntax-error'
  | 'reference-error'
  | 'uri-error'
  | 'eval-error'
  | 'aggregate-error'
  | 'abort-error'
  | 'timeout-error'
  | 'non-error-thrown'

/** Privacy-safe summary of one thrown value. */
export interface FlightErrorSummary {
  readonly kind: FlightErrorKind
}

/** Request whose downstream stream threw. */
export interface ThrewFlightOutcome {
  readonly kind: 'threw'
  readonly error: FlightErrorSummary
  readonly firstChunkMs?: number
  readonly totalMs: number
  readonly usage?: TokenUsage
}

/** Request observation that ended without a provider finish. */
export interface IncompleteFlightOutcome {
  readonly kind: 'incomplete'
  readonly reason:
    | 'stream-ended-without-finish'
    | 'consumer-returned'
    | 'consumer-threw'
  readonly firstChunkMs?: number
  readonly totalMs: number
  readonly usage?: TokenUsage
}

/** Terminal or in-flight state of one observed request. */
export type FlightOutcome =
  | RunningFlightOutcome
  | FinishedFlightOutcome
  | ThrewFlightOutcome
  | IncompleteFlightOutcome

/** One immutable request-attempt record. */
export interface FlightRecord {
  readonly schemaVersion: 1
  readonly id: RequestAttemptId
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly startedAt: number
  readonly request: RequestSummary
  readonly promptAssembly?: PromptAssemblySummary
  readonly outcome: FlightOutcome
  readonly evidence: readonly FlightEvidence[]
  readonly omissions: FlightRecordOmissions
}

/** Optional filters for flight-record listing. */
export interface FlightRecordQuery {
  readonly sessionId?: SessionId
  readonly turn?: number
  readonly step?: number
  readonly provider?: string
  readonly model?: string
  readonly outcome?: FlightOutcome['kind']
  readonly limit?: number
}

/** Finite reason for rejecting one marked request correlation. */
export type CorrelationMissReason =
  | 'missing-signal'
  | 'missing-pending'
  | 'agent-mismatch'
  | 'session-mismatch'

/** Process-local recorder health counters. */
export interface FlightRecorderHealth {
  readonly captured: number
  readonly completed: number
  readonly active: number
  readonly retained: number
  readonly evicted: number
  readonly truncatedRecords: number
  readonly correlationMisses: number
  readonly correlationMissesByReason:
    Readonly<Record<CorrelationMissReason, number>>
  readonly projectionFailures: number
  readonly subscriberFailures: number
}

/** Stable read capabilities exposed by the v1 service. */
export type FlightRecorderCapability =
  | 'diff'
  | 'health'
  | 'query'
  | 'snapshot'
  | 'subscribe'

/** Version and capability handshake for optional consumers. */
export interface FlightRecorderInfo {
  readonly protocolVersion: 1
  readonly recordSchemaVersion: 1
  readonly capabilities: readonly [
    'diff',
    'health',
    'query',
    'snapshot',
    'subscribe',
  ]
}

/** One atomic read of recorder identity, health, and retained records. */
export interface FlightRecorderSnapshot {
  readonly info: FlightRecorderInfo
  readonly revision: number
  readonly health: FlightRecorderHealth
  readonly records: readonly FlightRecord[]
}

/** Coalesced live-view invalidation carrying the latest service revision. */
export interface FlightRecorderChange {
  readonly revision: number
}

/** Optional consumer notified outside the synchronous capture stack. */
export type FlightRecorderListener = (
  change: FlightRecorderChange,
) => void | Promise<void>

/** Stable read-only service contract for commands and optional consumers. */
export interface FlightRecorderReader {
  info(): FlightRecorderInfo
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot
  subscribe(listener: FlightRecorderListener): () => void
  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult
  health(): FlightRecorderHealth
}

/** Scalar fields with stable diff semantics. */
export type FlightScalarField =
  | 'request.provider'
  | 'request.model'
  | 'request.reasoningEffort'
  | 'request.temperature'
  | 'request.maxTokens'
  | 'outcome.kind'
  | 'outcome.finish'

/** Numeric fields and keyed counters with stable diff semantics. */
export type FlightCounterField =
  | 'request.systemCharacters'
  | 'messages.total'
  | 'messages.byRole'
  | 'messages.bySource'
  | 'messages.byBlockType'
  | 'timing.firstChunkMs'
  | 'timing.totalMs'
  | 'usage.inputTokens'
  | 'usage.outputTokens'

/** Named collections with stable diff semantics. */
export type FlightNamedField =
  | 'tools'
  | 'prompt.sections'
  | 'prompt.contexts'
  | 'prompt.variables'

/** Scalar value supported by the content-free diff contract. */
export type FlightScalarValue = string | number | null

/** One changed scalar field. */
export interface FlightValueChange {
  readonly kind: 'value'
  readonly field: FlightScalarField
  readonly before: FlightScalarValue
  readonly after: FlightScalarValue
}

/** One changed numeric metric or keyed counter. */
export interface FlightCounterChange {
  readonly kind: 'counter'
  readonly field: FlightCounterField
  readonly key: string | null
  readonly before: number | null
  readonly after: number | null
  readonly delta: number | null
}

/** One addition, removal, or structural-size change in a named collection. */
export interface FlightNamedChange {
  readonly kind: 'named'
  readonly field: FlightNamedField
  readonly name: string
  readonly change: 'added' | 'removed' | 'changed'
  readonly beforeSize: number | null
  readonly afterSize: number | null
}

/** One deterministic content-free record change. */
export type FlightChange =
  | FlightValueChange
  | FlightCounterChange
  | FlightNamedChange

/** Deterministic difference between two retained request attempts. */
export interface FlightRecordDiff {
  readonly fromId: RequestAttemptId
  readonly toId: RequestAttemptId
  readonly changed: boolean
  readonly changes: readonly FlightChange[]
}

/** Retained-record diff result without exceptional missing-id control flow. */
export type FlightDiffResult =
  | { readonly kind: 'ok'; readonly diff: FlightRecordDiff }
  | { readonly kind: 'missing'; readonly ids: readonly RequestAttemptId[] }

/** Incremental observations emitted while a model stream is consumed. */
export type FlightStreamObservation =
  | { readonly kind: 'first-chunk'; readonly elapsedMs: number }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | {
    readonly kind: 'finished'
    readonly finish: FinishReason
    readonly firstChunkMs?: number
    readonly totalMs: number
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'threw'
    readonly error: unknown
    readonly firstChunkMs?: number
    readonly totalMs: number
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'incomplete'
    readonly reason:
      | 'stream-ended-without-finish'
      | 'consumer-returned'
      | 'consumer-threw'
    readonly firstChunkMs?: number
    readonly totalMs: number
    readonly usage?: TokenUsage
  }
