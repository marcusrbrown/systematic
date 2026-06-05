---
title: "feat: Merge upstream ce-brainstorm + ce-plan improvements into ours"
type: feat
status: completed
shipped: "PR #486; released in v2.26.0"
date: 2026-06-04
origin: docs/brainstorms/2026-06-04-merge-upstream-brainstorm-plan-requirements.md
---

# Merge Upstream ce-brainstorm + ce-plan Improvements

## Overview

Merge the improvements from upstream CEP `ce-brainstorm` and `ce-plan` into Systematic's versions —
while preserving the Systematic-specific additions upstream lacks (Phase 3.5 Document Review,
`requirements-capture.md`, `visual-communication.md`, our Core Plan Template). Upstream's
improvements taken: Phase 2.5 Synthesis Summary, markdown rendering guidance, section contracts, and
ce-plan's anti-expansion + scope-synthesis steps. **HTML output mode and the output-mode toggle are
dropped** — Systematic renders markdown only, so the html-rendering machinery and Phase 0.0 output
resolution add no value.

## Problem Frame

Our `ce-brainstorm` and `ce-plan` diverged from upstream and have fallen behind on genuinely useful
improvements (see origin: docs/brainstorms/2026-06-04-merge-upstream-brainstorm-plan-requirements.md).
The directive is to bring upstream's improvements into ours, not to lean-rewrite or cherry-pick.
These are our two highest-traffic workflow skills, so the merge must read as one coherent skill each,
not stitched-together halves.

## Requirements Trace

- R1. ce-brainstorm gains Phase 2.5 Synthesis Summary (+ `synthesis-summary.md`) as a scope
  checkpoint before doc-write, coexisting with our Phase 3.5 Document Review (quality gate after).
- R2. Both skills gain a per-skill `markdown-rendering.md` rendering-guidance reference (prose/bullets/
  tables heuristics, ID-prefix format, bold-leader labels, section anatomy), wired into the skill.
  **HTML rendering and any output-mode toggle are explicitly NOT included** — markdown only.
- R3. Section description (`brainstorm-sections.md` / `plan-sections.md`) lands as a **rendering/
  ordering layer only**; our `requirements-capture.md` / Core Plan Template remain the canonical
  content authority. (No html-rendering sub-file.)
- R4. ce-plan gains 0.7 Solo-Mode Scoping Synthesis + 5.1.5 Brainstorm-Sourced Scoping Synthesis
  (mutually exclusive: no-origin-doc vs with-origin-doc) + 3.7 Anti-Expansion.
- R5. All Systematic-specific additions preserved and reconciled (no drop, no duplication).
- R6. All CEP-internal converted to Systematic conventions; content-integrity clean
  (no `.compound-engineering`, `CLAUDE.md`, `compound-engineering:`; all sub-file refs resolve;
  no dangling html-rendering ref); registry regenerated; full gate green; additions dogfood
  `writing-skills`.

## Scope Boundaries

- No CONCEPTS.md creation; no `ce-sessions` dependency.
- No regression of Phase 3.5 Document Review or the Core Plan Template.
- **No HTML rendering** (`html-rendering.md` not imported) and **no output-mode toggle** (no Phase 0.0,
  no `output:` token, no config field) — Systematic renders markdown only.

### Deferred to Separate Tasks

- **Vocabulary Capture** (both skills): OMIT — depends on CONCEPTS.md we don't have. Reintroduce
  as its own task if CONCEPTS.md ever lands. (origin decision)
- **ce-plan 0.1a Approach-Altitude**: DEFER — planning-time grounding found `approach-altitude.md`
  introduces an `execution: knowledge-work` carve-out coupled to `ce-work` routing changes
  (`plan-sections.md` markers + ce-work carve-out path) that are outside this merge's scope and were
  rejected in the ce-work delta analysis. Porting 0.1a faithfully would pull in that out-of-scope
  carve-out. Track separately if the knowledge-work carve-out is ever adopted across ce-plan+ce-work.
- ce-work / ce-compound-refresh merges: separate skills, separate effort.

## Context & Research

### Relevant Code and Patterns

- `skills/ce-brainstorm/SKILL.md` (198 lines) — our skill; Phase 0/0.1b/2/3/3.5 structure; `$ARGUMENTS`
  at line 42; `argument-hint` frontmatter. Phase 3.5 Document Review is ours (upstream lacks).
