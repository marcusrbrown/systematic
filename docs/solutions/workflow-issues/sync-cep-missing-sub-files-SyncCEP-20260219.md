---
module: Sync CEP Workflow
date: 2026-02-19
problem_type: workflow_issue
component: tooling
symptoms:
  - "PR #110 imported 9 new skills but only SKILL.md files were created"
  - "32 sub-files (references/, scripts/, assets/) silently dropped during sync"
  - "Imported multi-file skills non-functional due to missing supporting files"
root_cause: missing_tooling
resolution_type: code_fix
severity: high
tags: [sync-cep, sub-files, precheck, skill-import, multi-file-skills]
---

# Troubleshooting: sync-cep Silently Drops Sub-Files for New Multi-File Skills

## Problem

The automated sync-cep workflow discovered 9 new upstream skills and created
SKILL.md for each, but silently dropped all 32 sub-files (references/, scripts/,
assets/). This rendered most imported skills non-functional since they depend on
supporting files for references, examples, and scripts.

## Environment

- Module: Sync CEP Workflow (check-cep-upstream.ts + convert-cc-defs + sync-cep.md)
- Runtime: Bun + TypeScript
- Affected Component: `scripts/check-cep-upstream.ts`, `.opencode/skills/convert-cc-defs/SKILL.md`, `.opencode/commands/sync-cep.md`
- Date: 2026-02-19

## Symptoms

- PR #110 (`chore/sync-cep`) imported 9 new skills with only SKILL.md for each
- 32 sub-files across 8 skills were missing (1 skill was single-file, correctly handled)
- No errors reported — the missing files were invisible to the workflow
- Skills like `gemini-imagegen` (missing `requirements.txt`, `scripts/`) and `every-style-editor` (missing `references/EVERY_WRITE_STYLE.md`) were incomplete

| Skill | Upstream Files | Missing |
|-------|---------------|---------|
| andrew-kane-gem-writer | 6 | 5 (references/) |
| dhh-rails-style | 7 | 6 (references/) |
| dspy-ruby | 9 | 8 (assets/, references/) |
| every-style-editor | 2 | 1 (references/) |
| gemini-imagegen | 7 | 6 (requirements.txt, scripts/) |
| rclone | 2 | 1 (scripts/) |
| resolve-pr-parallel | 3 | 2 (scripts/) |
| setup | 1 | 0 (single file, OK) |
| skill-creator | 4 | 3 (scripts/) |
| **TOTAL** | **41** | **32 missing** |

## What Didn't Work

**Direct solution:** Root cause was identified through code analysis on the first
investigation pass. No failed remediation attempts.

## Solution

Three coordinated changes across the precheck script, the skill document, and
the command document:

### 1. Precheck script: discover sub-files for new definitions

Added `newUpstreamFiles: Record<string, string[]>` to the `CheckSummary` type
and a `collectNewUpstreamFiles()` function that uses the git tree (already
fetched) to collect all files belonging to each new definition.

```typescript
// Before: newUpstream was just a list of definition keys
{
  "newUpstream": ["skills/every-style-editor", "skills/gemini-imagegen"]
}

// After: newUpstreamFiles maps each key to its full file list
{
  "newUpstream": ["skills/every-style-editor", "skills/gemini-imagegen"],
  "newUpstreamFiles": {
    "skills/every-style-editor": ["SKILL.md", "references/EVERY_WRITE_STYLE.md"],
    "skills/gemini-imagegen": ["SKILL.md", "requirements.txt", "scripts/generate.py", "scripts/setup.sh"]
  }
}
```

Key changes in `scripts/check-cep-upstream.ts`:
- Added `treePaths: string[]` to `FetchResult` (tree data was already fetched, now exposed)
- Added `treePaths: string[]` to `CheckInputs` (passed through to computation)
- Added `collectSkillFiles()` helper — filters tree paths by skill directory prefix
- Added `collectNewUpstreamFiles()` — orchestrates file discovery for all new keys
- Extracted `CEP_PREFIX` constant (was duplicated inline)

### 2. convert-cc-defs skill: sub-file discovery instructions

Added a "Discovering Sub-Files for New Skills" section to Phase 1a with two
approaches:
- **Option A**: Use `newUpstreamFiles` from the precheck summary (automated sync)
- **Option B**: Query the git tree API directly (manual import)

Also added a `files` array requirement note in Phase 4b (manifest entries).

### 3. sync-cep command: reference the new data

Updated the command to document `newUpstreamFiles` in the precheck summary
description and added a "New Upstream File Lists" section explaining how the
agent should use the file map.

**Files changed:**

```
scripts/check-cep-upstream.ts          # Core fix: sub-file discovery
tests/unit/check-cep-upstream.test.ts  # 6 new tests + updated existing tests
.opencode/skills/convert-cc-defs/SKILL.md  # Skill instructions for sub-file handling
.opencode/commands/sync-cep.md         # Command references newUpstreamFiles
```

## Why This Works

The root cause was a **data gap at three levels**:

1. **`toDefinitionKey()` returns `null` for sub-files** — by design, for key
   deduplication. `skills/foo/references/bar.md` correctly returns `null` because
   the definition key is `skills/foo`, not a per-file key. But this meant
   sub-files were invisible to the `newUpstream` detection path.

2. **Precheck summary had no file lists for new definitions** — it only reported
   the definition key (e.g., `skills/every-style-editor`). The sync agent had no
   data about what sub-files exist. For *existing* definitions, the manifest's
   `files` array provides this data, but new definitions have no manifest entry.

3. **convert-cc-defs lacked a sub-file discovery step** — Phase 1 documented
   batch fetching but didn't instruct the agent to enumerate all files in a new
   skill directory before fetching.

The fix closes the gap at each level: the precheck now provides authoritative
file lists from the git tree, the skill teaches agents how to use them, and the
command ensures the data is referenced in the workflow.

## Prevention

- **Always include a `files` array in manifest entries for multi-file skills** —
  without it, the precheck script can't hash sub-files for change detection
- **When adding new automated import capabilities**, consider what data the
  downstream agent needs — report-only sections still need enough data for the
  agent to act when it does import
- **Test with multi-file skills** — the existing test suite only covered
  single-file definitions for the `newUpstream` path. The 6 new tests now cover
  multi-file discovery explicitly
- **Verify PR completeness against upstream tree** — for any PR that imports
  new skills, compare the file count against the upstream directory listing

## Related Issues

- See also: [batch-import-cep-agents-to-systematic-20260210.md](../integration-issues/batch-import-cep-agents-to-systematic-20260210.md) — Related sync-cep workflow documentation
- See also: [workflow-command-prompt-dry-run-integration.md](../integration-issues/workflow-command-prompt-dry-run-integration.md) — Related sync-cep dry-run fix
