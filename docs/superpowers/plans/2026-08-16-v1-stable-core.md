# dsh-request-flight-recorder v1.0 Stable Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a SemVer-stable v1 reader contract with bounded content-free records, atomic snapshots, isolated live-view invalidation, reasoned health, `/flight list`, and release-grade compatibility evidence.

**Architecture:** Keep the existing capture and Ring Store ownership, but put DSH-specific event translation behind a Harness adapter. Projection becomes explicitly bounded and produces omission metadata; the service exposes a versioned reader interface, atomic revisioned snapshots, and coalesced asynchronous notifications while optional commands remain a separate consumer.

**Tech Stack:** Node.js 22.19/24, TypeScript 6, ESM, pnpm 11, Vitest 4, tsdown, Cordis 4.0.1, DeepSeek Harness 0.1.0-rc.6, Schemastery 3.18.

---

Git commit, push, publication, release, and remote metadata steps are excluded
because they require separate explicit authorization. The repository has no
initial commit, so this plan runs in the current working tree rather than an
unavailable worktree.

## File Map

| File | Responsibility |
|---|---|
| `src/error.ts` | Finite content-free error classification. |
| `src/limits.ts` | Exported hard limits, omission constructors/merging, bounded names and counters, iterative schema counting. |
| `src/public.ts` | Canonical named runtime and type exports. |
| `src/subscriptions.ts` | Per-listener coalescing, `setImmediate` delivery, async settlement, and disposal. |
| `src/harness-adapter.ts` | All official DSH event registration and runtime identity extraction. |
| `src/types.ts` | v1 record, reader, info, snapshot, health, omission, and subscription contracts. |
| `src/project.ts` | Bounded request and prompt projections returning summaries plus omissions. |
| `src/index.ts` | Stable reader implementation, revision state, health accounting, and subsystem composition. |
| `src/command.ts` | Reader-only `/flight` parser including Session-scoped list. |
| `src/format.ts` | v1 record, health, diff, and compact list rendering. |
| `tests/error.spec.ts` | Error-kind normalization and privacy canaries. |
| `tests/limits.spec.ts` | Every hard boundary, cycle, ordering, omission, and schema-node rule. |
| `tests/public-api.spec.ts` | Protocol, capability, root export, reader, and declaration contracts. |
| `tests/snapshot.spec.ts` | Atomic snapshot and revision semantics. |
| `tests/subscriptions.spec.ts` | Coalescing, pending listener, failure isolation, unsubscribe, and disposal. |
| `tests/adapter.spec.ts` | Adapter registration, correlation reason, and no-event-name leakage. |
| `tests/soak.spec.ts` | 10,000-request bounded-state and repeated lifecycle verification. |
| `tests/fixtures.ts` | Complete v1 records with schema and omission defaults. |
| `tests/project.spec.ts` | Bounded content-free projection. |
| `tests/plugin.spec.ts` | End-to-end v1 service, privacy, health, and lifecycle. |
| `tests/command.spec.ts` | `/flight list`, bounds, isolation, and existing syntax. |
| `tests/format.spec.ts` | New list, omission, finite-error, and detailed-health text. |
| `tests/package.spec.ts` | v1 package, Node matrix, docs, exports, CI, and packed artifacts. |
| `bench/project.bench.ts` | Repeatable projection benchmark fixture. |
| `docs/api.md` | Stable reader and public types. |
| `docs/data-schema.md` | Record fields, evidence, and omissions. |
| `docs/privacy-threat-model.md` | Data inventory and trust boundaries. |
| `docs/architecture.md` | Adapter-to-snapshot flow. |
| `docs/compatibility.md` | Node/Cordis/DSH matrix. |
| `docs/migration.md` | v0.2 to v1 compile-time migration. |
| `docs/benchmarks.md` | Benchmark method and reviewed baseline. |
| `examples/read-only-consumer.ts` | Snapshot plus subscription example. |
| `package.json` | v1 metadata, exact exports, scripts, and narrowed engines. |
| `.github/workflows/ci.yml` | Node 22.19/24 matrix and v1 package gates. |
| `scripts/smoke-packed.mjs` | v1 root-export and reader smoke. |
| `README.md`, `README.zh-CN.md` | Canonical bilingual v1 documentation. |

### Task 1: Replace raw errors with a finite privacy-safe contract

