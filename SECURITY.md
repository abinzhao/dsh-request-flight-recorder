# Security Policy

## Supported versions

Security fixes are prepared for the current `1.x` line. Older development
versions are not supported.

## Private reporting

Do not open a public issue for a suspected vulnerability. Report it privately
through GitHub Security Advisories:

https://github.com/abinzhao/dsh-request-flight-recorder/security/advisories/new

Include the affected version, expected impact, and the smallest safe
reproduction. Do not include credentials, API keys, tokens, private prompts,
message bodies, raw provider responses, or unredacted logs. Use placeholders
and remove unrelated data.

No response-time or disclosure deadline is promised before the repository has
a published security support process. Coordinate public disclosure through the
private advisory.

## Diagnostic data boundary

The recorder intentionally excludes prompt text, message content, tool
arguments, tool results, prompt variable values, raw error messages, stacks,
causes, custom Error names, and non-Error thrown values. Structural names,
counts, timings, model identifiers, Session identifiers, and command result
text can still be sensitive. Other DeepSeek Harness profile services may
persist command output. Review and redact diagnostics before sharing them.
