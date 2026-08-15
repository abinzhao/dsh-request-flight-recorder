# Compatibility

Version 1.1.0 is built and tested against the following exact extension
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
Consumer, Profile, and browser-locale gates run once on Node 22.19.0.

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

## Automated gates

The exact declared RC is blocking. CI compiles and tests on Node 22.19 and 24,
then packs the artifact and runs two Node 22.19 distribution checks:

```sh
pnpm smoke:packed .artifacts/dsh-request-flight-recorder-1.1.0.tgz
pnpm verify:dsh-profile .artifacts/dsh-request-flight-recorder-1.1.0.tgz
pnpm verify:dsh-locale .artifacts/dsh-request-flight-recorder-1.1.0.tgz
```

The Profile gate installs the tarball through the exact public DSH CLI in an
isolated `DSH_HOME`, verifies one composed Bundle row, boots Web on an
ephemeral port, requires HTTP 200, terminates the real CLI with `SIGTERM`, and
removes its generated Home and CLI installation.

The locale gate opens three isolated Web profiles in Chromium and verifies
English initialization, Chinese initialization, and explicit-preference
preservation. It removes browser contexts and every temporary `DSH_HOME`.

The daily `latest` and `next` check is observational. Each new RC is tested in
a temporary repository copy:

```sh
pnpm verify:dsh-candidate 0.1.0-rc.6
```

The candidate gate reports the first failed layer as `install`, `test`,
`typecheck`, `build`, `publint`, `pack`, or `smoke`. Together with the Profile
and real request checks, compatibility evidence is grouped as install,
typecheck, compose, boot, Agent Loop, command, privacy, and cleanup. A passing
observation does not edit package metadata, create a commit, widen a Peer
range, or publish a release.

## Installation surfaces

The package Bundle patch inserts `dsh-request-flight-recorder` with capacity
128. The supported installation paths are npm package name, immutable GitHub
commit, local checkout, and local tarball through `dsh plugin --profile`.

The package also exports
`dsh-request-flight-recorder/invariant` for official invariant ownership
registration.