**Files:**
- Create: `src/error.ts`
- Create: `tests/error.spec.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/format.ts`
- Modify: `tests/fixtures.ts`
- Modify: `tests/plugin.spec.ts`
- Modify: `tests/format.spec.ts`

- [x] **Step 1: Write failing finite-classification tests**

Create cases for every public kind, unknown custom names, throwing `name`
getters, and non-Error values:

```ts
expect(classifyFlightError(new TypeError('TOP_SECRET_VALUE'))).toEqual({
  kind: 'type-error',
})
expect(classifyFlightError(Object.assign(new Error('secret'), {
  name: 'Provider_TOP_SECRET_VALUE',
}))).toEqual({ kind: 'error' })
expect(classifyFlightError('TOP_SECRET_VALUE')).toEqual({
  kind: 'non-error-thrown',
})
expect(JSON.stringify(classifyFlightError(new Error('TOP_SECRET_VALUE'))))
  .not.toContain('TOP_SECRET_VALUE')
```

Cover exact mappings for `Error`, `TypeError`, `RangeError`, `SyntaxError`,
`ReferenceError`, `URIError`, `EvalError`, `AggregateError`, `AbortError`, and
`TimeoutError`.

- [x] **Step 2: Update integration expectations and verify RED**

Change thrown-outcome expectations to:

```ts
expect(world.recorder.latest()?.outcome).toMatchObject({
  kind: 'threw',
  error: { kind: 'non-error-thrown' },
})
```

Run:

```sh
pnpm exec vitest run tests/error.spec.ts tests/plugin.spec.ts tests/format.spec.ts
```

Expected: FAIL because `classifyFlightError` and `FlightErrorKind` do not exist,
and current records still contain `name` and `message`.

- [x] **Step 3: Implement the finite classifier**

Define exactly:

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

`classifyFlightError(error)` must read `error.name` inside `try/catch`, map only
the finite names, return `error` for unknown names or getter failure, and never
read message, stack, cause, code, or thrown string content.

- [x] **Step 4: Route records and logs through classification**

Replace `summarizeError()` in `src/index.ts`. Recorder warnings must render only:

```ts
this.ctx.logger('request-flight-recorder').warn(
  'capture failed at %s: %s',
  stage,
  classifyFlightError(error).kind,
)
```

Update `formatRecord()` to render `threw:${value.error.kind}`.

- [x] **Step 5: Verify GREEN and privacy**

Run:

```sh
pnpm exec vitest run tests/error.spec.ts tests/plugin.spec.ts tests/format.spec.ts
pnpm typecheck
```

Expected: all focused tests pass; serialized records, command text, and captured
recorder logs contain no seeded error message.

### Task 2: Add hard structural limits and omission metadata

**Files:**
- Create: `src/limits.ts`
- Create: `tests/limits.spec.ts`
- Modify: `src/types.ts`
- Modify: `src/project.ts`
- Modify: `src/index.ts`
- Modify: `tests/fixtures.ts`
- Modify: `tests/project.spec.ts`
- Modify: `tests/plugin.spec.ts`
- Modify: `tests/diff.spec.ts`
- Modify: `tests/command.spec.ts`
- Modify: `tests/format.spec.ts`
- Modify: `tests/ring-store.spec.ts`

- [x] **Step 1: Define failing limit and omission tests**

Specify the exact public constant:

```ts
expect(FLIGHT_LIMITS).toEqual({
  nameCharacters: 256,
  tools: 128,
  promptSections: 256,
  promptContexts: 256,
  promptVariables: 256,
  messageCounterKeys: 64,
  toolSchemaNodes: 4096,
})
expect(Object.isFrozen(FLIGHT_LIMITS)).toBe(true)
```

Create `emptyFlightRecordOmissions()` expectations with all ten zero fields:
`requestTools`, `promptTools`, `promptSections`, `promptContexts`,
`promptVariables`, `messageRoles`, `messageSources`, `messageBlockTypes`,
`oversizedNames`, and `truncatedToolSchemas`.

- [x] **Step 2: Add boundary fixtures and verify RED**

Test limit minus one, exact limit, and limit plus one for each collection.
Test:

- a 257-code-unit tool name is omitted;
- 65 distinct message-source keys retain 64;
- repeated observations of the omitted 65th key increment omissions per
  observation;
- an oversized message key increments both its map omission and
  `oversizedNames`;
- a cyclic schema terminates;
- a 4,097-node schema reports `parameterNodes: 4096`;
- input ordering remains stable;
- serialized output excludes seeded descriptions and values.

