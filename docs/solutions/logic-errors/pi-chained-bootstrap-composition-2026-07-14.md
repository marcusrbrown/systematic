---
title: Preserve foreign content when composing a chained bootstrap prompt
date: 2026-07-14
category: logic-errors
module: pi-harness-bootstrap
problem_type: logic_error
component: tooling
symptoms:
  - Earlier extension text containing a Systematic marker example is silently deleted
  - The Pi prompt tells agents to call an OpenCode-only skill tool
  - Bootstrap loading failure disables injection without an operator-visible diagnostic
root_cause: logic_error
resolution_type: code_fix
severity: medium
last_updated: 2026-07-17
tags: [pi-harness, bootstrap-injection, prompt-composition, idempotency, adapter-parity, graceful-degradation, capability-profiles]
---

# Preserve foreign content when composing a chained bootstrap prompt

## Problem

Pi's `before_agent_start` hook receives one system-prompt string containing contributions from earlier extensions. Reusing OpenCode's marker-scrubbing mutator against that string treated foreign text as Systematic-owned content, while also carrying OpenCode-specific tool instructions and silent failure behavior into Pi.

## Symptoms

- An earlier contribution containing a literal `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>` example disappears.
- The injected prompt tells Pi agents to use a generic `skill` tool that Pi does not register; Pi exposes skills through its native prompt/read workflow instead.
- Unreadable or malformed bootstrap content can disable injection without telling the operator why.

## What Didn't Work

The first composition helper wrapped Pi's chained string in a synthetic OpenCode-shaped array and called `applyBootstrapContent`:

```typescript
const output = { system: [existingSystemPrompt] }
applyBootstrapContent(output, bootstrapContent)
return output.system[0]
```

`applyBootstrapContent` removes every complete Systematic marker block before appending the current snapshot. That is useful for reconciling Systematic's prior OpenCode registrations, but it is too broad for a string that already contains arbitrary text from other Pi extensions.

## Solution

### Deduplicate only the exact owned snapshot

Pi composition now compares against the bootstrap content computed by this extension. It never scans or removes marker-shaped text from earlier contributions:

```typescript
export function composeSystemPromptWithBootstrap(
  existingSystemPrompt: string,
  bootstrapContent: string | null,
): string | null {
  if (bootstrapContent === null) return null

  if (
    existingSystemPrompt === bootstrapContent ||
    existingSystemPrompt.endsWith(`\n\n${bootstrapContent}`)
  ) {
    return existingSystemPrompt
  }

  return existingSystemPrompt.length > 0
    ? `${existingSystemPrompt}\n\n${bootstrapContent}`
    : bootstrapContent
}
```

OpenCode continues using `applyBootstrapContent`; the adapters intentionally use different composition strategies because their host ownership models differ.

### Inject harness-specific usage text

`BootstrapDeps` accepts an optional `usageTemplate`. OpenCode omits it and retains the existing bytes; Pi supplies instructions matching Pi's native skill workflow:

```typescript
const PI_BOOTSTRAP_USAGE_TEMPLATE = `**Skills usage:**
- Use \`systematic_skill\` for Systematic skills.
- For non-Systematic skills, follow Pi's native skill instructions and read the listed SKILL.md path.`
```

This keeps the shared bootstrap loader while moving harness vocabulary to the adapter that owns it.

### Separate safe computation from diagnostics

`computeBootstrapContentSafe` returns `null` when bootstrap computation fails and accepts a best-effort reporter for thrown errors. Reporter failure is also caught, so diagnostics cannot turn graceful degradation into startup failure. Pi writes one constant line to stderr for thrown computation failures rather than putting operator-facing errors into the model's prompt.

The Pi handler translates `null` to `undefined`:

```typescript
pi.on('before_agent_start', (event) => {
  const systemPrompt = composeSystemPromptWithBootstrap(
    event.systemPrompt,
    bootstrapContent,
  )
  if (systemPrompt === null) return undefined
  return { systemPrompt }
})
```

Pi only replaces the current prompt when a handler result includes `systemPrompt`; returning `undefined` leaves the prompt produced by earlier handlers unchanged.

## Why This Works

A sentinel pattern identifies syntax, not authorship; foreign content can legitimately contain the same bytes. Exact comparison against the adapter's own snapshot provides idempotency without claiming ownership of the rest of the chain. Injected harness vocabulary keeps shared content loading without pretending host tools are portable, while the guarded reporter separates operator diagnostics from agent instructions.

## Prevention

- Derive idempotency from the host's composition and ownership model before reusing a mutator from another adapter.
- Preserve an earlier marker example byte-for-byte in a regression test.
- Assert idempotency at the composition-helper level, and add a real registered-handler double-run test if handler-level chaining semantics change.
- Assert Pi output contains Pi-native skill instructions and excludes OpenCode-only tool language.
- Force bootstrap loading to throw; assert one stderr diagnostic and successful extension registration.
- Keep OpenCode bootstrap output pinned so Pi dependency injection cannot drift its default text.

## Pattern extension (2026-07-17): capability-profile inlining via BootstrapDeps

The harness-portability increment (PR #653, v3.1.0) widened the same seam this
doc established. `BootstrapDeps` now carries an optional `profileBlock`
alongside `usageTemplate`; `getBootstrapContent` appends it inside the
`<SYSTEMATIC_WORKFLOWS>` zone in fixed order: usage template → profile block →
skill catalog (`src/lib/bootstrap.ts:108-239`).

- Harness capability profiles are plain markdown under
  `skills/using-systematic/references/{opencode,pi}-profile.md`, read by
  `readHarnessProfile(dir, name)` (`src/lib/bootstrap.ts:114-131`).
- Per-harness population at the entry points: OpenCode passes
  `readHarnessProfile(..., 'opencode')` (`src/index.ts:40-43`); Pi passes the
  `'pi'` profile through `computeBootstrapContentSafe` (`src/pi.ts:63-70`).
- The seam is nullable and fail-soft: any read failure emits one stderr
  diagnostic and returns `null`, so the bootstrap composes without the profile
  rather than crashing plugin load — the diagnostic requirement from this
  doc's Prevention list, applied at the narrower profile scope.
- Regression guards extend this doc's list: a production-shaped snapshot pin
  (profile inlined), double-run idempotency for profile injection, and a
  sentinel-collision guard asserting neither real profile contains the
  bootstrap markers (`tests/unit/bootstrap.test.ts:449-516`).

When adding a new harness or new per-harness prose, extend `BootstrapDeps`
with optional, nullable fields consumed inside the existing sentinel zone —
do not fork the bootstrap or compose outside the markers. The neutral skill
prose this layer serves is enforced by content-integrity check #13 (see
[neutral-v1 marker + migrated-set identifier gate](../best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md)).

## Related Issues

- [Cross-harness adapter parity contract tests](../best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md)
- [Test packaged harness extensions against the real Pi runtime](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md) — runtime proof of these bootstrap-injection rules against the real spawned Pi
- [OpenCode plugin factory duplicate registration](../integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md)
- [OpenCode plugin hook silent defect swallowing](../integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md)

Pi currently computes this bootstrap from Systematic's default configuration. A Pi-native config namespace and precedence policy remain a separate architecture decision; do not read `.opencode` configuration implicitly from Pi.
