# Benchmarks

Run the release-evidence benchmark with:

```sh
pnpm bench
```

The command is intentionally separate from `pnpm check`. It has no absolute
timing assertion and therefore does not make normal CI dependent on host speed.

## Baseline environment

- Date: 2026-08-16
- Node.js: 22.22.0
- pnpm: 11.7.0
- Vitest: 4.1.10
- Architecture: arm64
- CPU: Apple M3 Pro

## Projection fixtures

| Fixture | Shape |
|---|---|
| Small | no tools |
| Standard | 16 tools with one simple property each |
| Limit-sized | 128 tools, matching `FLIGHT_LIMITS.tools` |

The explicit percentile pass uses warmed `performance.now()` samples. The same
run also executes Vitest/Tinybench throughput measurements.

| Fixture | Samples | Median | P95 |
|---|---:|---:|---:|
| Small | 20,000 | 0.000125 ms | 0.000625 ms |
| Standard | 5,000 | 0.003666 ms | 0.005583 ms |
| Limit-sized | 1,000 | 0.027292 ms | 0.028833 ms |

These numbers are the actual contents of `.artifacts/benchmark-v1.txt` from the
baseline run. They are not a cross-machine performance guarantee.

## Soak evidence

`tests/soak.spec.ts` performs 10,000 deterministic insert-and-settle operations
without provider credentials. Capacity remains 128, 9,872 older records are
evicted, active returns to zero, revision remains a safe integer, structural
collections remain within `FLIGHT_LIMITS`, and seeded secret text is absent from
the final snapshot.

## Baseline updates

Before release, compare Median and P95 on the same supported Node baseline.
Investigate a regression greater than 20 percent. If the change is expected,
record the implementation reason, environment, new raw output, and reviewed
baseline in the same change. Never copy numbers from another machine or invent
missing results.