Run:

```sh
pnpm exec vitest run tests/limits.spec.ts tests/project.spec.ts
```

Expected: FAIL because projection is currently recursive and unbounded.

- [x] **Step 3: Implement bounded helpers**

Add:

```ts
export const FLIGHT_LIMITS = Object.freeze({
  nameCharacters: 256,
  tools: 128,
  promptSections: 256,
  promptContexts: 256,
  promptVariables: 256,
  messageCounterKeys: 64,
  toolSchemaNodes: 4096,
} as const)

export interface ProjectionResult<T> {
  readonly summary: T
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

Implement zero construction and field-by-field omission merge. Do not mutate a
previously returned omission object.

Implement iterative schema traversal with an array stack and `WeakSet<object>`.
Stop before count exceeds 4096. A cycle or remaining stack sets
`truncated: true`; never recurse.

- [x] **Step 4: Make projections return summaries plus omissions**

Change:

```ts
projectRequest(options): ProjectionResult<RequestSummary>
projectPromptAssembly(assembly): ProjectionResult<PromptAssemblySummary>
```

For message maps, do not allocate an unbounded set after 64 keys. If the key is
not retained because the map is full or the key is oversized, increment the
corresponding omission per observation.

For ordered arrays, keep the first bounded, valid-name items and count every
rejected item.

- [x] **Step 5: Add v1 record fields and integrate capture**

Define:

```ts
export const FLIGHT_RECORD_SCHEMA_VERSION = 1 as const

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
```

`PendingRequest` retains prompt summary and prompt omissions. `beginRecord()`
merges request and prompt omissions, inserts one immutable record, and
increments `truncatedRecords` once when any omission is positive.

Update every fixture and direct record literal with schema version and zero
omissions.

- [x] **Step 6: Verify bounds and complete regression**

Run:

```sh
pnpm exec vitest run tests/limits.spec.ts tests/project.spec.ts tests/plugin.spec.ts
pnpm test
pnpm typecheck
```

Expected: every existing behavior remains green; cyclic and oversized input is
bounded; all records carry explicit omission data.

### Task 3: Publish the intentional v1 reader and protocol surface

**Files:**
- Create: `src/public.ts`
- Create: `tests/public-api.spec.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `tests/package.spec.ts`
- Modify: `scripts/smoke-packed.mjs`

- [x] **Step 1: Write failing protocol and import tests**

Specify:

```ts
expect(FLIGHT_RECORDER_PROTOCOL_VERSION).toBe(1)
expect(recorder.info()).toEqual({
  protocolVersion: 1,
  recordSchemaVersion: 1,
  capabilities: ['diff', 'health', 'query', 'snapshot', 'subscribe'],
})
```

Generate a temporary TypeScript consumer that imports the default service,
constants, `RequestAttemptId`, `FlightRecorderReader`, `FlightRecord`,
`FlightRecorderSnapshot`, and `FlightRecorderListener` from the package root.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/public-api.spec.ts tests/package.spec.ts
pnpm typecheck
```

Expected: FAIL because root named exports, info, and the reader interface do not
exist.

- [x] **Step 3: Define the stable public contracts**

Add exactly:

```ts
export const FLIGHT_RECORDER_PROTOCOL_VERSION = 1 as const

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
```

Define `FlightRecorderReader` with `info`, `snapshot`, `subscribe`, `list`,
`get`, `latest`, `diff`, and `health`.

Declare the contracts before implementing them in later tasks:

```ts
export interface FlightRecorderSnapshot {
  readonly info: FlightRecorderInfo
  readonly revision: number
  readonly health: FlightRecorderHealth
  readonly records: readonly FlightRecord[]
}

export interface FlightRecorderChange {
  readonly revision: number
}

export type FlightRecorderListener = (
  change: FlightRecorderChange,
) => void | Promise<void>
```

- [x] **Step 4: Create the canonical public barrel**

`src/public.ts` explicitly exports only approved runtime constants/helpers and
approved public types. `src/index.ts` retains the default service export and
re-exports `./public.js`. Do not export projectors, store, formatter, adapter,
subscriptions, or stream observer.

- [x] **Step 5: Extend packed smoke**

The generated consumer imports all public runtime exports from the packed
package. Runtime smoke asserts the exact frozen `info()` result. Structural
assignment of the mounted service to `FlightRecorderReader` is verified after
`snapshot()` and `subscribe()` exist in Task 5, then repeated from the packed
artifact in Task 10.

- [x] **Step 6: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/public-api.spec.ts tests/package.spec.ts
pnpm typecheck
pnpm build
pnpm exec publint
```

