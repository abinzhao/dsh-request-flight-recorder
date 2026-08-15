# Contributing

Contributions should remain narrowly scoped to content-free request
diagnostics for the official DeepSeek Harness runtime. Do not change Agent Loop
or Prompt semantics, add persistence by default, or collect message bodies,
tool arguments, results, credentials, or Prompt variable values.

## Setup

Use Node.js `^22.19.0 || ^24.0.0` and the pnpm version declared in
`package.json`.

```sh
pnpm install
```

## Development workflow

Use test-driven development for behavior changes:

1. Add one focused test and run it to capture the expected RED failure.
2. Implement the smallest change that produces GREEN.
3. Refactor only while the focused and existing tests remain GREEN.

Keep changes surgical. Reuse existing Cordis lifecycle, immutable data, error
handling, and privacy patterns. Avoid unrelated formatting or refactoring.

## Verification

Run the focused test first, then the complete gate:

```sh
pnpm check
```

`pnpm check` requires 100% production coverage, TypeScript validation, a fresh
build, and `publint`. Before submitting a change, also regenerate the committed
distribution output:

```sh
pnpm build
```

Include any resulting `lib/` changes when source behavior or public types
change. Do not edit `lib/` manually.

For release-facing changes, also run:

```sh
pnpm exec vitest run tests/soak.spec.ts
pnpm bench
pnpm pack --pack-destination .artifacts
node scripts/smoke-packed.mjs .artifacts/dsh-request-flight-recorder-1.0.0.tgz
```

Review changes to `FlightRecorderReader`, protocol/schema constants, records,
health, limits, or root exports as SemVer-sensitive public API changes. Test the
declared Node 22.19 and Node 24 matrix before widening compatibility. Benchmark
baseline changes must include the raw environment and Median/P95 evidence.

## Pull requests

- Explain the user-visible behavior and privacy impact.
- Include RED and GREEN command evidence for behavior changes.
- Keep documentation and tests aligned with the implementation.
- Describe public API, schema, compatibility, Soak, and benchmark impact.
- Confirm that no secrets, credentials, raw prompts, message content, tool
  arguments, debug output, or unrelated files are included.
- Do not combine a feature with unrelated dependency or architecture changes.
