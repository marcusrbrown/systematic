---
title: A trusted step that runs after the agent needs its own job
date: 2026-11-09
category: security-issues
module: .github/workflows/fro-bot.yaml
problem_type: security_issue
component: development_workflow
symptoms:
  - "The approval backstop, a step holding the bot's personal access token, ran with if: always() in the same job as the agent step"
  - "The agent step and the backstop shared the job's gh config, HOME, GITHUB_ENV and GITHUB_PATH"
  - "Scheduled and dispatched agent runs leave the workflow token readable by the model through gh auth token"
root_cause: scope_issue
resolution_type: workflow_improvement
severity: high
tags: [github-actions, trust-boundary, job-isolation, branch-protection, required-checks, agent-sandbox, credential-scope]
---

# A trusted step that runs after the agent needs its own job

## Problem

A workflow gave a model a shell in one step and then ran a trusted step, holding a credential, later in the same job. A later step in a job is not isolated from an earlier one. They share the runner's home directory and `gh` configuration, the files the runner uses to apply `$GITHUB_ENV` and `$GITHUB_PATH`, and the workspace. Whatever the model can write there can change what the trusted step does or sees. The fix is a job boundary, not a better script.

## Symptoms

- The `Dismiss disallowed Fro Bot approvals` step ran `if: always()` after the agent step in the agent's job. It carried the bot's personal access token and called `gh api` and `jq` from `PATH`.
- Nothing between the two steps reset the shared state. The agent action clears only its own process's `GH_CONFIG_DIR` when it withholds a credential, and a search of its runtime source found nothing that validates or resets `$GITHUB_ENV` or `$GITHUB_PATH`. The default `gh` configuration under `$HOME`, those two files and the workspace stay as the model left them.
- Which of those paths a model could use to change the backstop was reasoned from the action's source, not shown with a working test. The unconfirmed ones were a `gh` configuration key that redirects the API, a step-level `env:` entry versus a `$GITHUB_ENV` entry for the same key, and writes to the runner's file-command files. The fix below does not depend on confirming any of them.

## What Didn't Work

- **Hardening the step in place.** Running `gh` with an empty config directory and a minimal environment closes some paths, but it rests on a precedence rule between step `env:` and `$GITHUB_ENV` that was not verified, and the job still shares the workspace and runner. It was considered and not used.
- **Relying on the script being inline.** The backstop's `run:` text comes from the workflow file, not the workspace, so the model cannot edit it. The inputs it reads and the tools it resolves are the exposed part.
- **Counting on the credential being withheld.** On `pull_request`, `issue_comment` and `issues` triggers the action withholds the credential from the model. That covers the model's own environment and the config directory it would use. It does not cover the rest of the job.

## Solution

Move the trusted step into its own job. In `.github/workflows/fro-bot.yaml:895-940` the `approval-backstop` job is named `Fro Bot approval backstop`. It declares `needs: fro-bot`, runs on a fresh runner with `permissions: {}`, has no checkout, and has no `uses:` step. Its only step is the original script, unchanged, including the fail-closed `exit 1` when reviews cannot be listed.

The agent job passes what the backstop needs as a declared job output: `outputs.allowed` at `.github/workflows/fro-bot.yaml:672-674` carries the approval-rule result. The backstop runs on `always()`, skips when the agent job was skipped, and acts only when the output is not `true` on a pull request event or a comment on a pull request.

Then make the new job a required check in all three places that list required checks, so a backstop failure still blocks a merge:

- the main ruleset, `Fro Bot approval backstop` at `.github/settings.yml:60`;
- the branch-protection contexts, `Fro Bot approval backstop` at `.github/settings.yml:111`;
- the release gate's list, `--required-check "Fro Bot approval backstop"` at `.github/workflows/release-gate.yaml:69`.

The job reports `skipped` on bot and allowed pull requests. The release gate accepts `skipped` for it (see the comment at `.github/workflows/release-gate.yaml:48-50`). Pull requests that were open before the change have no such check until their next push or a re-run.

## Why This Works

