---
title: gh statusCheckRollup conclusion is empty string for in-progress jobs, not a failure
module: scripts (CI polling)
date: 2026-05-18
last_updated: 2026-11-16
problem_type: developer_experience
component: tooling
severity: medium
tags:
  - gh-cli
  - jq
  - ci-polling
  - pr-checks
  - github-api
  - status-context
applies_when:
  - Writing scripts that poll `gh pr view --json statusCheckRollup` to wait for CI to settle
  - Comparing `conclusion` field values against `"SUCCESS"` to count failures
  - Implementing PR-merge gates or post-push wait loops in shell
  - Waiting for a review by a bot on the head commit, or deciding when to stop polling a PR
---

# gh statusCheckRollup conclusion is empty string for in-progress jobs, not a failure

## Context

The `gh pr view --json statusCheckRollup` response carries one entry per CI check. A check run (`__typename` `CheckRun`) has two fields that together describe its state:

- `status`: `QUEUED`, `IN_PROGRESS`, or `COMPLETED`
- `conclusion`: `SUCCESS`, `FAILURE`, `CANCELLED`, `SKIPPED`, `NEUTRAL`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE` — but **only when** `status == "COMPLETED"`

For checks that are still running, `conclusion` is the empty string `""`. Code that compares `conclusion != "SUCCESS"` to count failures will falsely flag every running job as a failure. A commit status (`StatusContext`) has neither field; see Guidance.

This bit a polling loop during the PR #405 cycle. The script used:

```sh
CI_FAILED=$(gh pr view 405 --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.conclusion!="SUCCESS" and .conclusion!="NEUTRAL" and .conclusion!=null)]|length')
```

At iteration 1, three jobs were `IN_PROGRESS` (Fro Bot, CodeQL `Analyze (typescript)`, Docs Build). Each carried `conclusion: ""`, which did not match `"SUCCESS"`, `"NEUTRAL"`, or `null`. The script reported `ci_failed=4` and triggered the "✗ CI failure" break-out branch. There was no actual failure — all 11 checks went on to pass minutes later and the PR merged cleanly.

## Guidance

The rollup mixes two kinds of entry, and each needs its own test. Branch on `__typename`:

| `__typename` | Fields that carry state | Pending when | Failed when |
|---|---|---|---|
| `CheckRun` | `status`, `conclusion` | `status` is not `COMPLETED` | `status` is `COMPLETED` and `conclusion` is not `SUCCESS`, `NEUTRAL` or `SKIPPED` |
| `StatusContext` | `state` only (no `status`, no `conclusion`) | `state` is `PENDING` or `EXPECTED` | `state` is `FAILURE` or `ERROR` |

A `StatusContext` is a commit status, such as Renovate's `renovate/stability-days`. It has `state` and `context` but no `status` or `conclusion`. A filter written for `CheckRun` alone reads the missing `status` as not `COMPLETED`, so the entry counts as pending forever and a loop that waits for `ci_pending == 0` never ends. The same filter never counts a failed `StatusContext`.

```sh
# Count failed entries: completed check runs that did not pass, and failed commit statuses
CI_FAILED=$(gh pr view <num> --json statusCheckRollup -q '[.statusCheckRollup[]
  | select(
      (.__typename=="CheckRun" and .status=="COMPLETED"
        and (.conclusion|IN("SUCCESS","NEUTRAL","SKIPPED")|not))
      or (.__typename=="StatusContext" and (.state|IN("FAILURE","ERROR")))
    )]|length')

# Count pending entries: check runs not yet COMPLETED, and commit statuses not yet decided
CI_PENDING=$(gh pr view <num> --json statusCheckRollup -q '[.statusCheckRollup[]
  | select(
      (.__typename=="CheckRun" and .status!="COMPLETED")
      or (.__typename=="StatusContext" and (.state|IN("PENDING","EXPECTED")))
    )]|length')
```

Break out of the loop only when `ci_pending == 0` (every check has settled) and `ci_failed == 0`. Failing either keeps polling. `mergeStateStatus == "CLEAN"` is a useful cross-check but not a substitute: it can lag the roll-up by a few seconds.

**Evidence.** `NEUTRAL` and `SKIPPED` are conclusions of a completed `CheckRun` and do not fail a PR. The filters were run against two real PRs. #1359 (`CheckRun` ×20, `StatusContext` ×1, plus two `SKIPPED` Fro Bot entries) gave `failed=0 pending=0`. #1429 gave `failed=2 pending=0`: `Host Contract v2 shard 2/4` and `Host Contract`, both `FAILURE`. The earlier form of this doc's filter, `select(.status!="COMPLETED")`, returned #1359's `SUCCESS` `StatusContext` as pending, and `select(.status=="COMPLETED" and .conclusion!="SUCCESS" and .conclusion!="NEUTRAL")` returned both `SKIPPED` entries as failed.

### Waiting for a review on the head commit, and when to stop

A loop that waits on the roll-up also needs two exits the roll-up cannot give it.

- **Stop when the PR is no longer `OPEN`.** A loop that only watches checks keeps polling a merged or closed PR, because nothing in the roll-up changes after merge. Read `state` every iteration and leave on `MERGED` or `CLOSED`.
- **Wait for a review whose `commit.oid` equals `headRefOid`.** A review on an earlier commit says nothing about the code now on the branch. Each entry of `reviews` carries the commit it reviewed, so compare it with the PR head:

```sh
gh pr view <num> --json state,headRefOid,reviews -q '
  .headRefOid as $head
  | {open: (.state=="OPEN"),
     reviewed: ([.reviews[]|select(.author.login=="fro-bot" and .commit.oid==$head)]|length>0)}'
```

Against #1430 this printed `{"open":false,"reviewed":true}`. A force-push changes `headRefOid` and makes every earlier review stale, so re-read it each iteration.

## Why This Matters

A false-positive CI failure in a polling script aborts the loop and triggers the wrong follow-up branch. In a one-off interactive use that may just look weird; in a longer-running automation it can:

- Send a misleading status message to the operator
- Skip the intended *success* branch (e.g., auto-merge, release-tag wait, follow-up dispatch)
- Push the operator to investigate a fictional failure, wasting the very wall-time that polling was meant to save

The shape of the bug is a classic "absent value vs sentinel value" trap: `conclusion: ""` is semantically *"not yet decided"*, not *"decided != SUCCESS"*. jq does not distinguish them when the only filter is `conclusion != "SUCCESS"`. Anchoring on the orthogonal `status` field disambiguates cleanly.

## When to Apply

- Any shell or automation script that polls `gh pr view --json statusCheckRollup`
- Any logic that compares CI `conclusion` against a constant (success or failure)
- Any merge-gate or release-gate that branches on CI roll-up state
- Any loop that waits for a review or for CI and must end on its own once the PR merges or closes

## Examples

### Wrong — counts in-progress jobs as failures

```sh
# BAD: select(.conclusion != "SUCCESS")
CI_FAILED=$(gh pr view 405 --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.conclusion!="SUCCESS" and .conclusion!="NEUTRAL" and .conclusion!=null)]|length')

if [ "$CI_FAILED" -gt 0 ]; then
  echo "✗ CI failure"   # ← fires while jobs are still running
  break
fi
```

The correct filters are under Guidance.

### Diagnostic — surface raw state when debugging

```sh
gh pr view <num> --json statusCheckRollup \
  -q '.statusCheckRollup[] | {__typename, name, context, status, conclusion, state}'
```

Run it against a PR with an in-progress check. Keys that belong to the other entry type print `null`.
