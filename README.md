# dsh-request-flight-recorder

[中文](./README.zh-CN.md)

Content-free model request diagnostics for DeepSeek Harness. The plugin observes
official Agent Loop requests through Cordis, correlates request assembly with
stream completion, and keeps a bounded in-memory flight history for debugging.

## What it provides

- Exact Session, Turn, Step, and request-attempt coordinates.
- Provider, model, generation settings, structural message counts, and tool
  schema sizes.
- Prompt section, context, tool, and variable names without their values.
- Time to first chunk, total duration, token usage, finish reason, and
  structured failure state.
- Process health counters, retained-record queries, and deterministic
  content-free diffs.
- An optional official `/flight` human command when the profile provides the
  Commands service.

The recorder does not register a model Tool, Skill, prompt section, or context
provider. It does not change Agent Loop or prompt semantics.

## Compatibility

Version `1.0.0` targets DeepSeek Harness `0.1.0-rc.6`, Cordis `^4.0.1`, and
Node.js `^22.19.0 || ^24.0.0`. DSH release candidates may change extension
contracts; use the matching plugin version.

## Installation

### npm

For npm installation, add the package to a profile through the official DSH
plugin command:

```sh
dsh plugin --profile web add dsh-request-flight-recorder
```

### GitHub commit

For a public GitHub checkout, pin an immutable commit rather than a moving
branch:

```sh
dsh plugin --profile web add "github:abinzhao/dsh-request-flight-recorder#<commit-sha>"
```

### Local checkout

From this repository:

```sh
dsh plugin --profile web add .
```

To install a packed artifact instead:

```sh
pnpm pack
dsh plugin --profile web add ./dsh-request-flight-recorder-1.0.0.tgz
```

Verify the composed profile:

```sh
dsh --profile web --dump-config
```

The output should contain a `request-flight-recorder` row. The package Bundle
adds this default:

```yaml
- insert:
    - id: request-flight-recorder
      name: dsh-request-flight-recorder
      config:
        capacity: 128
```

`capacity` must be a positive safe integer. It limits retained records in the
current process; health counters are tracked independently of eviction.

## Human command

When the active profile includes the official Commands service:

```text
/flight
/flight latest
/flight list
/flight list 20
/flight show <request-id-prefix>
/flight diff
/flight diff <from-prefix> <to-prefix>
/flight health
```

`/flight` and `/flight latest` show the newest retained record for the current
Session. `/flight list` defaults to 10 rows; an explicit limit must be from 1
through 20. An implicit diff compares the two newest records. IDs are resolved
as unique prefixes within the current Session; missing or ambiguous prefixes
fail closed. Output is plain text and limited to 4,096 UTF-16 code units.

Representative output:

```text
flight abcdef12
turn 1 · step 1 · attempt 1
model deepseek/deepseek-chat
request 1 message · 10 system chars · 1 tool
tools read_file(2)
prompt sections identity · contexts workspace · variables cwd
outcome finished:stop · ttft 5ms · total 20ms · tokens 12 in / 4 out
```

The command uses `recordInput: false`, so its raw arguments are not copied into
the `command/run` record. Command result text may be persisted by the active
DeepSeek Harness profile or its session/history plugins. Treat command output
as internal diagnostics.

## Service API

The plugin registers the process-local read-only
`ctx.requestFlightRecorder` service:

```ts
const latest = ctx.requestFlightRecorder.latest(session.id)
const records = ctx.requestFlightRecorder.list({
  sessionId: session.id,
  provider: 'deepseek',
  model: 'deepseek-chat',
  outcome: 'finished',
  limit: 10,
})
const record = ctx.requestFlightRecorder.get(requestAttemptId)
const health = ctx.requestFlightRecorder.health()
const comparison = ctx.requestFlightRecorder.diff(fromId, toId)
const info = ctx.requestFlightRecorder.info()
const snapshot = ctx.requestFlightRecorder.snapshot()

const unsubscribe = ctx.requestFlightRecorder.subscribe(({ revision }) => {
  if (ctx.requestFlightRecorder.snapshot().revision >= revision) {
    render(ctx.requestFlightRecorder.snapshot())
  }
})
unsubscribe()
```

