---
title: gh statusCheckRollup conclusion is empty string for in-progress jobs, not a failure
module: scripts (CI polling)
date: 2026-05-18
problem_type: developer_experience
component: tooling
severity: medium
tags:
  - gh-cli
  - jq
  - ci-polling
  - pr-checks
  - github-api
applies_when:
  - Writing scripts that poll `gh pr view --json statusCheckRollup` to wait for CI to settle
  - Comparing `conclusion` field values against `"SUCCESS"` to count failures
  - Implementing PR-merge gates or post-push wait loops in shell
---

# gh statusCheckRollup conclusion is empty string for in-progress jobs, not a failure

## Context

The `gh pr view --json statusCheckRollup` response carries one entry per CI check. Each entry has two fields that together describe its state:

- `status`: `QUEUED`, `IN_PROGRESS`, or `COMPLETED`
- `conclusion`: `SUCCESS`, `FAILURE`, `CANCELLED`, `SKIPPED`, `NEUTRAL`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE` — but **only when** `status == "COMPLETED"`

For checks that are still running, `conclusion` is the empty string `""`. Code that compares `conclusion != "SUCCESS"` to count failures will falsely flag every running job as a failure.

This bit a polling loop during the PR #405 cycle. The script used:

```sh
CI_FAILED=$(gh pr view 405 --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.conclusion!="SUCCESS" and .conclusion!="NEUTRAL" and .conclusion!=null)]|length')
```

At iteration 1, three jobs were `IN_PROGRESS` (Fro Bot, CodeQL `Analyze (typescript)`, Docs Build). Each carried `conclusion: ""`, which did not match `"SUCCESS"`, `"NEUTRAL"`, or `null`. The script reported `ci_failed=4` and triggered the "✗ CI failure" break-out branch. There was no actual failure — all 11 checks went on to pass minutes later and the PR merged cleanly.

## Guidance

Filter by `status == "COMPLETED"` **before** evaluating `conclusion`. Two correct jq patterns:

```sh
# Count failed-after-completion (excludes in-progress, excludes SUCCESS, excludes NEUTRAL)
CI_FAILED=$(gh pr view <num> --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.status=="COMPLETED" and .conclusion!="SUCCESS" and .conclusion!="NEUTRAL")]|length')

# Count still-pending (jobs not yet COMPLETED)
CI_PENDING=$(gh pr view <num> --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.status!="COMPLETED")]|length')
```

Treat `NEUTRAL` as non-failing (it covers SKIPPED-via-event-filter jobs and similar). `null` does not appear in normal `statusCheckRollup` responses but harmless to include defensively if desired.

For the loop break-out condition, require BOTH:

1. `ci_pending == 0` (every check has settled)
2. `ci_failed == 0` (none of the settled checks failed)

Failing either condition keeps polling. The merge-state-status check (`mergeStateStatus == "CLEAN"`) is a useful cross-check but is not a substitute — `mergeStateStatus` can lag the actual CI roll-up by a few seconds during the transition.

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

### Right — status filter first

```sh
# GOOD: select(.status == "COMPLETED" and .conclusion != "SUCCESS")
CI_PENDING=$(gh pr view 405 --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.status!="COMPLETED")]|length')
CI_FAILED=$(gh pr view 405 --json statusCheckRollup \
  -q '[.statusCheckRollup[]|select(.status=="COMPLETED" and .conclusion!="SUCCESS" and .conclusion!="NEUTRAL")]|length')

if [ "$CI_FAILED" -gt 0 ]; then
  echo "✗ CI failure"  # only fires when a COMPLETED check has a non-success conclusion
  break
fi

if [ "$CI_PENDING" = "0" ]; then
  echo "✓ All checks settled"
  break
fi
```

### Diagnostic — surface raw state when debugging

The wrong/right blocks above hardcode the actual PR number (`405`) from the incident that prompted this doc. The diagnostic below uses `<num>` because it is general guidance — substitute the PR number under investigation.

```sh
gh pr view <num> --json statusCheckRollup \
  -q '.statusCheckRollup[] | {name, status, conclusion}'
```

This is the fastest way to verify the empty-string-conclusion behavior in your own environment. Run it against a PR that has at least one in-progress check.

## Related

- `docs/solutions/developer-experience/gh-api-heredoc-backtick-escape-2026-05-17.md` — another `gh` CLI rigor lesson, on heredoc body escaping when authoring PR/issue bodies via `gh api -F body=`. Different surface, same category of trap (treating the CLI's surface as a black box rather than verifying field semantics).
