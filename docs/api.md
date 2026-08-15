# Public API

Version 1.1.0 exposes the same version-1 read-only, process-local API from the
package root.
Internal stores, projectors, adapters, formatters, and subscription coordinators
are not public.

## Handshake

```ts
import {
  FLIGHT_RECORDER_PROTOCOL_VERSION,
  FLIGHT_RECORD_SCHEMA_VERSION,
  type FlightRecorderReader,
} from 'dsh-request-flight-recorder'

function connect(reader: FlightRecorderReader): void {
  const info = reader.info()
  if (
    info.protocolVersion !== FLIGHT_RECORDER_PROTOCOL_VERSION
    || info.recordSchemaVersion !== FLIGHT_RECORD_SCHEMA_VERSION
  ) {
    throw new Error('unsupported flight recorder contract')
  }
}
```

Both constants are `1`. Capability order is stable:
`diff`, `health`, `query`, `snapshot`, `subscribe`.

## FlightRecorderReader

```ts
interface FlightRecorderReader {
  info(): FlightRecorderInfo
  snapshot(query?: FlightRecordQuery): FlightRecorderSnapshot
  subscribe(listener: FlightRecorderListener): () => void
  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
  diff(fromId: RequestAttemptId, toId: RequestAttemptId): FlightDiffResult
  health(): FlightRecorderHealth
}
```

`list()` combines supplied filters and returns newest records first.
`snapshot()` is one atomic, deeply frozen view:

```ts
interface FlightRecorderSnapshot {
  readonly info: FlightRecorderInfo
  readonly revision: number
  readonly health: FlightRecorderHealth
  readonly records: readonly FlightRecord[]
}
```

The revision is process-local, starts at zero, never wraps, and advances for
record insertion, first terminal settlement, correlation miss, and projection
failure. Reads, usage-only observations, duplicate settlement, and subscriber
failure do not advance it.

## Subscription

`subscribe()` delivers coalesced invalidations outside the synchronous capture
stack. A listener receives only the latest revision, not a durable event log.
Slow listeners never overlap with themselves. Listener failures are isolated
and counted in health. Call the returned idempotent disposer when the consumer
stops:

```ts
const unsubscribe = reader.subscribe(({ revision }) => {
  const snapshot = reader.snapshot()
  if (snapshot.revision < revision) return
  render(snapshot)
})

unsubscribe()
```

## Immutability and lifetime

Records, arrays, snapshots, health objects, reason maps, and diff results are
frozen. The service provides no mutation, raw-body retrieval, export, or
persistence API. Retained state and listeners are cleared when its Cordis
service lifetime ends.

## Diagnostic configuration

`capacity`, `slowFirstChunkMs`, and `slowTotalMs` are positive safe integers.
Defaults are 128, 1000, and 2000 respectively. Thresholds affect only
`/flight list slow` and Explain classification; they do not change capture,
retention, protocol version, record schema, or model requests.