Expected: only the documented root surface and `./invariant` are publishable.

### Task 4: Add atomic snapshots and revision semantics

**Files:**
- Create: `tests/snapshot.spec.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `tests/plugin.spec.ts`

- [x] **Step 1: Write failing snapshot state-transition tests**

Assert:

```ts
expect(recorder.snapshot()).toEqual({
  info: recorder.info(),
  revision: 0,
  health: recorder.health(),
  records: [],
})
```

Cover one revision for each:

- insertion with simultaneous eviction and omissions;
- first terminal settlement;
- each correlation miss;
- each projection failure.

Assert no revision for direct requests, first-chunk/usage-only observation,
duplicate settlement, reads, or subscriber failure.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/snapshot.spec.ts
```

Expected: FAIL because `snapshot()` and revision do not exist.

- [x] **Step 3: Implement saturating revision**

Add:

```ts
private revision = 0

private change(): void {
  if (this.revision < Number.MAX_SAFE_INTEGER) this.revision += 1
}
```

Call once after each complete synchronous state transaction. Capture insertion
must update capture, eviction, truncation, active identity, and then call
`change()` once.

- [x] **Step 4: Implement the atomic snapshot**

Build and deep-freeze:

```ts
snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot {
  return deepFreeze({
    info: this.info(),
    revision: this.revision,
    health: this.health(),
    records: this.store.list(query),
  })
}
```

Reset revision to zero on disposal.

- [x] **Step 5: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/snapshot.spec.ts tests/plugin.spec.ts
pnpm typecheck
```

Expected: transition counts and frozen atomic snapshots pass.

### Task 5: Implement coalesced subscription isolation

**Files:**
- Create: `src/subscriptions.ts`
- Create: `tests/subscriptions.spec.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `tests/snapshot.spec.ts`

- [x] **Step 1: Write failing subscription tests**

Use controlled promises and `setImmediate` turns to prove:

- no callback runs synchronously;
- three changes before delivery produce one latest revision;
- only one callback is active per listener;
- changes during a pending promise produce one later callback;
- one synchronous throw does not block another listener;
- one rejected promise increments failure count;
- unsubscribe before delivery prevents invocation;
- disposer is idempotent;
- service disposal cancels pending delivery.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/subscriptions.spec.ts
```

Expected: FAIL because the subscription coordinator does not exist.

- [x] **Step 3: Implement one-listener state**

Each listener tracks:

```ts
interface ListenerState {
  active: boolean
  scheduled: boolean
  running: boolean
  dirty: boolean
  latestRevision: number
}
```

`publish(revision)` updates all active states. Schedule at most one
`setImmediate` callback so Cordis Fiber disposal can run through its Promise
microtasks before consumer delivery.
If running, set `dirty`. After synchronous or asynchronous settlement, schedule
one later callback when dirty. Catch both throw and rejection through an
injected `onFailure`.

- [x] **Step 4: Integrate with recorder changes**

`change()` increments revision, then calls the coordinator. `subscribe()`
delegates and returns its idempotent disposer. Subscriber failures increment
`subscriberFailures` without calling `change()` or publishing recursively.
Service disposal clears the coordinator.

- [x] **Step 5: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/subscriptions.spec.ts tests/snapshot.spec.ts tests/plugin.spec.ts
pnpm typecheck
```

Expected: subscription callbacks never execute on the capture stack and cannot
alter recorder behavior.

### Task 6: Add reasoned health accounting

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/format.ts`
- Modify: `tests/plugin.spec.ts`
- Modify: `tests/format.spec.ts`
- Modify: `tests/command.spec.ts`

- [x] **Step 1: Write failing exact-health tests**

The zero value is:

```ts
{
  captured: 0,
  completed: 0,
  active: 0,
  retained: 0,
  evicted: 0,
  truncatedRecords: 0,
  correlationMisses: 0,
  correlationMissesByReason: {
    'missing-signal': 0,
    'missing-pending': 0,
    'agent-mismatch': 0,
    'session-mismatch': 0,
  },
  projectionFailures: 0,
  subscriberFailures: 0,
}
```

Prove one marked failed request increments exactly one reason and aggregate
equals the reason sum. Assert nested maps are frozen and disposal resets all
values.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/plugin.spec.ts tests/format.spec.ts tests/command.spec.ts
```

