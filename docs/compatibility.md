# Compatibility

Version 1.0.0 is built and tested against the following exact extension
boundary:

| Component | Supported |
|---|---|
| Node.js | `^22.19.0 || ^24.0.0` |
| pnpm | `11.7.0` for repository workflows |
| DeepSeek Harness packages | `0.1.0-rc.6` |
| Cordis | `^4.0.1` |
| Schemastery | `^3.18.1` |
| Package format | ESM |

CI is configured for Node 22.19.0 and Node 24. Complete tests, type checking,
build-drift verification, and `publint` run on both. Packing and the Fresh
Consumer smoke test run once on Node 22.19.0.

The current local release-candidate evidence was produced on Node 22.22.0.
Remote CI success is not claimed until a repository workflow actually runs.

DeepSeek Harness versions other than `0.1.0-rc.6` are unsupported because their
Cordis events, Agent Loop marker, payloads, or service contracts have not passed
this repository's compatibility matrix. Do not widen peer ranges without:

1. compiling against the proposed version;
2. running all tests and 100% coverage;
3. building and checking committed output;
4. packing and loading a fresh consumer;
5. installing through the official DSH plugin command and dumping the profile.

## Installation surfaces

The package Bundle patch inserts `dsh-request-flight-recorder` with capacity
128. The supported installation paths are npm package name, immutable GitHub
commit, local checkout, and local tarball through `dsh plugin --profile`.

The package also exports
`dsh-request-flight-recorder/invariant` for official invariant ownership
registration.
