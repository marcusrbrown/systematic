---
title: "refactor: Harness-neutral dispatch prose in ce-* skills"
type: refactor
status: active
date: 2026-07-17
origin: docs/brainstorms/2026-07-17-ce-dispatch-prose-harness-neutral-requirements.md
---

# refactor: Harness-neutral dispatch prose in ce-* skills

## Execution Finding (2026-07-17) — scope collapsed during implementation

Mid-execution investigation invalidated the plan's premise and collapsed it to a single edit. Evidence:

- The qualified `systematic:<category>:<name>` form is the **canonical, phantom-validated cross-reference**: `checkReferenceIntegrity` (`scripts/content-integrity.ts:568-622`) matches it against a real `agents/<category>/<name>.md` — ARCHITECTURE.md invariant #4 ("no phantom skill references"). Stripping qualified IDs to bare names silently removes that validation coverage.
- ce-review's 16 qualified IDs are a **persona-roster reference table** (`SKILL.md:112-142`), not dispatch prose. The recon's "17 dispatch sites" was wrong — all 12 originally-flagged lines were R3/R4 prose with zero qualified IDs.
- The qualified form is the **corpus-wide convention** (document-review, deepen-plan, resolve-pr-feedback, ce-compound). Neutralizing only these 4 skills would break consistency.
- The planned R5 gate (ban qualified IDs in migrated bodies) would **conflict** with the phantom-reference check that validates them.

Decision (Marcus): narrow to the one genuinely-wrong form — the pseudo-dispatch fake-call syntax `task systematic:research:X(...)` in ce-plan, which reads as literal code on any harness. Convert to prose that **keeps** the phantom-validated qualified IDs. R1/R2a bare-name conversions (Units 1, 3) reverted; R5 gate (Unit 4) dropped. Requirements R1, R4–R8 are withdrawn; only R2's syntax-neutralization intent survives, reshaped to preserve qualified references.

## Overview

Four `neutral-v1`-marked ce-* skills (ce-plan, ce-ideate, ce-review, ce-brainstorm) carry subagent-dispatch prose using qualified persona IDs (`systematic:<category>:<name>`) and pseudo-dispatch call syntax (`task systematic:research:X(...)`) that neither harness resolves as a dispatch target. This plan replaces the qualified forms with bare persona names, minimally neutralizes the pseudo-dispatch syntax, and adds a lexical detector to content-integrity check #13 so the drift cannot silently return. Split into two risk tiers per document review: mechanical replacement (low risk, uniform) and narrative rewrite (higher risk, minimized, ce-review last).

## Problem Frame

The four skills assert `harness-portability: neutral-v1`, but their bodies name qualified persona IDs and pseudo-dispatch syntax. On Pi this is verified-broken — `systematic_delegate` matches bare names exactly and throws on a miss (`src/lib/agent-resolver.ts`). On OpenCode's task-tool dispatch path the qualified form is not a valid `subagent_type` either (`agent.get()` against a bare-name registry), though model inference has masked this and no OpenCode failure has been observed. Check #13 has no detector for this class, so the marker's neutrality claim goes unenforced (see origin: docs/brainstorms/2026-07-17-ce-dispatch-prose-harness-neutral-requirements.md).

## Requirements Trace

