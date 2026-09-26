---
title: jq's // operator treats false as missing, so a fork check refused every same-repo PR
date: 2026-09-26
category: logic-errors
module: pull-request-workflow
problem_type: logic_error
component: development_workflow
symptoms:
  - "`@fro-bot` comments on same-repo PRs get no response"
  - "Run fails at 'Refuse fork PR heads from comment triggers' with `Refusing to check out fork PR head from comment trigger (PR #1029, fork=unknown).`"
root_cause: wrong_api
resolution_type: config_change
severity: medium
tags: [jq, github-actions, fro-bot, fork-check, fail-closed]
---

# jq's `//` operator treats `false` as missing, so a fork check refused every same-repo PR

## Problem

In the Fro Bot workflow, the comment-trigger guard refused every same-repo pull request. Mentioning `@fro-bot` on a PR from this repository never reached the agent.

## Symptoms

- A reply to a review on #1029 got no response.
- Run 36228154810 failed at `Refuse fork PR heads from comment triggers`:
  `##[error]Refusing to check out fork PR head from comment trigger (PR #1029, fork=unknown).`

## What Didn't Work

The guard looked correct. Fork PRs were refused, which is the case it was written for. Nothing ever tested the allowed case, a same-repo PR passing through.

## Solution

`.github/workflows/fro-bot.yaml` read the fork flag with jq's alternative operator:

```yaml
# before
is_fork=$(gh api "repos/${{ github.repository }}/pulls/${pr_number}" --jq '.head.repo.fork // "unknown"')

# after
is_fork=$(gh api "repos/${{ github.repository }}/pulls/${pr_number}" --jq 'if .head.repo.fork == null then "unknown" else (.head.repo.fork | tostring) end')
```

The `if [ "$is_fork" != "false" ]` refusal check is unchanged. The fix (#1030) was verified against three inputs:

- #1029 produced `false`.
- `{"head":{"repo":{"fork":true}}}` produced `true`.
- `{"head":{"repo":null}}` produced `unknown`.

`actionlint` passed.

## Why This Works

jq's `a // b` returns `b` when `a` is `false` or `null`, not only when it is `null`. A non-fork PR has `fork: false`, so the old expression turned it into `"unknown"` and the fail-closed check refused it:

```sh
jq -n 'false // "unknown"'   # "unknown"
jq -n 'null // "unknown"'    # "unknown"
```

An explicit `== null` test keeps a real `false` and still fails closed when the field is missing.

## Prevention

- Never use `//` to supply a default for a field that can legitimately be `false`. Use `if . == null then … else … end`.
- For fail-closed guards, test that the allowed case passes, not only that the refused case is refused.
- Before trusting a jq default, run the expression against a live payload that contains `false` (`gh api … --jq '<expr>'`).
- Give workflow-only fixes a `ci(...)` title, not `fix(ci)`. In this repo a `fix` title triggers an npm patch release.

## Related Issues

- #1030 (fix), #1029 (where it surfaced)
- [`../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md`](../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md): another workflow condition that coerced an implicit value
