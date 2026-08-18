---
title: A lint count is not a project fact until the input set is defined
date: 2026-08-17
category: workflow-issues
module: lint-baseline
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A local metric disagrees with CI and tool versions already match"
  - "Generated or gitignored output may exist in the working tree"
  - "A lint, test, or warning count is about to be quoted in a PR or commit message"
  - "A repository-wide command traverses the filesystem rather than tracked files"
tags:
  - lint
  - baseline
  - gitignored-artifacts
  - generated-output
  - reproducibility
  - metrics
---

# A lint count is not a project fact until the input set is defined

## Context

`bun run lint` is `biome check .` (`package.json:43`), with Biome pinned at `2.5.8`.

That command walks the filesystem, not the git index. `claude-code/` is gitignored build staging (`.gitignore:65`) produced by `scripts/build-claude-code-plugin.ts`, and it contains JavaScript that Biome happily lints.

Measured on the same commit, same Biome version:

| Working tree | Warnings |
|---|---|
| `claude-code/` present | 17 |
| `claude-code/` absent | 11 |

The 6-warning delta came entirely from `claude-code/skills/onboarding/scripts/inventory.mjs`.

The number 17 was quoted repeatedly as "the baseline" — in a PR description and in a commit message — and was only corrected when a reviewer running from a clean checkout reported 11. Version drift was ruled out early because the pin is exact, which made the disagreement look inexplicable. The tool was fine. The working directory was not.

## Guidance

Treat a repository-wide count as a project fact only when its input set is defined by the repository rather than by whoever last ran a build.

Before quoting one:

```bash
git status --short --ignored | grep -v '^!! node_modules'
```

Anything listed under `!!` is present locally, invisible to git, and potentially inside the tool's traversal. If generated output is present, either remove it or state its presence alongside the number.

The reliable version:

```bash
# what a clean checkout would see
git stash --include-untracked   # or remove generated staging explicitly
bun run lint
```

If generated output *should* be linted, say so explicitly and record which build produced it. What fails is the unstated case, where two people run the same command against different filesystems and both believe they measured the repository.

A count is only reproducible when reported with its inputs:

```text
command:        bun run lint
tool version:   Biome 2.5.8
checkout state: clean, no generated staging
result:         11 warnings
```

## Why This Matters

A warning count reads like a property of the code. It is actually a function of four things:

```text
count = tool version × command × configuration × filesystem input set
```

Three of those are version-controlled. The fourth is whatever happens to be on disk. When a command is spelled `.` or `**/*`, gitignored build output silently joins the measurement.

The practical damage is not the wrong number, it is that the wrong number becomes a shared reference point. "Unchanged from baseline" is unfalsifiable when two people hold different baselines, so a real regression can hide inside a stale delta. Quoting the number in a commit message makes it permanent.

## When to Apply

- Before writing any count into a PR description, commit message, or review comment.
- After running a build that emits gitignored output — especially one you then forget about.
- When local and CI results disagree and the tool versions match. Suspect the input set before suspecting the tool.
- When generated output uses a different language or ruleset than the source it was generated from, which is exactly when it produces unfamiliar findings.

## Examples

**Not a fact:**

```text
lint at its 17-warning baseline, unchanged
```

**A fact:**

```text
lint unchanged from `main`
```

Better still, when the number carries weight:

```text
11 warnings from `bun run lint` (Biome 2.5.8, clean checkout).
A local `claude-code/` build adds 6 more from generated output.
```

**Making it structural.** If a single stable number matters, stop relying on working-directory hygiene: scope the command to tracked source, lint generated trees under a separate task, or exclude generated staging in the tool's own configuration. Any of those beats depending on who last ran a build.

## Related

- [`docs/solutions/developer-experience/typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md`](../developer-experience/typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md) — the same shape with a different mechanism: there the green signal is narrowed by `tsconfig` `include` rather than by working-directory state, and it hides an undefined function rather than extra warnings.
- [`docs/solutions/best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md`](../best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — the same failure in prose: a written number that the repository does not support.
- [`docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — ask what the instrument measures before trusting its output; here it measured more than intended.
- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](version-pinned-evidence-must-be-reproven-2026-08-16.md) — adjacent: evidence invalidated by a moving pin rather than by working-directory state.