Expected: FAIL because reason maps and new counters are absent.

- [x] **Step 3: Implement one reasoned miss helper**

Use:

```ts
private miss(reason: CorrelationMissReason): void {
  this.correlationMisses += 1
  this.correlationMissesByReason[reason] += 1
  this.change()
}
```

Check conditions in order: missing Signal, missing pending request, Agent
identity mismatch, Session mismatch. A request satisfies only the first failing
condition.

- [x] **Step 4: Update health formatting**

Add stable lines for truncated/subscriber totals and all four reasons. Keep
health output free of Session and request identifiers and inside the existing
4 KiB bound.

- [x] **Step 5: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/plugin.spec.ts tests/format.spec.ts tests/command.spec.ts
pnpm typecheck
```

Expected: aggregate and reasoned accounting are exact and immutable.

### Task 7: Isolate official DSH contracts in a Harness adapter

**Files:**
- Create: `src/harness-adapter.ts`
- Create: `tests/adapter.spec.ts`
- Modify: `src/index.ts`
- Modify: `tests/plugin.spec.ts`

- [x] **Step 1: Add adapter boundary tests**

Test real Cordis registration through the adapter and statically assert that
event-name strings `system-prompt/assemble`, `agent/request`, and `llm/stream`
appear only in `src/harness-adapter.ts`.

Adapter callbacks expose owned inputs:

```ts
export type HarnessStage =
  | 'system-prompt/assemble'
  | 'agent/request'
  | 'llm/stream'

export interface HarnessAssemblyInput {
  readonly assembly: PromptAssembly
  readonly agent: Agent
  readonly signal: AbortSignal
}