- R1. Replace every qualified persona ID with the bare persona name across the four skills (Tier 1, mechanical).
- R2. Neutralize pseudo-dispatch call syntax (`task systematic:research:X(...)`) minimally — change the dispatch form, not the surrounding orchestration narrative (Tier 2).
- R2a. ce-review handled last, highest scrutiny; prefer the smallest edit that removes the qualified/literal form over a fuller rephrase.
- R3. Preserve capability-degradation prose (`model:` overrides, `mode` omission, parallel-vs-sequential fallbacks) byte-identical; verify by pre/post diff of those blocks.
- R4. Preserve dispatch intent: personas, sequencing/parallelism, read-only constraints, run-id threading, validator/fixer orchestration unchanged in meaning.
- R5. Add a lexical qualified-ID detector to check #13, scanning migrated skill bodies and the currently scanned frontmatter fields.
- R6. The detector's category segment derives from the real bundled agent category list (not a hardcoded literal), so it cannot drift and benign non-category `systematic:` mentions do not trip it.
- R7. Reuse the existing exemption surface exactly (harness-profile files, sanctioned idiom); add no new carve-out. A migrated body may not contain a qualified ID even in a documented example.
- R8. Do not gate dispatch verbs (`spawn`/`dispatch`/`call`) — undecidable; accepted limitation that the gate enforces the qualified-ID form only.

## Scope Boundaries

- Only the four `neutral-v1` ce-* skills and content-integrity check #13.
- `model:`/`mode`/parallel degradation prose stays as-is (already harness-honest).
- No change to Pi's delegate resolver, OpenCode's task tool, or the agent registry.
- No new capability, no workflow redesign.

## Context & Research

### Relevant Code and Patterns

- Dispatch-prose sites (from recon): ce-plan `SKILL.md:172,229-230,240,298-299,327`; ce-ideate `SKILL.md:114,116,130`; ce-brainstorm `SKILL.md:117`; ce-review `SKILL.md` (persona-dispatch references — most of its ~17 flagged lines are `model:`/`mode`/parallel prose that R3 preserves; the implementer confirms in-scope vs out-of-scope per site).
- Gate internals: `scripts/content-integrity.ts:1135-1179` (`MIGRATED_SKILL_IDENTIFIER_PATTERNS`), `1181-1279` (`checkMigratedSkillIdentifiers`, `isHarnessProfileFile` exemption, frontmatter fields, sanctioned-idiom exemption, per-line reporting).
- Resolver contract: `src/lib/agent-resolver.ts`, `src/lib/pi-delegate-tool.ts` (bare-name only, `{agent,task}` shape).

### Institutional Learnings

- `docs/solutions/best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md` — the gate's marker-only predicate, 9-identifier lexical model, zone exemptions. This plan extends that exact detector.
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md` — R8's verb-exclusion follows the honest-ban rule (ban the lexically decidable form, do not guess paraphrases).
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — the marker predicate has no runtime consumer to mirror; the qualified-ID detector is gate-only enforcement.

## Key Technical Decisions

- **Risk-tiered, not gate-only:** the mechanical qualified-ID→bare fix carries the real Pi-correctness value at low risk and proceeds; the narrative rewrite is minimized and ce-review is last. Pure gate-only was rejected — it leaves neutral-v1 bodies carrying non-neutral IDs (see origin).
- **Category source derives, not hardcodes:** R6's detector reads the same bundled category list the codebase already knows, so the gate cannot drift from the real `agents/` categories.
- **Prose clean before gate goes live:** Units 1-3 land the prose fixes before Unit 4's detector enforces on the real tree, so content-integrity stays green through the change.

## Open Questions

### Resolved During Planning

- Enumerate vs derive category names for R5: **derive** from the bundled category list.
- Gate-only vs full rewrite: **risk-tiered rewrite** (Marcus's decision after document review).

### Deferred to Implementation

- Exact neutral phrasing per R2 site: a per-site wording call, bounded by the R2/R2a minimize-the-edit rule so it cannot balloon into a narrative rewrite.
- Whether ce-review has any true in-scope qualified-ID/pseudo-dispatch site or is entirely R3-preserved prose: confirmed per-site during Unit 3.

## Implementation Units

> **Superseded by the Execution Finding above.** Units 1, 3, and 4 were withdrawn (bare-name conversion strips phantom-validated references; the R5 gate conflicts with the phantom-reference check). Only Unit 2's syntax-neutralization shipped, reshaped to preserve qualified IDs. The original units are retained below for provenance.

- [x] **Unit 2 (shipped, reshaped): pseudo-dispatch syntax → prose in ce-plan.** Converted the three `task systematic:research:X(...)` / `task systematic:workflow:X(...)` fake-call blocks (`skills/ce-plan/SKILL.md` — Phase 1.1, 1.3, 1.5) into `Dispatch \`systematic:<category>:<name>\` — pass ...` prose, matching ce-plan's own existing dispatch-instruction style and retaining the phantom-validated qualified IDs. Verified: content-integrity clean, 0 pseudo-dispatch literals remain, 7 qualified IDs retained, ce-ideate/ce-brainstorm/ce-review untouched.

