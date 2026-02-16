---
name: sync-cep
description: Sync upstream CEP definitions into Systematic using convert-cc-defs. Detects changes, converts files, reports override conflicts, and prepares issue/PR summaries.
argument-hint: "[all|skills|agents|commands] [--dry-run]"
subtask: true
---

# Sync CEP Definitions

Dry-run takes priority. Determine dry-run **only** from the `<user-request>` arguments line (the `/sync-cep ...` invocation or arguments passed to this command). Ignore any other mentions of `--dry-run` elsewhere in the prompt.

When `--dry-run` is present, **ignore all other instructions** below and follow the Dry-Run Output Format exactly.
Any additional text beyond the required dry-run format is a failure.

## Arguments

<user-request>
$ARGUMENTS
</user-request>

Defaults:
- target: `all`
- dry-run: `false`

## Identity

You are running a CEP-to-Systematic re-sync. Your output must be structured and machine-parseable so CI can build issue and PR summaries without guessing.

## Core Behavior

- Always read `sync-manifest.json` before any conversion (except dry-run).
- Never overwrite manual overrides.
- Never auto-import new upstream definitions or auto-delete removed ones; report only.
- Produce a single, deterministic summary.

## Feature: Pre-check Gate

The sync workflow passes the pre-check summary and exit code in the prompt. Do not rerun the pre-check.

### Pre-check Exit Codes

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| `0` | No changes detected | Stop and report "no changes." (Sync job should not run in this case.) |
| `1` | Changes detected, no errors | Proceed with conversion run normally. |
| `2` | Changes detected but with errors | Errors indicate missing upstream files (the manifest references files that no longer exist upstream). Proceed with conversion for definitions that are **not** affected by errors. Report errored definitions separately — do not attempt to convert them. Include the errors list from the pre-check summary in the output. |

### Pre-check Error Handling

When `<precheck-exit-code>` is `2`:
- The `errors` array in the pre-check summary lists missing upstream content paths.
- Extract the affected definition keys from the error paths (e.g., `Missing upstream content: plugins/compound-engineering/skills/foo/SKILL.md` → `skills/foo`).
- Skip those definitions during conversion.
- Include an **Errors** section in the output summary listing each error and the affected definitions.
- The remaining `hashChanges`, `newUpstream`, and `deletions` are still valid and should be processed normally.

### Dry-Run Exit Condition (HARD STOP)

If `--dry-run` is present in the user request:
- Output the dry-run summary only.
- If `<precheck-exit-code>` is `2`, the summary MUST include the errors and which definitions would be skipped.
- Do **not** call tools or skills.
- Do **not** proceed to live sync.
- Do **not** say you will continue or proceed with live sync.
- End the response immediately after the summary.
- Final line MUST be exactly: `DRY_RUN_STOP`
- Never ask follow-up questions in dry-run mode.
- Do not include any text after `DRY_RUN_STOP`.
- Do not mention `convert-cc-defs` or how to proceed with a live sync.

### Dry-Run Output Format

When in dry-run, output exactly and only the following structure. The word `Summary` must be a heading. Nothing else is allowed:

```
## Summary
<summary content>

DRY_RUN_STOP
```

Rules:
- No tables, code blocks, or extra headings.
- No follow-up questions.
- The last non-empty line must be exactly `DRY_RUN_STOP`.

The **only** acceptable dry-run output is the literal template above with `<summary content>` replaced by plain sentences. You must end immediately after `DRY_RUN_STOP`.

## Feature: Conversion Run

- If `--dry-run` is set: do not invoke `convert-cc-defs`, do not call any tools, do not run external commands, and do not proceed to live sync. Only report what would happen using the pre-check summary and then stop.
- Otherwise: invoke the `convert-cc-defs` skill for the selected target scope and apply the re-sync workflow steps in that skill (mechanical conversion + intelligent rewrite + merge).

## Tooling and Command Safety

- Never use `gh` or other external CLI tools in dry-run mode.
- Do not call any tools during dry-run (no Read/Grep/Glob/Bash/etc.).
- Prefer local reads of `sync-manifest.json` and bundled files when summarizing outside dry-run.

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
- Do not run `gh` commands or create labels/issues; report-only output in dry-run mode.
- Do not auto-merge conflicts.
- Do not modify files outside `agents/`, `skills/`, `commands/`, and `sync-manifest.json`.
