---
title: Ship a one-shot release for an older major without moving the default install
date: 2026-08-18
category: best-practices
module: npm-release-management
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Publishing a single fix for users pinned to a previous major version
  - The latest dist-tag must keep pointing at the current major
  - No ongoing support channel for the older major is wanted
  - Release automation is configured for the mainline branch only
tags:
  - npm
  - dist-tags
  - semver
  - maintenance-release
  - release-management
---

# Ship a one-shot release for an older major without moving the default install

## Context

A fix was needed for users still on the previous major, who could not upgrade because the new major removed bundled content they depended on. The requirement was to reach those users without creating a maintenance line — no standing channel, no public support commitment, no change to what a fresh install receives.

The hazard is that `npm publish` defaults to `--tag latest` **regardless of semver ordering**. Publishing `2.33.4` while `latest` pointed at `3.12.1` would have moved `latest` backward, so every subsequent `npm install <pkg>` would have delivered the old major. npm does not protect against this.

## Guidance

Dist-tags do not participate in semver range resolution. A consumer with `^2.33.0` or `^2` resolves to the highest published version matching that range whether or not a tag points at it. That single fact is what makes a one-shot possible:

1. Publish under a throwaway dist-tag, never `latest`.
2. Verify the version resolves and that `latest` is unchanged.
3. Delete the throwaway tag.
4. Re-verify — the version must still resolve by range and by exact reference.

Scope the release-automation change to the maintenance branch. If the tool is configured for one branch, add the maintenance entry **on that branch only** and never merge it, so mainline publishing behavior is untouched.

Prefer publishing through CI rather than locally. A local publish loses provenance attestation if the package publishes with it enabled, which would make the maintenance version the only one in the package's history without one.

## Why This Matters

Leaving the temporary tag in place converts a one-off into an advertised channel with unclear ownership and no stated lifecycle. Users discover it, depend on it, and reasonably expect it to keep receiving fixes.

Skipping the tag entirely is worse: the publish silently retargets `latest` to an older major, and the symptom appears as new users installing outdated software with no error anywhere.

The step most likely to be skipped is the final verification. Deleting a dist-tag is a mutation on the same registry metadata that governs installs, so confirm the range still resolves afterward rather than assuming deletion only removed the tag.

## When to Apply

- Backporting a fix to a major version the mainline has moved past.
- Any publish of a version lower than the current `latest`.
- Serving users blocked from upgrading by breaking changes, without committing to a support line.
- Running release automation from a branch that must not alter mainline release behavior.

## Examples

Publish to a throwaway channel, verify, then retract the tag:

```bash
# Publish under a temporary channel — never `latest` for an older major
npm publish --tag v2-temp

# Confirm the version landed and `latest` did not move
npm view <pkg>@2.33.4 version          # → 2.33.4
npm view <pkg> dist-tags               # → { "latest": "3.12.1", "v2-temp": "2.33.4" }

# Retract the temporary channel
npm dist-tag rm <pkg> v2-temp

# Re-verify after deletion — this is the step that proves the one-shot worked
npm view '<pkg>@^2.33.0' version       # → resolves to 2.33.4
npm view <pkg>@2.33.4 version          # → 2.33.4
npm view <pkg> dist-tags               # → { "latest": "3.12.1" }
```

Branch-scoped automation config, with the constraint stated where an editor will see it:

```yaml
# This entry publishes a single maintenance release and exists only on the
# maintenance branch. It must never be merged to the mainline branch.
branches:
  - main
  - name: fix/v2-dispatch-identifiers
    range: 2.33.x
    channel: v2-temp
```

## Related

- [`../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`](../workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md) — the mainline counterpart: what decides whether a release happens at all.
- [`../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md`](../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md) — verifying a publish actually occurred, which is the check this practice depends on at every step.