- [~] **Unit 1 (withdrawn): Tier-1 mechanical qualified-ID replacement (ce-plan, ce-ideate, ce-brainstorm)**

**Goal:** Replace qualified persona IDs with bare names at the prose-mention sites in the three small skills.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `skills/ce-plan/SKILL.md` (172, 240)
- Modify: `skills/ce-ideate/SKILL.md` (114, 116, 130)
- Modify: `skills/ce-brainstorm/SKILL.md` (117)

**Approach:**
- Find-replace each `systematic:<category>:<name>` → `<name>` (e.g., `systematic:research:slack-researcher` → `slack-researcher`). Prose-mention sites only ("Dispatch `systematic:research:X`" → "Dispatch `X`"); surrounding sentence unchanged.
- Do not touch `model:`/`mode`/parallel wording on these lines (R3).

**Patterns to follow:** bare persona names as registered in `agents/<category>/<name>.md` frontmatter.

**Test scenarios:**
- Integration: `bun scripts/content-integrity.ts` stays clean after the edits (no new violations; gate not yet extended).
- Happy path: grep confirms zero `systematic:research:` / `systematic:workflow:` qualified IDs remain in the three files' prose-mention sites.

**Verification:** No qualified persona IDs at the listed prose-mention sites; degradation prose untouched; content-integrity clean.

- [~] **Unit 2 (original spec, superseded by shipped-reshaped above): Tier-2 pseudo-dispatch syntax neutralization (ce-plan)**

**Goal:** Remove the `task systematic:research:X(...)` pseudo-call syntax in favor of minimal harness-neutral dispatch prose.

**Requirements:** R2, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `skills/ce-plan/SKILL.md` (229-230, 298-299, 327)

**Approach:**
- Replace the literal `task systematic:research:X(<args>)` call form with neutral prose that names the persona by bare name and routes through the active harness's delegation mechanism (reference the capability-profile mechanism, not a literal call form).
- Keep the change local to the dispatch line; do not restructure the surrounding phase narrative (R4).

**Patterns to follow:** the neutral dispatch phrasing already used in orchestrating-subagents after its Unit 3 rewrite (harness-neutral, no literal `task(` form).

**Test scenarios:**
- Happy path: zero `task systematic:` pseudo-call occurrences remain in ce-plan.
- Integration: content-integrity clean; the ce-plan Phase 1.1 dispatch intent (which researchers run, in parallel) reads unchanged in meaning.

**Verification:** No pseudo-dispatch call syntax in ce-plan; the research-agent dispatch intent is preserved.

- [~] **Unit 3 (withdrawn): ce-review careful pass (highest scrutiny, last)**

**Goal:** Neutralize any in-scope qualified-ID / pseudo-dispatch form in ce-review while preserving its tuned persona-orchestration exactly.

**Requirements:** R1, R2a, R3, R4

**Dependencies:** Units 1-2

**Files:**
- Modify: `skills/ce-review/SKILL.md`

**Approach:**
- Classify each flagged site: in-scope (qualified ID / pseudo-dispatch literal) vs out-of-scope (`model:` override, `mode` omission, parallel/sequential fallback — R3 preserved).
- Edit only in-scope sites, with the smallest change that removes the qualified/literal form (R2a).
- Preserve run-id threading, validator/fixer spawning, read-only constraints, and parallel-dispatch semantics unchanged in meaning (R4).

