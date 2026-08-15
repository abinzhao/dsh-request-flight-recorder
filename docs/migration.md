# Migration from 0.2 to 1.0

Version 1.0 preserves the default plugin export, Bundle configuration,
`capacity`, existing query methods, diff semantics, and optional `/flight`
commands. The changes below are intentional compile-time and data-contract
breaks.

## Errors

`FlightErrorSummary` no longer exposes an arbitrary Error `name` or `message`.
It contains only `kind: FlightErrorKind`. Custom names map to `error`, and a
non-Error thrown value maps to `non-error-thrown`.

Consumers must replace:

```ts
record.outcome.error.message
```

with finite classification:

```ts
record.outcome.error.kind
```

The original downstream exception behavior is unchanged.

## Records

Every `FlightRecord` now requires:

- `schemaVersion: 1`;
- `omissions: FlightRecordOmissions`.

Structural collections are bounded by `FLIGHT_LIMITS`. Consumers that display
or aggregate records should surface positive omission counters instead of
assuming a complete structural list.

## Health

`FlightRecorderHealth` adds:

- `truncatedRecords`;
- `subscriberFailures`;
- `correlationMissesByReason`.

`correlationMissesByReason` contains `missing-signal`, `missing-pending`,
`agent-mismatch`, and `session-mismatch`. The existing
`correlationMisses` aggregate equals their sum.

## Stable reader

Consumers should type against `FlightRecorderReader`. Version 1 adds `info()`,
atomic `snapshot()`, and coalesced `subscribe()`. Subscription changes are
invalidations; read a fresh snapshot rather than treating notifications as a
durable change stream.

The protocol and record constants are both `1`:

```ts
FLIGHT_RECORDER_PROTOCOL_VERSION
FLIGHT_RECORD_SCHEMA_VERSION
```

## Commands and runtime

`/flight list` and `/flight list 20` provide Session-scoped compact listings.
Health output now includes omissions, subscriber failures, and all correlation
reasons.

The Node.js engine range narrows from `^22.19.0 || >=24.0.0` to
`^22.19.0 || ^24.0.0`. DeepSeek Harness remains fixed at `0.1.0-rc.6`.
