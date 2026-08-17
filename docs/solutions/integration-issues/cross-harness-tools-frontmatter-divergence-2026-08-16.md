---
title: The same tools frontmatter is permissive on OpenCode and restrictive on Pi
date: 2026-08-16
category: integration-issues
module: agent-resolution
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Bundled agents declaring `tools:` receive no tool restriction on OpenCode"
  - "The same agents cannot write files on Pi"
  - "A skill instruction to write an artifact is unsatisfiable on one harness but succeeds on the other"
root_cause: wrong_api
resolution_type: workflow_improvement
related_components:
  - opencode
  - pi
tags:
  - cross-harness
  - tool-permissions
  - agent-frontmatter
  - agent-resolver
  - least-privilege
---

# The same tools frontmatter is permissive on OpenCode and restrictive on Pi

## Problem

Bundled agents declare tools as a comma-separated string:

```yaml
tools: Read, Grep, Glob, Bash
```

OpenCode and Pi parse that identical line into opposite outcomes. OpenCode discards it and applies no restriction. Pi reads it as a least-privilege allowlist. One declaration, two contradictory meanings, no error on either side.

## Symptoms

- `src/lib/agents.ts:30` types `tools` as `Record<string, boolean>`.
- `isToolsMap()` rejects any non-object value, so the string form fails the guard and `src/lib/agents.ts:80` assigns `undefined`. An undefined `tools` means no restriction.
- `src/lib/agent-resolver.ts:151-158` maps `Read`, `Grep`, `Glob`, and `Bash` to Pi's `read`, `grep`, `find`, and `bash`.
- `resolveToolAllowlist` fails closed on anything unrecognized (`src/lib/agent-resolver.ts:174-199`).

Every persona under `agents/review/` declares the string form. All of them are unrestricted on OpenCode and write-incapable on Pi.

## What Didn't Work

Two designs died on this before the cause was understood.

**Trusting the declaration as written.** The frontmatter reads like a least-privilege grant, so it was assumed to be enforced everywhere. On OpenCode it enforces nothing, and nothing surfaces that.

**Adding a validating tool for sub-agents to call.** The `ce:review` workflow needed non-conforming artifacts rejected at the write boundary, and a registered plugin tool looked like the answer. It cannot work on either harness:

- On Pi, `resolveToolAllowlist` throws `UnknownDeclaredToolError` at catalog-build time for any tool outside the fixed built-in table. A custom tool never becomes callable.
- On OpenCode, a registered tool can be *offered* but not *required*. Nothing prevents a sub-agent from writing directly instead.

The workflow had also been instructing personas to write their own artifacts, calling it "the ONE write operation you are permitted to make." On Pi that instruction was unsatisfiable from the start — those runs could never produce artifacts at all.

## Solution

Delete the sub-agent write path rather than guarding it. Sub-agents return structured data inline; the parent orchestrator validates and persists.

```text
Sub-agent:  inspect → return JSON inline → never touch disk
Parent:     validate → annotate provenance → persist
```

This needs no tool registration, so it behaves identically on OpenCode, Pi, and Claude Code — including Claude Code, which has no plugin runtime at all.

## Why This Works

The bypass is removed by construction instead of being policed. A sub-agent with no write instruction and no write path cannot produce a non-conforming artifact, regardless of what its `tools:` declaration means on the current harness.

It also sidesteps the divergence rather than depending on it. Any design that relies on `tools:` meaning the same thing across harnesses is building on a contradiction.

## Prevention

- Do not treat `tools:` frontmatter as an enforced grant on OpenCode. Verify the parsed value is a boolean map before assuming any restriction applies.
- When a workflow requires a capability, confirm every target harness can actually provide it. Check `OPENCODE_TO_PI_TOOL` in `src/lib/agent-resolver.ts` before assuming a tool is reachable on Pi.
- Prefer designs where the orchestrator holds the capability. The parent has one well-understood permission set; sub-agents have as many as there are harnesses.
- Treat "this instruction is unsatisfiable on one harness" as a contract bug, not a runtime edge case. It produces silence, not errors.

## Related

- [`docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`](../best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md) — earlier evidence of `tools:` being silently dropped, in the converter path rather than the resolver.
- [`docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md`](../best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md) — why shared-core tests do not prove adapter parity.
- [`docs/solutions/workflow-issues/subagent-skill-permission-scoping-2026-05-20.md`](../workflow-issues/subagent-skill-permission-scoping-2026-05-20.md) — related but distinct: per-agent *skill* permissions, not `tools:` parsing.
- Issue #784 — persona agents dispatched as generic sub-agents, losing per-agent model tiering.
