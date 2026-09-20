---
title: Reviewer findings need verification against the checkout the code lives in
date: 2026-09-20
category: workflow-issues
module: ce-review
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Running ce:review on work that lives in a git worktree rather than the primary checkout
  - Dispatching read-only review personas that compute their own diff
  - Deciding whether to act on a high-confidence finding without reading the code
  - Evaluating a finding that claims a feature is entirely missing
symptoms:
  - "Personas report a feature as completely unimplemented while its test suite passes"
  - "Findings cite real symbol names but describe pre-change behavior"
  - "Stated confidence is 0.94-0.99 on claims a single grep refutes"
related_components:
  - tooling
  - testing_framework
tags: [ce-review, worktree, subagent, false-positive, verification, checkout]
---

# Reviewer findings need verification against the checkout the code lives in

## Context

A `ce:review` run covered a feature developed in a git worktree at
`../systematic-project-profiles`, not the primary checkout. Nine personas returned
11 findings. Five were false, and four of those came from personas describing a
tree that did not contain the feature:

- `correctness` returned three findings at 0.96-0.99 confidence stating that
  `lookupProfileBundle` never consults project config, that
  `assertAllProfileBundlesAreValid` skips project bundles, and that
  `mergeOverlayMap` never stores per-field origins.
- `cli-readiness` returned one at 0.99 stating `buildConfigShowJson` omits
  `activeProfileSourcePath`.

All four were refuted by a single grep each. `lookupProfileBundle` has the project
branch. `assertAllProfileBundlesAreValid` takes `projectConfig` and iterates all
three sources. `mergeOverlayMap` computes `nextOrigins` and stores
`origins: nextOrigins`. `buildConfigShowJson` returns the field, the type declares
it, and a test asserts it in `--json` output.

The personas ran `git diff <base>` from the primary checkout, where `<base>` *was*
`HEAD`. The diff came back empty and the source files read as pre-feature.

A fifth false finding had a different cause. `api-contract` claimed at 0.93 that
adding a required field to the exported `SystematicConfig` interface breaks
downstream TypeScript consumers. `package.json` exports exactly one path,
`.` → `./dist/index.js`, and `src/index.ts` has no named exports at all — only
`export default SystematicPlugin`, which is an architectural invariant the loader
requires and `tests/unit/package-exports.test.ts` pins. No consumer can import that
type, so nothing external could break.

## Guidance

**Verify every finding against the tree before acting on it.** This is the control
that worked. All five false findings were caught by reading the code at `HEAD`, and
none would have been caught by weighing stated confidence.

**Treat "this feature is absent" as self-refuting when the suite passes.** A finding
asserting that a feature is entirely unwired, alongside a green suite containing
tests for that feature, describes two incompatible trees. One of them is not the
tree under review.

**State the target checkout in the brief, and know that it is not sufficient.** The
briefs in this run did name the worktree path and did say not to touch the primary
checkout. Four findings still came from the wrong tree. Path instructions reduce the
failure; they do not remove it.

**Check the export surface before accepting a breaking-change claim.** A claim that
an exported type change breaks consumers is only meaningful if consumers can reach
the type. `package.json`'s `exports` map and the entry file's named exports settle it.

## Why This Matters

The findings were not vague. They named real functions, described plausible
omissions, and carried higher stated confidence than the findings that were true.
Acting on them meant "fixing" code that was already correct — in a merge pipeline
where the surrounding logic enforces a trust boundary.

Confidence is a reviewer's self-report about its reasoning. It carries no
information about whether the reviewer read the right bytes.

## When to Apply

- Any review of code in a worktree, isolated checkout, or container.
- Any autofix decision, where a false finding becomes a committed change rather than
  a paragraph someone can ignore.
- Any finding whose claim is the *absence* of something, which is cheap to check and
  easy to get wrong.

## Examples

Wrong tree, empty diff:

```bash
# run from the primary checkout, where <base> == HEAD
git diff -U10 d54109b -- src/lib/config.ts   # returns nothing
```

The reviewer then reads `src/lib/config.ts` at the primary checkout's `HEAD` and
describes a file that predates the change.

Refuting a finding costs one command:

```bash
cd <the worktree the work actually lives in>
grep -n "allowProjectProfiles" src/lib/config.ts
```

Checking whether an exported-type change can reach a consumer:

```bash
node -e "const p=require('./package.json'); console.log(JSON.stringify(p.exports))"
grep -cE "^export (const|function|interface|type|class|\{)" src/index.ts   # 0
```

## Related

- [`delegated-verification-needs-a-prepared-environment-2026-08-18.md`](./delegated-verification-needs-a-prepared-environment-2026-08-18.md)
  — a different way a delegate in a worktree reports confidently about the wrong
  thing: the tree is correct but its dependencies are absent.
- [`../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md)
  — worktree scoping producing observations that do not describe the intended target.
- [`../best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md`](../best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md)
  — the same shape at a different boundary: check the claim where its consumer lives.

## Postscript

While writing this document, the orchestrator verified candidate facts against
`origin/main` and never checked that the local working tree had been pulled. It had
not. A research lane correctly reported that a newly extracted module did not exist,
and was initially assumed to be exhibiting the very failure described above. The
lane was right; the orchestrator was reading a stale checkout.

The lesson is not that reviewers are unreliable. It is that the checkout is a
variable, it is invisible in the output, and it is worth confirming before drawing a
conclusion from an absence.
