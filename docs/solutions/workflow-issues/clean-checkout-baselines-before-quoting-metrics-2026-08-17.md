---
title: A repository claim is not a fact until the input set is defined
date: 2026-08-17
last_updated: 2026-08-23
category: workflow-issues
module: lint-baseline
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A local metric disagrees with CI and tool versions already match"
  - "Generated or gitignored output may exist in the working tree"
  - "A count, inventory, or tree claim is about to be quoted in docs, a PR, or a commit message"
  - "A repository-wide command traverses the filesystem rather than tracked files"
  - "A tool under test reads ambient user configuration from outside the repository"
tags:
  - baseline
  - gitignored-artifacts
  - reproducibility
  - metrics
  - test-isolation
  - user-config
  - branch-state
  - exhaustive-verification
---

# A repository claim is not a fact until the input set is defined

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

Treat a repository-wide count as a project fact only when its input set is defined by the repository rather than by whoever last ran a build — or by whichever branch happens to be checked out.

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

A checkout on the wrong branch changes the input set too. Stand on the branch the claim will ship on before verifying it:

```bash
git switch <target-branch>
git rev-parse --abbrev-ref HEAD
```

And when the claim is about the tree rather than a number, enumerate the claims rather than searching for one phrasing:

```bash
grep -oh '`[a-z][a-zA-Z0-9_./-]*`' STRUCTURE.md | tr -d '`' \
  | grep -E '^(src|scripts|skills|agents|tests)/' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

Grep finds the phrasing you thought of. An enumeration finds the ones you did not.

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

It is tempting to say three of those are version-controlled and only the filesystem is not. That is not reliable either. When a command is spelled `.` or `**/*`, gitignored build output silently joins the measurement — and when a tool reads ambient user configuration, the configuration factor leaves version control too.

A second instance, one day later, took the configuration path. `bun test tests/unit` produced 8 failing plugin-loading tests on a v2.x checkout, and the same 8 on a pristine checkout of the release tag, which made them look like a known-bad property of that release:

```text
error: Invalid Systematic config in ~/.config/opencode/systematic.jsonc: Unrecognized key: "workflow_guard"
```

The tests load the developer's real user config. That file carries a `workflow_guard` key introduced in the v3 schema, which v2's stricter validation rejects, so plugin init threw. Nothing was wrong with the branch. CI had been green throughout, because runners have no user config at that path.

```bash
OPENCODE_CONFIG_DIR=/tmp/isolated HOME=/tmp/isolated-home bun test tests/unit
# → 1072 pass, 0 fail
```

The reproducible-input rule is the same; only the contaminating factor moved. Worth noting the sharper trap in this variant: repeating the run on a pristine checkout *confirmed* the failures, because the contaminant lived outside the repository entirely and a clean checkout does not touch it. Checking out clean code is not the same as controlling the input set.

A third instance moved the contaminant *inside* git, and it defeats the check at the top of this page. A documentation PR claimed 56 unit test files where it had counted 59, because the count was taken while a feature branch was checked out that adds three test files.

`git status --short --ignored` reports nothing in that situation. The extra files are tracked and clean — they are simply another branch's tracked files. Stashing does not help, and neither does a pristine checkout, because the working tree already *was* pristine. It was pristine for the wrong branch.

The same contamination produced a second error in the same PR, in a different field: the docs described `scripts/generate-review-artifact-schema.ts`, a file that existed only on that feature branch. So the failure is not specific to counts. Any claim about the tree inherits the branch it was read from.

Verification method compounds it. The correction searched for `59 unit test files` and missed a third occurrence worded `Unit tests (59 files)`. Enumerating every documented path instead then found a fourth error nobody was looking for: a `.opencode/commands/` directory still described long after it was removed.

The practical damage is not the wrong number, it is that the wrong number becomes a shared reference point. "Unchanged from baseline" is unfalsifiable when two people hold different baselines, so a real regression can hide inside a stale delta. Quoting the number in a commit message makes it permanent.

## When to Apply

- Before writing any count into a PR description, commit message, or review comment.
- After running a build that emits gitignored output — especially one you then forget about.
- When local and CI results disagree and the tool versions match. Suspect the input set before suspecting the tool.
- When a failure reproduces on a pristine checkout. That rules out your working tree, not the environment around it — ambient config in `$HOME` survives any checkout.
- Before reporting test failures from a checkout of a different major version, where a schema or config contract may have changed underneath a file the tool reads from outside the repository.
- When generated output uses a different language or ruleset than the source it was generated from, which is exactly when it produces unfamiliar findings.
- Before documenting any count, script inventory, or directory. Check out the branch the claim will ship on and recount there; a feature branch in the working tree lends its files to the answer.

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

**A claim that carried its branch.** Not a fact:

```text
tests/unit/       # 59 unit test files
scripts/generate-review-artifact-schema.ts
```

Both were read from a feature branch. On the branch that shipped them, the count was 56 and the script did not exist.

**Making it structural.** If a single stable number matters, stop relying on working-directory hygiene: scope the command to tracked source, lint generated trees under a separate task, or exclude generated staging in the tool's own configuration. Any of those beats depending on who last ran a build.

For documentation, the structural version is a check that enumerates rather than matches — every documented path tested for existence, so a stale claim fails loudly instead of waiting for a reviewer to notice it.

## Related

- [`docs/solutions/developer-experience/typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md`](../developer-experience/typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md) — the same shape with a different mechanism: there the green signal is narrowed by `tsconfig` `include` rather than by working-directory state, and it hides an undefined function rather than extra warnings.
- [`docs/solutions/best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md`](../best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — the same failure in prose: a written number that the repository does not support.
- [`docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — ask what the instrument measures before trusting its output; here it measured more than intended.
- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](version-pinned-evidence-must-be-reproven-2026-08-16.md) — adjacent: evidence invalidated by a moving pin rather than by working-directory state.
- [`docs/solutions/workflow-issues/delegated-verification-needs-a-prepared-environment-2026-08-18.md`](delegated-verification-needs-a-prepared-environment-2026-08-18.md) — the same rule applied to delegation: a gate run in an unprepared environment reports on the environment, not the code.
- [`docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md) — the structural fix for ambient-state contamination: isolate `HOME`, XDG roots, and config paths so the input set stops depending on whose machine runs the command.
