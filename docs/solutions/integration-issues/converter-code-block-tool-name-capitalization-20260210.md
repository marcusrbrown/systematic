---
title: "Converter Skips Code Blocks: 47 Broken Tool Name Examples in orchestrating-swarms"
date: 2026-02-10
severity: high
category: integration-issues
component: converter
tags:
  - converter
  - code-blocks
  - tool-names
  - orchestrating-swarms
last_refreshed: 2026-05-16
environment: "Bun 1.x / TypeScript 5.7+ / OpenCode"
symptoms:
  - "Code examples show Task({ instead of task({ after CC→OC conversion"
  - "Users copying code examples from skill documentation get runtime errors"
  - "47 instances of capitalized Task({ in orchestrating-swarms SKILL.md"
root_cause: "Converter intentionally skips fenced code blocks to avoid false positives (e.g., 'Task' as a noun). Manual code block audit step in convert-cc-defs skill was missed during batch import of a 1718-line file."
resolution_type: process
confidence: verified
related: []
---

# Converter Skips Code Blocks: 47 Broken Tool Name Examples in orchestrating-swarms

## Problem

After batch-importing 10 CEP skills from upstream (`EveryInc/compound-engineering-plugin@e8f3bbcb35`), the `orchestrating-swarms` skill contained 47 instances of `Task({` (Claude Code capitalization) in its code examples instead of `task({` (OpenCode lowercase). Every code example in this 1718-line file was broken — users copying examples would get runtime errors.

### Symptoms

- All code examples in `skills/orchestrating-swarms/SKILL.md` used `Task({...})` instead of `task({...})`
- `const research = await Task({...})` instead of `const research = await task({...})`
- One-liner spawns like `Task({ team_name: "codebase-review", ... })` also affected
- 47 total occurrences, all inside fenced JavaScript code blocks

## Investigation

### Step 1: Understand the converter's design

The converter (`src/lib/converter.ts`) uses `CODE_BLOCK_PATTERN` to identify fenced code blocks (` ```...``` `) and inline code (`` `...` ``). In `transformBody()`, these regions are replaced with placeholders before applying tool name mappings, then restored after. This is **intentional** — it prevents false positives like:

- "Complete the Task today" → would incorrectly become "Complete the task today"
- "Task list management" → would incorrectly become "task list management"
- CSS class names, variable names in non-JS contexts

The converter's behavior is tested and correct. The problem is downstream.

### Step 2: Understand the code-block audit requirement

The converter's intentional code-block skip is documented in `src/lib/converter.ts` source comments (see `CODE_BLOCK_PATTERN` and `transformBody()`). The `convert-cc-defs` workflow that previously documented the manual audit step has been deleted. Any batch conversion run via the CLI (`bun src/cli.ts convert <file>`) must include a separate code-block audit step — the converter will not fix capitalized tool names inside fenced code blocks.

### Step 3: Verify scope

Searched all skills for capitalized tool names in code blocks:

```bash
grep -rn "Task(" skills/ --include="*.md" | grep -v "Task Analysis\|Task List\|task("
```

Only `orchestrating-swarms` was affected. Other skills either had no code examples or had already been correctly audited. The `agent-native-architecture` references contained Swift iOS API calls (`endBackgroundTask`) — correct and unrelated.

## Root Cause

**Two-factor failure:**

1. **Converter design (correct):** Skips code blocks to avoid false positives in prose text. This is the right tradeoff — false positives in prose are worse than requiring manual code block review.

2. **Process gap (the bug):** The manual "Code Block Audit" step (Phase 3d) in the convert-cc-defs workflow was missed during batch execution. The orchestrating-swarms file is unusually large (1718 lines, 47 tool calls in code blocks) making the omission high-impact.

The convert-cc-defs skill documented the audit requirement, but under batch pressure (10 skills, 52 files), the step was skipped for this file. The workflow lacked enforcement — it was advisory, not gated.

## Solution

### Immediate fix (applied)

```bash
sed -i '' 's/Task({/task({/g' skills/orchestrating-swarms/SKILL.md
sed -i '' 's/await Task(/await task(/g' skills/orchestrating-swarms/SKILL.md
```

Verified: 0 `Task({` remaining, 47 `task({` present.

### Manifest tracking

Manifest tracking was previously used during the CEP sync era; that infrastructure no longer exists. Today, the content-integrity gate at `scripts/content-integrity.ts` catches `Task(` (capitalized) inside fenced code blocks as a CC heritage pattern.

### Skill improvement (applied)

Added a high-risk pattern note to the convert-cc-defs skill's Code Block Audit section:

> **High-risk pattern:** Long skills with many code examples (e.g., orchestrating-swarms has 47 `Task({` calls across 1700+ lines). After mechanical conversion, run a targeted search for capitalized tool names inside code blocks: `grep -n "Task(\|TodoWrite\|AskUserQuestion" <file>`. Fix all occurrences — users copying broken examples will get runtime errors.

## Prevention

### 1. Post-conversion validation command

`scripts/content-integrity.ts` already runs banned-pattern detection (including `Task(` in code blocks) on every CI run. For ad-hoc CLI conversions, run it locally with `bun scripts/content-integrity.ts` before committing.

### 2. Workflow guardrails

Make Phase 3d a hard gate in `convert-cc-defs`:
- Run the validation command; if exit code != 0, do not proceed to Phase 4
- Record audit counts in manifest notes: `CODE_BLOCK_AUDIT: PASS (Task(:0, TodoWrite:0)`

### 3. Bundled-assets integration test

Add a test in `tests/integration/` that scans all shipped `skills/`, `agents/`, `commands/` for CC markers inside code blocks. This catches misses at CI time, not review time.

### 4. Batch import backstop

For multi-file imports, run the validator on `git diff --name-only --diff-filter=AM` after the batch completes.

## Verification

```bash
# Confirm fix
grep -c "Task({" skills/orchestrating-swarms/SKILL.md  # 0
grep -c "task({" skills/orchestrating-swarms/SKILL.md  # 47

# Full build
bun run build && bun run typecheck && bun run lint && bun test
# 328/328 tests pass, 617 expect() calls
```

## Cross-References

- **PR:** [#63](https://github.com/marcusrbrown/systematic/pull/63) — feat: sync all CEP skills from upstream
- **Converter source:** `src/lib/converter.ts` — `CODE_BLOCK_PATTERN` and `transformBody()`
- **Content-integrity gate:** `scripts/content-integrity.ts` — CI enforcement for CC heritage patterns

## Key Takeaway

The converter's code-block-skipping is a correct safety measure. The failure was a process gap: a manual audit step documented in the workflow but not enforced. The fix is twofold: (1) targeted grep after every conversion, and (2) automated validation that fails CI if CC markers remain in code blocks. **Don't trust humans to manually audit 1700-line files under batch pressure — automate the check.**
