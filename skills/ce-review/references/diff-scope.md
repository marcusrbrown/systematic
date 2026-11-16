# Diff Scope Rules

These rules apply to every reviewer. They define what is "your code to review" versus pre-existing context.

## Scope Discovery

The parent pins the review scope once and gives you four values: the checkout path (`<checkout_path>`), the base SHA (`<base_sha>`), the head (`<head>`), and a manifest listing every changed path with its status (`A`, `M`, `D`, `R`, or `T`), rename source, and added and deleted line counts. That scope is exact. Do not recompute the supplied review scope, and do not widen it. No diff is inlined in your prompt, so read the diff of one path at a time from git. Run every git command against the pinned checkout with `git -C <checkout_path>`.

**Read one path's diff:**

- When the head is a commit: `git -C <checkout_path> diff -U10 <base_sha> <head> -- <path>`.
- When the head is "working tree": `git -C <checkout_path> diff -U10 <base_sha> -- <path>`. The checkout had uncommitted changes when the scope was pinned, so the diff runs against the working tree.
- For a renamed path (status `R`), pass the rename source and the path together.

**Read old source** from the base commit: `git -C <checkout_path> show <base_sha>:<path>`. A deleted file (status `D`) exists only there, so a finding on it cites the base-side path and line. For a renamed path, read the old source from the rename source. Source the diff does not touch is read in the checkout.

**Not permitted:** a range-wide diff or log to rebuild or widen the scope, such as `git diff <base_sha>` with no path, `git diff --stat`, or `git log <base_sha>..`, and any new merge-base or base-branch detection. The manifest already lists every changed path. A path outside the manifest is not part of the review, except as surrounding context or a pre-existing finding.

## Finding Classification Tiers

Every finding you report falls into one of three tiers based on its relationship to the diff:

### Primary (directly changed code)

Lines added or modified in the diff. This is your main focus. Report findings against these lines at full confidence.

### Secondary (immediately surrounding code)

Unchanged code within the same function, method, or block as a changed line. If a change introduces a bug that's only visible by reading the surrounding context, report it -- but note that the issue exists in the interaction between new and existing code.

### Pre-existing (unrelated to this diff)

Issues in unchanged code that the diff didn't touch and doesn't interact with. Mark these as `"pre_existing": true` in your output. They're reported separately and don't count toward the review verdict.

**The rule:** If you'd flag the same issue on an identical diff that didn't include the surrounding file, it's pre-existing. If the diff makes the issue *newly relevant* (e.g., a new caller hits an existing buggy function), it's secondary.
