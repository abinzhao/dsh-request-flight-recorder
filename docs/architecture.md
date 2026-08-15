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
  -> immutable Ring Buffer record
  -> FlightRecorderReader snapshot/query/diff
  -> optional /flight command or read-only consumer
```

`registerHarnessAdapter()` is the only production module that registers
`system-prompt/assemble`, `agent/request`, and `llm/stream`. It owns official
Agent Loop marker detection, current-Initiator lookup, and payload translation.
The service owns projection, correlation, health, retention, revision, and
subscription state.

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
