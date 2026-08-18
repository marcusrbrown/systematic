---
title: A green release job is not evidence that anything was published
date: 2026-08-18
category: integration-issues
module: release-workflow
problem_type: integration_issue
component: tooling
symptoms:
  - A workflow_dispatch release run concluded successfully but published nothing
  - The release log ended with a success line naming a version that does not exist in the registry
  - The same log contained an earlier warning that the publish step was skipped
  - Dispatches from the default branch always published; dispatches from other branches never did, regardless of the input
root_cause: config_error
resolution_type: config_change
severity: critical
tags:
  - github-actions
  - semantic-release
  - expression-precedence
  - npm-publishing
  - dry-run
---

# A green release job is not evidence that anything was published

## Problem

A release workflow triggered with `-f dry-run=false` finished with conclusion `success` and logged `✔ Published release 2.33.4 on v2-temp channel`. Nothing reached the registry. The dry-run input had been ignored for every manual dispatch since the expression was written.

## Symptoms

- `gh workflow run main.yaml --ref <branch> -f dry-run=false` completed with all jobs green.
- The log's closing line named a published version and channel.
- Earlier in the same log: `⚠ Skip step "publish" of plugin "@semantic-release/npm" in dry-run mode`.
- `npm view <pkg>@<version>` returned nothing, and the named dist-tag did not exist.
- Behavior split by branch: dispatches from the default branch always published for real, dispatches from anywhere else never did — in both cases ignoring what the caller asked for.

## What Didn't Work

Reading the job conclusion. A green check means the workflow completed without erroring, which it did — semantic-release ran successfully in dry-run mode and exited zero.

Reading the tool's own closing line. `✔ Published release …` is emitted in dry-run mode too; it reports the action that *would* be taken. Taken alone it is indistinguishable from a real publish.

## Solution

Two defects, one masking the other.

The expression relied on precedence that does not hold:

```yaml
DRY_RUN: ${{ github.event_name == 'pull_request' || github.event.inputs.dry-run && 'true' || 'false' }}
```

`&&` binds tighter than `||`, and a `workflow_dispatch` input arrives as a **string**. With `dry-run=false` this evaluates as:

```text
false || ('false' && 'true') || 'false'   →   'true'
```

The string `'false'` is truthy, so the flag was `'true'` for every dispatch.

A later step then forced it back:

```yaml
- name: Get Release Options
  env:
    INPUT_DRY_RUN: ${{ ... }}          # computed, never read
    IS_DEFAULT_BRANCH: ${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
  run: |
    if [[ $DRY_RUN != 'true' || $IS_DEFAULT_BRANCH == 'true' ]]; then
      echo "DRY_RUN=false" >> $GITHUB_ENV
    fi
```

That override is why ordinary releases worked at all, and therefore why the first bug stayed invisible. It also meant a deliberately requested dry run on the default branch performed a **real release**.

The fix parenthesizes the intent and compares against the string explicitly:

```yaml
DRY_RUN: ${{ (github.event_name == 'pull_request' || github.event.inputs.dry-run == 'true') && 'true' || 'false' }}
```

The override step is then deleted rather than left to contradict the input — once the expression is correct, every event the workflow handles already arrives with the right value.

## Why This Works

The corrected expression enables dry-run only when the event is a pull request or the input is exactly the string `"true"`. Push events carry no inputs, so they evaluated false before and evaluate false now — ordinary releases are unaffected.

The deeper point is about evidence. Three separate signals all indicated success: the job conclusion, the closing log line, and the absence of any error. None of them observed the artifact. The only check that could distinguish the two outcomes was querying the registry.

## Prevention

- **Verify the artifact, not the job.** After a release run, query the registry or release API for the version and channel. A workflow conclusion describes the workflow, not its effect.
- **Never rely on truthiness for a dispatch input.** Inputs arrive as strings, so `'false'` is truthy. Compare explicitly: `inputs.x == 'true'`.
- **Parenthesize any expression mixing `&&` and `||`.** The ternary idiom `cond && 'a' || 'b'` is only safe when `cond` is a single parenthesized expression.
- **Suspect a masking override when a bug is branch-dependent.** Behavior that differs by branch for a branch-independent input means something downstream is rewriting the value.
- **Treat a computed-but-unread variable as a defect signal.** `INPUT_DRY_RUN` existed and was never referenced, which is what allowed two contradictory sources of truth to coexist unnoticed.
- **Prove a CI expression fix by running it**, not only by tracing it. A truth table catches precedence errors; only an actual dispatch proves the pipeline behaves.

## Related Issues

- [`../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md) — the same shape one layer out: every mechanical gate passed while the produced artifact was defective. There the fix was to read the artifact as installed; here it is to query the registry.
- [`../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md) — another way a release pipeline completes successfully while shipping nothing, decided by the commit subject rather than a workflow input.
- [`../developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`](../developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md) — on trusting what the release tooling appears to report versus what it actually does.