**Execution note:** Diff the `model:`/`mode`/parallel blocks pre/post to confirm they are byte-identical (R3) before considering the unit done.

**Test scenarios:**
- Happy path: zero qualified persona IDs and zero pseudo-dispatch literals remain in ce-review.
- Edge case: each R3 degradation block is byte-identical pre/post (diff check).
- Integration: content-integrity clean; the persona-orchestration flow (run-id, validator/fixer, parallel reviewers) reads with unchanged meaning.

**Verification:** In-scope forms removed; R3 blocks provably unchanged; orchestration intent preserved.

- [~] **Unit 4 (withdrawn — conflicts with phantom-reference check): content-integrity check #13 — qualified-ID detector**

**Goal:** Add a lexical detector that flags qualified persona IDs in migrated skill bodies and scanned frontmatter fields, keyed to the derived bundled category list.

**Requirements:** R5, R6, R7, R8

**Dependencies:** Units 1-3 (real-tree prose must be clean before the detector enforces)

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Derive the category segment from the bundled agent category list already available to the script (the `agents/` subdirectory set), not a hardcoded literal (R6).
- Add a `systematic:<category>:<name>` pattern to the migrated-identifier scan, reusing `isHarnessProfileFile` exemption and the existing sanctioned-idiom handling unchanged (R7).
- Do not add dispatch-verb detection (R8).
- Reuse the existing per-line reporting and frontmatter-field scan.

**Execution note:** Test-first — write the red fixtures (synthetic migrated skill with a qualified ID flagged; profile file with the same ID exempt; benign non-category `systematic:foo` not flagged) before the detector.

**Test scenarios:**
- Happy path: a synthetic migrated skill body containing `systematic:review:correctness-reviewer` is flagged.
- Edge case: the same qualified ID inside a harness-profile file is NOT flagged (exemption reused).
- Edge case: a benign `systematic:something` that is not `<category>:<name>` is NOT flagged (R6 category bound).
- Edge case: a qualified ID in a scanned frontmatter field (description/argument-hint) is flagged.
- Error path: category-derivation returns the real bundled categories (guard against an empty/stale list silently disabling the detector).
- Integration: full-tree `bun scripts/content-integrity.ts` is clean after Units 1-3 (the four skills now pass the new detector).

**Verification:** Detector flags qualified IDs in migrated bodies + frontmatter, honors existing exemptions, derives categories, and the real tree is green.

## System-Wide Impact

- **Interaction graph:** check #13 runs in the CI content-integrity gate; the new pattern participates in `totalViolations`. No runtime code path touched.
- **API surface parity:** the four skills' rendered command descriptions are unaffected (frontmatter `description` unchanged unless a qualified ID appears there).
- **Unchanged invariants:** Pi delegate resolver, OpenCode task tool, agent registry, and the existing 9 migrated-identifier patterns all unchanged; this adds one pattern and edits prose only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| ce-review rewrite flattens tuned orchestration | R2a smallest-edit rule + R4 intent preservation + R3 byte-diff check; handled last under highest scrutiny |
| Gate lands before prose is clean → CI red | Unit 4 depends on Units 1-3; detector enforces only after the four skills are clean |
| Category derivation drifts or returns empty, silently disabling the detector | Explicit test asserts the derived list matches the real bundled categories |
| R5 flags a legitimate documented qualified-ID example | Accepted by R7 — migrated bodies use bare names everywhere; examples rewritten, no carve-out |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-17-ce-dispatch-prose-harness-neutral-requirements.md](docs/brainstorms/2026-07-17-ce-dispatch-prose-harness-neutral-requirements.md)
- Related code: `scripts/content-integrity.ts`, `src/lib/agent-resolver.ts`, `skills/ce-plan|ce-ideate|ce-review|ce-brainstorm/SKILL.md`
- Learnings: `docs/solutions/best-practices/neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md`
