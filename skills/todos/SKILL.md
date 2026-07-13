---
name: todos
description: Use when creating durable work items, managing todo lifecycle, or tracking findings across sessions in the file-based todo system; when reviewing pending todos for approval, prioritizing code review findings, or interactively categorizing work items; or when batch-resolving approved todos, especially after code review or triage sessions
argument-hint: "[create|triage|resolve] [optional: findings list, source type, or specific todo ID/pattern]"
disable-model-invocation: true
---

# File-Based Todo Tracking

## Overview

The `.context/systematic/todos/` directory is a file-based tracking system for code review feedback, technical debt, feature requests, and work items. Each todo is a markdown file with YAML frontmatter. This skill covers the full lifecycle in three sections: **Create** (new todos), **Triage** (review pending todos for approval), and **Resolve** (batch-implement approved todos).

> **Legacy support:** Always check both `.context/systematic/todos/` (canonical) and `todos/` (legacy) when reading. Write new todos only to the canonical path. This directory has a multi-session lifecycle -- do not clean it up as scratch.

## Directory Paths

| Purpose | Path |
|---------|------|
| **Canonical (write here)** | `.context/systematic/todos/` |
| **Legacy (read-only)** | `todos/` |

## File Naming Convention

```
{issue_id}-{status}-{priority}-{description}.md
```

- **issue_id**: Sequential number (001, 002, ...) -- never reused
- **status**: `pending` | `ready` | `complete`
- **priority**: `p1` (critical) | `p2` (important) | `p3` (nice-to-have)
- **description**: kebab-case, brief

**Example:** `002-ready-p1-fix-n-plus-1.md`

## File Structure

Each todo has YAML frontmatter and structured sections. Use the todo template included below when creating new todos.

```yaml
---
status: ready
priority: p1
issue_id: "002"
tags: [rails, performance]
dependencies: ["001"]     # Issue IDs this is blocked by
---
```

**Required sections:** Problem Statement, Findings, Proposed Solutions, Recommended Action (filled during triage), Acceptance Criteria, Work Log.

**Optional sections:** Technical Details, Resources, Notes.

## Integration with Workflows

| Trigger | Flow |
|---------|------|
| Code review | `/ce:review` -> Findings -> `/systematic:todos` (Triage section) -> Todos |
| Autonomous review | `/ce:review mode:autofix` -> Residual todos -> `/systematic:todos` (Resolve section) |
| Code TODOs | `/systematic:todos` (Resolve section) -> Fixes + Complex todos |
| Planning | Brainstorm -> Create todo -> Work -> Complete |

## Key Distinction

This skill manages **durable, cross-session work items** persisted as markdown files. For temporary in-session step tracking, use platform task tools (`todowrite`/`TaskUpdate` in OpenCode, `update_plan` in Codex) instead.

> **Tool preference:** Use native file-search/glob and content-search tools instead of shell commands for finding and reading todo files. Shell only for operations with no native equivalent (`mv`, `mkdir -p`).

---

## Create

### Creating a New Todo

1. `mkdir -p .context/systematic/todos/`
2. Search both paths for `[0-9]*-*.md`, find the highest numeric prefix, increment, zero-pad to 3 digits.
3. Use the todo template included below, write to canonical path as `{NEXT_ID}-pending-{priority}-{description}.md`.
4. Fill Problem Statement, Findings, Proposed Solutions, Acceptance Criteria, and initial Work Log entry.
5. Set status: `pending` (needs triage) or `ready` (pre-approved).

**Create a todo when** the work needs more than ~15 minutes, has dependencies, requires planning, or needs prioritization. **Act immediately instead** when the fix is trivial, obvious, and self-contained.

### Triaging Pending Items

1. Glob `*-pending-*.md` in both paths.
2. Review each todo's Problem Statement, Findings, and Proposed Solutions.
3. Approve: rename `pending` -> `ready` in filename and frontmatter, fill Recommended Action.
4. Defer: leave as `pending`.

See the Triage section below for an interactive approval workflow.

### Managing Dependencies

```yaml
dependencies: ["002", "005"]  # Blocked by these issues
dependencies: []               # No blockers
```

To check blockers: search for `{dep_id}-complete-*.md` in both paths. Missing matches = incomplete blockers.

### Completing a Todo

1. Verify all acceptance criteria.
2. Update Work Log with final session.
3. Rename `ready` -> `complete` in filename and frontmatter.
4. Check for unblocked work: search for files containing `dependencies:.*"{issue_id}"`.

### Todo Template

@./assets/todo-template.md

