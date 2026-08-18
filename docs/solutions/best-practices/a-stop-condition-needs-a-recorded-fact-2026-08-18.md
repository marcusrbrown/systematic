---
title: A stop condition that compares now against then requires the contract to record then
date: 2026-08-18
category: best-practices
module: prior-art-survey
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "A downstream step refuses to proceed when an earlier step's result may be stale"
  - "A contract defines a check but not the field the check reads"
  - "A rule must work in environments where version control or history may be unavailable"
tags:
  - contract-design
  - staleness
  - workflow-contract
  - schema-design
  - verification
---

# A stop condition that compares now against then requires the contract to record then

## Context

A planning workflow gained a prior-art survey: an earlier step establishes what already exists, and a later step consumes that result. The consuming step was specified to stop when the survey had gone stale:

> Work execution does not begin on a plan whose surveyed scope has changed since the survey ran.

The survey's schema recorded exactly these top-level fields: `verdict`, `scope`, `budget`, `candidates`, `scopes_considered`, `acceptance`.

Nothing there says *when* the survey ran, or against what state. No timestamp, no revision, no digest. The consuming step was told to compare current state against the survey's state, and the survey never recorded its state.

The instruction tried to paper over this by naming possible evidence sources — version-control history, "any recorded baseline, manifest, timestamps, or other portable local evidence." None of them were things the survey produced. Every execution would reach the same dead end: freshness unknown.

## Guidance

**When you write a rule of the form "stop if X has changed since Y," the artifact must record what Y was.** Otherwise the rule is not strict or lenient — it is unevaluable, and an unevaluable rule degrades into whatever the implementer guesses.

Specify four things together, in the same change:

1. **What baseline is recorded**, and by whom.
2. **How current state is computed** for comparison.
3. **What happens when comparison is impossible** — and it must not be "assume fresh."
4. **What scope the comparison covers** — the whole repository is usually wrong and always expensive.

The fix added a required freshness record supporting either path:

```json
"freshness": {
  "vcs_reference": { "kind": "git", "head": "<revision>" }
}
```

```json
"freshness": {
  "scope_baseline": { "digest": "<hash of the surveyed scope>" }
}
```

At least one must be present. A repository with version control compares revisions; one without compares a portable digest. Neither available means the result is *unverifiable*, which stops execution and asks for a fresh survey rather than proceeding on an assumption.

## Why This Matters

This is a contract hole, not an implementation bug, and it is invisible to the usual gates. The schema compiled. Its tests passed. The consuming instruction read as a reasonable, even careful, rule. Nothing failed, because nothing yet tried to evaluate the condition.

The failure surfaces only in use, as a step that always reports the same non-answer — and the natural repair at that point is to weaken the rule, since it "never works," rather than to notice the missing field.

## When to Apply

- Any rule containing "since", "still valid", "out of date", "has changed", or "no longer matches".
- Any handoff where one step's output is consumed by a later step that may run much later.
- Any contract that must hold in environments you do not control — no version control, shallow clones, exported archives.

Write the check and the recorded evidence in the same change. If they are split across two changes, the first one ships a rule nothing can satisfy.

## Examples

**Unevaluable:**

> Refuse to proceed if the analyzed files have changed since the analysis ran.

Nothing says what the analysis observed, so "changed since" has no referent.

**Evaluable:**

> The analysis records the scope it examined and either the revision it observed or a digest of that scope. Refuse to proceed when the current revision or digest differs. When neither can be computed, report that freshness is unverifiable and request a fresh analysis — do not assume the result still holds.

The second version can actually run, and its failure mode is explicit rather than emergent.

## Related

- [Compiling the real schema proves it parses, not that it rejects](schemas-need-adversarial-probes-not-just-compilation-2026-08-16.md) — a schema can be well-tested against the payloads it defines and still omit a field a downstream rule depends on.
- [A deletion gate must observe every field the deleted code wrote](deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md) — the sibling case, where a check watches fewer fields than the thing it guards.
