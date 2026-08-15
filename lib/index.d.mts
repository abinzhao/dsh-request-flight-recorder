import { Context, Service } from "@deepseek-ai/cordis";
import { FinishReason, TokenUsage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Branded } from "@deepseek-ai/dsh-brand";
//#region src/types.d.ts
/** Stable identity of one observed model-request attempt. */
type RequestAttemptId = Branded<'RequestAttemptId'>;
/** Stable schema carried by every v1 record. */
declare const FLIGHT_RECORD_SCHEMA_VERSION: 1;
/** Stable in-process reader protocol version. */
declare const FLIGHT_RECORDER_PROTOCOL_VERSION: 1;
/**
 * Brand a runtime string as a request-attempt identity.
 * @param value - unique request-attempt value.
 * @returns the same string with its compile-time brand.
 */
declare function RequestAttemptId(value: string): RequestAttemptId;
/** Evidence quality attached to one group of recorded facts. */
type FlightEvidenceKind = 'exact' | 'derived' | 'inferred';
/** Provenance of one group of recorded facts. */
interface FlightEvidence {
  readonly kind: FlightEvidenceKind;
  readonly source: 'llm/stream' | 'agent/request' | 'system-prompt/assemble';
}
/** Structural summary of model-visible messages. */
interface MessageSummary {
  readonly total: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly bySource: Readonly<Record<string, number>>;
  readonly byBlockType: Readonly<Record<string, number>>;
}
/** Structural summary of one model-visible tool. */
interface ToolSummary {
  readonly name: string;
  readonly parameterNodes: number;
}
/** Content-free summary of one exact model request. */
interface RequestSummary {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stopCount?: number;
  readonly messages: MessageSummary;
  readonly systemCharacters: number;
  readonly tools: readonly ToolSummary[];
}
/** One named prompt contribution without its text. */
interface PromptContributionSummary {
  readonly name: string;
  readonly characters: number;
}
/** Content-free summary of one authoritative prompt assembly. */
interface PromptAssemblySummary {
  readonly sections: readonly PromptContributionSummary[];
  readonly contexts: readonly PromptContributionSummary[];
  readonly tools: readonly string[];
  readonly variables: readonly string[];
}
/** Structural observations omitted by hard per-record safety limits. */
interface FlightRecordOmissions {
  readonly requestTools: number;
  readonly promptTools: number;
  readonly promptSections: number;
  readonly promptContexts: number;
  readonly promptVariables: number;
  readonly messageRoles: number;
  readonly messageSources: number;
  readonly messageBlockTypes: number;
  readonly oversizedNames: number;
  readonly truncatedToolSchemas: number;
}
/** Running request with no observed terminal outcome yet. */
interface RunningFlightOutcome {
  readonly kind: 'running';
}
/** Request whose downstream stream emitted a terminal finish chunk. */
interface FinishedFlightOutcome {
  readonly kind: 'finished';
  readonly finish: FinishReason;
  readonly firstChunkMs?: number;
  readonly totalMs: number;
  readonly usage?: TokenUsage;
}
/** Finite error categories retained without arbitrary upstream text. */
type FlightErrorKind = 'error' | 'type-error' | 'range-error' | 'syntax-error' | 'reference-error' | 'uri-error' | 'eval-error' | 'aggregate-error' | 'abort-error' | 'timeout-error' | 'non-error-thrown';
/** Privacy-safe summary of one thrown value. */
interface FlightErrorSummary {
  readonly kind: FlightErrorKind;
}
/** Request whose downstream stream threw. */
interface ThrewFlightOutcome {
  readonly kind: 'threw';
  readonly error: FlightErrorSummary;
  readonly firstChunkMs?: number;
  readonly totalMs: number;
  readonly usage?: TokenUsage;
}
/** Request observation that ended without a provider finish. */
interface IncompleteFlightOutcome {
  readonly kind: 'incomplete';
  readonly reason: 'stream-ended-without-finish' | 'consumer-returned' | 'consumer-threw';
  readonly firstChunkMs?: number;
  readonly totalMs: number;
  readonly usage?: TokenUsage;
}
/** Terminal or in-flight state of one observed request. */
type FlightOutcome = RunningFlightOutcome | FinishedFlightOutcome | ThrewFlightOutcome | IncompleteFlightOutcome;
/** One immutable request-attempt record. */
interface FlightRecord {
  readonly schemaVersion: 1;
  readonly id: RequestAttemptId;
  readonly sessionId: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly attempt: number;
  readonly startedAt: number;
  readonly request: RequestSummary;
  readonly promptAssembly?: PromptAssemblySummary;
  readonly outcome: FlightOutcome;
  readonly evidence: readonly FlightEvidence[];
  readonly omissions: FlightRecordOmissions;
}
/** Optional filters for flight-record listing. */
interface FlightRecordQuery {
  readonly sessionId?: SessionId;
  readonly turn?: number;
  readonly step?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly outcome?: FlightOutcome['kind'];
  readonly limit?: number;
}
/** Finite reason for rejecting one marked request correlation. */
type CorrelationMissReason = 'missing-signal' | 'missing-pending' | 'agent-mismatch' | 'session-mismatch';
/** Process-local recorder health counters. */
interface FlightRecorderHealth {
  readonly captured: number;
  readonly completed: number;
  readonly active: number;
  readonly retained: number;
  readonly evicted: number;
  readonly truncatedRecords: number;
  readonly correlationMisses: number;
  readonly correlationMissesByReason: Readonly<Record<CorrelationMissReason, number>>;
  readonly projectionFailures: number;
  readonly subscriberFailures: number;
}
/** Stable read capabilities exposed by the v1 service. */
type FlightRecorderCapability = 'diff' | 'health' | 'query' | 'snapshot' | 'subscribe';
/** Version and capability handshake for optional consumers. */
interface FlightRecorderInfo {
  readonly protocolVersion: 1;
  readonly recordSchemaVersion: 1;
  readonly capabilities: readonly ['diff', 'health', 'query', 'snapshot', 'subscribe'];
}
/** One atomic read of recorder identity, health, and retained records. */
interface FlightRecorderSnapshot {
  readonly info: FlightRecorderInfo;
  readonly revision: number;
  readonly health: FlightRecorderHealth;
  readonly records: readonly FlightRecord[];
}
/** Coalesced live-view invalidation carrying the latest service revision. */
interface FlightRecorderChange {
  readonly revision: number;
}
/** Optional consumer notified outside the synchronous capture stack. */
type FlightRecorderListener = (change: FlightRecorderChange) => void | Promise<void>;
/** Stable read-only service contract for commands and optional consumers. */
interface FlightRecorderReader {
  info(): FlightRecorderInfo;
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot;
  subscribe(listener: FlightRecorderListener): () => void;
  list(query?: FlightRecordQuery): readonly FlightRecord[];
  get(id: RequestAttemptId): FlightRecord | undefined;
  latest(sessionId?: SessionId): FlightRecord | undefined;
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult;
  health(): FlightRecorderHealth;
}
/** Scalar fields with stable diff semantics. */
type FlightScalarField = 'request.provider' | 'request.model' | 'request.reasoningEffort' | 'request.temperature' | 'request.maxTokens' | 'outcome.kind' | 'outcome.finish';
/** Numeric fields and keyed counters with stable diff semantics. */
type FlightCounterField = 'request.systemCharacters' | 'messages.total' | 'messages.byRole' | 'messages.bySource' | 'messages.byBlockType' | 'timing.firstChunkMs' | 'timing.totalMs' | 'usage.inputTokens' | 'usage.outputTokens';
/** Named collections with stable diff semantics. */
type FlightNamedField = 'tools' | 'prompt.sections' | 'prompt.contexts' | 'prompt.variables';
/** Scalar value supported by the content-free diff contract. */
type FlightScalarValue = string | number | null;
/** One changed scalar field. */
interface FlightValueChange {
  readonly kind: 'value';
  readonly field: FlightScalarField;
  readonly before: FlightScalarValue;
  readonly after: FlightScalarValue;
}
/** One changed numeric metric or keyed counter. */
interface FlightCounterChange {
  readonly kind: 'counter';
  readonly field: FlightCounterField;
  readonly key: string | null;
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number | null;
}
/** One addition, removal, or structural-size change in a named collection. */
interface FlightNamedChange {
  readonly kind: 'named';
  readonly field: FlightNamedField;
  readonly name: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly beforeSize: number | null;
  readonly afterSize: number | null;
}
/** One deterministic content-free record change. */
type FlightChange = FlightValueChange | FlightCounterChange | FlightNamedChange;
/** Deterministic difference between two retained request attempts. */
interface FlightRecordDiff {
  readonly fromId: RequestAttemptId;
  readonly toId: RequestAttemptId;
  readonly changed: boolean;
  readonly changes: readonly FlightChange[];
}
/** Retained-record diff result without exceptional missing-id control flow. */
type FlightDiffResult = {
  readonly kind: 'ok';
  readonly diff: FlightRecordDiff;
} | {
  readonly kind: 'missing';
  readonly ids: readonly RequestAttemptId[];
};
//#endregion
//#region src/limits.d.ts
/** Non-configurable safety limits forming the v1 record contract. */
declare const FLIGHT_LIMITS: Readonly<{
  readonly nameCharacters: 256;
  readonly tools: 128;
  readonly promptSections: 256;
  readonly promptContexts: 256;
  readonly promptVariables: 256;
  readonly messageCounterKeys: 64;
  readonly toolSchemaNodes: 4096;
}>;
//#endregion
//#region src/index.d.ts
/** Validated plugin configuration. */
interface RequestFlightRecorderConfig {
  /** Maximum records retained in process memory. */
  capacity: number;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** In-process structural request diagnostics. */
    requestFlightRecorder: RequestFlightRecorder;
  }
}
/** Content-free recorder for loop-built model requests and stream outcomes. */
declare class RequestFlightRecorder extends Service {
  static inject: string[];
  static Config: z<Schemastery.ObjectS<{
    capacity: z<number, number>;
  }>, Schemastery.ObjectT<{
    capacity: z<number, number>;
  }>>;
  private readonly store;
  private promptBySignal;
  private pendingBySignal;
  private attemptsByAgent;
  private activeIds;
  private readonly subscriptions;
  private captured;
  private completed;
  private evicted;
  private truncatedRecords;
  private correlationMisses;
  private correlationMissesByReason;
  private projectionFailures;
  private subscriberFailures;
  private revision;
  private disposed;
  /**
   * Register the recorder service and its effect-owned waterfall listeners.
   * @param ctx - Cordis context carrying the required DSH services.
   * @param config - validated bounded-retention configuration.
   */
  constructor(ctx: Context, config: RequestFlightRecorderConfig);
  /** Return the stable protocol, schema, and capability handshake. */
  info(): FlightRecorderInfo;
  /** Read one deeply frozen atomic view of recorder state. */
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot;
  /** Subscribe to coalesced out-of-stack recorder invalidations. */
  subscribe(listener: FlightRecorderListener): () => void;
  /**
   * List retained records from newest to oldest.
   * @param query - optional session filter.
   * @returns a frozen detached array of immutable records.
   */
  list(query?: FlightRecordQuery): readonly FlightRecord[];
  /**
   * Read one retained request attempt.
   * @param id - request-attempt identity.
   * @returns the immutable record when it remains retained.
   */
  get(id: RequestAttemptId): FlightRecord | undefined;
  /**
   * Read the newest retained request attempt.
   * @param sessionId - optional session filter.
   * @returns the newest matching immutable record.
   */
  latest(sessionId?: SessionId): FlightRecord | undefined;
  /**
   * Compare two retained attempts without exceptional missing-id control flow.
   * @param fromId - earlier retained request-attempt identity.
   * @param toId - later retained request-attempt identity.
   * @returns a frozen structural diff or exact missing identities.
   */
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult;
  /**
   * Read a fresh process-local health snapshot.
   * @returns frozen capture, settlement, retention, and failure counters.
   */
  health(): FlightRecorderHealth;
  private beginRecord;
  private miss;
  private applyObservation;
  private finishRecord;
  private change;
  private warnCaptureFailure;
}
//#endregion
export { FLIGHT_LIMITS, FLIGHT_RECORDER_PROTOCOL_VERSION, FLIGHT_RECORD_SCHEMA_VERSION, type FinishedFlightOutcome, type FlightChange, type FlightCounterChange, type FlightCounterField, type FlightDiffResult, type FlightErrorKind, type FlightErrorSummary, type FlightEvidence, type FlightEvidenceKind, type FlightNamedChange, type FlightNamedField, type FlightOutcome, type FlightRecord, type FlightRecordDiff, type FlightRecordOmissions, type FlightRecordQuery, type FlightRecorderCapability, type FlightRecorderChange, type FlightRecorderHealth, type FlightRecorderInfo, type FlightRecorderListener, type FlightRecorderReader, type FlightRecorderSnapshot, type FlightScalarField, type FlightScalarValue, type FlightValueChange, type IncompleteFlightOutcome, type MessageSummary, type PromptAssemblySummary, type PromptContributionSummary, RequestAttemptId, RequestFlightRecorderConfig, type RequestSummary, type RunningFlightOutcome, type ThrewFlightOutcome, type ToolSummary, RequestFlightRecorder as default };