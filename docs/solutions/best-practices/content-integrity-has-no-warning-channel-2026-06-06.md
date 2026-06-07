---
title: content-integrity has no non-failing warning channel; gate checks are violation-or-nothing
category: best_practice
problem_type: best_practice
module: content-integrity
component: ci-gate-design
tags:
  - ci-gate
  - content-integrity
  - planning
  - verification
  - tooling
related_components:
  - tooling
date: 2026-06-06
---

# content-integrity has no non-failing warning channel; gate checks are violation-or-nothing

## Context

A skill-frontmatter tune-up planned a new `scripts/content-integrity.ts` check that would
**warn** (non-blocking) when a bundled skill body references `$ARGUMENTS` but its frontmatter
omits `argument-hint`. A warning felt right: only one skill had the gap, so failing CI on a
low-severity authoring nit seemed disproportionate.

Plan review (feasibility + adversarial, converging) flagged the assumption as infeasible: the
gate has **no general non-failing warning channel**. `CheckResult` has exactly one warning
bucket, `allowlistWarnings`, which is allowlist-specific and the *only* count excluded from
`totalViolations()`. Every other check sums into `totalViolations()`, and `main()` exits
non-zero whenever that total is greater than zero. So "emit a warning" for an arbitrary new
check actually means one of two things: build new warning plumbing (a `CheckResult` field +
`printResult` wiring + exclusion from the failing total), or make it a hard violation.

For a one-skill guard, building warning infrastructure was not justified, so the check shipped
as a normal violation that mirrors the existing `deprecated.reason` and agent-mode/temperature
gates.

## Guidance

**Before planning a content-integrity check as "advisory," verify the gate's enforcement model.**
content-integrity is binary: a check either records a violation (fails CI when the total is
non-zero) or it does nothing. The `allowlistWarnings` bucket is not a general-purpose warning
channel and should not be assumed reusable for unrelated checks.

When a one-time cleanup is small (here, a single skill), the durable value is the *guard*, not
the cleanup. The guard only pays off if it actually blocks regressions, which on this gate means
a hard violation. Design for that:

- Fix the existing case(s) first, so the violation check runs clean against the real tree.
- Wire the new check end-to-end exactly like a sibling: `CheckResult` field, count in
  `totalViolations()`, print in `printResult()`, invoke in `checkContentIntegrity()`, and update
  the header invariant list.
- Add an integration assertion that the real tree produces zero violations, so the gate cannot
  silently start failing on legitimate content.

**Make body scans fence-aware.** A check that scans skill *body* text for a literal token (here
`$ARGUMENTS`) will false-positive on documentation that mentions the token inside a fenced code
block. Strip fenced code blocks before scanning, and add a dedicated test for the
mention-inside-a-fence case. A line-anchored fence-stripping regex does not handle fences
indented inside list items or blockquotes; if no bundled asset needs that, document the
limitation rather than over-engineering the regex, and rely on the real-tree integration test to
surface a future case.

## Why this matters

Two consecutive plans had review catch a wrong infrastructure assumption before implementation
(this one, and a prior overlay-precedence gap). The pattern is the same: a plan describes a
mechanism ("use the warning channel", "the explicit value already wins") that sounds plausible
but was never checked against the actual code. Grounding the *mechanism*, not just the intent,
is what the plan-review gate exists to catch. For tooling changes specifically, confirm the
primitive you intend to use actually exists before writing units around it.

## Related

- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — a runtime drop-rule and its gate check must agree; this doc adds that the gate side has only one enforcement primitive.
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md` — another content-integrity check where the honest design was simpler than the first plan assumed.
- `docs/solutions/best-practices/harden-converter-injected-agent-defaults-2026-06-06.md` — the sibling hardening arc whose gates this check pattern mirrors.
