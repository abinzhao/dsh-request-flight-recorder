# Privacy Threat Model

The recorder is an observability plugin in the same Node.js process as other
DeepSeek Harness plugins. It reduces retained content but is not a security
boundary against code running in that process.

## Retained allowlist

The recorder may retain:

- request identity, Session ID, Turn, Step, and attempt coordinates;
- provider and model identifiers;
- selected scalar generation settings;
- structural names for tools, prompt sections, contexts, and variables;
- structural counts, schema node counts, timing, token usage, and finish kind;
- finite error categories and omission counters.

Structural names and model identifiers may still be sensitive. Treat snapshots
and command output as internal diagnostics.

## Excluded content

No retained record contains a raw error message.

The recorder does not retain prompt text, message content, tool descriptions,
tool arguments, tool results, prompt variable values, credentials, raw provider
responses, or arbitrary thrown values.

A failed request stores only a finite error kind. It does not store an error
message, stack, cause, custom Error name, or non-Error thrown value.
Non-Error values map to `non-error-thrown`; unknown Error names map to `error`.
The original downstream exception still propagates by object identity.

## Commands and consumers

The optional `/flight` command uses `recordInput: false`, so command arguments
are not copied into the command-run record. Its result text may be persisted by
the active Commands, Session, or history plugin. `/flight list` exposes fewer
fields than full record rendering, but output must still be handled as internal
diagnostic data.

Reader consumers run with process-local access. Subscription callbacks receive
only a revision invalidation and must call `snapshot()` to read current state.
The recorder itself does not write records to disk or send them over a network.

## Language preference

The minimal Web Client Half may persist the standard Host
`locale.preference` when no explicit preference exists. This language code is
separate from process-local diagnostics. The Client Half cannot access Sessions
or flight records, and it does not import the Host recorder implementation.
An explicit preference is preserved.

## Resource controls

The Ring Buffer defaults to 128 records. Every structural collection and tool
schema traversal has a hard bound published through `FLIGHT_LIMITS`. Omission
counters make truncation visible without retaining omitted content.

Service disposal clears records, pending correlation state, counters, and
listeners. This does not erase copies already persisted by another plugin.

## Reporting

Security reports must use placeholders. Do not attach credentials, private
prompts, message bodies, raw provider responses, or unredacted logs.
