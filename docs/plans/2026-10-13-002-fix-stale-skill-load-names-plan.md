---
title: "fix: Bundled skills name only skills that resolve"
type: fix
status: active
date: 2026-10-13
---

# fix: Bundled skills name only skills that resolve

## Overview

Bundled skill text still names some skills by their directory form (`ce-plan`, `ce-doc-review`, `ce-brainstorm`) instead of the names the resolver loads (`ce:plan`, `document-review`, `ce:brainstorm`). A model that follows the text gets a not-found error and has to guess the right name. #1110 fixed the brainstorm handoff and the shipping workflow. This plan fixes the remaining references and adds a gate so the form cannot come back.

## Requirements Trace

- R1. No backticked skill reference in `skills/` or `agents/` uses the `ce-<name>` or `/ce-<name>` form.
- R2. `bun scripts/content-integrity.ts` fails when one is added, and does not flag paths, fenced code, qualified agent IDs, or plain prose.

## Scope Boundaries

- Plain-prose mentions are out of scope, for example agent descriptions that say "ce-plan's deepening workflow". They are not load instructions, and editing curated agent descriptions regenerates the registry and the Pi fixtures with no change in behavior.
- No guard or runtime change. Loading the corrected names changes no guard state beyond what the skill tools already do.
- `docs/` is out of scope. Plans and solution docs legitimately name old forms.

## Context & Research

- `src/lib/skill-resolver.ts` `resolveSkill` strips one `systematic:` prefix, then requires an exact frontmatter-name match. Bundled frontmatter names use `ce:`, so a `ce-<name>` reference never resolves.
- `scripts/content-integrity.ts` `checkSkillReferenceIntegrity` validates only `ce:<name>` against `skills/ce-<name>/`. `collectScanTargets` scans `skills/` and `agents/` markdown. `updateFenceMarker` tracks fenced blocks.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`: checks fail or pass. Test legitimate mentions and the real tree.
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md`: prefer a narrow, honest rule with stated limits.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "skills/, agents/, scripts/content-integrity.ts, tests/unit/content-integrity.test.ts",
  "freshness": {
    "vcs_reference": "a501c5a6"
  },
  "budget": {
    "max_search_passes": 12,
    "max_candidate_inspections": 25,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "scripts/content-integrity.ts:checkSkillReferenceIntegrity",
      "description": "Validates ce:<name> skill references against skills/ce-<name>/ directories.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/content-integrity.ts:updateFenceMarker",
      "description": "Tracks fenced code blocks while scanning markdown.",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Ban the form instead of resolving each token.** Every bundled skill named `ce-*` on disk is named `ce:*` in its frontmatter, so a backticked `ce-<name>` span is wrong whichever skill it means. That rule is exact and needs no exemption list.
- **Match whole code spans only.** A span is flagged when its whole content is `ce-<name>` or `/ce-<name>`, optionally followed by arguments. Spans containing `.`, `:`, `_`, or an interior `/` are paths, run directories, or qualified IDs, and are skipped.

## Implementation Units

- [ ] **Unit 1: Rename the remaining references**

**Goal:** Every backticked skill reference in `skills/` and `agents/` uses a name that resolves.

**Requirements:** R1

**Files:**
- Modify: `skills/document-review/references/synthesis-and-presentation.md`
- Modify: `skills/ce-review/references/persona-catalog.md`
- Modify: `skills/ce-plan/references/universal-planning.md`
- Modify: `skills/ce-plan/references/plan-handoff.md`
- Modify: `skills/ce-plan/references/deepening-workflow.md`
- Modify: `skills/ce-ideate/references/post-ideation-workflow.md`
- Modify: `skills/ce-brainstorm/references/requirements-capture.md`
- Modify: `skills/ce-brainstorm/references/brainstorm-sections.md`
- Modify: `agents/review/README.md`

**Approach:**
- `ce-plan` → `ce:plan`, `ce-work` → `ce:work`, `ce-brainstorm` → `ce:brainstorm`, `ce-compound` → `ce:compound`, `ce-doc-review` → `document-review`.
- Slash forms become `/ce:plan` and `/ce:work`.
- Fix the plain-prose stale names on the same lines when they sit next to a corrected reference, for example in synthesis-and-presentation's caller-context paragraph.

**Test scenarios:**
- Test expectation: none -- text-only change, covered by Unit 2's real-tree check.

**Verification:**
- Every renamed token resolves through `resolveSkill`.
- `bun run registry:drift` and `bun scripts/generate-pi-subagents-personas.ts --check` are clean.
- The Claude Code plugin build succeeds.

- [ ] **Unit 2: Gate the `ce-<name>` form**

**Goal:** Content integrity fails on a backticked `ce-<name>` skill reference.

**Requirements:** R2

**Dependencies:** Unit 1 for the real-tree check to pass.

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Extend `checkSkillReferenceIntegrity`, or add a sibling check wired next to it, that scans `skills/` and `agents/` markdown outside fenced blocks.
- Report file, line, the token, and the suggested `ce:<name>` form.

**Execution note:** Test-first.

**Test scenarios:**
- Error path: `` `ce-plan` ``, `` `/ce-work` ``, and `` `ce-doc-review mode:headless` `` each fail.
- Edge case: spans that pass include `` `skills/ce-plan/SKILL.md` ``, `` `.context/systematic/ce-review/<run-id>` ``, `` `systematic:review:architecture-strategist` ``, `` `ce:plan` ``, and `` `ce-plan-deepen-XXXXXX` `` (a path or temp-name prefix with interior `_` or a trailing placeholder).
- Edge case: a bad name inside a backtick fence, a tilde fence, or an indented list fence passes.
- Edge case: unbackticked prose `ce-plan's deepening workflow` passes.
- Integration: the real tree has zero violations after Unit 1. Re-injecting `` `ce-plan` `` into a temp copy of a real skill file fails.

**Verification:**
- `bun scripts/content-integrity.ts` is clean on the tree.
- The new tests fail without the check.

## Sources & References

- Issue: #1106. Prior partial fix: #1110.
