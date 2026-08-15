# Changelog

All notable changes are recorded here following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A version entry does
not by itself indicate that the package has been published to npm.

## [1.1.0] - 2026-08-16

### Added

- Blocking supported-RC Profile verification and observational checks for new
  DSH release candidates.
- Chinese and English command output, first-browser locale synchronization,
  filtered lists, deterministic Explain facts, and retained-window Stats.
- Configurable `slowFirstChunkMs` and `slowTotalMs` diagnostic thresholds.

### Changed

- Recorder State and Harness Adapter now own explicit transactional and event
  translation boundaries.
- Every command derives its result from one Session-scoped atomic Snapshot.
- Provider error and aborted finishes are normalized to privacy-safe finite
  failure outcomes.
- Reader protocol and record schema remain version `1`.

## [1.0.0] - 2026-08-16

### Added

- SemVer-stable `FlightRecorderReader` with protocol and record-schema
  handshakes, atomic snapshots, saturating revisions, and coalesced
  subscriptions.
- Hard structural limits with per-record omission accounting and truncated
  record health.
- Reasoned correlation health, subscriber failure isolation, and
  Session-scoped `/flight list`.
- Dedicated DeepSeek Harness adapter boundary, lifecycle/Soak evidence,
  projection benchmarks, public contract documentation, and a typed read-only
  consumer example.
- Node 22.19 and Node 24 CI matrix plus v1 Fresh Consumer package smoke.

### Changed

- Failure records now retain only a finite error kind. Arbitrary Error names,
  messages, stacks, causes, and non-Error thrown values are excluded.
- Every record now carries `schemaVersion: 1` and `omissions`.
- Supported Node.js engines are `^22.19.0 || ^24.0.0`.

## [0.2.0] - 2026-08-15

### Added

- Process health counters for captures, completion, retention, eviction,
  correlation misses, and projection failures.
- Conjunctive retained-record queries for coordinates, provider, model,
  outcome, and result limit.
- Deterministic content-free request diffs.
- Optional official `/flight` human command with Session-scoped lookup and
  bounded plain-text output.
- npm and commit-pinned GitHub installation metadata, bilingual documentation,
  and the current official Bundle patch format.

### Changed

- Ring Buffer insertion now reports eviction to the recorder health state.
- Package version and DeepSeek Harness compatibility documentation now target
  the v0.2 contract and `0.1.0-rc.6`.

## [0.1.0] - 2026-08-15

### Added

- Official Agent Loop request capture through Cordis events.
- `AbortSignal`, Agent identity, and Session ID correlation.
- Content-free request and prompt-assembly projection.
- Transparent stream observation for timing, usage, finish, failure, and
  incomplete consumption.
- Bounded 128-record in-memory Ring Buffer and read-only Service API.
- Invariant Companion registration and full automated test coverage.