---

## Triage

Interactive workflow for reviewing pending todos one by one and deciding whether to approve, skip, or modify each.

**Do not write code during triage.** This is purely for review and prioritization -- implementation happens in the Resolve section below.

- First set the /model to Haiku
- Read all pending todos from `.context/systematic/todos/` and legacy `todos/` directories

### 1. Present Each Finding

For each pending todo, present it clearly with severity, category, description, location, problem scenario, proposed solution, and effort estimate. Then ask:

```
Do you want to add this to the todo list?
1. yes - approve and mark ready
2. next - skip (deletes the todo file)
3. custom - modify before approving
```

Use severity levels: 🔴 P1 (CRITICAL), 🟡 P2 (IMPORTANT), 🔵 P3 (NICE-TO-HAVE).

Include progress tracking in each header: `Progress: 3/10 completed`

### 2. Handle Decision

**yes:** Rename file from `pending` -> `ready` in both filename and frontmatter. Fill the Recommended Action section. If creating a new todo (not updating existing), use the naming convention from the Create section above.

Priority mapping: 🔴 P1 -> `p1`, 🟡 P2 -> `p2`, 🔵 P3 -> `p3`

Confirm: "✅ Approved: `{filename}` (Issue #{issue_id}) - Status: **ready**"

**next:** Delete the todo file. Log as skipped for the final summary.

**custom:** Ask what to modify, update, re-present, ask again.

### 3. Final Summary

After all items processed:

```markdown
## Triage Complete

**Total Items:** [X] | **Approved (ready):** [Y] | **Skipped:** [Z]

### Approved Todos (Ready for Work):
- `042-ready-p1-transaction-boundaries.md` - Transaction boundary issue

### Skipped (Deleted):
- Item #5: [reason]
```

### 4. Next Steps

```markdown
What would you like to do next?

1. proceed to the Resolve section below to resolve the todos
2. commit the todos
3. nothing, go chill
```

---

## Resolve

Resolve approved todos using parallel processing, document lessons learned, then clean up.

Only `ready` todos are resolved. `pending` todos are skipped — they haven't been triaged yet. If pending todos exist, list them at the end so the user knows what was left behind.

### 1. Analyze

Scan `.context/systematic/todos/*.md` and legacy `todos/*.md`. Partition by status:

- **`ready`** (status field or `-ready-` in filename): resolve these.
- **`pending`**: skip. Report them at the end.
- **`complete`**: ignore, already done.

If a specific todo ID or pattern was passed as an argument, filter to matching todos only (still must be `ready`).

Residual actionable work from `ce:review mode:autofix` after its `safe_auto` pass will already be `ready`.

Skip any todo that recommends deleting, removing, or gitignoring files in `docs/brainstorms/`, `docs/plans/`, or `docs/solutions/` — these are intentional pipeline artifacts.

### 2. Plan

Create a task list grouped by type (e.g., `todowrite` in OpenCode, `update_plan` in Codex). Analyze dependencies -- items that others depend on run first. Output a mermaid diagram showing execution order and parallelism.

### 3. Implement (PARALLEL)

Spawn a `systematic:workflow:pr-comment-resolver` agent per item. Prefer parallel; fall back to sequential respecting dependency order.

**Batching:** 1-4 items: direct parallel returns. 5+ items: batches of 4, each returning only a short status summary (todo handled, files changed, tests run/skipped, blockers).

For large sets, use a scratch directory at `.context/systematic/todo-resolve/<run-id>/` for per-resolver artifacts. Return only completion summaries to parent.

### 4. Commit & Resolve

Commit changes, mark todos resolved, push to remote.

GATE: STOP. Verify todos resolved and changes committed before proceeding.

### 5. Compound on Lessons Learned

Load the `ce:compound` skill to document what was learned. Todo resolutions often surface patterns and architectural insights worth capturing.

GATE: STOP. Verify the compound skill produced a solution document in `docs/solutions/`. If none (user declined or no learnings), continue.

### 6. Clean Up

Delete completed/resolved todo files from both paths. If a scratch directory was created at `.context/systematic/todo-resolve/<run-id>/`, delete it (unless user asked to inspect).

```
Todos resolved: [count]
Pending (skipped): [count, or "none"]
Lessons documented: [path to solution doc, or "skipped"]
Todos cleaned up: [count deleted]
```

If pending todos were skipped, list them:

```
Skipped pending todos (proceed to the Triage section above to approve):
  - 003-pending-p2-missing-index.md
  - 005-pending-p3-rename-variable.md
```
