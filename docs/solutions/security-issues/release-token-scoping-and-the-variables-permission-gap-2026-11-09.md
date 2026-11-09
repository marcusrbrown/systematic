---
title: Release token scoping, and why the publish token cannot be scoped to read a repository variable
date: 2026-11-09
category: security-issues
module: .github/workflows/release.yaml
problem_type: security_issue
component: authentication
symptoms:
  - "A GitHub App token minted with only an app id and a private key carries every permission the installation has"
  - "Adding any permission-* input to the publish token's mint would leave the hold recheck unable to read the RELEASE_HOLD variable"
  - "The hold recheck fails closed with: Could not read RELEASE_HOLD; refusing to publish."
root_cause: config_error
resolution_type: config_change
severity: medium
tags: [github-app, create-github-app-token, least-privilege, release-workflow, repository-variables, permission-scoping]
---

# Release token scoping, and why the publish token cannot be scoped to read a repository variable

## Problem

The release workflow mints a GitHub App token in two credentialed jobs, `publish` and `refresh`. Both mints passed only `app-id` and `private-key`. With no `permission-*` input, `actions/create-github-app-token` gives the token every permission the App's installation holds. The obvious hardening is to list the permissions each job needs. That is right for one job and wrong for the other: the publish job reads a repository variable, and the action has no input that grants access to variables.

## Symptoms

- Both mints had only `app-id` and `private-key`, so each token carried the full installation permission set. The action's README says: "By default, the token inherits all of the installation's permissions."
- The publish job rechecks the live `RELEASE_HOLD` repository variable through the API with the App token. A token scoped with any `permission-*` input would not be able to read it. That behavior was reasoned from the permission list below. It was not exercised against a live release, because a failed attempt would block one.
- When that read fails for any reason other than a 404, the recheck fails closed and nothing publishes. The workflow's message is `Could not read RELEASE_HOLD; refusing to publish.`

## What Didn't Work

Rejected alternatives. None was run against a live release; the first is reasoned from the permission list.

- **Scoping the publish mint like the refresh mint.** `actions/create-github-app-token` at the pinned commit generates its `permission-*` inputs from a permissions list of 56 keys (for example `actions`, `contents`, `environments`, `pull_requests`, `secrets`, `workflows`), and none is for variables. The `actions` key is described as "GitHub Actions workflows, workflow runs, and artifacts". GitHub's published REST description of installation-token permissions has no variables key either. The Variables permission exists on the App's own registration page, but a token request cannot ask for a subset that includes it.
- **Reading the `vars` context, or dropping the recheck.** `vars` is a snapshot taken when the job starts, so removing the live recheck would miss a hold set mid-run. The recheck keeps such a hold limiting publishing to a maintainer approval.

## Solution

Treat the two mints differently and say why in the file.

The `refresh` job mints its token with `permission-contents: write` and `permission-pull-requests: write`, scoped to this repository. The permissions come from what the job does: Git Data API writes need contents, and the release PR create, edit, close and auto-merge calls need pull requests. See the `Create release App token` step in `.github/workflows/release.yaml:345-352`, which carries `permission-contents`.

The `publish` job leaves its mint unscoped by permission on purpose and documents the reason next to it. The mint is still limited to the current repository because it sets neither `owner` nor `repositories`, the job is gated by `environment: release`, and its condition requires the default branch. See `.github/workflows/release.yaml:182-192` for the `Create release App token` comment and mint, and `.github/workflows/release.yaml:104-110` for the `publish` job's main-only condition and environment.

```yaml
# Limited to this repository (no `owner` or `repositories`) but deliberately
# not limited by permission: the hold recheck reads a repository variable.
- name: Create release App token
  uses: actions/create-github-app-token@<sha>
  with:
    app-id: ${{ secrets.RELEASE_APP_ID }}
    private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

## Why This Works

An App installation token has the installation's permissions unless the request narrows them, and a request can only narrow to permissions the token API can express. Variables is not among them. For the publish job the choice is therefore all of the installation's permissions on this repository, or no hold recheck. The workflow keeps the recheck and bounds the exposure by other means: one repository, an environment gate, and a main-only job.

A test makes the choice visible. If someone later adds a `permission-*` input to the publish mint, the test fails, and the comment above it says the hold recheck has to change with it.

## Prevention

- **Pin both mints in a test.** `tests/unit/release-workflow.test.ts:382-384` asserts that the `publish` mint's scope is empty. `tests/unit/release-workflow.test.ts:978-983` asserts that the `refresh` scope is exactly `permission-contents: write` and `permission-pull-requests: write`. The helper `appTokenScope` at `tests/unit/release-workflow.test.ts:559-571` also asserts that neither mint sets `owner` or `repositories`.
- **Derive each scoped mint from every use of the token in the job:** each API call, each `gh` command, each `git push`, each action input. If any use is ambiguous, keep that permission and leave a comment saying why. Under-scoping a release job stops releases.
- **Before scoping a mint that later reads a repository variable, check the action's permission list.** If the variable read is on a mint you want to narrow, the narrowing is not available. Decide whether to keep the mint broad, or to move the read to a step that uses a different credential.
- **Choose the token's target deliberately.** With no `owner` and no `repositories`, the token covers only the current repository. With `owner` alone it covers every repository in the installation. Add `repositories` to name the few that are needed.
- **Gate token-minting jobs to the default branch in the job condition.** A manually dispatched run uses the workflow file from the ref it was dispatched on, so a branch can carry its own copy of a job that mints a token. Prefer also limiting the environment that holds the App secrets to the default branch. That is a repository setting and does not show in the workflow file.

## Related Issues

- [A workflow test asserted an exact action SHA, so every Renovate bump failed the Test check](../test-failures/release-workflow-test-pins-action-sha-2026-10-14.md)
- [The scheduled release gate refused every release PR because API-created commits have a web-flow committer](../logic-errors/release-gate-rejects-api-created-release-commits-2026-10-14.md)
- [A trusted step that runs after the agent needs its own job](trusted-step-after-the-agent-needs-its-own-job-2026-11-09.md)
