---
title: The workflow guard was removed
date: 2026-10-19
last_updated: 2026-10-19
category: best-practices
module: workflow-guard
problem_type: tooling_decision
component: development_workflow
severity: medium
applies_when:
  - You are reading a plan or learning that describes the workflow guard, receipts, or the operation observer
  - A config file still sets `workflow_guard`
  - You are deciding whether to add an observation gate for agent behavior
tags:
  - workflow-guard
  - removal
  - receipts
  - operation-observer
  - superseded
  - config-compatibility
---

# The workflow guard was removed

Tracked in [#1153](https://github.com/marcusrbrown/systematic/issues/1153). The workflow guard, its receipt ledger, and the operation observer are gone from the plugin. This note records why, what users see, and what stays. The plans and learnings that describe the guard are kept as history and marked superseded by this note.

## What was removed

- The guard runtime: `opencode-workflow-guard`, `workflow-guard`, `receipt-ledger`, `receipt-readback`, `receipt-classifier`, and `question-attestation` in `src/lib`.
- The local operation observer, `opencode-operation-observer`, which took the worktree and remote snapshots the guard relied on.
- The four `systematic_workflow_start`, `systematic_workflow_status`, `systematic_workflow_complete`, and `systematic_workflow_control` tools, and the `tool.execute.before` and `event` hooks that fed the guard.
- The guard guidance that the bootstrap added when the guard was on, and the guard-only unit and integration suites.
- The `web-tree-sitter` and `tree-sitter-bash` dependencies, which only the guard's command classifier used.

## Why

- **No proven value.** The guard was an observation gate for an honest agent. It never caught a real skipped step.
- **Size.** It was about 19.5k lines of source and about 45k lines of tests.
- **Churn.** More than 24 pull requests fixed it, and most of the recent ones closed a hole that the previous fix exposed.
- **Per-call cost.** Each observed tool call took two synchronous worktree snapshots.

## What users see

- **Default configuration:** nothing. The guard had been off by default since 3.23.0.
- **`observe` mode:** the receipts, the status tools, and the guidance block are gone.
- **`protected` mode:** the guard no longer blocks guarded commits, pushes, pull-request creation, or completions.
- **A `workflow_guard` key in config:** still accepted from every source with any value, ignored, and logged as one warning per file per load. The warning names the file and the key, never prints the value, and links to the configuration reference. Delete the key to silence it.
- **A model that calls a removed tool name from earlier in a session:** OpenCode reports an invalid-tool result and the turn continues.

## What stays

- Skill output restoration after the host truncates it.
- The bootstrap prompt and the `<SYSTEMATIC_WORKFLOWS>` block.
- The config hook, the config schema, and the capability snapshot.
- Pi and the Claude Code bundle, which never carried the guard.

## History

Guard plans and learnings keep their text and carry `status: superseded` with a `superseded_by` link to this note. The pattern in the async-commit learning, that a read which commits on return must detect any change made while it waited, still applies beyond the guard.

## Related

- [#1153](https://github.com/marcusrbrown/systematic/issues/1153), the removal
- [Configuration reference: Removed Settings](https://fro.bot/systematic/reference/configuration#removed-settings)
