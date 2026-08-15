# Architecture

The plugin is a passive observer. It does not modify Agent Loop inputs, prompt
semantics, stream chunks, ordering, backpressure, cancellation, return values,
or exception identity.

## Flow

```text
DeepSeek Harness Cordis events
  -> registerHarnessAdapter
  -> strict correlation
  -> bounded structural projection
  -> FlightRecorderState transaction
  -> immutable FlightRecorderReader Snapshot
  -> optional /flight command or read-only consumer
```

`registerHarnessAdapter()` is the only production module that registers
`system-prompt/assemble`, `agent/request`, and `llm/stream`. It owns official
Agent Loop marker detection, current-Initiator lookup, strict correlation,
attempt numbering, structural projection, stream observation, and terminal
failure redaction.

`FlightRecorderState` owns Ring Buffer retention, active request identities,
health counters, revision, subscriptions, and disposal as one transaction
boundary. It accepts projected domain records and does not know DSH event payloads.
`RequestFlightRecorder` is the Cordis lifecycle composition root and delegates
the stable Reader Interface to State.

The Command module consumes one atomic Snapshot for the invoking Session.
Prefix resolution, list limits, health rendering, and Diff therefore observe
one revision and cannot race a second Reader call.

## Correlation

Only requests with the official Agent Loop marker are candidates. Correlation
requires the same `AbortSignal`, Agent object identity, and Session ID. The first
failed condition increments exactly one reason:

1. `missing-signal`
2. `missing-pending`
3. `agent-mismatch`
4. `session-mismatch`

The recorder delegates unchanged and never guesses a match.

## Retention and revision

The Ring Buffer has a configurable positive capacity and defaults to 128.
Insertion, simultaneous eviction, and omission accounting are one transaction
and one revision. First terminal settlement is another revision. Revision
saturates at `Number.MAX_SAFE_INTEGER`.

Snapshots combine the current handshake, revision, health, and filtered record
list in one synchronous read. Stored records and returned views are frozen.

## Deliberate boundaries

`project.ts` remains one deep privacy boundary for limits, cycle detection,
name filtering, omission accounting, and structural summaries. Public protocol
types remain local in `types.ts`. The implementation does not add
single-implementation seams for clocks, UUIDs, stores, formatters, or each
command. These boundaries avoid moving complexity between shallow modules.

## Subscription isolation

Subscriptions are invalidations, not an event journal. Each listener has at
most one active call. Changes while a listener is queued or pending coalesce to
the latest revision. Delivery uses Node `setImmediate`, keeping callbacks off
the capture stack and allowing Cordis disposal to clear queued delivery first.
Thrown and rejected listener failures are contained and counted without
publishing recursively.

## Lifecycle

Cordis effects own event listeners, optional Commands integration, retained
state, correlation maps, and subscriptions. Disposal clears all process-local
state. Tests cover 100 sequential mount/dispose cycles, queued subscription
cancellation, and streams that settle after their retained record was evicted.