export interface HarnessRequestInput {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface HarnessStreamInput {
  readonly options: GenerateOptions
  readonly initiator: Agent | undefined
  readonly next: () => AsyncIterable<StreamChunk>
}

interface HarnessCaptureHandlers {
  assembled(input: HarnessAssemblyInput): void
  requested(input: HarnessRequestInput): void
  streaming(input: HarnessStreamInput): AsyncIterable<StreamChunk>
  projectionFailed(stage: HarnessStage, error: unknown): void
}

export function registerHarnessAdapter(
  ctx: Context,
  handlers: HarnessCaptureHandlers,
): void
```

- [x] **Step 2: Run existing integration plus adapter test**

Run:

```sh
pnpm exec vitest run tests/adapter.spec.ts tests/plugin.spec.ts
```

Expected: RED until registration is moved; all prior integration tests must
remain behaviorally unchanged during extraction.

- [x] **Step 3: Extract without widening behavior**

Move only official event registration, loop-marker check, initiator lookup, and
official payload translation. Keep correlation state, health, projection,
store, revision, and subscription ownership in the service.

The adapter must call every `next()` exactly once and return exact downstream
objects/streams.

- [x] **Step 4: Verify GREEN and import direction**

Run:

```sh
pnpm exec vitest run tests/adapter.spec.ts tests/plugin.spec.ts tests/observe-stream.spec.ts
pnpm typecheck
```

Expected: all transparent waterfall and stream behavior remains green; no
official event string remains in other source files.

### Task 8: Add Session-scoped `/flight list`

**Files:**
- Modify: `src/command.ts`
- Modify: `src/format.ts`
- Modify: `tests/command.spec.ts`
- Modify: `tests/format.spec.ts`

- [x] **Step 1: Write failing list syntax tests**

Cover:

```text
/flight list
/flight list 1
/flight list 20
```

Reject `0`, `21`, fractions, non-numbers, and extra arguments with the stable
usage text:

```text
usage: /flight [latest|list [limit]|show <id>|diff [from] [to]|health]
```

Default list limit is 10.

- [x] **Step 2: Write failing isolation and format tests**

Assert each row has only short id, turn/step/attempt, provider/model, and
outcome. Seed Session ids, prompt names, tool names, variables, and error input;
none may appear. Other-Session records must not be queried.

- [x] **Step 3: Verify RED**

Run:

```sh
pnpm exec vitest run tests/command.spec.ts tests/format.spec.ts
```

Expected: FAIL because list parsing and rendering do not exist.

- [x] **Step 4: Implement minimal list behavior**

Add:

```ts
export function formatRecordList(
  records: readonly FlightRecord[],
): string
```

The command calls:

```ts
recorder.list({ sessionId, limit })
```

An empty result returns the existing no-record error. All success text passes
through `boundCommandText`.

- [x] **Step 5: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/command.spec.ts tests/format.spec.ts
pnpm typecheck
```

Expected: all old and new command forms pass with Session isolation.

### Task 9: Add repeated-lifecycle, concurrency, soak, and benchmark evidence

**Files:**
- Create: `tests/soak.spec.ts`
- Create: `bench/project.bench.ts`
- Modify: `package.json`
- Modify: `tsconfig.test.json`
- Modify: `vitest.config.ts`
- Modify: `tests/plugin.spec.ts`

- [x] **Step 1: Write lifecycle and concurrency tests**

Add:

- 100 sequential mount/dispose cycles on one root Context;
- overlapping streams from two Agents and two Sessions;
- capacity eviction during overlap;
- final zero state for disposed service references;
- no subscriber callback after disposal.

- [x] **Step 2: Write the 10,000-record bounded-state test**

Use direct deterministic service/store fixtures rather than a real provider.
Assert:

- retained count never exceeds capacity;
- every collection remains under `FLIGHT_LIMITS`;
- revision remains safe;
- active returns to zero;
- no secret fixture text appears in a final snapshot.

- [x] **Step 3: Run soak tests**

Run:

```sh
pnpm exec vitest run tests/soak.spec.ts tests/plugin.spec.ts
```

Expected: tests complete deterministically without provider credentials.

- [x] **Step 4: Add a non-default benchmark script**

Add:

```json
{
  "scripts": {
    "bench": "vitest bench --run"
  }
}
```

Extend `tsconfig.test.json` to typecheck benchmark and example sources:

```json
{
  "include": [
    "src/**/*.ts",
    "tests/**/*.ts",
    "bench/**/*.ts",
    "examples/**/*.ts",
    "vitest.config.ts"
  ]
}
```

Benchmark bounded request projection for small, standard, and limit-sized
fixtures. The benchmark is release evidence, not part of `pnpm check`, avoiding
flaky per-change timing failures.

- [x] **Step 5: Verify benchmark execution**

Run:

```sh
mkdir -p .artifacts
pnpm bench | tee .artifacts/benchmark-v1.txt
```

Expected: all three fixtures report median and P95 without errors, and the
actual output is retained for `docs/benchmarks.md`; do not invent numbers.

### Task 10: Upgrade package, CI, and packed-consumer contracts to v1

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/smoke-packed.mjs`
- Modify: `tests/package.spec.ts`
- Generate: `lib/index.mjs`
- Generate: `lib/index.d.mts`
- Generate: `lib/invariant.mjs`
- Generate: `lib/invariant.d.mts`

- [x] **Step 1: Write failing v1 package tests**

Assert:

```ts
expect(manifest.version).toBe('1.0.0')
expect(manifest.engines.node).toBe('^22.19.0 || ^24.0.0')
```

CI must define a Node matrix containing `22.19.0` and `24`, run complete gates
on both, and perform pack/smoke once on Node 22.19.

Tarball name and documentation contracts use
`dsh-request-flight-recorder-1.0.0.tgz`.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/package.spec.ts tests/public-api.spec.ts
```

Expected: FAIL on v0.2 metadata, engines, workflow, tarball path, and missing v1
docs.

- [x] **Step 3: Update package metadata and workflow**

Keep exact DSH peers and no `prepare`. Narrow Node engines, update version, and
use:

```yaml
strategy:
  matrix:
    node: [22.19.0, 24]
```

Build-drift, publint, pack, and smoke remain release-blocking.

- [x] **Step 4: Generate and inspect v1 output**

Run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec publint
mkdir -p .artifacts
pnpm pack --pack-destination .artifacts
node scripts/smoke-packed.mjs .artifacts/dsh-request-flight-recorder-1.0.0.tgz
```

Expected: root public exports and both package entries load in a fresh consumer.

### Task 11: Write v1 public documentation and migration guidance

**Files:**
- Create: `docs/api.md`
- Create: `docs/data-schema.md`
- Create: `docs/privacy-threat-model.md`
- Create: `docs/architecture.md`
- Create: `docs/compatibility.md`
- Create: `docs/migration.md`
- Create: `docs/benchmarks.md`
- Create: `examples/read-only-consumer.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `package.json`
- Modify: `tests/package.spec.ts`

- [x] **Step 1: Add failing documentation contracts**

Both READMEs must contain:

- `1.0.0`, exact DSH compatibility, and narrowed Node engines;
- `/flight list` and `/flight list 20`;
- protocol/schema constants;
- snapshot and subscribe example;
- all hard limits;
- no raw error-message retention;
- links to API, schema, privacy, architecture, compatibility, migration, and
  benchmark documents.

The migration document must state the exact error, record, health, and Node
changes. The example must compile against `FlightRecorderReader`.

- [x] **Step 2: Verify RED**

Run:

```sh
pnpm exec vitest run tests/package.spec.ts
pnpm typecheck
```

Expected: FAIL because v1 documents and packaged allowlist entries are absent.

- [x] **Step 3: Write factual documents from implementation**

Use actual exported names and measured benchmark output. Mark DSH versions not
tested as unsupported. Do not claim npm publication, GitHub release,
provenance, signed tags, or remote CI success before those actions occur.

- [x] **Step 4: Include public docs and example in package**

Add the seven docs and example to `files`. Keep source-internal plans and specs
out of the tarball.

- [x] **Step 5: Verify GREEN**

Run:

```sh
pnpm exec vitest run tests/package.spec.ts
pnpm typecheck
pnpm exec publint
```

Expected: bilingual commands and v1 contract documentation agree.

### Task 12: Run complete release-candidate verification

**Files:**
- No source changes unless a failure starts with a focused regression test in
  the owning task.

- [x] **Step 1: Run complete local gates**

```sh
pnpm install --frozen-lockfile
pnpm test:coverage
pnpm typecheck
pnpm build
pnpm exec publint
pnpm bench
```

Expected: 100% statements, branches, functions, and lines; all type/build/package
gates pass; benchmark completes.

- [x] **Step 2: Verify deterministic committed output**

```sh
mkdir -p .artifacts
pnpm build
shasum -a 256 lib/* > .artifacts/lib-before.sha256
pnpm build
shasum -a 256 lib/* > .artifacts/lib-after.sha256
diff -u .artifacts/lib-before.sha256 .artifacts/lib-after.sha256
```

Expected: the second build produces identical hashes. CI keeps
`git diff --exit-code -- lib` once generated output exists in a committed
checkout.

- [x] **Step 3: Pack and load a fresh consumer**

```sh
mkdir -p .artifacts
pnpm pack --pack-destination .artifacts
node scripts/smoke-packed.mjs .artifacts/dsh-request-flight-recorder-1.0.0.tgz
```

Expected: exact allowlist, no install script, all root exports, invariant entry,
and empty reader state load successfully.

- [x] **Step 4: Verify official DSH installation**

Use a new ignored home, never `~/.dsh`:

```sh
DSH_HOME="$PWD/.artifacts/dsh-home-v1" \
pnpm --dir ../deepseek-harness dsh plugin --profile web add \
"$PWD/.artifacts/dsh-request-flight-recorder-1.0.0.tgz"

DSH_HOME="$PWD/.artifacts/dsh-home-v1" \
pnpm --dir ../deepseek-harness dsh --profile web --dump-config
```

Expected: the Bundle contains `request-flight-recorder` and the real profile
boots without module-resolution failure.

- [x] **Step 5: Review final scope and secrets**

```sh
git status --short
git diff --check
rg -n "console\\.|debugger|TO[D]O|FIX[M]E|XXX|DEEPSEEK_API_KEY|TOP_SECRET_VALUE" \
  src tests bench scripts examples \
  docs/api.md docs/data-schema.md docs/privacy-threat-model.md \
  docs/architecture.md docs/compatibility.md docs/migration.md \
  docs/benchmarks.md README.md README.zh-CN.md .github || true
```

Expected: seeded test canaries appear only in tests; no credentials, debug
residue, placeholders, publication claims, or unrelated changes are present.

## Execution Order

Tasks are sequential because each freezes contracts consumed by the next:

```text
Error privacy
  -> bounded record schema
  -> public reader protocol
  -> snapshot revision
  -> subscriptions
  -> health
  -> Harness adapter
  -> command
  -> stress evidence
  -> package
  -> docs
  -> release verification
```

Do not parallelize tasks that modify `src/types.ts`, `src/index.ts`, shared
fixtures, or package metadata in the same working tree.
