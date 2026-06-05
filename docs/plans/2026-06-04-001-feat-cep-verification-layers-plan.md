---
title: "feat: CEP verification-layer ports (ce-review Stage 5b + frontmatter parse-safety)"
type: feat
status: completed
shipped: "PR #485 (commit c3032ee); released in v2.25.0"
date: 2026-06-04
origin: docs/brainstorms/2026-06-04-cep-verification-layers-requirements.md
---

# feat: CEP Verification-Layer Ports

## Overview

Port two independent-verification capabilities surfaced by the CEP `ce:*` delta analysis, both
right-sized after grounding against our actual code:

1. **ce-review Stage 5b validation pass** — an independent per-finding validator that re-checks
   merged findings before synthesis, annotating each `validated: true|false` with a reason.
   **Validate-only: never deletes a finding** — rejected findings are surfaced in a "Filtered (not
   validated)" section, neutralizing the false-negative risk. This is the primary, higher-value item.
2. **content-integrity frontmatter parse-safety** — extend the CI gate to detect the silent
   `#`-truncation YAML class and to scan `docs/solutions/` (currently unscanned), plus adopt
   upstream's narrower category enums. Prevents silent loss of compounded knowledge.

The two units are **independent** and may ship in separate PRs **in either order** — neither
depends on the other, and each leaves a self-consistent state if it ships alone (Unit 1 is
self-contained `ce:review` behavior + its template; Unit 2 is a self-contained gate + schema
change). There is no shared release expectation and no compatibility coupling between them.
ce-ideate's basis-as-required-field refinement is **deferred** (mostly already ours; below YAGNI)
and is not planned here.

## Problem Frame

Upstream `EveryInc/compound-engineering-plugin`'s recent valuable work is in independent-
verification / quality-floor layers. Two map to real gaps in Systematic (see origin:
`docs/brainstorms/2026-06-04-cep-verification-layers-requirements.md`):

- Our multi-persona `ce:review` trusts every surfaced finding. False positives (persona missed an
  existing guard, flagged pre-existing code, misread types) reach the user/fixer unfiltered. We
  have no false-positive filter.
- Our `content-integrity` gate's `checkFrontmatter` only scans skill entry files, and our
  `parseFrontmatter` silently truncates `#`-bearing unquoted values (`parseError: false`, data
  lost) — verified empirically. `docs/solutions/`, the project's institutional memory, is scanned
  by nothing, so silent knowledge loss there is undetected.

## Requirements Trace

- R1. ce-review gains an independent validation pass over merged findings before synthesis.
- R2. The validator never deletes a finding; rejected findings are surfaced in the "Filtered (not
  validated)" group with reason (validate-only).
- R3. The validation pass is bounded by a default gating threshold (cost is linear in validated
  count).
- R4. content-integrity detects the `#`-truncation parse-safety class that `parseFrontmatter`
  silently drops.
- R5. content-integrity scans `docs/solutions/` markdown frontmatter (currently unscanned).
- R6. Adopt upstream's narrower category enums + "prefer narrowest" guidance in
  `skills/ce-compound/references/schema.yaml`.
- R7. Anti-coupling: port discrete capabilities only — no upstream `mode:agent` apply model,
  action-class rubric, or CEP-internal skill dependency.

## Scope Boundaries

- No CONCEPTS.md / vocabulary lifecycle, no `ce-sessions` dependency.
- No action-class rubric adoption (apply-philosophy mismatch).
- No ce-ideate scope expansion (elsewhere-modes, web research, caching).
- No regression of our existing autofix/report-only/headless mode system.
- No bundled Python scripts — gate logic stays TypeScript.
- The gate **detects** truncation risk in CI; it does not prevent write-time data loss.

### Deferred to Separate Tasks

- ce-ideate `basis`-as-required-field refinement: deferred maybe-not; revisit only with an
  explicit user-value case (see origin: Resolved Decisions).

## Context & Research

### Relevant Code and Patterns

- `skills/ce-review/SKILL.md` — Stages 1–6. Stage 5 (Merge findings, ~line 451) produces the
  merged finding set with `autofix_class`/`requires_verification`/`confidence`/`pre_existing`;
  Stage 6 (Synthesize and present, ~line 480) renders the finding tables. The validation pass
  inserts as **Stage 5b** between them.
