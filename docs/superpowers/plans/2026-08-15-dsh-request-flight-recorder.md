# dsh-request-flight-recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent DeepSeek Harness plugin that records bounded, content-free structural summaries of loop-built model requests and their stream outcomes.

**Architecture:** A default-exported Cordis `RequestFlightRecorder` service correlates `system-prompt/assemble`, `agent/request`, and `llm/stream` observations. Pure projection and stream-observation modules feed an in-memory bounded store; the public service exposes immutable read-only queries.

**Tech Stack:** Node.js 22.19+, TypeScript 6, ESM, pnpm 11, Vitest 4, tsdown, Cordis 4.0.1, DeepSeek Harness 0.1.0-rc.6.

---

Commit steps are intentionally excluded because no commit was requested.

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Published package metadata, exact tested DSH peers, scripts, and bundle declaration. |
| `tsconfig.json` | Strict production TypeScript compilation. |
| `tsconfig.test.json` | Test compilation over `src` and `tests`. |
| `tsdown.config.ts` | ESM runtime build for `index` and `invariant`. |
| `vitest.config.ts` | Unit and integration test discovery. |
| `src/types.ts` | Public immutable records, query types, summaries, outcomes, and branded ID. |
| `src/ring-store.ts` | Bounded retention and read-only query behavior. |
| `src/project.ts` | Content-free request and prompt-assembly projections. |
| `src/observe-stream.ts` | Transparent async iterable observation. |
| `src/index.ts` | Cordis service, event correlation, configuration, and public query API. |
| `src/invariant.ts` | Package-owned invariant companion with an explicit no-runtime-check rationale. |
| `tests/ring-store.spec.ts` | Capacity, order, filtering, and immutability. |
| `tests/project.spec.ts` | Structural projection and privacy assertions. |
| `tests/observe-stream.spec.ts` | Chunk identity, timing, finish, errors, and consumer return. |
| `tests/plugin.spec.ts` | Real Cordis waterfall correlation and lifecycle cleanup. |
| `tests/invariant.spec.ts` | Package-owned invariant companion registration lifecycle. |
| `cordis.patch.yml` | Installable DSH bundle row. |
| `README.md` | Installation, API, configuration, privacy, model experience, and limitations. |
| `LICENSE` | MIT license matching the upstream project. |

### Task 1: Scaffold the independent package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `tsdown.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `LICENSE`

- [x] **Step 1: Create package metadata**

Declare `dsh-request-flight-recorder@0.1.0`, ESM exports for `.` and `./invariant`, `dsh.bundle.patch`, Node engines, and these peers mirrored in dev dependencies:

```json
{
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
  "@deepseek-ai/dsh-invariants": "0.1.0-rc.6",
  "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
  "@deepseek-ai/dsh-session": "0.1.0-rc.6",
  "@deepseek-ai/dsh-system-prompt": "0.1.0-rc.6"
}
```

Use `@deepseek-ai/schemastery@^3.18.1` as a runtime dependency. Use TypeScript 6, Vitest 4, tsdown 0.22, and publint as development dependencies.

- [x] **Step 2: Create strict build configuration**

Production compilation includes only `src`; tests use a second no-emit configuration. Build `src/index.ts` and `src/invariant.ts` to `lib/*.mjs` with `lib/*.d.mts` declarations and no source maps.

- [x] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: dependency installation succeeds and creates `pnpm-lock.yaml`.

- [x] **Step 4: Verify the empty test harness**

Run:

```bash
pnpm exec vitest run --passWithNoTests
```

Expected: exit code 0 with no tests found.

### Task 2: Implement bounded immutable retention

**Files:**
- Create: `src/types.ts`
- Create: `tests/ring-store.spec.ts`
- Create: `src/ring-store.ts`

- [x] **Step 1: Write failing Ring Store tests**

Cover these observable behaviors:

