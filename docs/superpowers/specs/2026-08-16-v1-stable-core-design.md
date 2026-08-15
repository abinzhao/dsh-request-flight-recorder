# dsh-request-flight-recorder v1.0 Stable Core Design

**Status:** Approved direction; written specification pending final review  
**Date:** 2026-08-16  
**Target version:** 1.0.0  
**Initial Harness target:** DeepSeek Harness 0.1.0-rc.6  
**Repository:** `https://github.com/abinzhao/dsh-request-flight-recorder`

## Decision Summary

Release v1.0 as a stable, read-only diagnostics core rather than an all-in-one
observability product.

The package continues to own request capture, exact correlation, content-free
projection, bounded in-memory retention, query, diff, health, and the optional
human command. It adds:

1. Explicit protocol and record-schema versions.
2. A public reader interface and root-level named type exports.
3. Atomic snapshots and a coalesced asynchronous change-notification subscription.
4. Hard per-record resource limits with explicit omission metadata.
5. Name-only error summaries and content-free recorder logging.
6. Reasoned health counters and `/flight list`.
7. Compatibility, lifecycle, memory, performance, and release fitness gates.

Persistence, file export, RPC, Web UI, OpenTelemetry, and model-visible
diagnostics remain separate optional consumers and are not part of the v1 core.

## Decision Question

What must the current v0.2 recorder add before its public API, data shape,
privacy boundary, and release process are stable enough for SemVer v1?

## Context

v0.2 proves the functional core:

- Official Agent Loop request capture.
- Signal, Agent identity, and Session correlation.
- Immutable structural records in a bounded Ring Buffer.
- Query, diff, process health, and optional `/flight`.
- npm/GitHub Bundle packaging and official CLI installation.
- 100% production TypeScript coverage.

It is not yet a stable public platform:

- `src/types.ts` contracts are bundled into declarations but are not intentional
  named package exports.
- Consumers depend on the concrete Cordis service instead of an owned reader
  interface.
- Records have no schema version and the service has no capability handshake.
- Separate `health()` and `list()` reads do not form one atomic snapshot.
- There is no non-polling live-view consumer contract.
- Capacity bounds the number of records, but one record can contain unbounded
  structural names, collections, or schema traversal.
- Raw upstream `error.message` values enter retained records and recorder logs.
- Aggregate miss counters do not explain why correlation failed.
- `/flight show` requires an id, but the command has no list operation.
- Compatibility is proven for one exact DSH RC but is not recorded as a
  maintained matrix or adapter boundary.

## Goals

- Stabilize a small, explicit, read-only public API under SemVer.
- Make every exported record self-describing and safely bounded.
- Preserve strict content-free capture and fail-open model behavior.
- Provide atomic pull snapshots and coalesced live-view invalidation.
- Keep optional consumers outside the request hot path.
- Improve human diagnosis without adding mutation or export commands.
- Isolate upstream DSH contract changes behind one adapter module.
- Establish release-blocking compatibility, memory, lifecycle, and package
  checks.
- Preserve 100% statement, branch, function, and line coverage.

## Non-Goals

- No persistence, database, JSONL writer, or restart recovery.
- No file export or clipboard export.
- No RPC, HTTP endpoint, WebSocket, Web UI, or client module.
- No OpenTelemetry exporter or external reporting.
- No model Tool, Skill, prompt contribution, Context Provider, or message.
- No raw prompt, message, tool argument, tool result, variable value, error
  message, or stable model-content fingerprint.
- No clear, delete, edit, retry, cancel, or policy-enforcement operation.
- No billing-grade token accounting or model-quality evaluation.
- No promise to support untested DSH RC versions.
- No npm publication, GitHub release, push, Topic mutation, or remote write as
  part of implementation.

## Alternatives

| Option | Decision | Reason |
|---|---|---|
| Stable core plus optional external consumers | **Selected** | Freezes the privacy-safe read contract while keeping persistence and UI costs optional. |
| Add persistence, export, and UI to the v1 package | Rejected | Introduces retention, migration, encryption, deletion, and cross-process obligations unrelated to capture correctness. |
| Keep the v0.2 API and call it stable | Rejected | Leaves accidental exports, unbounded record shape, raw errors, and no consumer handshake. |
| Emit every record transition synchronously to listeners | Rejected | Slow or failing consumers would execute on the request/stream path. |
| Emit a durable asynchronous event log | Rejected | Recreates persistence and backpressure semantics inside the core. |
| Poll `list()` from every future consumer | Rejected | Wastes work and encourages incompatible polling conventions. |