- `skills/ce-review/references/subagent-template.md` — existing pattern for a persona subagent
  prompt; the new `validator-template.md` mirrors its structure (read-only, JSON-only return).
- `skills/document-review/references/findings-schema.json` and the document-review validator are
  prior art for an independent re-verification subagent returning `{validated, reason}` JSON.
- `scripts/content-integrity.ts` — `collectScanTargets` (~line 430) iterates only
  `['skills', 'agents']`; `checkFrontmatter`/`scanSkillFrontmatter` (~line 616) gate on
  `isSkillEntryFile` and rely on `parseFrontmatter.parseError`. The design-rationale comment
  (~line 30) explicitly states the gate "does not scan `docs/`" — must be updated.
- `src/lib/frontmatter.ts` — `parseFrontmatter`; verified: `# ` in an unquoted value →
  `parseError: false` with truncated value; `: ` in an unquoted value → `parseError: true`.
- `skills/ce-compound/references/schema.yaml` — current category enums (broad `best_practice`
  catch-all); upstream adds `architecture_pattern`/`design_pattern`/`tooling_decision`/
  `convention` + "prefer narrowest".

### Institutional Learnings

- The zsh/YAML silent-truncation solution-doc lesson (`docs/solutions/`) is the documented prior
  occurrence of this exact silent-data-loss class — the value case for R4/R5.
- `docs/solutions/` best-practice docs on independent-verification passes and discovery contracts
  inform the validate-only design.

### External References

- Upstream `EveryInc/compound-engineering-plugin` `plugins/compound-engineering/skills/
  ce-code-review/references/validator-template.md` (89 lines) — the validator prompt logic to
  adapt (not vendor verbatim; convert CC/CEP wording, drop `mode:agent` coupling).
- Upstream `ce-compound/scripts/validate-frontmatter.py` — the *logic* for parse-safety
  (re-implemented in TypeScript), not the file.

## Key Technical Decisions

- **Stage 5b placement:** between Merge (Stage 5) and Synthesize (Stage 6), operating on the
  merged finding set so it sees final severity/routing before presentation.
- **Validate-only:** annotate `validated`/`reason`; rejected findings move to the canonical
  "Filtered (not validated)" presentation group in Stage 6, never deleted. Resolves the
  false-negative risk. (Use this exact label in all template/skill edits.)
