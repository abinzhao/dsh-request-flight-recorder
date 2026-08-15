# Record Schema

Every v1 `FlightRecord` carries `schemaVersion: 1`, matching
`FLIGHT_RECORD_SCHEMA_VERSION`.

## Record

```ts
interface FlightRecord {
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

`request` contains provider, model, selected scalar generation settings,
message structure counters, system character count, tool names, and bounded
tool-schema node counts. `promptAssembly` contains bounded section, context,
tool, and variable names plus character counts where applicable.

Outcomes are `running`, `finished`, `threw`, or `incomplete`. A thrown outcome
contains only a finite `FlightErrorSummary.kind`; it never contains arbitrary
error text. Provider `error` and `aborted` finish reasons are normalized to a
`threw` outcome with `error.kind = "error"` so the provider failure object
cannot enter the record.

Evidence sources are `system-prompt/assemble`, `agent/request`, and
`llm/stream`. Evidence labels describe whether retained facts were exact,
derived, or inferred.

## Hard limits

`FLIGHT_LIMITS` is part of the v1 public contract:

| Field | Maximum |
|---|---:|
| `nameCharacters` | 256 UTF-16 code units |
| `tools` | 128 per request or prompt projection |
| `promptSections` | 256 |
| `promptContexts` | 256 |
| `promptVariables` | 256 |
| `messageCounterKeys` | 64 per counter map |
| `toolSchemaNodes` | 4096 per tool schema |

Names larger than `nameCharacters` are omitted as whole entries. Tool schemas
are traversed iteratively with cycle detection. Limits do not silently discard
observations: `omissions` records request tools, prompt tools, sections,
contexts, variables, message counter entries, oversized names, and truncated
tool schemas.

`FlightRecorderHealth.truncatedRecords` counts records with at least one
positive omission counter.

## Compatibility

Consumers must check both `FLIGHT_RECORDER_PROTOCOL_VERSION` and
`FLIGHT_RECORD_SCHEMA_VERSION`. Additive package releases may add APIs, but a
record or protocol shape incompatible with these contracts requires a new
version constant and SemVer review.
