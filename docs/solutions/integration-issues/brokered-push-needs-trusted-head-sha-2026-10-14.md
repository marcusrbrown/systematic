---
title: A PR comment asking Fro Bot for a change never reached the branch without trusted-head-sha
date: 2026-10-14
category: integration-issues
module: pull-request-workflow
problem_type: integration_issue
component: development_workflow
symptoms:
  - "On an issue_comment run, git push failed with \"could not read Username\""
  - "The run log showed \"GitHub CLI credential withheld from child (affected trigger)\""
  - "The agent committed locally, but nothing reached the PR branch"
root_cause: missing_workflow_step
resolution_type: config_change
severity: medium
tags: [fro-bot, brokered-push, trusted-head-sha, issue-comment-trigger, persist-credentials, same-repo-pr]
---

# A PR comment asking Fro Bot for a change never reached the branch without trusted-head-sha

## Problem

A trusted `@fro-bot` comment on a same-repository PR asked for a change. The agent made it and committed it, but the commit never reached the PR branch, so the work was lost with the runner. Fixed in #1117.

## Symptoms

- On PR #1056 (`issue_comment` trigger), the agent merged `main`, edited `.github/renovate.json5`, committed locally, and then `git push` failed with `could not read Username`.
- The log line `GitHub CLI credential withheld from child (affected trigger)` appeared during setup.
- The agent reported the failure honestly. Nothing reached the branch.

## What Didn't Work

- **Concluding that comment runs can never push.** fro-bot/agent has a supported delivery path for this case. Other repositories using the same action already deliver comment fixes.
- **Persisting checkout credentials.** That would hand the agent the token the action deliberately withholds. Checkout must keep `persist-credentials: false`.
- **Changing `output-mode`.** It only governs `schedule` and `workflow_dispatch` runs.

## Solution

Since fro-bot/agent#1170, the action withholds every GitHub credential from the agent on `issue_comment`, `pull_request` and `issues` triggers. Model-provider credentials still reach the agent. The action treats `pull_request_review_comment` and `discussion_comment` as deferred surfaces and still provisions the GitHub credential on them. For a trusted same-repository PR comment it delivers through a **brokered push**: the action rebuilds the agent's local changes ahead of a trusted head SHA and pushes them with its own token. The early brokered-push gate refuses an empty SHA, so nothing happens unless the workflow passes `trusted-head-sha`.

`.github/workflows/fro-bot.yaml` never passed it, and checked out `refs/pull/<n>/head`. The fix extends the existing fork-refusal step to resolve the same-repository head SHA:

```yaml
- name: Refuse fork PR heads from comment triggers
  id: prehead
  if: github.event_name == 'issue_comment' && github.event.issue.pull_request
  # env provides GH_TOKEN, REPO and PR_NUMBER; fork and unknown heads still exit 1
  run: |
    # ...
    sha=""
    if [ "$(printf '%s' "$pr_json" | jq -r '.head.repo.full_name // empty')" = "${REPO}" ]; then
      sha=$(printf '%s' "$pr_json" | jq -r '.head.sha // empty')
    fi
    echo "sha=${sha}" >> "$GITHUB_OUTPUT"
```

Checkout uses that SHA and keeps credentials off disk:

```yaml
ref: >-
  ${{
    steps.prehead.outputs.sha
    || github.event.pull_request.head.sha
    || ''
  }}
persist-credentials: false
```

The action receives the anchor and the repository's content paths:

```yaml
trusted-head-sha: ${{ steps.prehead.outputs.sha }}
# Default brokered-push paths are src/, packages/*/src/ and docs/.
# .github, scripts, package.json and lockfiles stay denied by the action.
brokered-push-extra-paths: skills,agents,tests,registry
```

Pull request events keep their existing checkout, and an empty output leaves `trusted-head-sha` empty, which is the action's default. The SHA is the same-repository head at comment time. It anchors checkout and the push base; it does not mean the code was reviewed, and that head's code runs during the job.

If a comment comes from a PR whose head repository differs but is not marked as a fork, the resolved SHA is empty and checkout falls back to the default branch. No PR code is checked out, but the run does not see the PR head either.

## Why This Works

The brokered push only runs when it has a same-repository head SHA. With it, the action rebuilds the agent's changes as file edits and pushes them with its own token, so the agent never holds a GitHub credential.

The brokered push has limits:

- It hard-denies `.github`, `scripts`, `package.json`, lockfiles, `Dockerfile`, `.git` and similar surfaces. The check applies to every path segment, so `skills/<name>/scripts/` stays denied under the `skills` extra path.
- It allows `src/`, `packages/*/src/`, `docs/`, the root `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md`, plus `brokered-push-extra-paths` (per the fro-bot/agent README and `src/shared/brokered-push-paths.ts` at the pinned version).
- It rebuilds changes as file edits, so it cannot deliver a CI or config change, or a merge from `main`.

The request in #1056 (a `.github/renovate.json5` change plus an update from `main`) could not have been delivered even with the anchor, and was applied by hand. The wiring is covered by tests that run the real resolver step against a stubbed `gh`.

## Prevention

- When adopting fro-bot/agent in a repository, wire `trusted-head-sha` together with `persist-credentials: false`.
- Know the protected-path list before writing `brokered-push-extra-paths`. Never add `.github`, `scripts`, manifests, lockfiles, Dockerfiles or `.git`.
- Ask Fro Bot for config, CI or dependency changes in a scheduled or dispatched run, or make them by hand. Comment runs cannot deliver them.
- Test the head resolver for a same-repository head, a different repository that is not marked as a fork, and a fork.
- Review test changes from comment-triggered runs closely. The `tests` extra path lets such a run edit tests that gate its own PR.

## Related Issues

- #1056, #1117
- `docs/solutions/logic-errors/jq-alternative-operator-treats-false-as-missing-2026-09-26.md`: the fork check on the same comment-trigger step.
- `docs/solutions/best-practices/release-notes-narrative-ci-automation-architecture-2026-05-23.md`: which credential each Fro Bot entry point holds.
- The same symptom and fix are documented in marcusrbrown/panthea, `docs/solutions/integration-issues/brokered-push-anchor-comment-fix-2026-09-29.md`.
