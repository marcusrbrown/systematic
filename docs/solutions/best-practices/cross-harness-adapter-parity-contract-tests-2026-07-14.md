---
title: Pin cross-harness adapter contracts at the boundary
date: 2026-07-14
category: best-practices
module: harness-adapter-testing
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Extracting shared core logic from an existing harness adapter
  - Exposing the same tool through multiple harness SDKs
tags: [adapter-parity, contract-tests, shared-core, opencode, pi, testing]
---

# Pin cross-harness adapter contracts at the boundary

## Context

Extracting a shared core removes duplicated business logic, but shared-core tests alone do not
prove that two harness adapters behave the same. Both adapters can agree with the helper while one
still wraps successful output incorrectly, translates errors, or changes harness-specific side
effects.

Systematic's `systematic_skill` tool has two boundaries:

- the OpenCode adapter returns the loaded skill as a string and records permission and metadata;
- the Pi adapter returns the same string in Pi's text-content envelope.

The shared core owns catalog lookup, content loading, and not-found errors. Adapter tests must
pin what remains outside that core.

## Guidance

### Compare the actual adapters

Instantiate both public adapters with the same real skill fixture. Invoke the OpenCode tool and the
tool captured from Pi's `registerTool`, then compare their observable output:

```ts
const openCodeResult = await openCodeTool.execute(
  { name: skillName },
  openCodeContext,
)
// Pi requires a tool-call ID; parity is asserted on the observable result.
const piResult = await piTool.execute(
  'tool-call-id',
  { name: skillName },
  undefined,
  undefined,
  piContext,
)

expect(piResult.content).toEqual([
  { type: 'text', text: openCodeResult },
])
expect(piResult.details.skillDir).toBe(
  openCodeMetadataCalls[0]?.metadata.dir,
)
```

Do the same for failure behavior. Capture each adapter's error for the same unknown skill and assert
that the messages are identical. Comparing each adapter only with the shared core is weaker: that
proves delegation, not adapter parity.

### Characterize adapter-only side effects

When shared logic moves, keep regression coverage on behavior intentionally left in the adapter.
For OpenCode, a successful load must request the exact skill permission before publishing metadata:

```ts
expect(askCalls).toEqual([
  {
    permission: 'skill',
    patterns: ['ce:plan'],
    always: ['ce:plan'],
    metadata: {},
  },
])

expect(metadataCalls).toEqual([
  {
    title: 'Loaded skill: ce:plan',
    metadata: { name: 'ce:plan', dir: skillDir },
  },
])
```

Resolution failures must happen before either side effect:

```ts
await expect(
  tool.execute({ name: 'nonexistent' }, context),
).rejects.toThrow('Skill "nonexistent" not found')

expect(askCalls).toEqual([])
expect(metadataCalls).toEqual([])
```

### Keep three test layers distinct

| Layer | Use when | What it proves |
|---|---|---|
| Shared-core tests | Resolver or catalog logic changes | Core behavior only |
| Adapter contract tests | Envelopes, errors, or adapter-only effects change | Cross-harness parity |
| Subprocess/package tests | Installation, lifecycle, or real harness wiring changes | End-to-end harness behavior |

Do not use a subprocess test to replace fast contract tests, and do not claim runtime integration
from a fake SDK boundary. Each layer catches a different failure class.

## Why This Matters

A shared core is a convergence mechanism, not proof of parity. Direct adapter comparison catches
wrong envelopes and translated errors. Side-effect characterization protects permission and metadata
behavior that a pure resolver cannot represent. Together, these tests make later refactors safe
without coupling the shared core to either SDK.

## When to Apply

- A second harness exposes an existing tool through a different result envelope.
- Business logic moves from an adapter into a shared module.
- One adapter performs permissions, metadata, logging, or lifecycle work outside the shared core.
- Review claims two harnesses are equivalent based only on helper-level tests.

## Examples

Use this pattern for a fast unit-level contract test that pins envelope parity, while keeping real
installation and lifecycle behavior in separate integration tests. Systematic applies it to the
OpenCode and Pi `systematic_skill` adapters in `tests/unit/pi.test.ts` and
`tests/unit/skill-tool.test.ts`.

## Related

- [Isolate OpenCode subprocess fixtures from the real installation](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md)
- [Test packaged harness extensions against the real Pi runtime](pi-real-runtime-integration-harness-2026-07-16.md) — the subprocess/package tier of this layer table, implemented for Pi
- [OpenCode swallows plugin hook defects unless tests force invocation](../integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md)
- [Behavior-first AJV contract verification for agent outputs](behavior-first-ajv-contract-verification-2026-07-21.md) — applies the same boundary-first test principle to schema-governed agent output.
- [Pi harness support plan](../../plans/2026-07-06-003-feat-pi-harness-support-plan.md)
- [Pi harness support requirements](../../brainstorms/2026-07-06-pi-harness-support-requirements.md)
