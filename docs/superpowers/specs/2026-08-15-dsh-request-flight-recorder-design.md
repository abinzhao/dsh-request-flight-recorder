# dsh-request-flight-recorder Design

## Status

Proposed for implementation after user review.

## Decision

Build `dsh-request-flight-recorder` as an independent, single-package DeepSeek Harness plugin. The first release observes loop-built model requests and their streams, retains bounded structural records in memory, and exposes a same-process read-only Cordis service.

The plugin does not modify model requests, append session events, persist records, register model-visible tools, or add a Web Client module.

## Context

DeepSeek Harness already records model-visible state in the append-only session log and exposes the final, deep-frozen `GenerateOptions` through the `llm/stream` waterfall. Existing diagnostics can measure token pressure or inspect static context, but no standard plugin correlates one exact request with its prompt assembly, turn and step coordinates, stream timing, usage, and terminal outcome.

The plugin must be useful outside the official monorepo while following the same Cordis lifecycle, package, event, type-safety, and testing conventions.

## Goals

- Capture the exact structure of every loop-built model request without changing it.
- Correlate a request with its initiating session, turn, step, and final prompt assembly.
- Record time to first chunk, completion latency, token usage, and terminal finish or thrown error.
- Retain only bounded structural metadata by default; do not duplicate message or prompt content.
- Expose immutable snapshots through a same-process service.
- Remove every listener and retained record when the plugin fiber is disposed.
- Preserve downstream stream identity, chunk order, errors, cancellation, and backpressure.

## Non-goals

- Persist records across process restarts.
- Add custom `SessionEventMap` members.
- Attribute every prompt contribution to an npm package when the official assembly exposes only contribution names.
- Capture auxiliary, hand-built LLM calls.
- Redact or export full request content.
- Add commands, tools, RPC, Web UI, OpenTelemetry, or external reporting.
- Evaluate model quality or enforce request policy.

## Constraints

- Target the currently published public packages and extension points in DeepSeek Harness `0.1.0-rc.6`.
- Use ESM, Node `^22.19.0 || >=24`, strict TypeScript, pnpm, Vitest, and tsdown.
- Register all listeners through Cordis effects.
- Every waterfall listener delegates with `next()` exactly once.
- The capture path is fail-open: recorder failures never block or replace a model request.
- Downstream failures are not swallowed or normalized by this plugin.
- Configuration is validated through Schemastery.
- No production function is implemented before a focused failing test demonstrates its behavior.

## Forces

| Force | Rationale |
|---|---|
| Exact request evidence | `llm/stream` is the last public observation point before adapter dispatch and receives the final deep-frozen request. |
| Causal coordinates | `agent/request` owns authoritative turn and step values, while `system-prompt/assemble` owns named prompt contributions. |
| Low request latency | Full cloning, serialization, hashing, or tokenization on the model-call path would tax every request. |
| Privacy | Prompt and message content can contain credentials, proprietary code, or personal data and already has a durable owner in the session log. |
| HMR correctness | An out-of-tree plugin must release listeners and state without requiring process restart. |
| RC compatibility | The plugin must depend on documented public packages and avoid agent-loop implementation imports. |

## Alternatives

| Alternative | Decision | Reason |
|---|---|---|
| Observe only `session/event` | Rejected | It can reconstruct model-visible history but does not directly observe the exact dispatched `GenerateOptions` or stream timing. |
| Proxy or replace the LLM adapter | Rejected | It couples diagnostics to routing and provider behavior and creates a risk of changing request semantics. |
| Append complete request snapshots to the session log | Rejected | It duplicates sensitive model-visible data, increases log size, and introduces session-format compatibility concerns. |
| Extend `dsh-context-doctor` | Rejected | Static context auditing and per-attempt runtime recording have different ownership, lifecycle, and data-retention requirements. |
| Separate Service Definition and Provider packages now | Rejected | The first release has one in-memory implementation and no independently evolving consumer; multiple packages would add unsupported abstraction. |
| Single service package with internal modules | Selected | It preserves explicit module boundaries while remaining one installable plugin and one reversible decision. |

## Architecture

### Package form

The package default-exports `RequestFlightRecorder`, a Cordis `Service` registered as `ctx.requestFlightRecorder`.

The service is both the current Service Definition and its sole in-memory Provider. Future persistence, command, RPC, and UI packages consume the public service without changing capture ownership.

```text
system-prompt/assemble ----\
                            \
agent/request ---------------> RequestFlightRecorder ---> bounded RingStore
                              /
llm/stream ------------------/
       |
       +---- exact downstream AsyncIterable, observed without buffering
```

