---
title: An exemption must be predicated on the uncheckable condition, not a proxy for it
date: 2026-08-18
category: best-practices
module: content-integrity
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A fail-closed gate needs an escape hatch for content it genuinely cannot verify"
  - "The escape hatch is triggered by a wording, marker, or shape that merely correlates with the unverifiable case"
  - "The gate exists to detect drift between a document and the source it describes"
tags:
  - content-integrity
  - fail-closed
  - gate-design
  - exemptions
  - drift-detection
---

# An exemption must be predicated on the uncheckable condition, not a proxy for it

## Context

A new fail-closed gate compared the plugin hook set claimed in contributor-facing documents against the set the plugin entry point actually registers. It needed one escape hatch, for a real reason.

`STRUCTURE.md` asserts completeness in prose without enumerating anything:

> `src/index.ts` — plugin factory (`SystematicPlugin`), registers every OpenCode hook Systematic provides (config, tool, the workflow-guard observation hooks, and the system transform)

There is no hook list to compare. Worse, naive extraction pulls the first inline-code span — `src/index.ts` — and reports it as a claimed hook name, producing a false violation on a correct document.

The escape hatch chosen was the assertion's wording:

```ts
if (/\b(?:every|all)\b[\s\S]{0,30}\bhooks?\b/i.test(assertion[0])) {
  return [...actualHooks]
}
```

Saying "all" or "every" near "hooks" meant the document was declared correct by fiat.

## Guidance

**Predicate an exemption on the condition that makes verification impossible, not on a signal that usually accompanies it.**

Here, the uncheckable condition is *the section names no item that could be compared*. The wording "all hooks" was a proxy for that — and the proxy admitted a case that was fully checkable:

```md
The plugin registers all six hooks:

- **`config`**
- **`tool`**
- **`experimental.chat.system.transform`**
```

This matched the proxy, so the check returned the source-derived set and never read the list. A document claiming six hooks while listing three passed clean, exit 0 — precisely the drift the gate existed to catch.

The corrected predicate names the actual condition:

```ts
const claimed = extractClaimedHookNames(assertionSection)
if (claimed.length > 0) return claimed   // enumerating — compare it

// Names nothing comparable: a prose-only completeness claim.
if (assertsCompleteness(assertion[0])) return [...actualHooks]
```

Naming even one real hook means the document is enumerating and the full set must match. `STRUCTURE.md` still passes; the stale document now fails and names the three missing hooks.

## Why This Matters

An exemption is a hole cut in a gate on purpose. The gate's value is bounded by how precisely that hole is cut.

A proxy predicate makes the hole a superset of the intended case, and the extra area is exactly where the gate is blind. Because it is fail-closed with no warning channel, nothing reports the blindness — the gate returns clean and reads as evidence.

This is the second over-broad exemption found in this same gate; an earlier whole-line skip was likewise a bypass, caught only in review. Exemption predicates deserve the same scrutiny as the assertions they exempt.

## When to Apply

- A gate needs an escape hatch and the obvious trigger is a phrase, comment marker, annotation, or file shape.
- Before writing the exemption, state the condition that makes verification impossible in one sentence. If that sentence and the predicate are not the same thing, the predicate is a proxy.
- Ask whether any input can satisfy the predicate while still being verifiable. If one can, that input is now unguarded.

## Examples

**Test every exemption from both sides.** An exemption test that only proves the intended case passes is half a test. The other half is the smallest mutation that should invalidate the exemption:

```
✓ prose-only completeness claim         → exempt, no violation
✓ completeness claim + partial list     → NOT exempt, violation naming what is missing
✓ completeness claim + full list        → NOT exempt, no violation
```

The middle case is the one that matters and the one most likely to be missing.

**Verify against real content, not only fixtures.** The bypass here was found by editing an actual repository document to the failure shape and running the real gate, not by reading the tests. Synthetic fixtures encode what the author already believed.

## Related

- [An allowlist is a claim that the rejected content is correct](an-allowlist-is-a-claim-the-content-is-correct-2026-08-17.md) — decides *whether* an exemption is warranted at all; this doc assumes it is and addresses where to draw its boundary.
- [neutral-v1 marker + migrated-set identifier gate](neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md) — records the earlier whole-line-skip bypass in this same gate, plus the policy on scanning fenced code.
- [Content-integrity has no non-failing warning channel](content-integrity-has-no-warning-channel-2026-06-06.md) — why a silently-passing gate leaves no trace.