## Architectural Boundaries

```text
Official DSH events
       |
Harness adapter
       |
Capture + correlation
       |
Bounded projection
       |
Immutable Ring Store -----> Query / Diff / Health
       |                           |
       +---- revision ------------+---- Atomic snapshot
                                           |
                            coalesced invalidation
                                           |
                               optional live consumers

Official Commands ---- optional /flight consumer
```

### Module Responsibilities

| Module | Responsibility |
|---|---|
| `src/harness-adapter.ts` | Own all DSH event names, initiator lookup, loop marking checks, and upstream-to-owned translation. |
| `src/limits.ts` | Resource constants and bounded structural collection helpers. |
| `src/types.ts` | Stable public reader, info, snapshot, record, query, health, diff, and subscription contracts. |
| `src/project.ts` | Pure bounded projection from official request and prompt types. |
| `src/ring-store.ts` | Immutable bounded retention and atomic state reads. |
| `src/subscriptions.ts` | Coalesced asynchronous invalidation and listener fault containment. |
| `src/index.ts` | Cordis service composition and public reader implementation. |
| `src/command.ts` | Optional Session-isolated human command consumer. |
| `src/public.ts` | Canonical intentional root named runtime and type exports; `index.ts` re-exports this surface. |

No internal store, projector, stream observer, adapter helper, or formatter
becomes public merely because it is bundled.

## Stable Public Contract

### Constants and Capabilities

```ts
export const FLIGHT_RECORDER_PROTOCOL_VERSION = 1
export const FLIGHT_RECORD_SCHEMA_VERSION = 1

export type FlightRecorderCapability =
  | 'query'
  | 'diff'
  | 'health'
  | 'snapshot'
  | 'subscribe'

export interface FlightRecorderInfo {
  readonly protocolVersion: 1
  readonly recordSchemaVersion: 1
  readonly capabilities: readonly FlightRecorderCapability[]
}
```

Rules:

- Capabilities are exactly `diff`, `health`, `query`, `snapshot`, and
  `subscribe` in lexical order.
- `info()` returns a deeply frozen value.
- Unknown capabilities must be ignored by consumers.
- Protocol changes only for service interaction incompatibility.
- Record schema changes only when serialized `FlightRecord` meaning or required
  shape becomes incompatible.

### Reader Interface

```ts
export interface FlightRecorderReader {
  info(): FlightRecorderInfo
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot
  subscribe(listener: FlightRecorderListener): () => void
  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
  diff(
    fromId: RequestAttemptId,
    toId: RequestAttemptId,
  ): FlightDiffResult
  health(): FlightRecorderHealth
}
```

The default Cordis service implements this interface. Commands and future
consumers depend on `FlightRecorderReader`, not the concrete implementation.

### Root Exports

The package root intentionally exports:

- The default `RequestFlightRecorder` Cordis service.
- Protocol and schema constants.
- `RequestAttemptId()` runtime branding helper.
- Every public reader, record, query, health, diff, limit, and subscription
  type.

The package keeps `./invariant` as the only secondary entry. No `./internal`
subpath is published.

### Record Version and Omission Metadata

Every record adds:

```ts
export interface FlightRecord {
  readonly schemaVersion: 1
  // Existing identity, coordinate, request, prompt, outcome, and evidence.
  readonly omissions: FlightRecordOmissions
}

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
```

Omission values are counts, not booleans, so consumers can distinguish a
complete empty collection from a bounded partial projection.

### Atomic Snapshot

```ts
export interface FlightRecorderSnapshot {
  readonly info: FlightRecorderInfo
  readonly revision: number
  readonly health: FlightRecorderHealth
  readonly records: readonly FlightRecord[]
}
```

`snapshot(query?)` reads all fields synchronously from one service turn:

- `records` follows existing newest-first conjunctive query semantics.
- `health.retained` describes the complete store, not the filtered record
  count.
- `revision` is a non-negative safe integer scoped to one service lifetime.
- Initial revision is zero.
- Every capture/store state transaction increments revision exactly once.
- The complete snapshot and every nested value are deeply frozen.

### Coalesced Subscription

```ts
export interface FlightRecorderChange {
  readonly revision: number
}

export type FlightRecorderListener = (
  change: FlightRecorderChange,
) => void | Promise<void>
```

`subscribe(listener)` is an invalidation API, not a durable event log:

- A consumer calls `snapshot()` initially and after notifications.
- Notifications contain only the latest revision.
- Multiple state changes before delivery are coalesced per listener.
- Delivery occurs through Node `setImmediate` after the capture stack and
  current microtask queue return. This lets Cordis begin asynchronous Fiber
  disposal before queued consumer delivery.
- Listener return values are never awaited by the model request path.
- At most one callback invocation is active per listener.
- Changes while a listener promise is pending are coalesced into one later
  callback carrying the latest revision.
- Synchronous throws and rejected promises are contained and counted.
- Unsubscribe is idempotent.
- Unsubscribing before queued delivery prevents invocation.
- Notifications preserve non-decreasing revisions and normally increase, but
  may skip intermediate values.
- Subscription does not guarantee persistence-grade observation of every
  transition.
- Service disposal clears listeners and pending deliveries.

## Resource Limits

Count-bounded retention is insufficient when a single request can expose large
structural collections. v1 uses non-configurable safety constants:

```ts
export const FLIGHT_LIMITS = {
  nameCharacters: 256,
  tools: 128,
  promptSections: 256,
  promptContexts: 256,
  promptVariables: 256,
  messageCounterKeys: 64,
  toolSchemaNodes: 4096,
} as const
```

Rules:

- Limits count UTF-16 code units where strings are involved.
- Names over `nameCharacters` are omitted completely, never partially stored.
- Collection projection keeps the first entries in authoritative order and
  reports the number omitted.
- Request tools and Prompt Assembly tools have independent omission counters.
- Message counter maps keep their first observed keys. Once the key limit is
  reached, each observation assigned to an unrepresented key increments the
  corresponding omission counter; projection does not allocate an unbounded
  set merely to deduplicate omitted keys.
- An oversized name increments both `oversizedNames` and the corresponding
  collection omission count. For a message counter, this happens per omitted
  observation.
- Tool schema traversal is iterative, cycle-safe, and stops at
  `toolSchemaNodes`.
- A capped tool records `parameterNodes: 4096` and increments
  `truncatedToolSchemas`.
- Limits are exported for consumers and documentation but are not configurable
  in v1, preventing configuration from defeating the memory guarantee.
- Existing `capacity` remains the only recorder configuration.

## Privacy and Error Contract

### Retained Outcomes

Replace raw error summaries:

```ts
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

export interface FlightErrorSummary {
  readonly kind: FlightErrorKind
}
```

Rules:

- Built-in and explicitly listed error names map to the finite kinds above.
- Unknown custom `Error.name` values map to `error`.
- Non-Error throws map to `non-error-thrown`.
- `error.message`, thrown string values, stacks, causes, codes, and provider
  payloads are not retained.
- No arbitrary error name is retained.

### Recorder Logging

Recorder-owned warnings include:

- Recorder stage.
- Normalized finite error kind.
- No error message, stack, thrown value, request id, Session id, prompt name,
  tool name, or model-visible content.

Downstream errors still propagate by object identity. Privacy changes affect
only recorder-owned copies and logs.

## Health Contract

Preserve existing aggregate counters and add reasoned diagnostics:

```ts
export type CorrelationMissReason =
  | 'missing-signal'
  | 'missing-pending'
  | 'agent-mismatch'
  | 'session-mismatch'

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
```

Rules:

- Aggregate `correlationMisses` equals the sum of all reason counters.
- One marked failed request increments exactly one reason.
- A record with any positive omission count increments `truncatedRecords`.
- Subscriber failures do not alter capture or schedule recursive
  notifications.
- Subscriber failures do not increment revision; they are visible on explicit
  snapshots and the next independently triggered notification.
- Every health object and nested reason map is frozen.
- All values reset with the service lifetime.

## Human Command

Add:

```text
/flight list
/flight list <limit>
```

Rules:

- Default limit is 10.
- Explicit limit is a positive safe integer from 1 through 20.
- Results are restricted to the invoking Session.
- Each row includes short id, turn, step, attempt, provider/model, and outcome.
- No error details, Session id, prompt names, tool names, or variable names are
  shown in list output.
- Existing latest, show, diff, and health behavior remains.
- The command hint and usage text include list.
- All success output remains bounded to 4,096 UTF-16 code units.
- Command input remains `recordInput: false`.

`/flight health` adds truncated and subscriber failure totals plus correlation
reason counts. It remains process-global and exposes no Session identifiers.

## Harness Compatibility Boundary

Move official event integration behind `harness-adapter.ts`.

The adapter owns:

- `system-prompt/assemble`, `agent/request`, and `llm/stream` listener
  registration.
- `isAgentLoopRequest()`.
- Current initiator lookup.
- Signal, Agent, Session, Turn, and Step extraction.
- Translation from official request, prompt, finish, and usage types into owned
  projector inputs.

The service owns no upstream event-name string outside the adapter.

v1 initially supports exact DSH `0.1.0-rc.6`. The package's own reader and
record contracts are stable even when a later patch release changes the
adapter to support a new DSH RC. Peer ranges remain exact until every version
in a proposed range passes the compatibility matrix.

## State and Revision Semantics

Revision increments once for each of:

- A captured record insertion, including any simultaneous eviction.
- The first terminal settlement of a captured attempt.
- A correlation miss.
- A projection failure.

Insertion folds any omission and `truncatedRecords` accounting into the same
single revision increment.

Revision does not increment for:

- Direct unmarked LLM requests.
- First-chunk or usage observations before terminal settlement.
- Duplicate terminal settlement.
- Subscriber failure.
- Reads.

The running record may receive usage internally before settlement, but retained
public state changes only at insertion and terminal settlement, preserving the
existing coarse update model.

## Failure Model

| Failure | Required behavior |
|---|---|
| Projection encounters a cyclic or oversized schema | Stop at the hard node cap, mark omission, continue capture. |
| Structural collection exceeds a limit | Retain the bounded prefix, report exact omitted count. |
| Structural name exceeds the limit | Omit the entry and increment `oversizedNames`. |
| Error classification fails | Store `{ kind: 'error' }`; propagate original downstream behavior. |
| Listener throws or rejects | Increment `subscriberFailures`; do not affect capture or other listeners. |
| Listener is slow | It runs after the capture stack and is not awaited; same-process CPU isolation is not promised. |
| Consumer misses revisions | Read the latest atomic snapshot; intermediate notification delivery is not promised. |
| Revision reaches `Number.MAX_SAFE_INTEGER` | Stop incrementing at the maximum and continue serving snapshots; practical wraparound is forbidden. |
| Adapter cannot correlate | Increment exactly one reason and delegate unchanged. |
| Service disposes with queued notifications | Cordis disposal runs before the queued `setImmediate`; cancel delivery, clear listeners and retained state, preserve downstream stream behavior. |

## Migration from v0.2

Preserved:

- Default package export.
- `capacity` configuration and default.
- `list`, `get`, `latest`, `diff`, and `health` methods.
- Query order and filter semantics.
- Optional Commands lifecycle.
- Bundle installation shape.

Intentional breaking record changes before v1 freeze:

- `FlightRecord.schemaVersion` becomes required.
- `FlightRecord.omissions` becomes required.
- `ThrewFlightOutcome.error.name` and `.message` are replaced by finite
  `error.kind`.
- Health adds required counters and nested reason data.
- Public types become intentional root exports.

No persisted recorder data exists, so runtime migration is unnecessary.
Compile-time consumers must update thrown-error rendering and accept the new
required fields.

## Testing Strategy

### Public Contract

- Compile a consumer fixture importing every intended root export.
- Assert no internal module is exported.
- Snapshot the generated declaration surface.
- Verify protocol, schema, capability order, and deep immutability.
- Prove existing reader methods retain v0.2 behavior.

### Limits and Privacy

- Boundary tests at limit minus one, exact limit, and limit plus one.
- Oversized Unicode names ending at surrogate boundaries.
- Cyclic, deeply nested, and node-heavy tool schemas.
- Seed secret values in prompt, messages, tool arguments, error messages,
  thrown strings, stacks, causes, and logs; assert absence from every record,
  diff, snapshot, command result, and recorder log.
- Prove omission counts and `truncatedRecords` are exact.

### Snapshot and Subscription

- Atomic snapshot revision and full-store health semantics.
- Coalescing across multiple changes.
- Normally increasing revision delivery and saturation-safe non-decreasing
  behavior.
- Unsubscribe before and after queued delivery.
- Idempotent disposer.
- Synchronous throw and asynchronous rejection containment.
- One failing listener does not block another.
- Disposal cancels pending delivery.

### Compatibility and Lifecycle

- Real Cordis integration with exact published DSH peers.
- Official CLI tarball install, `--dump-config`, and real profile boot in
  isolated `DSH_HOME`.
- At least 100 mount/dispose cycles with no listener or retained-state growth.
- Multiple Agents and Sessions with overlapping streams.
- Cancellation, synchronous construction failure, downstream throw, consumer
  return, consumer throw, and duplicate finish.