### Modules

| File | Responsibility |
|---|---|
| `src/types.ts` | Public immutable record, summary, query, evidence, and branded ID types only. |
| `src/project.ts` | Pure structural projection from final prompt assembly and `GenerateOptions`; never stores content. |
| `src/ring-store.ts` | Bounded insertion-order retention and immutable snapshot queries. |
| `src/observe-stream.ts` | Async iterable wrapper that records timing, usage, finish, and thrown errors while preserving chunks. |
| `src/index.ts` | Cordis service, listener registration, request correlation, configuration, and public query API. |
| `src/invariant.ts` | Package-owned invariant companion; registers ownership but installs no runtime check because retention has no independent authoritative event stream. |

### Public service

```ts
export class RequestFlightRecorder extends Service {
  static readonly inject: readonly ['llm', 'agents', 'systemPrompt']
  static readonly Config: Schema<RequestFlightRecorderConfig>

  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
}
```

Returned records and arrays are detached and deeply immutable. The service exposes no mutation, registration, or raw-content API in the first release.

### Configuration

```ts
export interface RequestFlightRecorderConfig {
  capacity: number
}
```

`capacity` is a validated positive safe integer with a default of `128`. Updating configuration through HMR creates a new service lifetime; retained in-memory records intentionally do not cross fiber replacement.

## Data Model

```ts
export interface FlightRecord {
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
}
```

`RequestSummary` contains provider, model, optional generation scalars, message count, per-role and per-source counts, content-block counts, system-prompt character count, and tool names with parameter-schema byte estimates. It does not contain message text, system text, tool descriptions, tool parameter values, or serialized schemas.

`PromptAssemblySummary` contains ordered section and context names with character counts, tool names, and variable names. It never stores variable values or section text.

`FlightOutcome` is a discriminated union:

- `running`
- `finished`, with finish reason, optional usage, first-chunk latency, and total latency
- `threw`, with error name and message plus independently observed timing and usage
- `incomplete`, with reason `stream-ended-without-finish`, `consumer-returned`, or `consumer-threw`

Thrown errors remain distinct from terminal `finish { kind: 'error' | 'aborted' }` chunks.

`FlightEvidence` marks every field group as:

- `exact`: directly observed from final `GenerateOptions` or `StreamChunk`
- `derived`: obtained from an official projection
- `inferred`: correlated by an explicitly documented process-local rule

The first release uses `exact` for request and stream facts and `derived` for prompt assembly names. Turn and step are exact values captured from `agent/request`, then correlated to the request by the same initiating Agent and turn signal.

## Correlation

### Prompt assembly

The `system-prompt/assemble` listener awaits `next()`, projects the returned authoritative assembly, and stores the summary in a `WeakMap<AbortSignal, PromptAssemblySummary>` when the assembly context contains both an Agent and a signal.

The listener always returns the exact downstream assembly object. Projection errors are logged and contained.

### Turn and step

The `agent/request` listener awaits `next()`, records `{ agent, sessionId, turn, step, signal, promptAssembly }` in a `WeakMap<AbortSignal, PendingRequest>`, and returns the exact downstream call configuration.

No pending entry is published as a flight record until a matching loop-built `llm/stream` call arrives.

### Model request

The `llm/stream` listener:

1. Calls `isAgentLoopRequest(options)`. Non-loop calls delegate unchanged.
2. Reads `ctx.agents.currentInitiator()` and requires identity equality with the pending Agent.
3. Requires `options.sessionId` to equal the pending session ID.
4. Consumes the pending entry for `options.signal`.
5. Creates one running record before invoking the downstream stream.
6. Invokes `next()` exactly once.
7. Returns an async iterable that yields each downstream chunk unchanged and in order.

If exact correlation is unavailable, the request is not recorded. The plugin logs a bounded diagnostic warning rather than fabricating turn or step values.

`attempt` is a per-`sessionId:turn:step` ordinal incremented only when a correlated `llm/stream` request begins. This distinguishes retries without claiming that a message ID identifies a complete run.

## Stream Observation

The observer is pull-through, not buffering:

```text
consumer next()
  -> recorder asks downstream next()
  -> recorder observes returned chunk
  -> recorder yields the same chunk
```

The first observed chunk sets `firstChunkMs`. `usage` replaces the current usage snapshot. `finish` commits a `finished` outcome. Normal iterator completion without a finish commits `incomplete { reason: 'stream-ended-without-finish' }`; the recorder never invents `{ kind: 'stop' }`. The official LLM runtime invariant rejects this stream defect, and any resulting error still propagates unchanged through the listener chain.

