---
title: Spike cross-owner workflow behaviour with push-triggered stub probes, and list what else the push triggers
date: 2026-11-20
category: best-practices
module: ce-connect
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A design rests on GitHub Actions behaviour that no one has observed across two owners, such as context values, `referenced_workflows` or cache scope in a called workflow"
  - "The probe needs a workflow file that is not on the default branch yet"
  - "A probe branch is pushed to a repository that has push-triggered workflows"
tags: [github-actions, spike, probe, cross-owner, reusable-workflow, ce-connect, evidence, cleanup]
last_refreshed: 2026-11-20
---

# Spike cross-owner workflow behaviour with push-triggered stub probes, and list what else the push triggers

## Context

The reusable `ce:connect` workflow rests on behaviour that GitHub's documentation does not settle: what a called workflow sees in `github.*` and `job.*`, what the run API reports for a call from another owner, how the cache, concurrency and rerun behave in a callee, and which way the compare API answers. Before building on them, the behaviour was observed with stub workflows, a local caller and a caller in another owner, and recorded as `HARNESSES.md:311` (CN-7). The facts are in [the callee contract doc](called-workflow-github-context-is-the-callers-use-job-workflow-and-inputs-2026-11-20.md) and [the provenance doc](prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md).

The probe spent no model money and passed only a stand-in secret. Its cost is side effects: push-triggered jobs in the probed repositories would still run with their own secrets, and the cache entries, artifacts and runs stay behind. They are easy to list before the first push and easy to miss after it.

## Guidance

1. **Probe with stubs on a pushed branch.** A stub callee and a stub caller, each on a temporary branch, run on `push`. `workflow_dispatch` is the wrong trigger for a first run: GitHub says that event [only triggers a run if the workflow file exists on the default branch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch). The stubs run no agent, receive only a literal stand-in secret and create no issue, pull request, release or tag (`HARNESSES.md:311`, CN-7). Call the stub callee from the other owner by its full 40-hex SHA. A public callee at a commit that is on no default branch ran without a policy error (`HARNESSES.md:311`, CN-7).

2. **Probe each assumption the code trusts, one observation each.** The spike printed the callee's context values, ran a sparse self-checkout, saved and restored a cache, uploaded an artifact, forced a failed-job rerun to reach attempt 2, pushed back to back to see concurrency queue and cancel, and sent compare-API requests for each status it produced (`HARNESSES.md:311`, CN-7). The compare direction and its answers are in [the provenance doc](prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md). Keep one `path` list for cache save and restore, because [the cache version includes the `path`](https://github.com/actions/cache#cache-version).

3. **Let the run itself test the policy.** The other owner's Actions policy was unreadable with the probe's token (the policy API answered 403), but the call ran, which shows that the policy permits at least this case (`HARNESSES.md:311`, CN-7). Record that as "ran" and keep "the policy" on the not-observed list.

4. **List what else the push triggers, before you push.** A branch push runs every workflow whose `push` trigger matches it, not only the stubs. In Systematic, `renovate.yaml` lists `branches-ignore: [main]`, so a push to any other branch matches its push filter (`.github/workflows/renovate.yaml:10-11`, `branches-ignore`), and the job's `if` lets pushes through (`.github/workflows/renovate.yaml:34-39`). The job passes the repository's own `APPLICATION_ID` and `APPLICATION_PRIVATE_KEY` secrets to the called Renovate workflow (`.github/workflows/renovate.yaml:41-44`, `secrets`). The probe passed none of them, but a push would still start a job that holds them. Read every `on: push` filter in each repository the probe touches, decide whether such a job is acceptable, and write "no provider secrets" in the record, not "no secrets".

5. **Check files with `ls -aR`, or `test -f`.** `ls` [leaves out entries whose names begin with a period unless `-a` is given](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/ls.html), so `ls -R` does not show `.github`. Use `ls -aR`, or `test -f <path>` for the file you expect.

6. **Clean up what a probe leaves, and know what stays.** Delete the probe branches in both repositories. The cache and artifact steps wrote entries into the callers' repositories (`HARNESSES.md:311`, CN-7), so delete them as well, through the [cache](https://docs.github.com/en/rest/actions/cache#delete-a-github-actions-cache-for-a-repository-using-a-cache-id) and [artifact](https://docs.github.com/en/rest/actions/artifacts#delete-an-artifact) APIs, and list both afterwards to confirm none is left. The workflow runs stay. Once the probe workflow files are deleted, a run page may show no workflow definition, and its logs expire on the normal schedule (`HARNESSES.md:311`, CN-7). Keep the run identifiers you need for the evidence record before the files go.

7. **Write the evidence once, in three classes.** CN-7 separates what was observed in a live run, what was read from source and not run, and what was not observed (`HARNESSES.md:311`). Keep that split. The not-observed list is part of the claim: a report issue's author and an Issues write under the narrowed ceiling in a caller, a callee asking for more than its caller grants, a live agent run with repository skills off, a tag-pinned cross-owner call whose `referenced_workflows` suffix may differ, a job-scoped token for the compare request and the other owner's Actions policy. Each line is a place where the code depends on an assumption, and the record says so. Cite the record from the docs, not the scratch notes behind it.

## Why This Matters

A design that rests on an unobserved cross-owner fact can ship a trust check or a checkout that fails open. The stubs make the fact observable at the cost of the side effects above.

## When to Apply

When a design needs a GitHub Actions fact that crosses two owners, the documentation is silent on it, and the probe needs a workflow file on a branch that is not the default.

## Examples

`HARNESSES.md:311` (CN-7) is the model for the record: observed, read from source, and not observed, in that order.

## Related

- [`called-workflow-github-context-is-the-callers-use-job-workflow-and-inputs-2026-11-20.md`](called-workflow-github-context-is-the-callers-use-job-workflow-and-inputs-2026-11-20.md): the callee contract the probe established.
- [`prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md`](prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md): the provenance check built on the compare and `referenced_workflows` observations.
- [`pinned-helper-and-installed-client-skew-in-a-reusable-workflow-rollout-2026-11-20.md`](../integration-issues/pinned-helper-and-installed-client-skew-in-a-reusable-workflow-rollout-2026-11-20.md): the rollout that followed.
- [`hand-probe-a-cross-corpus-capability-before-building-2026-11-09.md`](hand-probe-a-cross-corpus-capability-before-building-2026-11-09.md): the same habit of probing a premise by hand before building.
