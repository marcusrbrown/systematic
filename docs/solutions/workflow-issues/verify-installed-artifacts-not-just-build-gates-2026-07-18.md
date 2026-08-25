---
title: Verify installed artifacts, not just build gates
date: 2026-07-18
last_updated: 2026-08-24
category: workflow-issues
module: claude-code-harness
problem_type: workflow_issue
component: development_workflow
severity: medium
tags:
  - verification
  - installed-artifact
  - build-gates
  - claude-code
  - empirical-probing
  - generated-output
applies_when:
  - A build or codegen step emits an artifact consumed in a different context than the source repo
  - A design rests on unverified external runtime/host behavior
  - Mechanical gates (build, drift, tests, typecheck) pass but correctness-in-situ is unconfirmed
---

# Verify installed artifacts, not just build gates

## Context

The first Claude Code plugin implementation passed every mechanical gate — build, drift check, tests, typecheck, lint, and a full code review all green — yet the generated bundle shipped three defects that only surfaced when the artifact was read as it would appear installed:

- a **fake version** (`0.0.1`) hardcoded as a fallback because `package.json` is a `0.0.0-semantic-release` placeholder that can never yield a real version at build time;
- a **dangling repo-relative link** — `Evidence registry: see [HARNESSES.md](../../../HARNESSES.md)` — inlined verbatim from a source profile into the shipped output-style, where `HARNESSES.md` doesn't exist and `../../../` escapes the plugin root;
- **wrong catalog identifiers** — the output-style listed skills as `ce:brainstorm` / `systematic:agent-browser` (source namespace) when Claude Code exposes them as `systematic:ce-brainstorm` (`plugin:dir-name`).

Every one passed CI. The user caught all three by reading the generated file.

## Guidance

**Mechanical gates validate the pipeline, not the artifact in situ.** Build/drift/tests/typecheck confirm the build ran and matches itself — they say nothing about whether the emitted artifact is *correct once installed in its target context*. For any codegen or build that produces an artifact consumed elsewhere (an installed plugin, a published bundle, a rendered doc), verification must **read or execute the emitted artifact as it appears in that target context**, not merely confirm the build succeeded.

Concretely, for a generated/published artifact:

- Read the actual generated file end-to-end and check for **context-coupled content** that is valid in the repo but broken once relocated: absolute paths, repo-relative links, source-namespace identifiers, and values that can't be produced truthfully at build time (placeholder versions).
- **Execute** the artifact where feasible (e.g., run the hook command to confirm shell escaping produces the intended text), rather than eyeballing it.
- Add gates that model the *target* contract: an integrity check over the generated namespace, not just a build-succeeds check.

**Probe unproven runtime channels empirically before designing around them.** Don't assume a host honors a mechanism. In this arc, probing the real Claude Desktop revealed that **imperative `SessionStart` hook content is refused as prompt injection**, while **declarative facts and the plugin output-style are honored** — which directly shaped the design (declarative hook, output-style enforcement). Verify the channel behaves as assumed before building on it.

A probe that comes back positive has not finished the job. It shows the capability is reachable; it does not show what made it reachable, and an ambient cause looks identical to the one you intended. See [A capability that works has not yet named its cause](./a-capability-that-works-has-not-named-its-cause-2026-08-24.md) for the negative control that separates them — and for what it cost when this rule was available here and went unconsulted.

**Close the class with a source-side gate where you can.** The arc also added a lexical skill-reference integrity check (`checkSkillReferenceIntegrity`, `SKILL_REF_REGEX = /\bce:([a-z0-9-]+)\b/g`) that fails when a `ce:<name>` reference has no matching `skills/ce-<name>/` directory — catching phantom references (`ce:debug`, `ce:polish-beta`) that had dangled on every harness.

## Why This Matters

Context-coupled content passes every gate and still ships broken. A green pipeline is a necessary but wildly insufficient signal for artifact correctness when the artifact lives somewhere other than the repo. Treating "gates pass" as "artifact is correct" is how a fake version, a dead link, and wrong identifiers all shipped past a full review.

## When to Apply

- Any build/codegen that emits an artifact consumed in a different context than the source repo (installed plugins, published bundles, generated docs, marketplace artifacts).
- Any design that rests on unverified host/runtime behavior — probe the real host first.
- Whenever you're tempted to conclude "CI is green, so it's correct" for a generated output.

## Examples

Context-coupled defects that passed all gates:

```
# fake version — package.json is a semantic-release placeholder
manifest.version = "0.1.0"   # fix: omit version; version by source commit SHA

# dangling repo-relative link inlined into the shipped output-style
Evidence registry: see [HARNESSES.md](../../../HARNESSES.md)   # fix: strip from shipped profile

# wrong catalog identifiers (source namespace, not the host's)
<name>ce:brainstorm</name>   # host exposes systematic:ce-brainstorm; fix: drop the catalog / translate
```

Empirical channel finding that shaped the design: imperative hook content refused as prompt injection; declarative facts + output-style honored — verified in the real host before committing to the enforcement model.

## Related

- [A capability that works has not yet named its cause](./a-capability-that-works-has-not-named-its-cause-2026-08-24.md) — extends the probe rule above with mechanism isolation: removing the suspected cause to prove it was the cause.
- [Pi real-runtime integration harness](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md) — verify a packaged extension in the *real* host runtime, not against a fake SDK; same "installed artifact ≠ build output" spine.
- [Cross-harness adapter parity contract tests](../best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md) — don't mistake boundary/helper tests for runtime proof.
- [Pi chained bootstrap composition](../logic-errors/pi-chained-bootstrap-composition-2026-07-14.md) — host-specific prompt composition; the imperative-vs-declarative channel distinction.
- [content-integrity should mirror runtime drop rules](../best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md) — gates should model the runtime contract they protect.
- [OpenCode plugin hook silent-defect swallow](../integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md) — probe the real host; don't trust silent success.
- [Build and publish a harness plugin from CI](../best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md) — the packaging pattern from the same arc.