If iterator creation, `next()`, or iteration throws, the record commits `threw` and rethrows the identical error object.

If the consumer stops iteration early, the wrapper forwards `return()` and commits `incomplete { reason: 'consumer-returned' }` without claiming a provider finish. A consumer-supplied `throw()` is forwarded with the identical value and commits `incomplete { reason: 'consumer-threw' }`.

## Ring Store

- Capacity applies to the complete retained result.
- Insertion of record `capacity + 1` evicts the oldest record.
- A running record may be evicted; later completion becomes a no-op.
- Query order is newest first.
- Session filtering preserves global recency order.
- Public reads return immutable values owned by the store; callers cannot mutate recorder state.
- Disposing the service clears all retained records and correlation maps.

No module-scope state survives HMR in the first release.

## Failure Model

| Failure | Required behavior |
|---|---|
| Projection throws | Log once for that request, delegate unchanged, omit unavailable summary. |
| Correlation missing | Delegate unchanged and do not create a misleading record. |
| Ring store update fails | Delegate or continue yielding unchanged; recorder failure is contained. |
| `next()` throws synchronously | Commit `threw` when a record exists, then rethrow the same object. |
| Downstream iteration throws | Commit `threw`, then rethrow the same object. |
| Recorder fiber disposes mid-stream | Stop publishing updates; do not cancel or alter the downstream stream. |
| Consumer cancels iteration | Forward iterator cleanup and record observation cancellation. |

## Interaction Style

Capture is synchronous structural projection plus pull-through stream observation. Persistence and UI are deliberately excluded, so there is no queue, polling, push subscription, or process boundary in the first release.

The public query API uses local snapshots because all current consumers are same-process tests and future host-side commands. A subscription API is deferred until a real live consumer establishes its ordering and backpressure requirements.

## Bounded Context Map

| Context | Responsibility | Upstream | Downstream | Relationship and translation |
|---|---|---|---|---|
| Harness request lifecycle | Produces authoritative assembly, coordinates, and final request | Session and plugin composition | Capture context | Customer/supplier; recorder conforms to public event types. |
| Capture context | Correlates official observations into one attempt | Harness lifecycle | Retention context | Anti-corruption layer; translates runtime objects into content-free summaries. |
| Retention context | Enforces capacity and immutable queries | Capture context | Future consumers | Customer/supplier; knows only flight-record types. |
| Future presentation context | Commands, RPC, or UI | Retention context | Human operator | Separate ways in v1; no implementation or API assumptions yet. |

## Trust and Privacy Boundaries

The plugin runs in the same trusted Node.js process as other DSH plugins; it is not a security isolation boundary.

The retained record excludes raw model-visible content. Error messages are retained because they are operational outcomes, but consumers must treat them as potentially sensitive. A future exporter requires a separate redaction design and must not reuse the in-memory record as proof that exported data is safe.

## Runtime Dependencies

| Dependency | Adoption criterion | Failure behavior | Exit path |
|---|---|---|---|
| `@deepseek-ai/dsh-llm` | Public `llm/stream`, `isAgentLoopRequest`, request and chunk types remain available. | Plugin cannot load if absent. | Remove plugin bundle; model execution remains unchanged. |
| `@deepseek-ai/dsh-agent` | Public request coordinates and initiating Agent API remain available. | Plugin cannot correlate requests if absent. | Remove plugin; no session data requires migration. |
| `@deepseek-ai/dsh-system-prompt` | Public assembly waterfall and types remain available. | Prompt contribution summary is unavailable. | A future version may make this summary optional without changing core request capture. |
| Cordis | Service registration and effect-owned listeners. | Load fails before requests are observed. | Remove plugin row from the profile. |

## Fitness Functions

| Property | Metric and threshold | Source | Cadence | Failure response | Check |
|---|---|---|---|---|---|
| Request transparency | Downstream receives the same `GenerateOptions` object and same chunk objects in the same order. | Integration test observer | Every change | Block release | `tests/plugin.spec.ts` |
| Error transparency | Downstream thrown error object is rethrown by identity. | Stream test | Every change | Block release | `tests/observe-stream.spec.ts` |
| Bounded retention | `size <= capacity` after every insertion, including running records. | Store tests | Every change | Block release | `tests/ring-store.spec.ts` |
| Privacy | Retained JSON contains no message text, system text, tool descriptions, variable values, or tool arguments. | Snapshot assertions | Every change | Block release | `tests/project.spec.ts` |
| Lifecycle cleanup | Disposed fiber receives no new records and retains zero records. | HMR lifecycle test | Every change | Block release | `tests/plugin.spec.ts` |
| Compatibility | Uses public package exports only; no import contains `/src/`. | Static test and package build | Every change | Block release | `pnpm run check` |
| Hot-path cost | Structural projection benchmark P95 below 2 ms for a 200-message synthetic request on the supported Node baseline. | Optional benchmark, not a flaky unit gate | Before release | Investigate and document | `bench/project.ts` |