Queries combine all supplied filters and return newest records first. Records,
arrays, health snapshots, and diff results are frozen. The API exposes no
mutation, body retrieval, export, or persistence operation.

`FLIGHT_RECORDER_PROTOCOL_VERSION` and `FLIGHT_RECORD_SCHEMA_VERSION` are both
`1`. `snapshot()` atomically returns handshake, revision, health, and records.
`subscribe()` delivers coalesced invalidations, not a durable event log.

## Hard limits

`FLIGHT_LIMITS` is a stable v1 contract:

| Field | Maximum |
|---|---:|
| `nameCharacters` | 256 |
| `tools` | 128 |
| `promptSections` | 256 |
| `promptContexts` | 256 |
| `promptVariables` | 256 |
| `messageCounterKeys` | 64 |
| `toolSchemaNodes` | 4096 |

Records expose exact omission counters when a structural observation exceeds a
limit. Names over 256 UTF-16 code units are omitted as whole entries.

## Privacy boundary

The recorder uses an explicit field allowlist. It does not retain prompt text,
message content, tool descriptions, tool arguments, tool results, or prompt
variable values. It retains structural names such as provider, model, tool,
prompt section, context, and variable names, plus counts and timings.

Upstream exception messages can contain provider-supplied details. The recorder
does not retain raw error messages, stacks, causes, custom Error names, or
non-Error thrown values. It stores only a finite error kind while preserving
the original downstream exception identity. This plugin runs in the same
Node.js process as other profile plugins and is not a security boundary.

No records are written to disk by the recorder. The bounded Ring Buffer is
cleared on process exit, HMR disposal, or service disposal. This does not
override persistence performed by the Commands or session/history services.

## Correlation and stream behavior

The plugin observes only requests carrying the official Agent Loop marker. It
correlates `system-prompt/assemble`, `agent/request`, and `llm/stream` using the
same `AbortSignal`, Agent object identity, and Session ID. If any coordinate is
missing or mismatched, it skips the record instead of guessing.

The stream observer preserves chunk object identity, ordering, backpressure,
consumer cancellation, return values, and thrown error identity. Observation
failures do not replace model-stream behavior.

## Invariant companion

`dsh-request-flight-recorder/invariant` registers package ownership with the
official invariant registry. It intentionally installs no duplicate runtime
check: bounded retention is already enforced synchronously by the Ring Buffer,
and there is no independent event source to cross-check.

## Troubleshooting

- Missing Bundle row: run `dsh --profile web --dump-config` and confirm the
  package is listed in the selected profile.
- No `/flight` command: the core recorder still works, but the selected profile
  does not currently provide the optional Commands service.
- No records: only official Agent Loop requests are captured; direct LLM calls
  are intentionally ignored.
- Rising correlation misses: inspect custom Agent Loop integrations for a
  shared `AbortSignal`, Agent identity, and Session ID.
- Missing older records: increase `capacity` if bounded eviction is expected to
  be too aggressive.

## Removal

```sh
dsh plugin --profile web remove dsh-request-flight-recorder
```

## Development

```sh
pnpm install
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm build
pnpm bench
pnpm exec publint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required workflow and
[SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## Reference

- [Public API](./docs/api.md)
- [Record schema and limits](./docs/data-schema.md)
- [Privacy threat model](./docs/privacy-threat-model.md)
- [Architecture](./docs/architecture.md)
- [Compatibility](./docs/compatibility.md)
- [Migration from 0.2](./docs/migration.md)
- [Benchmarks](./docs/benchmarks.md)

## License

[MIT](./LICENSE)