```ts
it('evicts the oldest record when capacity is exceeded', () => {
  const store = new FlightRingStore(2)
  store.insert(record('a', 'session-a'))
  store.insert(record('b', 'session-a'))
  store.insert(record('c', 'session-b'))
  expect(store.list().map(item => item.id)).toEqual(['c', 'b'])
})

it('filters by session without changing recency order', () => {
  const store = new FlightRingStore(3)
  store.insert(record('a', 'session-a'))
  store.insert(record('b', 'session-b'))
  store.insert(record('c', 'session-a'))
  expect(store.list({ sessionId: sessionId('session-a') }).map(item => item.id)).toEqual(['c', 'a'])
})

it('returns deeply frozen records', () => {
  const store = new FlightRingStore(1)
  store.insert(record('a', 'session-a'))
  expect(Object.isFrozen(store.get(attemptId('a')))).toBe(true)
  expect(Object.isFrozen(store.get(attemptId('a'))?.request)).toBe(true)
})
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/ring-store.spec.ts
```

Expected: FAIL because `src/ring-store.ts` does not exist.

- [x] **Step 3: Implement the minimal store**

Implement:

```ts
export class FlightRingStore {
  constructor(capacity: number)
  insert(record: FlightRecord): void
  update(id: RequestAttemptId, update: (record: FlightRecord) => FlightRecord): void
  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
  clear(): void
}
```

Validate capacity in the constructor, preserve insertion order, evict from both order and lookup structures, and deep-freeze inserted and updated records.

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/ring-store.spec.ts
```

Expected: all Ring Store tests pass.

### Task 3: Implement content-free structural projections

**Files:**
- Create: `tests/project.spec.ts`
- Create: `src/project.ts`
- Modify: `src/types.ts`

- [x] **Step 1: Write failing projection tests**

Construct a real `GenerateOptions` value containing secret message text, system text, tool descriptions, schema values, and variable values. Assert:

```ts
const summary = projectRequest(options)
expect(summary.provider).toBe('deepseek')
expect(summary.messages.total).toBe(3)
expect(summary.messages.byRole).toEqual({ user: 1, assistant: 1, system: 1 })
expect(summary.tools.map(tool => tool.name)).toEqual(['read_file'])
expect(JSON.stringify(summary)).not.toContain('TOP_SECRET')
```

Construct a `PromptAssembly` and assert ordered section/context names and character counts are preserved while texts and variable values are absent.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/project.spec.ts
```

Expected: FAIL because `projectRequest` and `projectPromptAssembly` do not exist.

- [x] **Step 3: Implement minimal projections**

Implement pure functions:

```ts
export function projectRequest(options: GenerateOptions): RequestSummary
export function projectPromptAssembly(assembly: PromptAssembly): PromptAssemblySummary
```

Count roles, source kinds/forms, content-block types, system characters, and tool names. Estimate tool parameter schema size by recursively counting JSON values rather than serializing schema text. Store variable names only.

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/project.spec.ts
```

Expected: all projection and privacy tests pass.

### Task 4: Implement transparent stream observation

**Files:**
- Create: `tests/observe-stream.spec.ts`
- Create: `src/observe-stream.ts`
- Modify: `src/types.ts`

- [x] **Step 1: Write failing stream tests**

Cover:

```ts
it('yields the identical chunks in order and commits finish timing', async () => {
  const chunks = [textDelta, usage, finish] as const
  const seen: FlightStreamObservation[] = []
  const result = await collect(observeStream(source(chunks), observation => seen.push(observation), clock))
  expect(result[0]).toBe(textDelta)
  expect(result[1]).toBe(usage)
  expect(result[2]).toBe(finish)
  expect(seen.at(-1)?.kind).toBe('finished')
})

it('rethrows the identical downstream error', async () => {
  const error = new Error('downstream failed')
  await expect(collect(observeStream(throwingSource(error), sink, clock))).rejects.toBe(error)
})

