---
title: Keep once-per-process Pi extension state on globalThis
date: 2026-10-22
category: best-practices
module: pi
problem_type: design_pattern
component: tooling
severity: low
applies_when:
  - A Pi extension factory writes output or claims a resource at init
  - pi-subagents child sessions can load the same extension again
  - A flag must hold across separately evaluated module instances in one process
tags: [pi, pi-subagents, extension-factory, globalthis, once-per-process, warnings]
---

# Keep once-per-process Pi extension state on globalThis

## Context

Systematic's Pi extension warns at startup when `systematic.json` holds settings that the packaged
pi-subagents personas cannot receive: overlays, and disables of curated personas. The warnings ran
from the extension factory body. A pi-subagents `Agent` child session loads extensions again, so the
same warnings printed once more for each child session.

## Guidance

Keep the once-only flag on `globalThis` under a registered symbol, and claim it only when there is
something to say. From `src/pi.ts`:

```ts
const WARNINGS_EMITTED_KEY = Symbol.for('systematic.pi.packagedWarningsEmitted')

function claimPackagedWarnings(): boolean {
  if (Reflect.get(globalThis, WARNINGS_EMITTED_KEY) === true) return false
  Reflect.set(globalThis, WARNINGS_EMITTED_KEY, true)
  return true
}

// ...
  if ((overlaysIgnored || disabledPackaged > 0) && claimPackagedWarnings()) {
    if (overlaysIgnored) reportPackagedOverlayIgnored()
    if (disabledPackaged > 0) reportPackagedPersonasStillLoad(disabledPackaged)
  }
```

- **`globalThis`, not a module-local `let`.** A child session can evaluate the extension as a fresh module
  instance. A module-local flag starts unset in each instance; `globalThis` is shared by every instance in
  the process.
- **`Symbol.for`, not a bare property name.** The registered symbol is the same across instances and
  cannot collide with another extension's string key.
- **Claim after deciding.** Checking the condition first means an early init with nothing to report does
  not use up the flag and silence a later init that does.

The OpenCode bootstrap guidance against `globalThis` does not apply here: it covers prompt idempotency,
which OpenCode coordinates through the system prompt array, not process-wide output.

## Why This Matters

Each repeat is the same text with no new information, and a fan-out workflow can start many child
sessions. Users learn to ignore startup output that scrolls past on every dispatch.

## When to Apply

- Startup notices, deprecation warnings and one-time hints from a Pi extension factory.
- Any process-wide resource an extension must create once, where the host may load the module twice.

## Examples

`tests/unit/pi.test.ts`, describe "once per process", relies on the `beforeEach` of the warnings
describe that contains it, which resets the flag with
`Reflect.deleteProperty(globalThis, Symbol.for(...))`. It covers four cases:

- initializing twice prints each warning once;
- an init with nothing to warn about does not silence a later warning;
- a warning suppressed by an earlier init is not replaced by another;
- a separately evaluated instance shares the flag. The test imports a second copy and checks that its
  default export is a different function before initializing both:

```ts
const secondInstancePath = '../../src/pi.ts?instance=2'
const second = (await import(secondInstancePath)) as {
  default: typeof piExtension
}
expect(second.default).not.toBe(piExtension)
```

Initializing the same imported module twice cannot tell `globalThis` from module-local state. The
second-instance test is the one that targets a module-local flag directly.

## Related

- [Generate Pi package agents in the build, not in prepublishOnly](generate-pi-package-agents-in-build-not-prepublish-2026-10-22.md)
- [OpenCode plugin multi-source loading: per-load registration with marker-based bootstrap](../integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md)
