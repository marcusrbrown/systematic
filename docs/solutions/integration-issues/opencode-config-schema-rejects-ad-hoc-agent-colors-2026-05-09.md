---
title: OpenCode /config HttpApi rejects ad-hoc bundled agent color names, crashing TUI launch
date: 2026-05-09
category: docs/solutions/integration-issues/
module: agent-bundle
problem_type: integration_issue
component: tooling
symptoms:
  - "TUI launch fails with: opencode server GET .../config?directory=... -> 400: (empty response body)"
  - "OpenCode log shows HttpApiSchemaError: Body Expected '#[0-9a-fA-F]{6}', got 'purple'"
  - "Error path is ['agent']['<bundled-agent-name>']['color']"
  - "Plugin config hook runs successfully but the resulting /config response fails server-side schema validation"
  - "Empty response body — TUI sees only HTTP 400 with no diagnostic detail"
root_cause: missing_validation
resolution_type: code_fix
severity: critical
related_components:
  - tooling
  - documentation
tags: [opencode, plugin, agent-config, schema-validation, color, http-400, regression]
---

# OpenCode /config HttpApi rejects ad-hoc bundled agent color names, crashing TUI launch

## Problem

OpenCode added strict Effect Schema validation on `GET /config` response
bodies. Any bundled agent emitted with a `color` value outside the new schema
causes the entire `/config` endpoint to return HTTP 400 with an empty body,
which crashes TUI launch. Systematic was emitting `color: purple`, `color:
blue`, `color: yellow`, `color: cyan`, `color: violet`, and `color: red` across
24 of 50 bundled agents — every one would crash a launch on a recent OpenCode
version.

## Symptoms

User-visible:

```
Error: opencode server GET http://opencode.internal/config?directory=...
       → 400: (empty response body)
```

OpenCode log (`~/.local/share/opencode/log/<timestamp>.log`):

```
HttpApiSchemaError: Body
Expected "#[0-9a-fA-F]{6}", got "purple"
Expected "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info", got "purple"
at ["agent"]["figma-design-sync"]["color"]
```

The empty response body is the worst part — the TUI surfaces only the HTTP
400, with no path or schema-error detail. Diagnosis requires reading the
OpenCode log directly.

## What Didn't Work

- **Suspecting the plugin singleton** (PR #335 work). The duplicate-call
  `return {}` regression was real and worth fixing, but it caused missing
  skills/slash commands after `/preset`, not the `/config` HTTP 400. Diagnosis
  initially conflated the two.
- **Suspecting `~/.config/opencode/systematic.json`.** The Systematic
  user-level config was syntactically valid and not required to trigger the
  crash. The problem reproduced with an empty user config.
- **Suspecting the local file plugin path itself.** `plugin: ["./src/index.ts"]`
  is not inherently the cause — once OpenCode logs were inspected, the schema
  error path made the real culprit obvious.
- **Inferring from the empty response body alone.** The body carries no
  diagnostic. Without the OpenCode log, this looks like a generic plugin
  load failure.

## Solution

Two-layer fix:

1. **Source cleanup**: rename ad-hoc colors in 24 bundled agent frontmatter
   files to OpenCode-valid theme tokens. Mapping applied:

   | From            | To       | Rationale                         |
   | --------------- | -------- | --------------------------------- |
   | `blue` (16x)    | `info`   | informational/cool                |
   | `cyan` (2x)     | `info`   | merges with blue                  |
   | `yellow` (3x)   | `warning`| semantic match                    |
   | `violet` (1x)   | `accent` | accent fits                       |
   | `purple` (1x)   | `accent` | reported crash agent              |
   | `red` (1x)      | `error`  | adversarial-reviewer, semantic    |

2. **Content-integrity gate** at `scripts/content-integrity.ts`: new
   `checkAgentColors` rule scans every `agents/**/*.md` file's `color:`
   frontmatter and asserts the value matches OpenCode's schema (`#RRGGBB` hex,
   or one of `primary | secondary | accent | success | warning | error |
   info`). Runs in CI on every PR. Mirrors the existing `checkAgentModel` rule
   that bans `model:` fields on bundled agents.

3. **Integration regression** in `tests/integration/opencode.test.ts`: runs
   the plugin config hook against an empty config and asserts every emitted
   `agent[*].color` matches the schema. Catches future drift before CI.

## Why This Works

OpenCode's `AgentConfig.color` field uses an Effect Schema union of
`#[0-9a-fA-F]{6}` regex and a literal-token enum. Anything else the plugin
emits gets rejected when the API serves `/config`. The HttpApi response
validator was added in OpenCode `96a534d8c` (PR #23712), and the strict
color schema was added in `2793502db` (PR #23237). Before those commits the
client ignored the field and the bug was latent.

By cleaning the source and enforcing both at gate time and runtime, drift
cannot recur silently — adding a new agent with `color: green` would fail the
content-integrity gate before merge, and a runtime emission with the wrong
shape would fail the integration test.

## Prevention

- **Content-integrity gate.** `scripts/content-integrity.ts:checkAgentColors`
  is now CI-blocking. Any new bundled agent with a non-schema `color` value
  fails the build.
- **Integration regression test.** `tests/integration/opencode.test.ts`
  contains an `every emitted bundled-agent color matches OpenCode /config
  schema` test that exercises the real plugin config hook, not just helper
  functions.
- **Treat plugin output as schema-validated.** OpenCode is moving toward
  Effect Schema validation across all surfaces. When adding any new bundled
  config field — `mode`, `temperature`, `top_p`, etc. — verify the upstream
  schema before emitting and add an integration assertion.
- **Read OpenCode logs first when the TUI returns HTTP 400 with empty body.**
  The 400 carries no body; the log carries the path and schema error. Default
  log location: `~/.local/share/opencode/log/<timestamp>.log`.
- **Pin the upstream remote.** Systematic research targets `anomalyco/opencode`,
  not `sst/opencode`. Verifying schemas against the wrong fork wastes time.

## Related Issues

- PR #346 (squash 7e4cb92) — the fix
- PR #335 (idempotent plugin registration) — separate regression conflated
  with this during initial diagnosis
- OpenCode commit `2793502db` / PR #23237 — introduced restricted
  `AgentConfig.color` Effect Schema
- OpenCode commit `96a534d8c` / PR #23712 — bridged `GET /config` through
  HttpApi response validation; this is what made the bug visible
- Memory `#2615` — captures the schema reference for future bundled-agent
  additions
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`
  — sibling regression discovered in the same diagnostic session
