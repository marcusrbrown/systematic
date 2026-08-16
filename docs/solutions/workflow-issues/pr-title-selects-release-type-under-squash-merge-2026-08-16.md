---
title: PR title selects the release type in a squash-only repo
module: .releaserc.yaml + release-pipeline
date: 2026-08-16
problem_type: workflow_issue
component: development_workflow
severity: medium
tags:
  - semantic-release
  - conventional-commits
  - squash-merge
  - release-pipeline
  - pr-workflow
applies_when:
  - Opening or retitling a PR whose change is user-visible but whose conventional type may not publish
  - Deciding the conventional type for a removal, cleanup, or internal-sounding change
  - Verifying what a merge will actually publish before clicking merge
---

# PR title selects the release type in a squash-only repo

## Context

This repository allows squash merges only:

```bash
gh api repos/marcusrbrown/systematic \
  --jq '{squash:.allow_squash_merge, merge:.allow_merge_commit, rebase:.allow_rebase_merge,
         title:.squash_merge_commit_title, msg:.squash_merge_commit_message}'
# {"squash":true,"merge":false,"rebase":false,
#  "title":"COMMIT_OR_PR_TITLE","msg":"COMMIT_MESSAGES"}
```

`squash_merge_commit_title: COMMIT_OR_PR_TITLE` means the PR title becomes the squash commit's subject line whenever a branch has more than one commit. That subject is the only thing `@semantic-release/commit-analyzer` reads to decide the release type.

`.releaserc.yaml` uses `preset: conventionalcommits` and adds exactly these rules:

```yaml
analyzeCommits:
  releaseRules:
    - {type: build, release: patch}
    - {type: build, scope: dev, release: false}
    - {type: docs, release: patch, scope: readme}
    - {type: docs, release: patch, scope: readme.md}
    - {type: docs, release: patch, scope: skill}
    - {type: docs, release: patch, scope: skills}
    - {type: docs, release: patch, scope: agents}
    - {type: docs, release: patch, scope: commands}
```

Everything else falls through to the preset defaults, which publish on `feat` (minor), `fix` (patch), and `perf` (patch) — and on nothing else. `refactor`, `test`, `chore`, `style`, and `ci` all appear in `presetConfig.types` and therefore show up as changelog *sections*, which makes them look like releasing types. They are not. A `refactor:` PR merges to `main`, produces a commit, produces no version, and publishes no package.

## Guidance

**Before merging, ask what the change does for the user, then pick the conventional type that publishes it. Appearing in `presetConfig.types` does not mean a type triggers a release.**

Releasing types in this repo:

| Type | Result |
|---|---|
| `feat` | minor |
| `fix` | patch |
| `perf` | patch |
| `build` (unscoped) | patch |
| `docs` with scope `readme`/`skill`/`skills`/`agents`/`commands` | patch |
| `refactor`, `test`, `chore`, `style`, `ci`, `build(dev)` | **no release** |

A removal is not automatically a `refactor`. If deleting code changes what users observe at runtime — smaller payload, less latency, fewer bytes on the wire, less data leaked — `perf` or `fix` is the honest type and it ships. Reserve `refactor` for changes with no observable difference.

Two checks worth running while the PR is open:

```bash
# What header will the squash produce?
gh pr view <N> --json title --jq .title

# Which rules are actually configured?
grep -A20 'releaseRules' .releaserc.yaml
```

Retitling is a one-line fix while the PR is open and costs nothing:

```bash
gh pr edit <N> --title "perf(bootstrap): remove redundant bootstrap skill catalog"
```

## Why This Matters

PR #786 removed Systematic's duplicated `<available_skills>` bootstrap catalog. It cut the generated bootstrap payload from 18,145 to 6,232 characters — a 65.6% reduction on every prompt of every session — and removed 23 absolute machine paths from prompt output. Both effects are user-visible.

It was titled `refactor(bootstrap): remove redundant bootstrap skill catalog`. Merged under that title it would have landed on `main`, published nothing, and sat unreleased until some unrelated later commit happened to trigger a version bump — at which point the improvement would ship inside another change's release notes, uncredited and undiscoverable. It was retitled to `perf(bootstrap):` before merge and shipped as a patch.

The failure mode is quiet in both directions. Nothing errors. CI is green. The merge succeeds. The only symptom is a release that never happens, which is invisible unless someone is specifically watching for it.

## When to Apply

- Any PR whose diff is mostly deletions but whose effect is user-visible
- Any PR titled `refactor`, `test`, `chore`, `style`, or `ci` that you expect to ship
- Any PR where the branch has multiple commits, since that is when the PR title — not a commit subject — becomes the release-deciding header
- When adding a new conventional type to `presetConfig.types`, confirm whether it also needs a `releaseRules` entry; the two lists serve different purposes

## Examples

### Wrong: internal-sounding type for a user-visible change

```text
refactor(bootstrap): remove redundant bootstrap skill catalog
```

Merges cleanly. Publishes nothing. The 65.6% payload reduction reaches no user until an unrelated commit drags it out.

### Right: the type that matches the observable effect

```text
perf(bootstrap): remove redundant bootstrap skill catalog
```

Merges cleanly and publishes a patch release carrying the change on its own terms.

### Squash body is prefilled from branch commits

`squash_merge_commit_message: COMMIT_MESSAGES` concatenates every branch commit message into the squash body. A branch commit subject that disagrees with the retitled header will appear inside the release notes:

```text
perf(bootstrap): remove redundant bootstrap skill catalog (#786)

refactor(bootstrap): remove redundant bootstrap skill catalog   <- stale branch subject
...
```

Either reword the branch commit before merging, or edit the squash body in the merge dialog. The header still drives the release type; the stale line is a cosmetic leak into a public artifact.

## Related

- [`docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`](../developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md) — the adjacent trap: the release *type* comes from the subject, and the release *notes* ignore the body entirely
- [`docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md`](../best-practices/release-notes-narrative-procedure-2026-05-23.md) — what to do after a release publishes
- `.releaserc.yaml` — source of truth for `releaseRules` and `presetConfig.types`
- PR #786 / commit `a875314` — where the near-miss was caught
