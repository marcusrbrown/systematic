---
title: Verification delegated into a fresh worktree measures nothing until dependencies exist
date: 2026-08-18
category: workflow-issues
module: delegated-verification
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Delegating work into a newly created git worktree, clone, or container
  - A subagent is asked to run gates or tests after making edits
  - A delegated report contains missing-package or missing-export errors
  - Interpreting whether a gate failed or could not run
tags:
  - git-worktree
  - delegated-work
  - verification
  - subagents
  - dependencies
---

# Verification delegated into a fresh worktree measures nothing until dependencies exist

## Context

A subagent was dispatched to apply content edits inside a freshly created `git worktree`. It made the edits correctly, then reported its verification exactly as it found it:

```text
bun scripts/content-integrity.ts
→ SyntaxError: js-yaml.mjs missing a default export

bun test tests/unit
→ 84 passed / 34 failed / 22 errors
→ missing zod, js-yaml, jsonc-parser
```

Read quickly, that is a broken branch: a malformed dependency import and three dozen failing tests. Read correctly, it is an empty `node_modules`. A new `git worktree` shares repository history with the primary checkout but not its installed dependencies.

After `bun install --frozen-lockfile`, content-integrity was clean and the suite ran normally.

The subagent did nothing wrong and overclaimed nothing. The defect was in the dispatch: it asked for verification in an environment where verification could not run, and the resulting output was shaped exactly like substantive findings.

## Guidance

A delegation brief that names a fresh environment must also name its preparation, or its verification results carry no information.

State the setup step explicitly, before the gates:

```text
Before verifying, prepare the worktree:
  bun install --frozen-lockfile

Then run:
  bun scripts/content-integrity.ts
  bun test tests/unit
```

Require the report to distinguish three states, not two:

- **Passed** — the gate ran against the intended source and found nothing.
- **Failed** — the gate ran and found a substantive defect.
- **Blocked** — the gate could not run because the environment was incomplete.

If dependency installation is deliberately out of scope, the brief should say so and instruct the subagent to report verification as blocked rather than presenting resolution errors as findings.

## Why This Matters

A caller who cannot tell "the gate failed" from "the gate could not run" draws the wrong conclusion in the expensive direction: reverting correct changes, or chasing defects that do not exist. In this case the edits were correct and the branch was healthy, and the report read as though neither were true.

The failure mode is specific to environments that look complete. A fresh worktree has the full source tree, correct git metadata, and every config file — everything except the one directory that is gitignored by design. Nothing about it signals "not ready."

This is also why the orchestrator should not accept a delegated verification result at face value. The subagent's report was accurate about what it observed; only the caller had the context to know that what it observed was meaningless.

## When to Apply

- Delegating edits or verification into a new `git worktree`, clone, container, or temp checkout.
- Reviewing any delegated report whose failures name missing modules, absent exports, or unresolved imports.
- Comparing results between environments where one is freshly created.
- Writing a brief that ends in "then run the tests" for an environment the subagent did not build.

## Examples

Insufficient brief — verification looks requested, but cannot succeed:

```text
Apply the content edits in /tmp/worktree and run the integrity check
and unit tests.
```

Usable brief — preparation named, states separated:

```text
Apply the content edits in /tmp/worktree.

Prepare the environment first:
  bun install --frozen-lockfile

Then verify:
  bun scripts/content-integrity.ts
  bun test tests/unit

Report setup failures separately from gate failures. If dependencies
cannot be installed, mark verification blocked; do not report missing
packages or imports as defects in the edited source.
```

Reconciling a report that arrives anyway:

```bash
# In the delegated environment, before believing any failure:
ls node_modules >/dev/null 2>&1 || echo "no dependencies installed — results are void"
```

## Related

- [`../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md) — the inverse hazard in the same family: there the environment carried *too much* ambient state and had to be isolated; here it carried too little and had to be provisioned. Both make a test result describe the environment rather than the code.
- [`registry-drift-on-skill-description-change-2026-05-20.md`](registry-drift-on-skill-description-change-2026-05-20.md) — also about delegation briefs being incomplete: there the missing piece was which generator commands to run, here it is whether the gates can run at all.
- [`../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md`](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md) — worktree scoping producing observations that do not describe the intended target.
