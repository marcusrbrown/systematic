---
name: sync-cep
description: Sync upstream CEP definitions into Systematic using convert-cc-defs. Detects changes, converts files, reports override conflicts, and prepares issue/PR summaries.
argument-hint: "[all|skills|agents|commands] [--dry-run]"
subtask: true
---

# Sync CEP Definitions

Dry-run takes priority. Determine dry-run **only** from the `<user-request>` arguments line (the `/sync-cep ...` invocation or arguments passed to this command). Ignore any other mentions of `--dry-run` elsewhere in the prompt.

When `--dry-run` is present, follow the Pre-check Gate to obtain precheck data, then follow the Dry-Run Output Format exactly. **Do not proceed to conversion or PR creation.**
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
- **Focus on CHANGED content only** — If upstream hasn't changed a section, preserve it exactly. Do not make gratuitous modifications.
- Produce a single, deterministic summary.

### Change Detection Critical Rules

| Rule | Reason |
|------|--------|
| Only modify changed portions | Unchanged content should be preserved verbatim |
| `~/.config/opencode/` is correct | Never change this to `~/.opencode/` |
| `question` is the correct tool name | Never change this to `AskUserQuestion` |
| Preserve formatting | Keep trailing newlines, don't strip EOL |
| Report discrepancies | Flag unexpected patterns for human review |

## Skill: convert-cc-defs

Before performing any conversion, use the `skill` tool to load `convert-cc-defs`. Do NOT use the `systematic_skill` tool — `convert-cc-defs` is a project-specific skill, not a bundled Systematic skill.

After loading the skill, follow its workflow: Phase 2 (Mechanical Conversion) for each definition, then Phase 3 (Intelligent Rewrite) for context-aware adjustments, then Phase 4 (Write and Register) to update files and manifest.

The precheck summary contains `hashChanges`, `newUpstream`, `newUpstreamFiles`, and `deletions` arrays. Each entry is a definition path like `skills/brainstorming` or `commands/workflows/review`. Process ALL definition types in the precheck's `hashChanges` array — agents, skills, AND commands. Do not skip a type.

### New Upstream File Lists

The `newUpstreamFiles` field is a map from definition key to its file list (e.g., `{"skills/my-skill": ["SKILL.md", "references/guide.md"]}`). When importing new definitions listed in `newUpstream`, use the file list from `newUpstreamFiles` to fetch ALL files — not just the primary definition file. For skills, this means fetching SKILL.md AND every sub-file (references/, scripts/, assets/, etc.). **Importing only SKILL.md while ignoring sub-files renders most multi-file skills non-functional.**

## Feature: Pre-check Gate

This command supports two modes for obtaining pre-check data. **The pre-check is a prerequisite — it runs before the dry-run decision.** Even in dry-run mode, you must have precheck data (either injected by the workflow or obtained by running the script) before producing the summary.

### Mode 1: Workflow-injected (CI)

When `<precheck-exit-code>` and `<precheck-summary>` XML tags are present in the prompt, use them directly. The sync workflow already ran the pre-check script — do not rerun it.

### Mode 2: Interactive (local session)

When the XML tags are absent, run the pre-check script yourself:

```bash
bun scripts/check-cep-upstream.ts
```

The script outputs JSON to stdout and uses its exit code to signal results:
- The Bash tool captures both stdout (the JSON precheck summary) and the exit code.
- Use the JSON output as the precheck summary and the exit code as the precheck exit code.
- Then proceed with the same exit-code logic described below.

**Note:** If the JSON output is large, you can redirect to a file and read it back:
```bash
bun scripts/check-cep-upstream.ts | tee /tmp/precheck.json; exit ${PIPESTATUS[0]}
```

**Environment:** The script requires `GITHUB_TOKEN` for authenticated GitHub API access. If not set, try `export GITHUB_TOKEN=$(gh auth token)` before running.

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
- Do **not** call conversion tools or skills (no `convert-cc-defs`, no file editing). Running the pre-check script to obtain data is allowed and required in interactive mode.
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

- If `--dry-run` is set: do not invoke `convert-cc-defs`, do not edit files, do not run conversions, and do not proceed to live sync. Only report what would happen using the pre-check summary (which was already obtained as a prerequisite) and then stop.
- Otherwise: invoke the `convert-cc-defs` skill for the selected target scope and apply the re-sync workflow steps in that skill (mechanical conversion + intelligent rewrite + merge).