- `skills/ce-brainstorm/references/{handoff,requirements-capture,universal-brainstorming}.md` — ours.
  `requirements-capture.md` (243 lines) is the canonical content contract — preserve.
- `skills/ce-plan/SKILL.md` (737 lines) — our skill; Core Plan Template under Phase 4 is canonical.
- `skills/ce-plan/references/{deepening-workflow,plan-handoff,universal-planning,visual-communication}.md`
  — ours; `visual-communication.md` (31 lines) upstream lacks — preserve.
- `scripts/content-integrity.ts` — `checkSubfileReferences` requires referenced sub-files to resolve;
  banned-pattern scan catches CC/CEP residue. New sub-files must be referenced + convertible.
- `src/lib/config-schema.ts` — strict Zod schema; confirms output-mode must NOT use config (R2).

### Upstream Source (EveryInc/compound-engineering-plugin, plugins/compound-engineering/skills/)

- `ce-brainstorm/SKILL.md` (285 lines): Phase 2.5 Synthesis Summary (take); Phase 0.0 Output Mode +
  Vocabulary Capture (omit).
- `ce-brainstorm/references/`: `synthesis-summary.md` (271, take), `brainstorm-sections.md` (301,
  take), `markdown-rendering.md` (207, take, strip html cross-refs); `html-rendering.md` (538, omit).
- `ce-plan/SKILL.md` (791 lines): 0.7 Solo-Mode Scoping, 3.7 Anti-Expansion, 5.1.5 Brainstorm-Sourced
  Scoping, section-contract wiring (take); Phase 0.0 Output Mode + 0.1a Approach-Altitude (omit/defer).
- `ce-plan/references/`: `plan-sections.md` (286, take), `synthesis-summary.md` (take),
  `markdown-rendering.md` (take, strip html cross-refs); `approach-altitude.md` + `html-rendering.md` (omit).

### Institutional Learnings

- `docs/solutions/` CEP-conversion lessons: grep changed files for CC/CEP residue + over-conversions
  after any sed pass; zsh word-splitting silent-failure class — use `find | while read` not `for f in $X`.
- Imported sub-files carry no per-file attribution comment (the skills are adaptations, not vendored).

## Key Technical Decisions

- **Drop HTML + output-mode entirely** (R2): Systematic renders markdown only. No `html-rendering.md`
  import, no Phase 0.0 Output Mode, no `output:` token, no config field. Upstream's own
  `markdown-rendering.md` states "No HTML mixed in... defer to HTML rendering" — confirming markdown
  is a clean standalone target. This removes the config-vs-token question and ~1076 lines of html
  machinery.
- **Per-skill `markdown-rendering.md`** (R2): each skill gets its own adapted copy (matches upstream
  layout; self-contained skills). ~200 lines/skill — the useful rendering guidance (prose/bullets/
  tables heuristics, ID-prefix format, bold-leader labels, section anatomy).
- **Section authority = single owner, hard rule** (R3 — tightened per review): our
  `requirements-capture.md` / Core Plan Template are the SOLE owner of section *inventory, ordering,
  and meaning*. The imported `*-sections.md` must be reduced to a strictly mechanical presentation
  reference — any normative section *names/order* in upstream's copy are STRIPPED on import and, if
  genuinely missing, folded into our canonical contract instead. `*-sections.md` may only describe
  *how* a section renders, never *which* sections exist. This is a hard single-owner rule, not a
  soft split — if a sentence in `*-sections.md` defines section existence, it's a bug to fix during
  import.
- **2.5 / 3.5 checkpoint contract**: 2.5 = scope gate before doc (only scope gate); 3.5 = quality/
  format review after doc (not a second scope negotiation).
- **One shared synthesis artifact, three consumers** (reframed per review — not "one model"):
  `synthesis-summary.md` is a shared summary artifact consumed by brainstorm Phase 2.5 (from
  dialogue), ce-plan 0.7 (solo, no origin doc), and ce-plan 5.1.5 (with origin doc). The three are
  distinct control flows over different input states — they share the artifact's keep-tests/shape
  budgets, not one flow. **Verified against upstream** (ce-plan SKILL.md lines 234, 638): 0.7 fires
  only in solo invocation (4 explicit guards); 5.1.5 fires only when an origin `*-requirements.md`
  exists; each explicitly skips when the other's condition holds. Mutual exclusivity is upstream's
  actual wiring, not an inference.