- **Default gating threshold (decided):** validate findings that are **P0/P1 OR
  `requires_verification: true`** by default. This resolves the reviewer concern that pure
  severity-gating would skip wrong-P2 noise: `requires_verification` catches lower-severity
  findings the personas themselves flagged as needing confirmation, which is precisely the
  uncertain class most worth validating. Cost stays bounded (it's a subset, not all findings).
  Findings outside this band pass through unvalidated and unfiltered.
- **Frontmatter check is TypeScript in the gate:** a new parse-safety scan distinct from
  `parseFrontmatter` (since that silently succeeds on the `#` class). Detect unquoted scalar
  values containing ` #` (comment-truncation) regardless of `parseError`.
- **Scan breadth:** add `docs/solutions/` to `collectScanTargets` markdown; apply the parse-safety
  check to those files (frontmatter present/structure only — not the skill required-field rules,
  which are skill-specific). Keep existing skill/agent scanning unchanged.
- **Severity:** the parse-safety violation **fails** CI (consistent with existing gate behavior;
  it's a deterministic structural check, not a fuzzy heuristic). Carried as a confirmable decision.

## Open Questions

### Resolved During Planning

- Where does the validator slot? → Stage 5b, between Merge and Synthesize.
- Does the validator delete findings? → No, validate-only with filtered surfacing.
- Python vs TS for parse-safety? → TypeScript in the gate (no bundle runtime dep).
- Which schema enums? → upstream's `architecture_pattern`/`design_pattern`/`tooling_decision`/
  `convention` + "prefer narrowest".

### Deferred to Implementation

- **default-on vs flag:** whether Stage 5b runs by default or behind a mode/flag. Working
  assumption: on by default for the gated band (P0/P1 OR `requires_verification`), since
  validate-only adds no deletion risk and the band bounds cost. Confirm during implementation if
  latency proves material.
- **Scan breadth final call:** `docs/solutions/` only vs broader `docs/**/*.md`. Plan scopes to
  `docs/solutions/` (the knowledge store); widening is a one-line change to the `solutionMarkdown`
  collection if wanted later.

## Implementation Units

- [x] **Unit 1: ce-review Stage 5b validation pass (prose + validator template)**

**Goal:** Add an independent, validate-only finding-validation pass to `ce:review` between Stage 5
and Stage 6, with a reusable validator subagent template.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Create: `skills/ce-review/references/validator-template.md`
- Modify: `skills/ce-review/SKILL.md`
- Modify: `skills/ce-review/references/review-output-template.md` (add canonical "Filtered (not
  validated)" presentation group)
- Test: `tests/unit/content-integrity.test.ts` (structural assertions, see below) + manual dogfood

**Automated structural coverage (not prose behavior, but catches regressions):** add lightweight
checks that the new sub-file is reference-integrity-resolvable and that `SKILL.md` retains required
structure. Prefer asserting via the existing content-integrity sub-file reference check (already
fails on dangling `references/*` paths) plus, if cheap, a test that `SKILL.md` contains the Stage
5b heading and references `validator-template.md`. Manual dogfood remains the behavioral check; the
structural test guards against accidental reference/heading breakage in our highest-traffic skill.

**Approach:**
- Adapt upstream `validator-template.md` into `skills/ce-review/references/validator-template.md`:
  one independent validator per gated finding, three questions (real in code as written? introduced
  by THIS diff? not handled elsewhere?), returns JSON `{validated, reason}`, read-only,
  conservative-confidence labeling. Convert all CC/CEP wording to Systematic/OpenCode; remove any
  `mode:agent`/action-class coupling (R7).
- Insert a new **Stage 5b: Validation pass** section in `SKILL.md` after Stage 5, before Stage 6:
  - Gate: validate only findings that are P0/P1 OR `requires_verification: true` by default (state
    the band + that it bounds cost).
  - Dispatch one validator subagent per gated finding in parallel, passing finding fields + diff +
    scope context (mirror the Stage 4 context bundle shape).
  - Collect `{validated, reason}`; attach to each finding. **Never drop a finding.**
  - Findings with `validated: false` are routed to a "Filtered (not validated)" group for Stage 6,
    not removed from the report.
- Update Stage 6 presentation in **both modes**:
  - **Interactive:** add a "Filtered (not validated)" subsection (canonical label — use this exact
    string everywhere) rendering rejected findings with their validator reason, appended AFTER the
    existing severity tables; validated findings flow through existing tables unchanged.
  - **Headless:** the headless envelope (Stage 6 / Mode Detection) has its own fixed structure —
    add the filtered findings to it too (e.g., a `filtered` array preserving the same per-finding
    fields + validator reason), so the validator state is not invisible in headless/autofix flows.
- **Output-contract compatibility note:** the change is additive — existing severity tables keep
  their structure, headings, and order; the Filtered group is appended. Document this so any reader
  or consumer relying on existing section order is unaffected (new content only ever appears after
  existing sections).
- Update `review-output-template.md` to include the canonical "Filtered (not validated)" group.

**Execution note:** This is skill-prose work; dogfood by running `ce:review` mentally/manually
against a known false-positive to confirm the flow reads correctly. No code is added.

**Patterns to follow:**
- `skills/ce-review/references/subagent-template.md` (subagent prompt shape, read-only contract).
- `skills/document-review` validator/independent-reviewer prior art for `{validated, reason}` JSON.

**Test scenarios:**
- Happy path (dogfood): a P1 finding that is genuinely guarded upstream → validator returns
  `validated: false`, finding appears in the Filtered group with reason, NOT in the actioned set.
- Happy path (dogfood): a real P0 finding new in the diff → `validated: true`, flows through normal
  P0 table unchanged.
- Edge case (prose): a P2 finding below the threshold → passes through unvalidated, no Filtered
  treatment, no validator dispatched.
- Anti-coupling check: `validator-template.md` contains no `mode:agent`, action-class, or
  CEP-internal skill references (grep).

**Verification:**
- `bun scripts/content-integrity.ts` clean (no phantom refs; new `references/validator-template.md`
  resolves from `SKILL.md`).
- The new sub-file is referenced in `SKILL.md` so the sub-file reference-integrity check passes.
- Registry drift check passes after regeneration (new reference file under a registered skill).
- Manual read-through confirms the validate-only flow never deletes findings.

---

- [x] **Unit 2: content-integrity frontmatter parse-safety + docs/solutions scan + schema enums**

**Goal:** Extend the CI gate to detect the silent `#`-truncation frontmatter class and to scan
`docs/solutions/`, and tighten the ce-compound schema enums.

**Requirements:** R4, R5, R6

**Dependencies:** None (independent of Unit 1; can ship as a separate PR)

**Files:**
- Modify: `scripts/content-integrity.ts` (add parse-safety check; extend `collectScanTargets`;
  update the design-rationale comment)
- Modify: `tests/unit/content-integrity.test.ts` (parse-safety + docs/solutions scan coverage)
- Modify: `skills/ce-compound/references/schema.yaml` (narrower enums + "prefer narrowest")
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Add a `checkFrontmatterParseSafety` function that detects the comment-truncation class. **It
  must not be an ad-hoc regex** — reviewers correctly flagged that distinguishing a truncating
  ` #` from a quoted value, a URL, a `#` inside a string, or a full-line comment is exactly what a
  YAML parser disambiguates. Use a **constrained, frontmatter-aware line scan** with explicit
  grammar rules, operating per top-level `key: value` line in the frontmatter block:
  - Only flat `key: scalar` lines are in scope (skip full-line comments `^\s*#`, list items `- `,
    block-scalar indicators `|`/`>`, and continuation/indented lines).
  - For an in-scope line, isolate the value portion after the first `: `. If the value is wrapped
    in matching quotes (`"..."` or `'...'`), it is SAFE (a `#` inside is literal) — skip it.
  - For an unquoted value, flag it if it contains ` #` (space-hash, the comment trigger). A `#`
    with no preceding space, or `#` at the start of an otherwise-quoted/structural value, is not a
    comment trigger.
  - Cross-check the verdict against `parseFrontmatter`: if the parsed value differs from the raw
    value (truncation actually occurred), that is the high-confidence signal; the line scan is the
    detector and the parse-diff is corroboration.
  - Emit a `FrontmatterViolation` with remediation (quote the value).
- **Adversarial fixtures are mandatory** (test-first): truncating `# ` (flag), quoted value with
  `#` (no flag), full-line comment (no flag), URL with `#fragment` in a quoted value (no flag),
  `#` at value start (no flag), list-item value with `#` (decide + cover). The check ships only
  when these all pass.
- Extend `collectScanTargets` to collect markdown under `docs/solutions/` into a **dedicated
  `solutionMarkdown` target set — NOT merged into `targets.markdown`/`allScannedFiles`.** This is
  critical: `allScannedFiles` feeds `checkBannedPatterns` and allowlist warnings, so adding
  solution docs to the general set would subject historical docs to CC/CEP banned-pattern
  enforcement they were never meant to have and fail CI. The parse-safety check is the ONLY check
  that consumes `solutionMarkdown`; skill/agent required-field checks and banned-pattern scanning
  keep their existing skills+agents+src scope unchanged.
- Update the design-rationale comment block (~line 30) that currently states the gate "does not
  scan `docs/`" to reflect the new `docs/solutions/` parse-safety scope.
- Update `schema.yaml`: add `architecture_pattern`, `design_pattern`, `tooling_decision`,
  `convention` to the category enum, and add the "prefer the narrowest applicable value;
  best_practice is the fallback" guidance + the YAML-reserved-indicator quoting rule.

**Execution note:** Test-first — add a failing fixture proving `# `-truncation is currently
undetected and `docs/solutions/` is unscanned, then implement until green.

**Patterns to follow:**
- `scanSkillFrontmatter` / `checkFrontmatter` structure in `scripts/content-integrity.ts`
  (violation objects + remediation strings).
- Existing `collectScanTargets` directory-walk pattern.

**Test scenarios:**
- Happy path: a solution-doc fixture with `problem: cache miss # under load` → parse-safety
  violation flagged citing the `#`-truncation risk.
- Happy path: a correctly-quoted value `problem: "cache miss # under load"` → no violation.
- Edge case: `#` inside an already-quoted value → no false positive.
- Edge case: a `#` at line start (full-line YAML comment) → no false positive (it's a real comment,
  not a truncated value).
- Scan coverage: a malformed `docs/solutions/` fixture is now picked up (proves the file is
  scanned, where before it was skipped).
- Regression: existing skill/agent frontmatter checks still pass unchanged.
- Schema: `schema.yaml` parses and contains the four new enum values + "prefer narrowest" guidance.

**Verification:**
- `bun test tests/unit/content-integrity.test.ts` green including new cases.
- `bun scripts/content-integrity.ts` runs clean on the real repo (no new violations introduced by
  the scan extension — i.e., existing solution docs are already safe, or are fixed in this unit).
- `bun run typecheck` + `bun run lint` clean.

## System-Wide Impact

- **Interaction graph:** Unit 1 touches only `ce:review` skill prose + a new reference file; no
  source code. Unit 2 touches the CI gate (`scripts/content-integrity.ts`) which runs in the build
  job — a new failing class could block releases (intended; deterministic check).
- **Error propagation:** Unit 2's new violation type flows through the existing
  `FrontmatterViolation` aggregation + exit-code path; no new error channel.
- **State lifecycle risks:** None — both units are additive checks/prose.
- **API surface parity:** `collectScanTargets` return shape gains `docs/solutions/` coverage;
  confirm callers (`checkFrontmatter` and the new parse-safety check) consume the right target set
  and existing callers are unaffected.
- **Integration coverage:** Unit 2's "file is now scanned" scenario is the key integration proof
  (unit-level function tests alone won't prove `collectScanTargets` actually reaches solution docs).
- **Unchanged invariants:** existing skill/agent required-field frontmatter checks, phantom-ref
  checks, banned-pattern checks, and agent-color checks are unchanged. ce-review Stages 1–5 and the
  existing mode system are unchanged; Stage 5b is purely additive and validate-only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Validator subagent rejects real findings (false negatives) | Validate-only design: findings are never deleted, only surfaced in the "Filtered (not validated)" group with reason — human/fixer always sees them. |
| Per-finding validator cost scales with finding count | Default band (P0/P1 OR `requires_verification`) bounds the validated set; findings outside it skip the pass. |
| New parse-safety check is noisy / flags existing safe docs | Test-first with precise ` #`-on-unquoted-value detection; full-line comments and quoted values excluded; run against real repo before merge. |
| Extending the CI gate blocks releases on a new class | Intended for a deterministic structural check; fix any real existing violations in Unit 2 so the gate is green on merge. |
| Porting from upstream re-couples to CEP | Anti-coupling boundary (R7): adapt the discrete validator prompt only; strip `mode:agent`/action-class; convert all CC/CEP wording. |

## Documentation / Operational Notes

- Unit 1 changes are user-facing `ce:review` behavior — `docs/` reference for the review skill may
  need a note about the validation pass (check `docs:generate` output; counts unaffected).
- Unit 2 changes CI gate behavior; the design-rationale comment + any AGENTS.md/`docs/AGENTS.md`
  mention of the gate's scan scope should be checked for accuracy.
- Both units require registry regeneration only if reference-file inventories change (Unit 1 adds
  `validator-template.md` under the `ce-review` skill — regenerate + drift check).
- Commit prefixes: Unit 1 (`ce:review` skill behavior) and Unit 2 (gate + schema) are both
  user-visible-quality changes; classify per the conventional-commit map (likely `feat(review):`
  for Unit 1 since it adds review functionality, `fix(integrity):` or `feat(integrity):` for Unit 2
  depending on framing — confirm at PR time).

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-04-cep-verification-layers-requirements.md
- Related code: `skills/ce-review/SKILL.md`, `scripts/content-integrity.ts`,
  `src/lib/frontmatter.ts`, `skills/ce-compound/references/schema.yaml`
- Upstream prior art: `EveryInc/compound-engineering-plugin` ce-code-review `validator-template.md`,
  ce-compound `validate-frontmatter.py` + `schema.yaml`
