---
title: Parallel Renovate runs opened duplicate PRs for one branch
date: 2026-10-19
category: integration-issues
module: dependencies
problem_type: integration_issue
component: development_workflow
symptoms:
  - "PRs #1163 and #1164 were opened at the same second for `renovate/all-minor-patch`, both titled `chore(dev): update dependency typebox to v1.4.1`"
  - "Two Renovate runs each logged `Branch created` and then `PR created` for the same branch, with the two `PR created` lines 170 ms apart"
root_cause: config_error
resolution_type: config_change
severity: medium
tags: [renovate, github-actions, concurrency, reusable-workflow, duplicate-pr, dependency-dashboard]
---

# Parallel Renovate runs opened duplicate PRs for one branch

## Problem

Four Dependency Dashboard edits made within ten seconds started four Renovate runs at the same time. Two of them each created the same branch and each opened a PR for it. The reusable Renovate workflow's concurrency group was unique per run, so it never serialized anything. Fixed in bfra-me/.github#2903.

## Symptoms

- #1163 and #1164 were opened by the `mrbro-bot` GitHub App, the token Renovate runs with, in the same second. They had the same title, base, and head branch, `renovate/all-minor-patch`.
- Two runs each logged `Branch created` and then `PR created`. The two `PR created` lines were 170 ms apart, so neither run saw the other's PR.
- In 11 seconds the branch received three distinct commits, each force-pushed over the last. The runs were racing to write the same branch, not pushing one shared commit.

## What Didn't Work

- **Suspecting the repository's Renovate config.** The config decides what to update. The race comes from how many runs execute at once.
- **A concurrency group in this repository's calling workflow.** That would have fixed this repository but left every other consumer of the reusable workflow open to the same race.
- **A workflow-level group in the reusable workflow.** Every `issues` or `pull_request` edit starts a run, even when the `renovate` job's `if:` skips it. If a skipped run can take the group's single pending slot, it displaces a pending run that has real work to do. That behavior is not confirmed (see Why This Works), and the group went on the job to avoid relying on it.

## Solution

`.github/workflows/renovate.yaml` here runs on `issues: edited` and calls `bfra-me/.github/.github/workflows/renovate.yaml`. Before bfra-me/.github#2903, the reusable workflow had this workflow-level group:

```yaml
concurrency:
  group: ${{ github.repository }}-${{ github.workflow }}-${{ github.run_number || github.ref }}
  cancel-in-progress: false
```

`github.run_number` is different for every run, so each run got a group of its own. bfra-me/.github#2903 removed that block and added a group to the `renovate` job:

```yaml
    # Job-level, so runs whose job is skipped never take a slot in the group.
    # Runs that write share one group per repository so they never race to create the same branch or PR.
    # Dry runs (pushes to non-default branches) stay ungrouped.
    concurrency:
      group: ${{ github.repository }}-${{ github.workflow }}-${{ (github.event_name == 'push' && github.ref != 'refs/heads/main') && github.run_id || 'write' }}
      cancel-in-progress: false
```

The dry-run test uses the same predicate as the workflow's existing `dry_run` input. `docs/workflows/renovate.md` in bfra-me/.github has a Concurrency section that records the behavior below.

## Why This Works

According to GitHub's [concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), under the default `queue: single` a group holds at most one pending job, and a newly queued job replaces it. The page describes only what `cancel-in-progress: true` does. The fix relies on the default, `false`, leaving the running job alone.

With every write run in the `...-write` group, a burst of edits yields one running job and at most one pending job. The pending job starts after the running one finishes, finds the branch and PR, and has nothing to create. A replaced pending job loses no work, because every Renovate run processes the whole repository and dashboard, not only the edit that started it. Don't set `queue: max` on this group: a long queue only repeats the same full pass.

Dry runs use `github.run_id`, so each keeps its own group and never waits on or replaces a write run.

Not confirmed:

- **Skipped jobs.** GitHub's docs don't say whether a job skipped by its `if:` takes a concurrency slot. The job-level placement assumes it doesn't.
- **Rollout.** The fix reaches this repository when the bfra-me/.github pin moves to a release that includes #2903.

## Prevention

- Don't put a per-run value (`run_number`, `run_id`, `run_attempt`) in the concurrency group of a job that changes shared remote state. Use a constant group for the write path, and keep per-run groups for runs that must not block each other, such as dry runs.
- Put the group on the job when the job has an `if:`, so runs that skip the job can't occupy the queue.
- Next to the group, write down that a newer pending run replaces an older one, and why that is safe for this job.
- Prove serialization by starting two write runs and checking that the second one waits as pending. A feature-branch push gets the dry-run group, which never queues behind write runs, so it can't show serialization.
- To find duplicate open PRs that share a head branch:

  ```bash
  gh pr list --state open --limit 500 --json number,headRefName \
    -q 'group_by(.headRefName)[] | select(length > 1)'
  ```

Known limit: the dry-run test compares against `refs/heads/main`. If the default branch has another name, its pushes get per-run groups. The existing `dry_run` input has the same limit.

## Related Issues

- bfra-me/.github#2903, the fix.
- #1163 and #1164, the duplicate PRs.
