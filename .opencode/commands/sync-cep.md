---
name: sync-cep
description: Sync upstream CEP definitions into Systematic using convert-cc-defs. Detects changes, converts files, reports override conflicts, and prepares issue/PR summaries.
argument-hint: "[all|skills|agents|commands] [--dry-run]"
subtask: true
---

# Sync CEP Definitions

Run the CEP re-sync workflow via the `convert-cc-defs` skill.

## Arguments

<target>$1</target>
<dry-run>$2</dry-run>

Defaults:
- target: `all`
- dry-run: `false`

## Identity

You are running a CEP-to-Systematic re-sync. Your output must be structured and machine-parseable so CI can build issue and PR summaries without guessing.

## Core Behavior

- Always read `sync-manifest.json` before any conversion.
- Never overwrite manual overrides.
- Never auto-import new upstream definitions or auto-delete removed ones; report only.
- Produce a single, deterministic summary.

## Feature: Pre-check Gate

- Use the pre-check JSON output (if available) to decide whether to proceed.
- If no changes are detected, stop and report “no changes.”

## Feature: Conversion Run

- Invoke the `convert-cc-defs` skill for the selected target scope.
- Apply the re-sync workflow steps in that skill (mechanical conversion + intelligent rewrite + merge).

## Feature: Issue/PR Dedupe

- Reuse branch `chore/sync-cep` for all sync PRs.
- If a PR exists for that branch, update it instead of creating a new one.
- Use or create a tracking issue labeled `sync-cep` and append run summaries as comments.

## Feature: Conflict Detection

Use the override merge matrix:
- Upstream unchanged + override exists → keep override
- Upstream changed + override on SAME field → conflict, report only
- Upstream changed + override on DIFFERENT field → apply upstream, preserve overrides
- Override is `"*"` → skip re-sync entirely

## Feature: Output Formatting

Produce a summary with:
- Changed / unchanged / skipped counts
- Per-definition hash table
- Conflicts list
- New upstream definitions list (report-only)
- Upstream deletions list (report-only)
- Rewrite failures list
- Phantom references list

### Output Sections

Include the following sections in both issue and PR bodies:
- Summary
- Hash changes table (definition, old hash, new hash)
- Conflicts (manual overrides)
- New upstream definitions (report-only)
- Upstream deletions (report-only, include keep/remove prompt)
- Rewrite failures
- Phantom references (commands referencing missing agents/skills)

## Boundaries

- Do not create PRs/issues or branches (CI handles that).
- Do not auto-merge conflicts.
- Do not modify files outside `agents/`, `skills/`, `commands/`, and `sync-manifest.json`.
