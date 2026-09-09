---
title: A "nothing changed" claim is scoped to a boundary, and the diff is not evidence for it
date: 2026-09-08
category: best-practices
module: systematic-plugin
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - A change touches an object the host owns and passes into a hook (`output.system`, `output` in `experimental.chat.system.transform`)
  - A refactor rewrites a loop into `.map()`, `.slice()`, or `.filter()` on something a caller may hold
  - A PR body claims "no runtime behavior changed" or "purely a type-safety change"
  - Writing or reviewing prose that states which config source wins for a field
  - A mechanical or compiler-driven sweep touches many files at once
related_components:
  - tooling
  - documentation
tags:
  [
    boundary-contract,
    reference-identity,
    output.system,
    experimental.chat.system.transform,
    appendMarker,
    noUncheckedIndexedAccess,
    SECURITY_OVERLAY_FIELDS,
    rejectProjectSecurityOverlay,
    preserveSecurityFields,
    silent-failure,
    opencode,
    plugin-hook,
    config-overlay,
  ]
---

# A "nothing changed" claim is scoped to a boundary, and the diff is not evidence for it

## Context

Two changes were wrong in the same way: each made a confident claim about behavior on the other side of a boundary, and each was checked by reading the change rather than the consumer.

**A type-safety sweep replaced a host-owned array.** Enabling `noUncheckedIndexedAccess` surfaced 132 sites. One of them was a loop in `src/lib/bootstrap.ts`, rewritten as `output.system = output.system.map(...)`. That reassigns the array instead of mutating it. `output` belongs to OpenCode and arrives through the `experimental.chat.system.transform` hook, so array *identity* is observable across that boundary — and `appendMarker` in `src/lib/opencode-workflow-guard.ts:3996` does `const system = output.system`, a live reference capture from a sibling hook. A host holding the original reference would have missed the injected bootstrap content. `docs/plans/2026-05-10-002-refactor-multi-load-plugin-registration-plan.md:13` had already recorded in-place replacement as the mechanism that makes multi-load registration converge instead of stacking blocks.

The PR asserted "no runtime behavior changed." A review across eleven personas returned zero findings, including a correctness reviewer asked to look for a loop conversion that traded in-place mutation for a new array. Nothing in the suite asserted array identity, so both semantics passed.

**A docs sync then inverted a trust boundary.** The next change described config precedence as "a project or custom overlay still overrides a profile-supplied routing choice." False for the project half. Routing fields are exactly `SECURITY_OVERLAY_FIELDS` (`src/lib/config-schema.ts:735`) — `model`, `variant`, `skills`, `permission`, `opencode`, `pi` — which a project file may not set at all: `rejectProjectSecurityOverlay` throws and fails the load rather than stripping. Because that guard runs first, a project fragment reaching the merge provably carries none of those fields, so `preserveSecurityFields` carrying the previous layer forward is defense-in-depth rather than a competing strip. User and custom overlays replace wholesale. The sentence claimed the untrusted tier could steer model selection, in the file readers use for "what invariants must hold."

Both were caught by reading what the consumer does with the thing that changed.

## Guidance

When a change touches something that crosses a boundary, ask one question: **what does the other side hold, capture, compare, or inherit?**

Then go read that side. Specifically:

- **For an object the host passes in**, grep for other code that captures it (`const x = output.y`) or retains it across calls. A sibling hook holding a reference is the case that makes reassignment observable.
- **For anything with provenance** — config sources, trust tiers, overlay precedence — read the merge site and the rejection path, not the type. Whether a lower-trust source is *rejected*, *stripped*, or *preserved from the previous layer* are three different behaviors that all look like "the field doesn't apply."

If the contract is real, pin it with a test that fails under the wrong semantics. A suite that passes under both is not a gate.

## Why This Matters

A compiler-driven sweep is the highest-risk place for this: 132 sites, each fix looks local, and volume makes per-site scrutiny feel disproportionate. "Zero errors after the rewrite" is evidence about the instrument, not the system (see [a-perfect-measurement-means-a-broken-instrument](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md)).

Automated review does not close this. Eleven personas, one of them briefed on this precise conversion, all read the diff and found nothing. The reviewer that caught it asked what the host does with `output.system`, and found the sibling hook capturing it.

For a prose claim the cost is delayed rather than immediate. A wrong sentence about a trust boundary sits in the file readers consult for invariants, and the next maintainer either files correct behavior as a bug or waves through a regression that matches the doc.

## When to Apply

- A refactor rewrites a loop into `.map()`, `.slice()`, or `.filter()` on a value the function did not create
- A change touches a parameter the caller still owns after the call returns
- A PR body claims "no runtime behavior changed," "purely a type-safety change," or "mechanical"
- Writing or reviewing documentation that states which config source, trust level, or layer wins

Local values are exempt. The rule is about values reachable by a caller, a host, or a captured reference.

## Examples

**The conversion that changed a contract:**

```ts
// Reassigns — a host holding the original reference stops seeing updates.
output.system = output.system.map((entry) => removeCompleteBootstrapBlocks(entry))

// Mutates in place. `.entries()` yields a non-optional element type,
// so it satisfies noUncheckedIndexedAccess without changing the contract.
for (const [i, entry] of output.system.entries()) {
  output.system[i] = removeCompleteBootstrapBlocks(entry)
}
```

**The assertion that pins it** (`tests/unit/plugin.test.ts:661`):

```ts
const originalRef = output.system
applyBootstrapContent(output, wrap('NEW CONTENT'))
expect(output.system).toBe(originalRef)
```

This fails against the `.map()` form and passes against `.entries()`. Every other test in that file reads `output.system` back off the same object, so it passes under both.

The trust-boundary equivalent already existed: `tests/unit/config.test.ts:496`, *"project overlays cannot configure model, permission, or managed skills"*. The invariant was tested. Only the sentence describing it was wrong — a reminder that prose about a boundary needs the same verification as code that crosses one.

## Related

- [a-perfect-measurement-means-a-broken-instrument](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — a clean result can be evidence the instrument is blind; "zero type errors after the sweep" is exactly that shape
- [layered-trust-boundaries-overlay-config](layered-trust-boundaries-overlay-config-2026-05-09.md) — how the overlay trust boundary is *designed*; this doc is about what counts as evidence for a claim about it
- [opencode-plugin-named-exports-break-loader](../integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md) — the sibling case: the host consumes a contract that differs from the author's intent, and only a host-visible assertion catches it
- [deletion-gates-must-observe-every-field-the-deleted-code-wrote](deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md) — a preservation gate must be seeded from the replaced code's own branches