- **0.7 is safe to take without 0.1a** (verified — review concern resolved): upstream SKILL.md line
  125 states approach-altitude (0.1a) operates *before* deliverable-commitment while 0.7/5.1.5
  "operate on a deliverable already committed to" — disjoint surfaces. 0.7 depends only on
  `synthesis-summary.md` (zero outbound refs), NOT on the knowledge-work carve-out. Defer 0.1a only.
- **Preserve headless-mode routing**: `synthesis-summary.md` carries headless-mode routing (internal
  draft, skip chat-time stage, route inferred bets to `## Assumptions`). Our skills have pipeline/
  `disable-model-invocation` paths — preserve this routing on import so automated callers behave.
- **Defer 0.1a Approach-Altitude**: coupled to out-of-scope ce-work knowledge-work carve-out.

## Open Questions

### Resolved During Planning

- HTML + output-mode: dropped entirely (markdown-only target).
- Rendering layout: per-skill `markdown-rendering.md` copy.
- Section authority (split-brain risk): ours canonical, upstream rendering-only.
- Vocabulary Capture: omit (CONCEPTS.md dependency).
- Approach-Altitude coupling: defer (ce-work carve-out dependency).
- 2.5/3.5 and triple-synthesis coherence: explicit contracts above.

### Deferred to Implementation

- Exact merged phase numbering in each SKILL.md (preserve our existing numbers; insert upstream
  phases at the grounded insertion points — brainstorm 2.5 between our Phase 2 and Phase 3; plan
  3.7 after our 3.6, 0.7/5.1.5 at their phases) — final numbering settled when editing the live files.
- Whether any upstream section in `*-sections.md` names a section our canonical contract is missing
  (fold in if so) — determined when reconciling the two during Unit edits.
**Transitive sub-file reference audit (verified against upstream — these MUST be cleaned on import,
because content-integrity only scans SKILL.md entry files, NOT nested reference docs):**
- `brainstorm-sections.md` → references `html-rendering.md` + `markdown-rendering.md`: STRIP the
  html-rendering ref (not imported); keep markdown-rendering ref.
- `plan-sections.md` → references `approach-altitude.md` + `html-rendering.md` + `deepening-workflow.md`
  + `markdown-rendering.md`: STRIP approach-altitude + html-rendering refs (neither imported); keep
  `deepening-workflow.md` (we already have it) + markdown-rendering.
- `synthesis-summary.md` (brainstorm) → references `brainstorm-sections.md` (imported ✓);
  `synthesis-summary.md` (ce-plan) → zero outbound refs ✓; both `markdown-rendering.md` → zero refs ✓.
