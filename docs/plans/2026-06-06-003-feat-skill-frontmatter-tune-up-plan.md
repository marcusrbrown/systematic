---
title: "feat: Skill frontmatter tune-up"
type: feat
status: active
date: 2026-06-06
origin: docs/brainstorms/2026-06-06-skill-frontmatter-tune-up-requirements.md
---

# feat: Skill frontmatter tune-up

## Overview

A small, durable bundled-skill frontmatter consistency tune-up: add the one missing `argument-hint`, annotate the existing field-semantics table with enforcement status, and add a content-integrity warning so the `$ARGUMENTS`-without-`argument-hint` gap can't silently reappear.

## Problem Frame

A deferred note estimated ~14 skills needed `argument-hint`. Grounding corrected that to a real gap of **one** skill (`ce-compound-refresh`), and the field-semantics docs already largely exist in `foundation-conventions.md`. So the value is closing the one gap, clarifying which frontmatter fields the runtime actually consumes versus reads-but-doesn't-enforce, and making the invariant durable with a gate. See origin: `docs/brainstorms/2026-06-06-skill-frontmatter-tune-up-requirements.md`.

## Requirements Trace

- R1. `skills/ce-compound-refresh/SKILL.md` declares an `argument-hint` reflecting its real usage: `mode:autofix` plus an optional `docs/solutions/` scope hint (e.g. a category, module, or keyword).
- R2. `foundation-conventions.md`'s frontmatter table annotates each field's enforcement status, distinguishing read-and-acted-on fields from read-but-unenforced ones; `allowed-tools` is marked read-but-unenforced (`src/lib/skills.ts` parses it into `SkillFrontmatter.allowedTools`, but no `src/lib` gate acts on it, and OpenCode doesn't enforce it).
- R3. The content-integrity gate fails (a hard violation, mirroring `deprecated.reason` / agent-mode checks) when a bundled `SKILL.md` body references `$ARGUMENTS` outside code fences but its frontmatter lacks `argument-hint`. The body scan ignores fenced code blocks so a skill that merely documents `$ARGUMENTS` is not falsely flagged.
- R4. The new check has unit coverage: `$ARGUMENTS` without `argument-hint` → flagged; with both → clean; with neither → clean.

## Scope Boundaries

- Not adding `argument-hint` to skills that don't take meaningful arguments.
- Not touching the 8 skills that have `argument-hint` but no literal `$ARGUMENTS` (they parse args differently and are correct).
- Not changing the runtime loader's recognized-field contract.
- The R3 check is a hard violation (content-integrity already exits non-zero on violations; no new warning channel is built). After Unit 1 the tree is clean, so it never false-fails.

### Deferred to Separate Tasks

- `config.test.ts` `AE\d+` test-name rename (note #122).
- Deprecated-skill + converter removal (v3.0.0, note #116).

## Context & Research

### Relevant Code and Patterns

- `scripts/content-integrity.ts` — `checkSkillFrontmatterFields` (~line 746) and `checkRequiredSkillField` (~line 718) already scan `skills/*/SKILL.md` frontmatter + body; the new check mirrors this pattern. Wire it end-to-end as a normal violation: add a `CheckResult` field, count it in `totalViolations()`, print it in `printResult()`, and invoke it in `checkContentIntegrity()`. NOTE (verified during review): content-integrity has NO general non-failing warning channel — `allowlistWarnings` is the only warning bucket and is allowlist-specific. So this check is a hard violation, not a warning.
- `skills/ce-compound-refresh/SKILL.md` — uses `$ARGUMENTS` for `mode:autofix` + scope hint.
- `skills/writing-systematic-skills/references/foundation-conventions.md` — the existing frontmatter field table to annotate.
- Existing `argument-hint` examples: `ce-plan` (`"[optional: feature description, ... or any task to plan]"`), `document-review` (`"[mode:headless] [path/to/document.md]"`).

### Institutional Learnings

- Memory: OpenCode `allowed-tools` is metadata, not enforced permissions.
- The content-integrity gate is the durable home for bundled-asset invariants (mirrors `deprecated.reason`, agent-mode, agent-color checks).

## Key Technical Decisions

- **Hard violation, not warning** (R3): content-integrity has no general non-failing warning channel (verified during review — `allowlistWarnings` is the only warning bucket and is allowlist-specific). Rather than build new warning infra for a one-skill guard, the check is a normal violation that mirrors the existing `deprecated.reason` / agent-mode gates. After Unit 1 the tree is clean, so it never false-fails.
- **Mirror the existing skill-frontmatter check pattern**: reuse `findSkillsInDir`/`extractFrontmatterBlock` + body scan; don't invent a new scanning mechanism.
- **Accurate `allowed-tools` framing** (R2): "read but not enforced," not "not read" — the loader parses it; nothing acts on it.
- **Fence-aware body scan** (R3): the `$ARGUMENTS` scan ignores fenced code blocks so a skill documenting `$ARGUMENTS` (rather than consuming it) isn't falsely flagged. Verified during review that all 13 current `$ARGUMENTS`-using skills are real consumers, so the tree is clean after Unit 1.

## Open Questions

### Resolved During Planning

- Warning vs hard-fail → hard violation (content-integrity has no non-failing warning channel; building one for a one-skill guard isn't justified).
- `argument-hint` text for `ce-compound-refresh` → reflects its real usage: `mode:autofix` plus an optional `docs/solutions/` scope hint.

### Deferred to Implementation

- Exact annotation shape in the field table (extra column vs inline note) — implementer's call, must clearly mark read-vs-acted-on.
- Exact fence-stripping approach for the `$ARGUMENTS` body scan — implementer's call, but it must not flag `$ARGUMENTS` inside fenced code blocks.

## Implementation Units

- [x] **Unit 1: Add argument-hint to ce-compound-refresh + annotate field table**

**Goal:** Close the one `argument-hint` gap and annotate the field-semantics table with enforcement status.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `skills/ce-compound-refresh/SKILL.md` (add `argument-hint` frontmatter)
- Modify: `skills/writing-systematic-skills/references/foundation-conventions.md` (annotate the field table)

**Approach:**
- Add an `argument-hint` reflecting the skill's real usage — `mode:autofix` plus an optional `docs/solutions/` scope hint (category, module, or keyword). For example: `argument-hint: "[mode:autofix] [optional: category, module, or keyword scope]"`.
- In `foundation-conventions.md`, annotate the existing field table so each field's enforcement status is clear: read-and-acted-on (e.g. `name`, `description`, `argument-hint`, `context: fork`, `subtask`) vs read-but-unenforced. Mark `allowed-tools` read-but-unenforced with the accurate explanation.

**Patterns to follow:**
- Existing `argument-hint` values in `ce-plan` / `document-review`.

**Test scenarios:**
- Test expectation: none — frontmatter/docs content; verified by content-integrity + `bun run docs:build`.

**Verification:**
- `ce-compound-refresh` has an accurate `argument-hint`; no skill uses `$ARGUMENTS` without one; the field table marks enforcement status; content-integrity clean.

- [x] **Unit 2: Content-integrity argument-hint violation + tests**

**Goal:** A content-integrity violation fires when a skill uses `$ARGUMENTS` (outside code fences) without `argument-hint`, with unit coverage.

**Requirements:** R3, R4

**Dependencies:** Unit 1 (so the gate runs clean against the real tree)

**Files:**
- Modify: `scripts/content-integrity.ts` (new violation check + end-to-end wiring)
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Add a check that, for each `skills/*/SKILL.md`, records a VIOLATION when the body references `$ARGUMENTS` outside fenced code blocks but the frontmatter lacks `argument-hint`. Strip/ignore fenced code blocks before scanning for `$ARGUMENTS` so documentation mentions don't false-positive. Mirror `checkSkillFrontmatterFields` and wire end-to-end: `CheckResult` field, `totalViolations()`, `printResult()`, `checkContentIntegrity()`.

**Execution note:** Test-first. RED: a fixture skill using `$ARGUMENTS` without `argument-hint` is flagged as a violation. GREEN: the check + fence-stripping.

**Patterns to follow:**
- `checkSkillFrontmatterFields` / `checkRequiredSkillField` structure and their tests.

**Test scenarios:**
- Happy path: a fixture skill with `$ARGUMENTS` in body + no `argument-hint` → violation recorded.
- Happy path: a fixture skill with both `$ARGUMENTS` and `argument-hint` → no violation.
- Edge case: a fixture skill with neither → no violation.
- Edge case (fence false-positive): a fixture skill that mentions `$ARGUMENTS` ONLY inside a fenced code block, with no `argument-hint` → no violation (fence-stripping works).
- Edge case: malformed/non-object frontmatter → handled like the sibling checks (no crash).
- Integration: the gate runs clean (zero violations) against the real tree after Unit 1.

**Verification:**
- The violation fires for the gap and only the gap; fenced `$ARGUMENTS` mentions don't trigger it; the real tree is violation-clean post-Unit-1; `totalViolations` counts it; tests pass.

## System-Wide Impact

- **API surface parity:** the new check joins the other `skills/*/SKILL.md` content-integrity checks.
- **Unchanged invariants:** no runtime loader change; no hard-fail added; existing checks untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The check fails CI on the real tree | After Unit 1 the tree is clean (verified during review: all 13 `$ARGUMENTS`-using skills are real consumers with `argument-hint`). An integration test asserts zero violations on the real tree. |
| `$ARGUMENTS` appears in a code-fence/example, not real usage | The body scan strips fenced code blocks before checking, and a dedicated test covers the fence-only case. |
| `argument-hint` text inaccurate for ce-compound-refresh | Derived from its real `mode:autofix` + scope-hint usage; verify against the SKILL.md body. |

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-06-skill-frontmatter-tune-up-requirements.md
- Related code: `scripts/content-integrity.ts`, `skills/ce-compound-refresh/SKILL.md`, `skills/writing-systematic-skills/references/foundation-conventions.md`
