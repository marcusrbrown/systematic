---
title: Comments and commit messages are claims, not evidence of final state
module: src/lib/config-handler.ts + src/lib/source-model-defaults.ts
date: 2026-08-16
problem_type: best_practice
component: development_workflow
severity: low
tags:
  - dead-code
  - dependency-surface
  - commit-sequencing
  - pr-narrative
  - final-state-verification
applies_when:
  - A field, parameter, or module is annotated as retained for compatibility
  - A multi-commit change deletes something an earlier commit in the same change modified
  - Writing a PR description or release note from commit messages
---

# Comments and commit messages are claims, not evidence of final state

## Context

Prose written next to code makes assertions about that code. Those assertions are unverified, they are never invalidated automatically, and they survive the conditions that made them true. Two variants of this showed up in one change.

**A comment claimed a consumer that did not exist.** Removing a config hook's model-availability discovery left a dependency field behind:

```ts
export interface ConfigHandlerDeps {
  /** Retained for dependency-surface compatibility; config emission does not use it. */
  client?: OpencodeClientLike
}
```

The comment is accurate about the present and misleading about the future. It says nothing reads the field, then keeps it anyway. A search across `src/`, `scripts/`, and `tests/` found zero reads and exactly one write — a pass-through in `src/index.ts` that existed only to populate it. Both were deleted.

**A commit message claimed work that HEAD does not contain.** One commit replaced a closed seven-literal `ProviderID` union with structural validation, hardening input handling in `src/lib/source-model-defaults.ts`. The next commit deleted that file. Both commits were correct in isolation, and the sequencing was deliberate so each stayed independently revertable. But the net diff for that file is:

```
src/lib/source-model-defaults.ts | 430 ---------------------------------------
1 file changed, 430 deletions(-)
```

The hardening does not exist at HEAD. Its commit message describes it in the present tense, and a PR description assembled from commit messages would have credited a security improvement that shipped nothing.

## Guidance

**For retained-for-compatibility annotations:** treat the comment as a hypothesis and test it. A field no code reads is dead regardless of what the comment says about why it is there. Compatibility is a property of consumers, so if you cannot name one, there is nothing to be compatible with.

```bash
# Name the consumer or delete the field
rg 'deps\.client|\.client\b' src/ scripts/ tests/
```

**For multi-commit changes:** verify the net diff before writing the narrative. Commit messages describe intent at a point in history; the PR ships a final tree.

```bash
# What actually changed, versus what the commits say changed
git diff --stat <base>..HEAD -- <path>
git log --oneline <base>..HEAD
```

When a commit's work is fully removed by a later commit in the same change, that is fine and often correct — but say so, or say nothing about it. Do not describe it as shipped.

## Why This Matters

Both failures are invisible to every automated gate. Types, tests, and linters have no opinion about whether a comment is true, and none of them read commit messages at all. The only detection mechanism is a reader who checks, and readers extend trust to prose precisely because checking is expensive.

The cost compounds. A retained field teaches the next reader that something depends on it, so they preserve it too. An overstated commit message flows into a squash body, then into release notes, and becomes the public record of what a version contains.

## When to Apply

- Any time you write "retained for", "kept for compatibility", or "reserved for future use" — name the consumer or the future, or delete the thing
- Before opening a PR whose commits modify and then delete the same file
- When assembling release notes or a PR description from commit history rather than from the diff

## Examples

**The audit that settles a retained field.** One command, three trees, zero reads found:

| Check | Result |
|---|---|
| `rg 'deps\.client' src/` | no matches |
| Constructions of `ConfigHandlerDeps` | one, in `src/index.ts` |
| Reads in that construction | none — it only wrote the field |

Verdict: delete the field and the pass-through.

**The net-diff check that catches an overstated narrative.** A file with insertions and deletions across the range still nets to a pure removal:

```bash
$ git diff --stat 09703a1..HEAD -- src/lib/source-model-defaults.ts
 src/lib/source-model-defaults.ts | 430 ---------------------------------------
```

No insertions. Whatever the intermediate commits said they added is not there.

## Related

- [`docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md) — the downstream consequence: commit and PR text become the public release record
- [`docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md) — verify the artifact, not the process that claims to produce it
- PR #790 — where both variants surfaced