- After import, grep every NEW sub-file for `html-rendering`, `approach-altitude`, `.compound-engineering`,
  `CONCEPTS.md`, `ce-sessions` — all must be absent (manual audit, since the gate won't catch nested refs).

## Implementation Units

- [x] **Unit 1: ce-brainstorm merge — Phase 2.5 Synthesis Summary + markdown rendering + sections**

**Goal:** Merge upstream's improvements into `skills/ce-brainstorm/`, preserving Phase 3.5 Document
Review + `requirements-capture.md`. No html, no output-mode.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** None

**Files:**
- Modify: `skills/ce-brainstorm/SKILL.md` (add Phase 2.5 Synthesis Summary between our Phase 2 and
  Phase 3; wire the markdown-rendering + sections references; keep Phase 3.5; NO Phase 0.0)
- Create: `skills/ce-brainstorm/references/synthesis-summary.md` (converted from upstream)
- Create: `skills/ce-brainstorm/references/brainstorm-sections.md` (rendering/ordering layer)
- Create: `skills/ce-brainstorm/references/markdown-rendering.md` (converted; html cross-refs stripped)
- Preserve: `skills/ce-brainstorm/references/requirements-capture.md` (canonical content authority)

**Approach:**
- Fetch upstream sub-files; apply CEP→Systematic conversion (`compound-engineering:`→`systematic:`,
  `.compound-engineering/`→drop, `CLAUDE.md`→`AGENTS.md`, CC tool names). Do NOT import
  `html-rendering.md`; strip any html-rendering cross-references inside `markdown-rendering.md` and
  the section files (html is not a Systematic output).
- Phase 2.5: insert the synthesis-summary scope checkpoint before doc-write; explicitly note it is
  the scope gate and Phase 3.5 remains the post-doc quality review.
- `brainstorm-sections.md` + `markdown-rendering.md` describe section ordering/rendering only;
  `requirements-capture.md` stays the content authority — if upstream names a missing section, fold
  it into requirements-capture.
- Omit Vocabulary Capture entirely. No Phase 0.0 / output token.

**Execution note:** Dogfood `writing-skills` — edited skills must be tested (apply the skill mentally
to confirm the merged flow is coherent end-to-end before claiming done).

**Patterns to follow:** existing Systematic skill prose style; our Phase 3.5 wording; converted-import
hygiene from prior CEP imports.

**Test scenarios:**
- Happy path: a Standard brainstorm surfaces Phase 2.5 scope synthesis (confirm-gated) before the doc,
  then runs Phase 3.5 Document Review after — both fire, no redundancy.
- Error path / hygiene: content-integrity finds zero CC/CEP residue, no html-rendering reference, and
  all 3 new sub-file refs resolve.
- Integration: merged SKILL.md reads coherently end-to-end (no orphaned phase numbers, no dangling
  refs, no stray output-mode mention).

**Verification:** content-integrity clean; merged skill reads as one coherent workflow; Phase 3.5 +
requirements-capture.md intact; no html/output-mode residue.

- [x] **Unit 2: ce-plan merge — 3.7 Anti-Expansion + 0.7/5.1.5 scope synthesis + markdown rendering + sections**

**Goal:** Merge upstream's improvements into `skills/ce-plan/`, preserving the Core Plan Template +
`visual-communication.md`; defer 0.1a Approach-Altitude; no html, no output-mode.

**Requirements:** R2, R3, R4, R5, R6

**Dependencies:** Unit 1 (shared conversion approach + synthesis-summary concept established first;
ship in order)

**Files:**
- Modify: `skills/ce-plan/SKILL.md` (3.7 Anti-Expansion after our 3.6; 0.7 Solo-Mode Scoping;
  5.1.5 Brainstorm-Sourced Scoping; section-contract wiring to plan-sections; keep Core Plan
  Template; NO Phase 0.0; do NOT add 0.1a)
- Create: `skills/ce-plan/references/synthesis-summary.md` (converted)
- Create: `skills/ce-plan/references/plan-sections.md` (rendering/ordering layer)
- Create: `skills/ce-plan/references/markdown-rendering.md` (converted; html cross-refs stripped)
- Preserve: `skills/ce-plan/references/visual-communication.md`

**Approach:**
- Same conversion approach as Unit 1 (no html import; strip html cross-refs; no output token).
- 3.7 Anti-Expansion: route tangential "while we're here" work to our existing `### Deferred to
  Separate Tasks` section under Scope Boundaries (reference our section name, not upstream's).
- 0.7 Solo-Mode Scoping (no origin doc) and 5.1.5 Brainstorm-Sourced Scoping (with origin doc) are
  mutually exclusive — wire both to reference `synthesis-summary.md`; ensure exactly one fires.
- Section-contract wiring references `plan-sections.md` for rendering only; Core Plan Template stays
  the content authority.
- Do NOT port 0.1a Approach-Altitude (deferred — ce-work carve-out coupling).

**Execution note:** Dogfood `writing-skills`; verify the merged plan flow end-to-end.

**Patterns to follow:** our Core Plan Template; our Scope Boundaries / Deferred sub-heading; Unit 1's
conversion hygiene.

**Test scenarios:**
- Happy path: `ce:plan` from an origin requirements doc fires 5.1.5 (not 0.7); from a bare request via
  bootstrap fires 0.7 (not 5.1.5) — never both.
- Edge case: a tangential refactor request routes to Deferred (3.7) unless explicitly asked.
- Error path / hygiene: content-integrity clean; all 3 new sub-file refs resolve; 0.1a absent;
  no `approach-altitude.md` or `html-rendering.md` reference dangling.
- Integration: merged SKILL.md coherent end-to-end; Core Plan Template + visual-communication.md intact.

**Verification:** content-integrity clean; one-synthesis-model holds (0.7 xor 5.1.5); 3.7 routes to our
Deferred section; Core Plan Template preserved; 0.1a + html/output-mode not present.

- [x] **Unit 3: Regenerate registry + full gate + dogfood verification**

**Goal:** Reconcile generated artifacts and prove the full quality gate.

**Requirements:** R6

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `registry/registry.jsonc` (regenerated via `bun scripts/generate-registry.ts`)

**Approach:**
- Regenerate registry (new sub-files may change registry output).
- Run the full pre-PR gate.

**Test scenarios:** Test expectation: none — generated-artifact reconciliation + gate run, no new
behavioral code.

**Verification (concrete assertions, not "reads coherently"):**
- **Phase-sequence assertion:** extract the merged phase headings from each SKILL.md; confirm the
  expected ordered sequence (brainstorm: ...Phase 2 → Phase 2.5 → Phase 3 → Phase 3.5...; plan:
  ...0.7 present, 3.7 after 3.6, 5.1.5 at its phase, NO Phase 0.0, NO 0.1a). No orphaned/duplicate
  phase numbers.
- **Reference-resolution assertion:** every `references/*.md` mentioned in each SKILL.md resolves on
  disk (content-integrity covers this); PLUS the manual nested-ref audit from Unit 1/2 confirms no
  `html-rendering`/`approach-altitude` strings survive in any new sub-file.
- **Gate:** typecheck, lint, content-integrity, registry drift, schema drift, build, Node ESM smoke
  (default-only), full unit suite, docs build — all green.
- **Taxonomy leak:** `grep -rEn '\bR[0-9]+\b|\bUnit [0-9]+\b' skills/ce-brainstorm skills/ce-plan`
  returns only legitimate illustrative content, not leaked taxonomy from THIS plan.
- **Preservation assertion:** Phase 3.5 Document Review, requirements-capture.md, Core Plan Template,
  visual-communication.md all present and unmodified in behavior.

## System-Wide Impact

- **Interaction graph:** ce-brainstorm and ce-plan are loaded by users + by other workflows
  (`ce:work` reads plans; LFG/SLFG pipelines invoke them with `disable-model-invocation`). No output
  mode means no behavioral change for automated callers — they keep getting markdown.
- **API surface parity:** both skills get the same `markdown-rendering.md` guidance — keep the
  rendering conventions consistent across the two so docs look uniform.
- **Unchanged invariants:** Phase 3.5 Document Review, requirements-capture.md, Core Plan Template,
  visual-communication.md — explicitly preserved, not modified in behavior. The skill registration
  mechanism (`collectSkillsAsCommands`) is unchanged; this is content-only.
- **Integration coverage:** content-integrity's sub-file-reference + banned-pattern checks are the
  automated proof that the merge introduced no dangling refs or CEP residue.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Half-converted CEP residue slips through (history of missed `CLAUDE.md`/`.compound-engineering`) | Post-conversion grep on changed files for CC/CEP refs AND over-conversions; content-integrity gate as backstop |
| Merged SKILL.md becomes stitched-together halves (incoherent flow) | Dogfood `writing-skills`; read end-to-end; user-flow-coherence success criterion (one scope model, one section authority, one output path) |
| Split-brain section authority (two normative section sources) | Decided: ours canonical, upstream rendering-only; fold missing sections into ours rather than keep parallel normative file |
| 0.7 / 5.1.5 both fire (redundant synthesis) | Mutually exclusive by origin-doc presence; verify exactly one path in test scenarios |
| Imported `markdown-rendering.md` retains html cross-references (upstream treats html as a sibling) | Strip html-rendering cross-refs during conversion; content-integrity confirms no dangling html-rendering reference |

## Documentation / Operational Notes

- No docs-site changes expected (skills are bundled content; registry regen covers OCX).
- No `argument-hint` changes needed (no output mode). Skill argument shapes are unchanged.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-04-merge-upstream-brainstorm-plan-requirements.md](docs/brainstorms/2026-06-04-merge-upstream-brainstorm-plan-requirements.md)
- Upstream: `EveryInc/compound-engineering-plugin` @ `plugins/compound-engineering/skills/{ce-brainstorm,ce-plan}/`
- Related code: `scripts/content-integrity.ts`, `src/lib/config-schema.ts`, `skills/ce-brainstorm/`, `skills/ce-plan/`