## Test Strategy

### Unit

- Ring capacity, order, filtering, eviction, and immutable reads.
- Request projection excludes content and preserves structural counts.
- Stream observer preserves chunks, finish, usage, errors, cancellation, and timing.
- Correlation refuses mismatched Agent, Session, or signal.

### Integration

- Compose real Cordis, LLM runtime, Agent registry, SystemPrompt, and the plugin.
- Dispatch a marked loop request through the real `llm/stream` waterfall.
- Assert exact downstream request identity and a completed flight record.
- Dispose the plugin fiber, dispatch again, and assert no new record.

### Package

- Typecheck against published `0.1.0-rc.6` packages.
- Build ESM output with tsdown.
- Run publint against the packed package.
- Install the packed tarball into a temporary fixture and load it through a real Cordis configuration.

No real model API key is required for the first release.

## Repository Layout

```text
dsh-request-flight-recorder/
  docs/
    superpowers/
      specs/
        2026-08-15-dsh-request-flight-recorder-design.md
  src/
    index.ts
    invariant.ts
    observe-stream.ts
    project.ts
    ring-store.ts
    types.ts
  tests/
    observe-stream.spec.ts
    plugin.spec.ts
    project.spec.ts
    ring-store.spec.ts
  cordis.patch.yml
  package.json
  pnpm-lock.yaml
  tsconfig.json
  tsconfig.test.json
  tsdown.config.ts
  vitest.config.ts
  README.md
  LICENSE
```

## Distribution

The npm package name is `dsh-request-flight-recorder`. Its `dsh.bundle.patch` points to `cordis.patch.yml`, which inserts the default-exported service plugin with validated configuration.

DeepSeek Harness packages are peer dependencies pinned to the tested RC version. Development dependencies mirror every DSH peer dependency. Runtime output contains only built `.mjs` ESM, `.d.mts` declarations, the bundle patch, README, and license.

No install script, `prepare` script, network access, file access, or environment-variable access is required.

## Consequences

### Positive

- Exact final request observation without changing the agent loop.
- No duplicated prompt content or session-format migration.
- Bounded memory and reversible installation.
- Clear path for later commands, persistence, and UI.
- Integration tests can run without provider credentials.

### Negative

- Records disappear on restart and HMR.
- No end-user surface exists in the first release.
- Contribution names do not prove package ownership.
- Missing correlation produces no record rather than a partial record.
- The recorder adds a small synchronous projection cost to each loop request.

## Reversibility

This is a two-way decision. Removing the plugin row and package leaves no durable data or session events to migrate.

Splitting Service Definition and Provider packages later is moderate cost because consumers depend only on the public service type. Reconsider the single-package design when a second Provider or an independently released Consumer exists.

Reconsider signal-based correlation if an official request-attempt identity becomes public or tests show the same signal can identify overlapping loop requests.

## Risks

| Risk | Likelihood | Impact | Mitigation | Evidence record |
|---|---|---|---|---|
| RC event signatures change | Medium | High | Pin tested RC, use public exports, add compile matrix before widening ranges. | Package build and lockfile |
| Capture changes stream behavior | Low | High | Identity and ordering integration tests; no buffering or retry. | `plugin.spec.ts` |
| Sensitive content enters summaries | Low | High | Allowlist projected fields; snapshot the complete serialized record. | `project.spec.ts` |
| Correlation attaches wrong coordinates | Low | High | Require signal, Agent identity, and Session identity to agree; otherwise skip. | Correlation tests |
| Retained running record outlives fiber | Low | Medium | Effect-owned listeners, disposed flag, store clear, mid-stream disposal test. | Lifecycle test |
| Large schemas add latency | Medium | Medium | Count names and bounded structural sizes without serializing complete schemas. | Benchmark |

## Responsibility

- Plugin architecture and implementation: this repository.
- Official event and type contracts: `deepseek-ai/deepseek-harness`.
- Local checks: `pnpm test`, `pnpm typecheck`, `pnpm build`, package inspection, and real Cordis load test.
- Remote publication, repository creation, push, and release: excluded until explicitly authorized.

## Approval Gate

Implementation starts only after the user approves this written design. The implementation plan must preserve the scope, TDD order, public API, lifecycle rules, and failure behavior defined here.