it('records consumer return without claiming provider finish', async () => {
  const iterator = observeStream(endlessSource(), sink, clock)[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  expect(lastObservation()).toEqual(expect.objectContaining({
    kind: 'incomplete',
    reason: 'consumer-returned',
  }))
})
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/observe-stream.spec.ts
```

Expected: FAIL because `observeStream` does not exist.

- [x] **Step 3: Implement the minimal observer**

Implement:

```ts
export function observeStream(
  stream: AsyncIterable<StreamChunk>,
  observe: (event: FlightStreamObservation) => void,
  now: () => number = performance.now.bind(performance),
): AsyncIterable<StreamChunk>
```

Use a custom async iterator so `next`, `return`, and `throw` are forwarded explicitly. Observe chunk facts after downstream resolution and before returning the same chunk object. Contain observer callback failures, but never contain downstream iterator failures.

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/observe-stream.spec.ts
```

Expected: all stream tests pass.

### Task 5: Implement the Cordis recorder service

**Files:**
- Create: `tests/plugin.spec.ts`
- Create: `src/index.ts`
- Modify: `src/types.ts`

- [x] **Step 1: Write failing integration tests**

Compose real Cordis services from published packages and mount `RequestFlightRecorder`. Verify:

- `system-prompt/assemble` calls downstream and captures the returned assembly.
- `agent/request` calls downstream and captures exact turn/step coordinates.
- A marked loop request through `llm/stream` reaches downstream with the identical `GenerateOptions`.
- Stream chunks preserve identity and produce one completed record.
- Mismatched signal, Agent, or Session creates no record.
- Direct non-loop LLM calls create no record.
- Disposing the plugin fiber clears records and removes listeners.
- A capture projection failure does not block downstream dispatch.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/plugin.spec.ts
```

Expected: FAIL because the default service export does not exist.

- [x] **Step 3: Implement the service**

Implement a default-exported service with:

```ts
export default class RequestFlightRecorder extends Service {
  static inject = ['llm', 'agents', 'systemPrompt']
  static Config = Schema.object({
    capacity: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(128),
  })

  list(query?: FlightRecordQuery): readonly FlightRecord[]
  get(id: RequestAttemptId): FlightRecord | undefined
  latest(sessionId?: SessionId): FlightRecord | undefined
}
```

Use `WeakMap<AbortSignal, PromptAssemblySummary>` and `WeakMap<AbortSignal, PendingRequest>`. Require loop marker, signal, initiating Agent identity, and Session identity before recording. Register every waterfall listener through `ctx.on`; use an effect-owned disposed flag and clear all retained state during teardown.

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/plugin.spec.ts
```

Expected: all service integration and lifecycle tests pass.

- [x] **Step 5: Run the complete focused suite**

Run:

```bash
pnpm test
```

Expected: all four test files pass with no warnings.

### Task 6: Add invariant companion, bundle, docs, and release checks

**Files:**
- Create: `src/invariant.ts`
- Create: `tests/invariant.spec.ts`
- Create: `cordis.patch.yml`
- Create: `README.md`
- Modify: `package.json`

- [x] **Step 1: Write a failing invariant companion test in `tests/invariant.spec.ts`**

Mount the real invariant registry, register this package's companion, verify the package name is reserved, dispose the registration, and verify it can be registered again. The companion installs no runtime check because bounded retention has no independent authoritative event stream.

- [x] **Step 2: Run the invariant test and verify RED**

Run:

```bash
pnpm exec vitest run tests/invariant.spec.ts
```

Expected: FAIL because `src/invariant.ts` does not exist.

- [x] **Step 3: Implement invariant companion and bundle**

Register package ownership as `dsh-request-flight-recorder` with a no-op installer and a contract comment explaining why no independent runtime relationship exists. Add a bundle patch that mounts the default export with `capacity: 128`.

- [x] **Step 4: Document exact behavior**

README sections:

- Installation and `cordis.patch.yml`
- Configuration
- Same-process service API
- Evidence levels
- Privacy and performance
- Model Experience: no direct model-visible effect and no KV-cache effect
- Known limitations: memory-only, no UI, no persistence, no package-owner attribution

- [x] **Step 5: Run complete verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm exec publint
pnpm pack --pack-destination .artifacts
```

Expected: all commands succeed; the tarball contains `lib/*.mjs`, `lib/*.d.mts`, README, LICENSE, package metadata, and `cordis.patch.yml`, with no source files or tests.

- [x] **Step 6: Review final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only the approved repository files are present, no whitespace errors, no generated residue outside `.artifacts`, and no credentials.
