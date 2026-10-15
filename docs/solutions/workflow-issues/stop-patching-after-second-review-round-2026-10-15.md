---
title: Stop patching after a second review round breaks the first round's fixes; cut scope instead
date: 2026-10-15
category: workflow-issues
module: workflow-system
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A plan or design review round finds P0/P1s in mechanisms that the previous round's fixes introduced"
  - "Those findings share one root cause"
  - "The next step would be a third patch round on the same mechanism family"
tags: [plan-review, review-rounds, scope-cut, deferred-design, narrow-pr, document-review]
---

# Stop patching after a second review round breaks the first round's fixes; cut scope instead

## Context

Three plan reviews in this repository followed the same arc. A real bug got a fix plan. The first review round found blocking findings (P0/P1), and the plan was patched with new mechanisms. The second round then found new P0/P1s in exactly those mechanisms.

- **#1005, remote seeding timeout.** The rewritten plan added compare-only readbacks, repository and push-URL pins, and absence proofs. Round 2 found that compare-only readbacks had no defined drift outcome, pins had no way to reach the observer, and completion readbacks still wrote baselines. The scope was cut to per-operation deferral plus binding from the operation's own before-read, which shipped in #1082. The remote-evidence design went to #1081.
- **#1095, snapshot budget.** A git-index identity was rejected because reviewers reproduced a forged index and a clean filter. Its replacement used chunked reads with a time ceiling. Reviewers found that chunked reads raced writers, and the ceiling did not cover per-entry git spawns. The change shipped as raised caps plus recorded causes, and read-race hardening moved to #1099.
- **#1099, observer false-cleans.** The round-1 fixes compared against baselines captured when the observer starts. Round 2 defeated each one, because that state is agent-writable before capture and is reset by a restart. #1129 shipped only the fixes that need no captured baseline, and the rest became design issue #1126.

In #1099 the shared cause was state the agent can write, captured as a trusted baseline. In #1005 it was a new readback path with undefined drift semantics. Each time, a third patch round would have added another mechanism of the same family.

## Guidance

After any review round that follows a fix round, run this check before writing more plan text:

1. **Map each P0/P1 to the mechanism it breaks.** A finding in code the previous round did not add is a normal finding. Fix it.
2. **Group the findings by root cause.** Two or more findings in round-1 mechanisms with one cause is the signal. Typical causes:
   - state captured from something the agent or an attacker can write;
   - a new comparison or readback whose failure outcome is undefined;
   - a bound that does not cover the work it claims to bound.
3. **Ask what a real fix needs.** If it needs an anchor the agent cannot write, state that survives a restart, or new semantics in another subsystem, it is a design question, not a patch.
4. **Find the deterministic subset.** Some fixes stay correct no matter how the broken mechanism is resolved. They form the narrow PR.
5. **Stop at round 2.** Do not run a third patch round on the same mechanism family. Present the scope cut to the decision-maker with the evidence.

The scope cut hands off three things, and the PR links all three:

- **A design issue** containing:
  - the problem and its user-visible effect;
  - every reproduction from both rounds, with tool versions;
  - the constraints any fix must keep (for #1126: raw-byte identity, and no agent-writable baseline);
  - open questions phrased as questions.
- **Documented limits.** Each deferred case goes into the ARCHITECTURE.md known limits, linked to its issue, so the gap stays visible after the PR merges.
- **Honest PR wording.** The PR body says which cases it closes and which it does not, names the issue that tracks the remainder, and describes what was proven rather than suspected.

A narrow PR still gets full code review, and findings in the deterministic subset are fixed in that PR. They do not reopen the deferred design.

## Why This Matters

When the root cause is structural, each patch adds surface the next round can attack. The plan grows and the merged result does not get safer. A documented limit also prevents a false sense of closure: without it, a reader of "fixed" assumes every listed vector is handled.

## When to Apply

- A second or later review round finds P0/P1s in mechanisms that the previous fix round added.
- Those findings share a root cause.
- A fix would need state outside the current component's control, or semantics the plan cannot define yet.
- A deterministic subset can ship on its own.

This does not apply to first-round findings, to independent findings in unchanged code, or to findings whose fix is local and adds no new mechanism. Those are ordinary review feedback, and another iteration is the right response.

## Examples

**#1099.** The second-round findings all traced back to baselines captured from agent-writable state. The shipped subset needs none; it is described in [the observer false-clean fix](../logic-errors/operation-observer-false-clean-worktree-2026-10-15.md). #1126 received both rounds' reproductions, and ARCHITECTURE.md's "Local observer snapshot" paragraph links it.

**#1005.** The deterministic subset was:

- defer a seed that times out;
- bind the baseline from the operation's own before-read;
- stop counting a timed-out before-read as "absent before".

Proving absence, server-verified first pushes, fork exclusion and drift handling moved to #1081, with every review finding attached. #1082 lists the two remaining gaps as known limits.

**#1095.** The deterministic subset was larger caps, a separate remote item cap, and a recorded cause on every hook path. The rejected designs stayed rejected, and read-race hardening became part of #1099.

## Related

- [Truth Reset: document-review convergence is a scope signal](../workflow-patterns/truth-reset-scope-split-20260417.md). That doc covers splitting a plan when reviewers agree up front that it is overscoped. This doc covers the later signal: fixes from the first round breaking in the second.
- [Iterative Oracle plan review loop](../workflow-patterns/iterative-oracle-plan-review.md). Iterating until reviews are clean fits independent findings. When round 2 breaks round 1's mechanisms for a shared reason, stop there instead of iterating further.
- Issues: #1005, #1081, #1082, #1095, #1099, #1126, #1129.
- Plans:
  - `docs/plans/2026-10-11-002-fix-remote-seeding-deferral-plan.md`
  - `docs/plans/2026-10-12-001-fix-operation-snapshot-limits-plan.md`
  - `docs/plans/2026-10-14-002-fix-observer-false-clean-plan.md`
