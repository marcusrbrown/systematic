---
title: Qualified persona IDs are canonical validated references, not dispatch bugs
date: 2026-07-17
category: best-practices
module: content-integrity
problem_type: convention
component: documentation
severity: medium
tags:
  - content-integrity
  - qualified-persona-ids
  - reference-validation
  - harness-portability
  - ce-skills
applies_when:
  - Refactoring or neutralizing skill/agent bodies that mention systematic:<category>:<name> IDs
  - Considering a gate that would ban qualified persona IDs
  - Reviewing a harness-portability change that converts persona references
---

# Qualified persona IDs are canonical validated references, not dispatch bugs

## Context

A harness-portability follow-up set out to neutralize "qualified persona IDs"
(`systematic:<category>:<name>`, e.g. `systematic:review:correctness-reviewer`)
across four ce-* skills, plus add a content-integrity gate to keep them out of
migrated skill bodies. The premise: those IDs are not valid dispatch targets on
either harness (OpenCode's `task()` resolves bare `subagent_type`; Pi's
`systematic_delegate` matches bare names exactly), so the prose was "wrong."

Mid-implementation investigation collapsed the whole increment to a 5-line prose
fix. The premise conflated two different things that happen to share the
`systematic:<category>:<name>` spelling:

1. **Pseudo-dispatch fake-call syntax** — `task systematic:research:X(...)`, which
   reads as literal code and is genuinely confusing on any harness.
2. **Qualified persona IDs as references** — the canonical, phantom-validated
   cross-reference form used in prose and persona rosters.

Only (1) is a defect. (2) is correct, validated, and conventional.

## Guidance

- **Fix the fake-call syntax, keep the qualified ID.** Convert
  `task systematic:research:X(...)` to prose like
  ``Dispatch `systematic:research:X` — pass ...``. The qualified ID stays.
- **Never bulk-convert qualified persona IDs to bare names.** The qualified form
  `systematic:<category>:<name>` is validated by `checkReferenceIntegrity`
  (`scripts/content-integrity.ts:568-617`), which builds a regex for that shape
  and asserts each match resolves to a real `agents/<category>/<name>.md`. A bare
  name (`correctness-reviewer`) does not match that regex, so converting silently
  **removes validation coverage** — a later typo would no longer be caught.
- **Persona-roster tables are references, not dispatch.** ce-review's roster
  (`skills/ce-review/SKILL.md:108-118`) maps persona → description. A table row is
  not a dispatch instruction; its qualified ID is a validated cross-reference.
  Leave it qualified.
- **Do not add a gate banning qualified IDs in skill bodies.** It would directly
  conflict with `checkReferenceIntegrity`, which *requires* the qualified form to
  validate references. The migrated-set identifier gate
  (`checkMigratedSkillIdentifiers`, `scripts/content-integrity.ts:1135-1179`) bans
  harness-specific tool syntax (`task(`, `subagent_type`, `todowrite`, …) and
  correctly does **not** list qualified persona IDs.

## Why This Matters

The qualified form is load-bearing on two axes:

- **Reference integrity (ARCHITECTURE invariant #4, "no phantom skill
  references").** `checkReferenceIntegrity` is the CI enforcement; the qualified
  ID is exactly what it validates. Stripping it trades a caught-at-CI typo for a
  silent runtime dispatch failure — the precise failure class that
  `reconciliation-sync-reference-integrity` documents.
- **Corpus convention.** Qualified IDs are the persona-reference style across the
  bundle: `document-review/SKILL.md:105-114`, `resolve-pr-feedback/SKILL.md:144-157`,
  `ce-compound/SKILL.md:464-477`, `ce-review/SKILL.md:108-118`. Neutralizing only
  four skills would make them inconsistent with every other skill.

The cost signal is the lesson: a full brainstorm → 5-persona document-review →
plan → work cycle collapsed to five lines the moment the premise was tested
against real code. The document-review's P1 premise challenge ("is this rewrite
justified given no observed failure?") was directionally right; the decisive
evidence only surfaced during implementation. When a refactor's premise rests on
"this form is wrong," verify against the gates and conventions that already
consume that form before scoping the work.

## When to Apply

- Any refactor that touches `systematic:<category>:<name>` references.
- Any harness-portability pass that neutralizes skill bodies — distinguish
  fake-call *syntax* (fix) from qualified *references* (keep).
- Any proposed content-integrity gate that would flag qualified IDs — stop; it
  conflicts with `checkReferenceIntegrity`.

## Boundary / Non-goal

This is the explicit "not this" list:

- Qualified persona IDs are **not** phantom references — they are the *validated*
  reference form. Do not strip, bulk-rename, or gate them.
- Harness-neutralization of skill bodies targets tool *syntax*, not persona
  *reference identifiers*.
- The migrated-set identifier gate must **not** be extended to qualified IDs.

## Examples

Correct fix — fake-call syntax neutralized, qualified ID preserved
(`skills/ce-plan/SKILL.md:227-231, 296-300, 323-328`):

```diff
- - task systematic:research:repo-research-analyst(Scope: technology, architecture, patterns. {planning context summary})
+ - Dispatch `systematic:research:repo-research-analyst` — scope: technology, architecture, patterns; pass the planning context summary.
```

Wrong change — strips phantom-validation coverage and breaks corpus convention:

```diff
  | Persona | Reference | Focus |
- | correctness | `systematic:review:correctness-reviewer` | Logic errors, edge cases |
+ | correctness | `correctness-reviewer` | Logic errors, edge cases |
  # ^ no longer matched by checkReferenceIntegrity; a typo here would ship unvalidated
```

## Related

- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md`
  — the origin of `checkReferenceIntegrity`; same reference-integrity family, but
  from the phantom-ref angle. This doc is its complement: the qualified form it
  validates is the form to *preserve*, not strip.
- `docs/solutions/best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md`
  — the migrated-set identifier gate. Boundary: that lexical ban must not be
  extended to qualified persona IDs (this doc is the negative-scope note).
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md`
  — same honest-ban discipline, different target; reference integrity is not a
  ban-rule case.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md`
  — the harness-portability/profile context this increment grew out of.
- `docs/solutions/best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md`
  — the Claude Code build translates the qualified form to `systematic:<name>` in
  *generated output only*; source keeps the canonical, phantom-validated form, so
  validation coverage is preserved on both sides.
