---
title: A merge-order dependency stated in prose is not enforced by anything
date: 2026-08-25
category: workflow-issues
module: pull-request-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
tags:
  - merge-order
  - stacked-pull-requests
  - base-branch
  - pr-dependencies
  - changes-requested
  - rebase-recovery
applies_when:
  - One pull request must land after another
  - Deciding whether to stack a PR on its dependency or hold it unopened
  - A stacked base branch merged and disappeared underneath an unopened PR
  - A dependent PR needs recovery after its base merged
---

# A merge-order dependency stated in prose is not enforced by anything

## Context

A pull request stated the precondition it then failed to satisfy. Its body said:

> **Merge #872 first.** That PR ships the executable bit. Landing this prose ahead of it
> would tell the parent to run a command that is present and unrunnable.

That warning was accurate. It was also inert. The PR was based on `main` at a commit
predating its dependency, so it stayed independently mergeable in exactly the order it
warned against.

The reviewer caught it by measuring rather than reading — building the artifact at that PR's
head:

```
$ bun scripts/build-claude-code-plugin.ts && stat -c '%a %n' claude-code/bin/systematic-validate-review-artifact
644 claude-code/bin/systematic-validate-review-artifact
```

Not executable — the prose told readers to run a bundled command that could not run at that
base commit.

## Guidance

Move the precondition into something the platform can check: a base branch, not a description.

**Stack the PR on its dependency when that dependency is not about to merge.** The platform
then refuses the wrong order outright, and retargets the PR to the default branch once the
base lands.

**Hold the dependent PR unopened when the dependency is approved and could merge at any
moment.** This is where stacking advice breaks down, and it happened in the same session as
the prose-only PR above. A PR was opened with its base pointing at another open PR's branch.
That base merged mid-flight, the branch was deleted, and creation failed:

```
pull request create failed: GraphQL: No commits between docs/entry-point-scope-learning and docs/skill-dir-anchor-convention, Base ref must be a branch (createPullRequest)
```

That failure is what produced the over-correction. Retreating to prose felt safer and was
strictly weaker.

**Never rely on prose alone.** It is worth writing the dependency down, but write it in
addition to the structural constraint, not instead of it.

## Why This Matters

Both failures share the same cause: the ordering lived in something that could not enforce it
— first a description, then a branch reference that stopped existing.

The prose case is more dangerous because it fails silently. A stacked base that disappears
errors loudly; a description does nothing, leaving a green, approved PR mergeable in the wrong
order.

## When to Apply

Any time one PR must land after another.

Stack when the dependency is still in review or otherwise not imminent. Hold when it is
approved and could land at any moment. Reach for prose only as a supplement to whichever of
those you chose.

## Examples

Recovery when the base merges out from under you is cheap, which is worth knowing so stacking
does not feel riskier than it is. Rebase onto the merged base — git recognizes the duplicated
commit and drops it:

```
warning: skipped previously applied commit e63c8be
Successfully rebased and updated refs/heads/docs/skill-dir-anchor-convention.
```

Then verify the dependency is present at the new head rather than assuming the rebase carried
it:

```
$ stat -f '%Sp %N' claude-code/bin/systematic-validate-review-artifact
-rwxr-xr-x claude-code/bin/systematic-validate-review-artifact
```

Finally, request re-review explicitly. A comment does not clear `CHANGES_REQUESTED`.

## Related

- [When prose is the enforcement mechanism, read it literally as a separate pass](./literal-text-review-catches-what-design-review-cannot-2026-08-18.md)
  — the adjacent failure. There the prose contradicted itself and needed literal reading; here
  the prose was correct, and the fix is structural enforcement.
- [A capability that works has not yet named its cause](./a-capability-that-works-has-not-named-its-cause-2026-08-24.md)
  — the reviewer measured the artifact instead of reading the claim about it, which is what
  surfaced this.
