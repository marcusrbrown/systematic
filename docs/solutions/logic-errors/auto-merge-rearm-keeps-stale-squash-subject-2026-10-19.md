---
title: Re-arming auto-merge kept the release PR's stale squash subject
date: 2026-10-19
category: logic-errors
module: release-pipeline
problem_type: logic_error
component: development_workflow
symptoms:
  - "The v3.24.0 tag points at 392d7483, whose subject is `chore(release): v3.23.1`"
  - 'The v3.24.0 release notes include "Release bookkeeping for v3.23.1"'
  - "The release PR's title read `chore(release): v3.24.0` when it was approved, so the stale subject was not visible in review"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [release-pr, auto-merge, squash-merge, gh-pr-merge, merge-subject, release-refresh]
---

# Re-arming auto-merge kept the release PR's stale squash subject

## Problem

The release PR refresh in `.github/workflows/release.yaml` arms auto-merge with `--subject "$TITLE"`. When a later refresh renamed the open release PR from v3.23.1 to v3.24.0 and armed it again, GitHub kept the subject from the first arming. Release PR #1160 was then squash-merged as `chore(release): v3.23.1`, and that commit carries the v3.24.0 tag. The CHANGELOG and the npm package were correct. Fixed in #1170.

## Symptoms

- `git show -s --format=%s 392d7483` prints `chore(release): v3.23.1`, and `v3.24.0` points at that commit.
- The v3.24.0 release notes list "Release bookkeeping for v3.23.1", because the narration reads commit subjects.
- PR #1160's title was `chore(release): v3.24.0` at approval and at merge.

## What Didn't Work

- **Looking for a stale input.** The PR title was `chore(release): v3.24.0`, and so was the PR's single commit, 4af0cf1f, which the refresh created. Neither the title nor the commit message carried the old version.
- **Relying on the repository's squash setting.** The repository uses `squash_merge_commit_title: COMMIT_OR_PR_TITLE`, which would have produced the right subject. Auto-merge stores the `--subject` given when it is enabled, and that stored subject is what the merge used.

## Solution

`arm_auto_merge` used to call `gh pr merge --auto --squash --match-head-commit "$head" --subject "$TITLE"` up to three times and warn if every try failed. The fix adds one line at the top of the function, before that loop:

```bash
gh pr merge "$pr" --repo "$REPO" --disable-auto >/dev/null 2>&1 || true
```

The current subject and `--match-head-commit` pin then replace the stored ones. The disable is best effort: it fails when nothing is armed, which is the normal case when the PR is first created.

The function has two call sites: the re-arm when the CHANGELOG is unchanged, and the arm after a new commit. The second one runs for an existing PR or a new PR, so there are three refresh paths in all.

`tests/unit/release-workflow.test.ts` runs the refresh against a stub `gh` and asserts the call order. On every refresh path, the disable comes before the enable. A failing disable neither fails the step nor skips the enable. One disable precedes up to three enable attempts.

## Why This Works

What the evidence shows:

- PR #1160's timeline has one `AUTO_SQUASH_ENABLED_EVENT`, at creation. It has no disable event, and nothing re-arms the PR after the rename at 21:47:44Z.
- The refresh run after the rename re-armed the PR with `TITLE=chore(release): v3.24.0`. The call exited 0 and logged no warning.
- The merge used the subject from the first arming.

What is inferred: enabling auto-merge on a PR that already has it enabled leaves the stored subject in place. The `gh pr merge` manual and GitHub's auto-merge docs don't say what a second `--auto` does. Disabling first removes the stored request, so the next enable stores the current subject.

The stub tests prove the call order, not GitHub's behavior. Confirm the fix on the next release PR that is renamed while armed.

## Prevention

- If a PR's title can change after auto-merge is armed, disable and re-enable auto-merge on every change. Don't assume a second `--auto` call updates anything.
- After a release, compare the merge commit subject with the PR title:

  ```bash
  gh pr view <n> --json title,mergeCommit -q '.title, .mergeCommit.oid'
  git show -s --format=%s <merge-commit-oid>
  ```

- When querying a PR timeline for auto-merge history, include `AUTO_SQUASH_ENABLED_EVENT`. A squash arming is recorded under that type, not `AUTO_MERGE_ENABLED_EVENT`.

## Related Issues

- #1170, the fix.
- #1160, the affected release PR.
- [The PR title selects the release type under squash merge](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md). Auto-merge's stored subject is the exception to the title rule described there.
- [The scheduled release gate refused every release PR because API-created commits have a web-flow committer](release-gate-rejects-api-created-release-commits-2026-10-14.md), about the same refresh job, which also creates commits through the API.