A job is a fresh machine. Nothing the agent step wrote to the first runner's home directory, environment files, `PATH` or workspace exists in the second one. The channel between them is the set of declared job outputs, which are plain strings. The backstop's credential lives in a job whose steps are one script and no third-party actions. Making the check required means its failure blocks the merge instead of being advisory. That covers both failure branches: the reviews cannot be listed, or a disallowed approval could not be dismissed. A first version of the job only warned on a failed dismissal, so the required check passed while the approval stayed. The script now still tries every approval, collects the ids it could not dismiss, and then fails with an error naming them (`.github/workflows/fro-bot.yaml:933-945`).

## Prevention

- **Treat any step after a model-driven step in the same job as untrusted-adjacent.** If it holds a credential, or makes a decision someone relies on, give it its own job. Pass data through job outputs and artifacts you validate.
- **Keep the isolated job minimal:** `permissions: {}`, no checkout, no `uses:` steps unless you must, and pin an explicit credential only in the step that needs it.
- **Register the job as a required check everywhere the repository lists them** (ruleset, branch protection contexts, any merge or release gate that carries its own list), then run the repository's settings and workflow tests. Allow `skipped` where the job legitimately does not run.
- **Make every failure path of a security backstop fail the job.** A warning that lets the job pass leaves the protected condition unenforced. The backstop tests run the real step script with stubs and expect a failed dismissal to fail the job while the remaining approvals are still tried (`tests/unit/fro-bot-workflow.test.ts:866-907`).
- **Pin the topology in a test.** The `approval backstop job` suite at `tests/unit/fro-bot-workflow.test.ts:767-823` asserts that the backstop is its own job that `needs` the agent job, has no `uses:` step, holds empty `permissions`, and reads the agent job's `allowed` output. Add the same kind of assertion for the three required-check lists.

## Residual: scheduled and dispatched agent runs

On `schedule` and `workflow_dispatch` runs the action resolves the credential mode to `provision` in its `resolveResponseDelivery` logic (`packages/runtime/src/agent/response-delivery.ts` in `fro-bot/agent`). Only `pull_request`, `issue_comment` and `issues` runs get `withhold`; every other event name, including `pull_request_review_comment`, falls through to `provision`. For `provision` runs, `configureGhAuth` in `src/services/setup/gh-auth.ts` exports `GH_TOKEN` and writes a `hosts.yml` into a temporary `GH_CONFIG_DIR`, and `src/services/setup/setup.ts` exports both for later steps. A comment in `gh-auth.ts` calls this an honest residual: the token is readable by the model's own shell, for instance through `gh auth token`, and the design does not close deliberate exfiltration. This was checked against the agent repository's `main` at `b7aa5f84d`.

The reason is `branch-pr` delivery. In that mode the prompt tells the model to commit, push and open the pull request itself, so the model needs a write credential. Brokered push, where the action pushes the model's changes with a credential the model never sees, applies only to the `pull_request`, `issue_comment` and `issues` triggers.

Remedies, in order of how complete they are:

1. The action can extend brokered delivery to `schedule` and `workflow_dispatch`, so the model edits the working tree and the action pushes.
2. An adopter can split the workflow: `output-mode: working-dir` with a token for the agent job that cannot write contents, then a publish job on a fresh runner that applies the change, validates the paths and pushes with a token minted only in that job. A sibling repository documents the same draft-and-publish split. This is the job-boundary rule applied to delivery.
3. `persist-credentials: false` on the checkout is worth doing but is not enough. It removes the credential from `.git/config` and leaves `hosts.yml`.
4. A classic personal access token can inherit broad user permissions. Where supported, use a fine-grained token restricted to the necessary repositories and permissions, or an appropriately scoped GitHub App token; a token cannot grant permissions its user lacks. Rotate the token if you suspect exposure.

This repository's autoheal runs use `branch-pr` on a schedule with the bot token, so it carries the residual until one of the first two remedies is adopted. The threat is prompt injection through content the model reads on those runs, not an outside caller with a token, since fork pull requests and non-collaborator triggers are excluded in the workflow's job condition.

## Related Issues

- [Release token scoping, and why the publish token cannot be scoped to read a repository variable](release-token-scoping-and-the-variables-permission-gap-2026-11-09.md)
- [A PR comment asking Fro Bot for a change never reached the branch without trusted-head-sha](../integration-issues/brokered-push-needs-trusted-head-sha-2026-10-14.md)
- [Express a fill-gaps-only guarantee as merge position, not a policy check](../best-practices/merge-chain-position-as-a-structural-guarantee-2026-09-20.md)