### Soak and Performance

- 10,000 synthetic requests prove retained count and structural dimensions stay
  within exported limits.
- Memory reaches a stable plateau after warm-up; the test records a release
  report and is not a flaky per-commit absolute-RSS assertion.
- Capture and projection benchmarks record median and P95 on the supported Node
  baseline.
- A release is blocked by a regression greater than 20% from the committed
  baseline unless the baseline change is reviewed and documented.
- Subscription callbacks never appear on the synchronous capture benchmark
  stack.

All production TypeScript remains under 100% statement, branch, function, and
line thresholds.

## Distribution and Supply Chain

Keep existing:

- No `prepare` or install script.
- Committed deterministic `lib/`.
- `prepack` rebuild.
- Packed-consumer Cordis smoke.
- Official CLI isolated-profile smoke.
- `publint`.

Add before v1 publication:

- Narrow `engines.node` to `^22.19.0 || ^24.0.0`; untested future Node majors
  are not claimed.
- Node 22.19 and Node 24 CI matrix.
- DSH compatibility matrix for every declared supported version.
- Package export/type consumer smoke.
- npm provenance through trusted publishing.
- GitHub Release from an immutable signed or verified tag.
- Tarball SHA-256 in release notes.
- Dependency review and automated update policy.

Remote publication and release actions require separate explicit
authorization.

## Documentation Deliverables

- `README.md` and `README.zh-CN.md`: v1 quick start, list command, limits,
  protocol, privacy, and compatibility.
- `docs/api.md`: reader and type reference with stability labels.
- `docs/data-schema.md`: every record field, evidence source, and omission
  meaning.
- `docs/privacy-threat-model.md`: data inventory, trust boundaries, logs,
  commands, optional consumers, and non-goals.
- `docs/architecture.md`: adapter, capture, projection, retention, snapshots,
  and invalidation flow.
- `docs/compatibility.md`: Node, Cordis, DSH, installation, and smoke matrix.
- `docs/migration.md`: v0.2 compile-time changes and future deprecation policy.
- `docs/benchmarks.md`: fixture, hardware/runtime metadata, results, and
  baseline-update process.
- `examples/read-only-consumer.ts`: snapshot plus subscription pattern without
  persistence.
- `CHANGELOG.md`: v1 breaking changes and migration link.
- `SECURITY.md`: update supported versions and error/log privacy language.
- `CONTRIBUTING.md`: public API review, compatibility matrix, soak, benchmark,
  and generated-output requirements.

## Fitness Functions

| Property | Threshold | Cadence | Failure response |
|---|---|---|---|
| Request transparency | Identical request, chunks, order, return, throw, and backpressure | Every change | Block merge |
| Content privacy | Seeded secrets absent from records, snapshots, diffs, commands, and recorder logs | Every change | Block merge |
| Memory shape | Record collections and schema traversal never exceed exported limits | Every change | Block merge |
| Reader compatibility | Declaration/API snapshot changes require explicit SemVer review | Every change | Block merge |
| Notification isolation | No listener executes synchronously on capture stack | Every change | Block merge |
| Lifecycle cleanup | 100 mount/dispose cycles leave no retained state or listeners | Before release | Block release |
| Compatibility | Every declared DSH version compiles, installs, and boots | Before release | Narrow support or block release |
| Performance | Median/P95 regression no greater than 20% without reviewed baseline update | Before release | Investigate or document exception |
| Package reproducibility | Build leaves committed `lib/` unchanged | Every change | Block merge |
| Coverage | Statements, branches, functions, and lines all 100% | Every change | Block merge |

## Release Sequence

Implementation may land in internal batches, but no intermediate version is
published automatically:

1. Privacy and resource limits.
2. Intentional public exports, protocol, schema, and reader interface.
3. Atomic snapshot and coalesced subscription.
4. Reasoned health and `/flight list`.
5. Harness adapter extraction and compatibility matrix.
6. Soak, lifecycle, performance, documentation, and supply-chain gates.
7. `1.0.0-rc.1` release candidate after explicit publication approval.
8. `1.0.0` only after RC installation and compatibility evidence is reviewed.

## Approval Gate

After this written specification is approved:

1. Generate a task-by-task TDD implementation plan with exact files and
   verification commands.
2. Implement in the release-sequence order.
3. Do not commit, push, publish, create a release, or mutate remote metadata
   without separate explicit authorization.
