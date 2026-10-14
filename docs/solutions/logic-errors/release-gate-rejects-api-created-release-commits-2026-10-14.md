---
title: The scheduled release gate refused every release PR because API-created commits have a web-flow committer
date: 2026-10-14
category: logic-errors
module: release-pipeline
problem_type: logic_error
component: development_workflow
symptoms:
  - "Skip: Release PR commit authors must all be systematic-release[bot], found: systematic-release[bot], web-flow."
  - "The scheduled gate never approved a release PR; 3.22.1, 3.22.2 and 3.22.3 shipped only after manual approval"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [release-gate, commit-authorship, web-flow, commit-verification, github-git-data-api, auto-approval, release-pr]
---

# The scheduled release gate refused every release PR because API-created commits have a web-flow committer

## Problem

The gated release flow approves the pending `release/pending` PR on a Wednesday and Sunday schedule (`.github/workflows/release-gate.yaml`), and auto-merge then ships it. The gate required every commit's author and committer to be the release App. GitHub records commits created through the API with `web-flow` as the committer, so the gate refused every release PR. Fixed in #1120.

## Symptoms

- The release-gate run on 2026-10-14 at 15:05 UTC decided (pre-fix message): `Skip: Release PR commit authors must all be systematic-release[bot], found: systematic-release[bot], web-flow.`
- Every release so far needed a maintainer to approve the release PR by hand.

## What Didn't Work

- **Treating author and committer as one list.** `gate-decide.ts` flattened both logins into `headCommitAuthors`, and `gate.ts` required every entry to equal the App. That shape cannot tell a commit the App created through the API from a commit anyone else made.

## Solution

The refresh job in `.github/workflows/release.yaml` creates the release commit through the Git Data API (`git/blobs`, `git/trees`, `git/commits`) using the App token. GitHub records such a commit with:

- author: the App (`systematic-release[bot]`);
- committer: `web-flow` ("GitHub");
- `commit.verification.verified: true`, reason `valid`, because GitHub signs it.

The gate now gathers per-commit facts in `scripts/release/gate-decide.ts`. Only a literal `true` counts as verified:

```ts
headCommits: requireArray(commits, 'PR commits').map((commit) => ({
  author: stringOrEmpty(dig(commit, 'author', 'login')),
  committer: stringOrEmpty(dig(commit, 'committer', 'login')),
  verified: dig(commit, 'commit', 'verification', 'verified') === true,
})),
```

`scripts/release/gate.ts` checks each commit:

```ts
for (const commit of pr.headCommits) {
  if (commit.author !== app) {
    return `Release PR commit author must be ${app}, found: ${commit.author || 'none'}.`
  }
  const trusted =
    commit.committer === app ||
    (commit.committer === WEB_FLOW_LOGIN && commit.verified)
  if (!trusted) {
    return `Release PR commit committer must be ${app} or a verified ${WEB_FLOW_LOGIN} commit, found: ${commit.committer || 'none'}.`
  }
}
```

Refused: a human author (including a commit made in the web UI, which has the human as author and `web-flow` as committer), a missing author or committer, an unverified `web-flow` committer, any other committer, and a PR with no commits.

The publish-time checks (`verify-merge.ts`, `gather-publish-facts.ts`, `decide-publish.ts`) only check the PR author, so they were never affected.

## Why This Works

When a commit is created through the API without an explicit committer, GitHub records `web-flow` as committer, so that login carries no trust signal. The gate now accepts a commit when GitHub reports the App as author and signed it as `web-flow`. Verification shows that GitHub signed the commit, not who requested it. Who can produce such a commit is bounded by the holders of the release App token and by the `release/**` branch ruleset (declared in `.github/settings.yml`), which limits pushes to the App. A commit made in the web UI carries its human author, so the gate refuses it.

Commit identity is checked only at the gate. The publish step relies on the attested head and checks the PR author.

The release PR #1115 commit (`131ee627`) has the accepted shape: author App, committer `web-flow`, verified.

## Prevention

- When a check trusts commit identity, read author and committer separately. Commits created through the API or the web UI always have `web-flow` as committer.
- Do not trust the committer login. Pair GitHub's verification flag and the author with a branch ruleset that limits who can write to the branch.
- Test the real commit shape the automation produces: App author, `web-flow` committer, verified. Also test the refusals: human author, unverified `web-flow`, missing fields.
- When adding a deterministic gate, read the decision reason of its first scheduled run. A gate that always skips looks the same as a gate with nothing to approve.

## Related Issues

- #1094 (gated release), #1100 (OIDC-only publish), #1115, #1120