## Tooling and Command Safety

- Never use `gh` or other external CLI tools in dry-run mode (exception: the pre-check script must run in interactive mode to obtain summary data).
- Do not call conversion tools or edit files during dry-run.
- Prefer local reads of `sync-manifest.json` and bundled files when summarizing outside dry-run.

## Feature: Commit, Branch, and PR (MANDATORY after changes)

After a successful conversion run (not dry-run) that modified any files, you **MUST** create or update a PR. A sync run that changes files but does not produce a PR is a **failed run**.

### Step 1: Check for changes

```bash
git status --porcelain agents/ skills/ commands/ sync-manifest.json
```

If the output is empty, no files were changed — skip to Step 4: Post to tracking issue.

### Step 2: Create branch and commit

```bash
git checkout -B chore/sync-cep
git add agents/ skills/ commands/ sync-manifest.json
git commit -m "chore: sync CEP upstream definitions"
```

### Step 3: Push and create or update PR

First, write the output summary to a temp file for use as the PR body. The summary MUST follow the Output Formatting template (hash changes table, conflicts, errors, etc.):

```bash
cat > /tmp/sync-cep-pr-body.md <<'ENDOFBODY'
## CEP Sync Summary

(paste the full output summary here)
ENDOFBODY
```

Push the branch:
```bash
git push -u origin chore/sync-cep --force-with-lease
```

Check if a PR already exists:
```bash
gh pr list --head chore/sync-cep --state open --json number --jq '.[0].number // empty'
```

- **If a PR number is returned:** update its body:
  ```bash
  gh pr edit <number> --body-file /tmp/sync-cep-pr-body.md
  ```
- **If empty (no PR):** create one:
  ```bash
  gh pr create --base main --head chore/sync-cep \
    --title "chore: sync CEP upstream definitions" \
    --body-file /tmp/sync-cep-pr-body.md \
    --label "sync-cep"
  ```

**Important:** Environment variables do not persist across separate Bash tool calls. Always write the PR body to a file first, then reference it with `--body-file`.

### Step 4: Post to tracking issue

Find the open tracking issue labeled `sync-cep`:
```bash
gh issue list --label sync-cep --state open --json number --jq '.[0].number // empty'
```

- **If an issue exists:** post a comment with the summary and a link to the PR.
- **If no issue exists:** create one with title `CEP Sync Run - YYYY-MM-DD`, label `sync-cep`, and the summary as the body.

### Reuse rules

- Always reuse branch `chore/sync-cep` — do not create timestamped or numbered branches.
- If a PR already exists for that branch, update it instead of creating a new one.
- Always link the PR in the tracking issue comment.

## Feature: Conflict Detection

Use the override merge matrix:
- Upstream unchanged + override exists → keep override
- Upstream changed + override on SAME field → conflict, report only
- Upstream changed + override on DIFFERENT field → apply upstream, preserve overrides
- Override is `"*"` → skip re-sync entirely

## Feature: Output Formatting

Use this exact template for all output. Copy it and fill in the placeholders:

```
## Summary
- **Scope**: [all|skills|agents|commands]
- **Definitions processed**: N
- **Hash changes applied**: N
- **Conflicts detected**: N
- **Errors (from precheck)**: N

### Hash Changes
| Definition | Old Hash | New Hash | Status |
|------------|----------|----------|--------|
| path/to/def | abc123 | def456 | ✅ Applied |

### Conflicts
| Definition | Field | Override Value | Upstream Value | Action |
|------------|-------|---------------|----------------|--------|
(None detected / list conflicts)

### New Upstream (report-only)
| Definition | Files |
|------------|-------|
| path/to/new-def | SKILL.md, references/guide.md |

### Upstream Deletions (report-only)
- path/to/deleted-def

### Errors
- [error message from precheck] → Affected: [definition key]

### Rewrite Failures
- (None / list failures)

### Phantom References
- (None / list commands referencing missing agents/skills)
```

## Boundaries

- Do not use `gh` commands or call external CLI tools during dry-run mode (exception: the pre-check script may run in interactive mode).
- Do not auto-merge conflicts.
- Do not modify files outside `agents/`, `skills/`, `commands/`, and `sync-manifest.json`.
- Use `gh` for PR creation, PR updates, issue comments, and (in interactive mode) authentication token setup.
- Branch name is always `chore/sync-cep`. Label is always `sync-cep`.
- **A sync run that changes files but produces no PR is a FAILED run.**
