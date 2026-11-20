---
title: A called workflow's `github` context is its caller's, so identify the callee with `job.workflow_*` and take every setting as an input
date: 2026-11-20
category: best-practices
module: ce-connect
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "A workflow becomes a `workflow_call` callee that repositories in other owners call"
  - "A step in the callee needs its own repository, commit or files, or reads `vars`, `secrets` or `github.*`"
  - "A later job in a callee downloads an artifact or restores a cache that an earlier job wrote"
tags: [github-actions, reusable-workflow, workflow-call, job-context, cross-owner, ce-connect, cache, artifacts]
last_refreshed: 2026-11-20
---

# A called workflow's `github` context is its caller's, so identify the callee with `job.workflow_*` and take every setting as an input

## Context

`.github/workflows/connect.yaml` now declares only `on: workflow_call` (`.github/workflows/connect.yaml:23-24`, `workflow_call`), and a thin wrapper owns the cron, the manual dispatch, the permissions ceiling and the settings (`.github/workflows/connect-scheduled.yaml:29`, `uses: ./.github/workflows/connect.yaml`), so a repository in another owner can call the same file. In a called workflow `github.*` and `vars` belong to the caller, not to the workflow's own repository. GitHub states that [the `github` context is always the caller's](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#github-context) and that [`job.workflow_*` names the reusable workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context). A live probe of a local call and a call from another owner showed the same split (`HARNESSES.md:311`, CN-7).

## Guidance

1. **Name the callee through `job.workflow_*`, never `github.*`.** In the probe, `github.repository`, `github.ref`, `github.event.repository.default_branch` and `github.event_name` named the caller, and `github.event_name` was the caller's event, never `workflow_call`. `job.workflow_repository`, `job.workflow_sha` and `job.workflow_file_path` named the callee. Read the SHA, not `job.workflow_ref`: the ref was a branch on the local call and the 40-hex SHA on the cross-owner one (`HARNESSES.md:311`, CN-7). GitHub's contexts reference says that if you "dereference a nonexistent property, it will evaluate to an empty string" ([contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)), so a wrong name here fails quietly. The same page lists `job.workflow_*` as unavailable on GitHub Enterprise Server, so a callee that relies on it does not run there.

2. **Check the callee out through those values, in the step that needs it.** This workflow's comment says `job.workflow_*` exists at step level only (`.github/workflows/connect.yaml:456-462`, the comment above `Check out the shared agent action`). The step takes a sparse checkout of `.github/actions` from the callee's own repository at its own commit, into a subdirectory, with no persisted credential (`.github/workflows/connect.yaml:463-473`, `Check out the shared agent action`). The comment names the point: a caller cannot put its own code in the action's place. The probe's default job token was enough to check out a public repository in another owner (`HARNESSES.md:311`, CN-7).

3. **Guard on the caller's event and default branch, and know whose they are.** The `prepare` and `run` jobs share one `if:` that reads `github.event_name` and `github.event.repository.default_branch`. Both are the caller's, so a wrapper on any other trigger, or a run on any other branch, starts nothing (`.github/workflows/connect.yaml:90-92`, `prepare` `if`; `.github/workflows/connect.yaml:449`, `run` `if`).

4. **Take every setting as an input and read no `vars`.** In the probe, `vars` resolved against the caller's repository: Systematic's variable was empty in the cross-owner call (`HARNESSES.md:311`, CN-7). The callee reads none, and the wrapper passes each repository variable as an input (`.github/workflows/connect.yaml:18-21`, the header comment; `.github/workflows/connect-scheduled.yaml:30-35`, `with`). The code assumes that a wrapper passing an unset variable sends an empty string, so the callee normalizes empty values in one place, before any checkout or write: an empty optional input gets its default, and an empty required one fails red (`.github/workflows/connect.yaml:115-120`, the comment above `Validate configuration`; `.github/workflows/connect.yaml:158`, `STEP_TIMEOUT="${STEP_TIMEOUT:-40}"`). The wrapper adds no fallback of its own.

5. **Name each secret, and test for emptiness yourself.** `secrets: inherit` [only works within one organization or enterprise](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#passing-inputs-and-secrets-to-a-reusable-workflow), so the wrapper passes both secrets by name, which is also what a foreign caller must do (`.github/workflows/connect-scheduled.yaml:8-10`, the comment; `.github/workflows/connect-scheduled.yaml:36-38`, `secrets`). A secret passed by name reached the callee in both probe calls (`HARNESSES.md:311`, CN-7). `required: true` on a callee secret [only checks that the caller passes it, not that it has a value](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow), so `prepare` compares each secret to the empty string in the expression and hands the step a boolean (`.github/workflows/connect.yaml:46-52`, `secrets`; `.github/workflows/connect.yaml:130-131`, `HAS_AUTH_JSON` and `HAS_OPENCODE_CONFIG`; `.github/workflows/connect.yaml:118-120`, the comment on why the value never reaches a step environment).

6. **Let the caller's job set the permissions ceiling.** GitHub says the [called workflow can only downgrade the `GITHUB_TOKEN` permissions it receives, never raise them](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#supported-keywords-for-jobs-that-call-a-reusable-workflow). The wrapper's call job grants `contents: read` and `issues: write` (`.github/workflows/connect-scheduled.yaml:23-28`), and the callee starts at `permissions: {}` and grants each job its own subset (`.github/workflows/connect.yaml:54`; `.github/workflows/connect.yaml:93-95`, `prepare`; `.github/workflows/connect.yaml:450-451`, `run`). The probe's logged grant under a callee `contents: read` and a caller `contents: read` was `Contents: read` and `Metadata: read`, and a top-level `permissions: {}` in the callee widened nothing (`HARNESSES.md:311`, CN-7). A callee that asks for more than its caller grants was not tested (same entry).

7. **Expect the caller's repository to scope concurrency and the cache.** The callee's concurrency group is per caller repository, so the wrapper sets none and the callee names its own (`.github/workflows/connect.yaml:56-61`, `concurrency`). `cancel-in-progress: false` with `queue: max` is accepted in a callee and queues runs in order (`HARNESSES.md:311`, CN-7). The ledger cache is saved and restored in the caller's repository, scoped to its ref (same entry).

8. **Mind the cache version and the hit flag.** Save and restore must list the same `path` values, because [the cache version is a hash of the compression tool and the `path`](https://github.com/actions/cache#cache-version): a restore with a different path misses even when the key matches (`HARNESSES.md:311`, CN-7). The restore here uses a prefix key, and `cache-hit` is `false` on a prefix match ([`actions/cache` restore outputs](https://github.com/actions/cache/blob/main/restore/README.md)), so `prepare` reads `cache-matched-key` instead (`.github/workflows/connect.yaml:253-255`, `restore-keys`; `.github/workflows/connect.yaml:260-269`, `CACHE_MATCHED_KEY`).

9. **Pass an artifact's name by job output, never rebuild it from the attempt.** When only the failed jobs are rerun, [jobs that are not rerun keep their outputs from the previous attempt](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), and in the probe only the attempt-1 artifacts existed afterwards, so a later job that rebuilt the name from `github.run_attempt` would ask for `-2` (`HARNESSES.md:311`, CN-7). Each producing job therefore outputs the name it uploaded under, and each consumer downloads by that output (`.github/workflows/connect.yaml:417-423`, `Name hand-off`; `.github/workflows/connect.yaml:103`, `handoff` output; `.github/workflows/connect.yaml:492`, `Download hand-off`).

## Why This Matters

Each of these fails without an error, and testing only in the author's own repository hides every one of them: that repository is where `github.*`, `vars` and the callee's files all happen to agree.

## When to Apply

When a workflow becomes callable from another repository, or a callee hands state between jobs by cache or artifact.

## Examples

The callee's checkout names its own repository and commit, copied from `.github/workflows/connect.yaml:466-467`:

```yaml
repository: ${{ job.workflow_repository }}
ref: ${{ job.workflow_sha }}
```

## Not verified

- A callee that asks for more permission than its caller grants, a tag-pinned cross-owner call and a job-scoped token for the compare request were not observed (`HARNESSES.md:311`, CN-7, the not-observed list).
- That an unset repository variable arrives as an empty string is what the wrapper and callee code assume, not a probe observation: the wrapper passes `vars.FRO_BOT_CONNECT_VARIANT` as it is (`.github/workflows/connect-scheduled.yaml:34`, `variant`) and the callee applies `VARIANT` only when it is non-empty (`.github/workflows/connect.yaml:128-152`, `VARIANT`).

## Related

- [`share-one-composite-agent-step-between-the-headless-and-interactive-workflows-2026-11-13.md`](share-one-composite-agent-step-between-the-headless-and-interactive-workflows-2026-11-13.md): the composite action that the callee checks out here.
- [`prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md`](prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md): how a client proves that a run in another repository called this workflow.
- [`spike-cross-owner-workflow-behaviour-with-push-triggered-stub-probes-2026-11-20.md`](spike-cross-owner-workflow-behaviour-with-push-triggered-stub-probes-2026-11-20.md): how the facts above were observed.
- [`pinned-helper-and-installed-client-skew-in-a-reusable-workflow-rollout-2026-11-20.md`](../integration-issues/pinned-helper-and-installed-client-skew-in-a-reusable-workflow-rollout-2026-11-20.md): the rollout hazards of the same split.
- [`report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md`](../integration-issues/report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md): the callee's other pinned-code hazard.
- [Cross-project connections guide](../../src/content/docs/guides/cross-project-connections.mdx): how a caller sets up the wrapper.
