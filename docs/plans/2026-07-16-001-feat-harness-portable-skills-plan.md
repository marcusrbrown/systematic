---
title: 'feat: Harness-portable bundled skills (B′-thin)'
type: feat
status: active
date: 2026-07-16
origin: docs/brainstorms/2026-07-16-harness-portable-skills-requirements.md
---

# feat: Harness-Portable Bundled Skills (B′-thin)

## Overview

Pi sessions activating bundled skills today receive instructions naming OpenCode tools that do not exist in Pi. This plan rewrites the four divergent capability instructions (subagent delegation, blocking user interaction, task tracking, skill loading) as neutral operations in a six-skill migrated set, ships two capability profiles (OpenCode, Pi) inlined through both controlled bootstraps, adds Pi's binding to the multi-harness interaction idiom at every site catalog-wide, enforces a zero-tolerance identifier ban on the migrated set in the content-integrity gate, and proves the discipline with a Pi subprocess-harness scenario.

## Problem Frame

v3.0.0 made Pi a first-class consumer of `skills/` (`pi.skills` manifest — native discovery of every SKILL.md). The prose was written for OpenCode: `orchestrating-subagents` titles OpenCode's `task()` "The Portable Primitive" in a harness whose delegation is sequential-only and persona-bound; the interaction idiom ("`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini") appears across 17 skills with zero Pi mentions. Document-review of the fuller B′ shape converged on staging thin: prove the discipline on the shipped, verifiable harness before minting more profiles. (see origin: docs/brainstorms/2026-07-16-harness-portable-skills-requirements.md)

## Requirements Trace

- R1. Four divergent capabilities defined as the neutral vocabulary; near-universal operations stay concrete (origin R1).
- R2. Migrated set: `orchestrating-subagents` (structural rewrite), `using-systematic` (additive routing), Pi binding added to the interaction idiom in `ce-brainstorm`, `ce-plan`, `ce-review` (3 sites), `ce-ideate` (origin R2). Per user confirmation, the same one-line Pi binding also lands at the 13 idiom sites in unmigrated skills (no gate marking implied).
- R3. Neutral operations with inline fallbacks; workflow invariants capability-independent; body says *what*, profile says *how to call it here* (origin R3).
- R4/R5. Two plain-markdown profiles under `skills/using-systematic/references/`; Pi profile encodes sequential-only `systematic_delegate`, optional blocking-input extension with numbered-chat fallback, skill loading via `systematic_skill` or native activation (origin R4, R5).
- R6. Both bootstraps inline their compact profile (origin R6).
- R7. Zero-tolerance bounded-identifier ban on the migrated set, fence-aware, profile files exempt-in-fences (origin R7).
- R8. Pi harness scenario: payload-scan proof of no absent-tool instructions (origin R8).
- R9/R10. Honesty posture in docs; `gh`/`git` stay; accidental `bun` prose in the migrated set generalized (origin R9, R10).

## Scope Boundaries

- No profiles for Claude Code / Codex / Copilot / Gemini this increment.
- No migration or gate-marking of the remaining catalog beyond the idiom one-liners.
- No runtime prose rewriting; no build-time variants.
- `INTERNAL_AGENT_SIGNATURES` untouched (OpenCode-only mechanism, irrelevant to Pi path).
- ce-review's `@./references/...` include-syntax portability: unresolved, deferred with the raw-consumer scope.

### Deferred to Separate Tasks

- Additional harness profiles + remaining-catalog classification: future increment, gated on the proof loop's evidence plus an explicit go decision.
- New solution docs for the two novel patterns (inlined capability profiles; metadata-marked gate subset): post-merge `ce:compound`.
- HARNESSES.md maintenance cadence beyond this increment (update when a profile ships or a harness contract changes).

## Context & Research

### Relevant Code and Patterns

- `src/lib/bootstrap.ts:175-217` `getBootstrapContent` — string concatenation; the `usageTemplate` field of `BootstrapDeps` (108-111) is the existing per-harness seam; insertion point for the profile block is between usage template and catalog (line 206), inside the `<SYSTEMATIC_WORKFLOWS>` zone (inherits marker idempotency).
- `src/pi.ts:28-30, 62-68` — `PI_BOOTSTRAP_USAGE_TEMPLATE` override + load-time bootstrap snapshot; `before_agent_start` composes via `composeSystemPromptWithBootstrap` (`src/lib/bootstrap.ts:143-159`).
- `scripts/content-integrity.ts` — 12 free-function checks dispatched in `checkContentIntegrity` (1261-1333); `stripFencedCodeBlocks` (1065-1071) is the fence primitive (used by `checkArgumentHint`); `isSkillEntryFile` (1175-1184) is the per-file scoping precedent; wiring requires `CheckResult` field + printer + `totalViolations` term.
- `src/lib/skills.ts:64-76` `parseMetadata` — `metadata` is an allowlisted top-level field, free-form string-string map, gate-opaque inside. Marker: `metadata: { harness-portability: neutral-v1 }`.
- `tests/integration/pi.test.ts:692-737` (bootstrap marker in payload, plain prompt), `824-871` (`systematic_skill` scripted tool call) — templates for the proof scenario.
- `tests/unit/bootstrap.test.ts:79-100` — proves `usageTemplate` override; extend for `profileBlock`.
- Idiom sites (19 total): ce-brainstorm:33, ce-plan:19, ce-review:62+314+637 (314 drifted to 2 harnesses), ce-ideate:21, deepen-plan:25, resolve-pr-feedback:330, frontend-design:56, git-commit-push-pr:10, git-commit:59+83, git-clean-gone-branches:40, ce-compound:35+266+416, ce-compound-refresh:36+398+678, reproduce-bug:17+114, onboarding:388, test-browser:51.
- `skills/orchestrating-subagents/SKILL.md` — 12 `task(` occurrences: 2 framing (8, 12), 7 fenced examples (15-87), 3 instruction/table (121, 122, 133).
- `skills/using-systematic/SKILL.md` — zero divergent identifiers in body; OpenCode-specific routing at lines 30 and 111 (duplicated by the bootstrap usage template); rest is harness-neutral discipline.

### Institutional Learnings

- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md` — lexical ban, stated scope limits, one-action remediation.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md` — do not reuse OpenCode's scrubber in Pi; pin OpenCode bootstrap bytes with a snapshot test; add a double-run idempotency test; assert Pi output excludes OpenCode-only tool language.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md` — violation-or-nothing wiring; fence-strip before body scans + dedicated fence tests.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — the gate's `metadata` read must mirror `parseMetadata`'s drop rules (non-string value drops the whole map).
- `docs/solutions/best-practices/pi-real-runtime-integration-harness-2026-07-16.md` — payload scan is the settled assertion mechanism; hard-fail on missing Pi; positive markers over absence-of-error.
- `docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md` — empirical token count before AND after prose rewrites.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` — registry drift-check after any description edit.
- `docs/solutions/workflow-issues/risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md` — resolutions echoed into unit specs below, not left in tables.

## Key Technical Decisions

- Profile block rides inside `<SYSTEMATIC_WORKFLOWS>` via a new `BootstrapDeps.profileBlock` field (default absent → OpenCode path unchanged shape): inherits existing marker idempotency; mirrors the proven `usageTemplate` seam. Rejected: a second sentinel zone (new coordination point, new rules).
- Profiles are pure markdown read from disk, inlined verbatim (no stitching/templating). Owned-by-one-file coupling comment in both consumers.
- Migration marker is `metadata: { harness-portability: neutral-v1 }` — allowlisted field, string-map, semantically a structural declaration (not a `compatibility` caveat).
- Gate mechanism: strict scan on migrated `SKILL.md` bodies (including fences); profile files under `using-systematic/references/` are FULLY EXEMPT — they are the designated home for harness identifiers (capability tables name tools in prose by design; execution finding 2026-07-17 corrected the earlier fences-only exemption). Rejected: drift-allowlist entries (that file's schema keys on known `BannedPattern`s; a parallel mechanism inside the new check is simpler and self-contained).
- Banned-identifier list (bounded, honest): `task(`, `subagent_type`, `todowrite`, `TodoWrite`, `` `question` `` tool references, `request_user_input`, `ask_user`, `AskUserQuestion`, `update_plan` — exact tokens, scope limit documented in the check. `systematic_skill`/`systematic_delegate` are NOT banned (they are Systematic's own cross-harness surface).
- The 13 unmigrated idiom sites get the Pi binding line only — no `metadata` marker, no gate coverage (user-confirmed inclusion).

## Open Questions

### Resolved During Planning

- Profile inlining point: inside `<SYSTEMATIC_WORKFLOWS>`, between usage template and catalog.
- AE4 assertion form: mock-model payload scan (system/developer roles), not tool-call observation.
- `metadata` viability: verified allowlisted + string-map semantics (`src/lib/skills.ts:48-76`).
- ce-ideate "Pi line": does not exist; all four ce-* skills get the same addition.
- Profile token budget: profiles are capability tables ~30-45 lines each; compact block target ≤ ~600 tokens per harness. Measured in Unit 2's snapshot test; if the OpenCode block pushes bootstrap growth past ~15%, trim the OpenCode profile to divergent-capability rows only (OpenCode names are already the prose default elsewhere).

### Deferred to Implementation

- Exact neutral phrasing per rewritten section (prose authoring is execution work).
- Whether orchestrating-subagents' background-task guidance has any Pi expression: profile declares it unavailable (inline work fallback); the rewrite words the body accordingly.

## Implementation Units

- [ ] **Unit 1: Capability profiles + using-systematic migration**

**Goal:** The two profile files exist; using-systematic's body becomes harness-neutral discipline that routes the four capabilities through "the active harness profile."

**Requirements:** R1, R2 (using-systematic), R3, R4, R5

**Dependencies:** None

**Files:**
- Create: `skills/using-systematic/references/opencode-profile.md`, `skills/using-systematic/references/pi-profile.md`
- Modify: `skills/using-systematic/SKILL.md`
- Test: `tests/unit/skills.test.ts` (frontmatter/marker parse), `scripts/content-integrity.ts` run (subfile refs resolve)

**Approach:**
- Each profile: one table over the four capabilities — mechanism, status (supported/degraded/unavailable), fallback — plus fenced invocation examples. Pi rows per R5: delegation = sequential-only `systematic_delegate({agent, task})`, bundled personas only, parallel unavailable → run sequentially; blocking input = optional extension, fallback numbered chat; task tracking = no native mechanism → maintain a visible list in responses; skill loading = `systematic_skill` or native activation.
- using-systematic: remove OpenCode-specific routing lines 30 and 111 (the bootstrap usage template already carries the binding); add a short "Capability resolution" section: neutral statement of the four operations + "the bootstrap inlines the active harness profile; consult it for exact mechanisms" + inline no-mechanism fallbacks.
- Add `metadata: { harness-portability: neutral-v1 }` to using-systematic frontmatter.
- SKILL.md must reference both profile files by relative path (subfile-reference check enforces resolution).

**Test scenarios:**
- Happy path: `findSkillsInDir` surfaces using-systematic with `metadata['harness-portability'] === 'neutral-v1'`.
- Edge case: profile files carry no frontmatter → confirm they are not picked up as skills and pass the gate's markdown scan.
- Integration: content-integrity passes with the new references present; fails if a profile path referenced in SKILL.md is missing (existing check, verified by temporary-removal spot check during development, not a committed test).

**Verification:** content-integrity clean; unit suite green; both profiles readable as standalone markdown.

- [ ] **Unit 2: Bootstrap profile inlining (both harnesses)**

**Goal:** Every OpenCode and Pi session's system prompt carries its harness's compact profile block inside `<SYSTEMATIC_WORKFLOWS>`.

**Requirements:** R6; AE5

**Dependencies:** Unit 1 (profiles exist)

**Files:**
- Modify: `src/lib/bootstrap.ts`, `src/index.ts`, `src/pi.ts`
- Test: `tests/unit/bootstrap.test.ts`, `tests/unit/pi.test.ts`

**Approach:**
- Add `profileBlock?: string` to `BootstrapDeps`; concatenate between usage template and catalog. Absent → byte-identical current output.
- `src/index.ts` passes the OpenCode profile; `src/pi.ts` passes the Pi profile (both read from the packaged `skills/using-systematic/references/` at load time, same directory-resolution pattern as the SKILL.md read; ownership coupling comment at both call sites).
- Do NOT touch `applyBootstrapContent` or Pi's composition helper — the block rides inside the existing content string.

**Execution note:** Snapshot-pin current OpenCode bootstrap output BEFORE the change (chained-bootstrap learning); the pinned test then documents the exact delta.

**Test scenarios:**
- Happy path: `getBootstrapContent` with `profileBlock` emits it inside the sentinel zone, after usage template, before catalog.
- Edge case: absent `profileBlock` → output byte-identical to pre-change snapshot.
- Edge case: profile block containing marker-shaped text round-trips composition without corruption (regression per chained-bootstrap incident).
- Integration: double-run of Pi's `before_agent_start` handler composes the profile block exactly once (idempotency at the registered-handler level).
- Integration: OpenCode path — `applyBootstrapContent` re-run does not duplicate the block (existing marker strip-and-replace covers it; assert explicitly).

**Verification:** bootstrap + pi unit suites green; measured block sizes recorded in the test (budget guard: warn-comment if OpenCode bootstrap grew >15%).

- [ ] **Unit 3: orchestrating-subagents structural rewrite**

**Goal:** The skill teaches delegation discipline in neutral operations; zero banned identifiers in its body; OpenCode invocation syntax lives only in the OpenCode profile.

**Requirements:** R1, R2, R3, R10

**Dependencies:** Unit 1 (profile exists to reference)

**Files:**
- Modify: `skills/orchestrating-subagents/SKILL.md`
- Test: gate check (Unit 5) + registry drift check

**Approach:**
- Rewrite framing (lines 8, 12): delegation as a capability ("dispatch bounded work to a subagent using the harness's delegation mechanism"), with parallel-vs-sequential expressed as profile-dependent ("run concurrently where the harness supports it; otherwise dispatch sequentially in dependency order").
- Replace the 7 fenced `task(` examples with neutral dispatch descriptions (structured prompts, scope, expected returns) — concrete syntax moves to the OpenCode profile's fenced examples.
- Rewrite retry/resume prose (121, 122, 133) neutrally ("re-dispatch with a corrected brief, or resume the prior specialist session where the harness supports session reuse").
- Empirical token count before and after (light-adaptation learning): post-count of banned identifiers in body = 0.
- Add `metadata: { harness-portability: neutral-v1 }`.
- Preserve the skill's workflow substance (failure handling, synthesis, anti-patterns) — this is a re-voicing, not a content redesign.

**Test scenarios:**
- Test expectation: none beyond gate coverage — prose-only change; Unit 5's gate fixture and Unit 6's harness scenario are the mechanical proof.

**Verification:** zero banned identifiers in body (counted); registry drift clean if description changed; content-integrity clean.

- [ ] **Unit 4: Interaction idiom Pi binding — all 19 sites**

**Goal:** Every occurrence of the multi-harness question-tool idiom names Pi's binding; ce-review's internally-drifted site (line 314) is normalized.

**Requirements:** R2, R5; user-confirmed catalog-wide inclusion

**Dependencies:** None (parallel-safe with Units 1-3; disjoint files except the four ce-* skills shared with nothing else)

**Files:**
- Modify: the 17 skills listed in Context (19 sites).
- Test: none (prose one-liners); content-integrity + registry drift as gates.

**Approach:**
- Canonical line: "(`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait)". Adapt surrounding grammar per site; normalize ce-review:314 to the full form.
- The four ce-* skills additionally get `metadata: { harness-portability: neutral-v1 }` (they are part of the migrated set; their remaining bodies already express the invariants capability-independently per AE2 — verify ce-review:62/637 wording stays tool-name-free outside the idiom parenthetical).

**Test scenarios:**
- Test expectation: none — mechanical prose edits; gate (Unit 5) covers the migrated four; grep-audit (19/19 sites carry the Pi binding) recorded in the PR body.

**Verification:** 19/19 sites updated (counted); content-integrity + registry drift clean.

- [ ] **Unit 5: Content-integrity gate — migrated-set identifier ban**

**Goal:** CI fails any PR reintroducing a banned identifier into a migrated skill body; profile files may quote identifiers inside fences only.

**Requirements:** R7; AE3

**Dependencies:** Units 1, 3, 4 (migrated set exists and is clean — gate lands green, never red)

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts` (or the script's existing test home — follow current wiring)

**Approach:**
- New check `checkMigratedSkillIdentifiers(rootDir, scanFiles)`: for each `skills/*/SKILL.md` (existing `isSkillEntryFile` scope) with `metadata['harness-portability'] === 'neutral-v1'` (read via `parseFrontmatter` + the same drop-rule as `parseMetadata` — mirror-runtime learning), scan the full body INCLUDING fences for the banned list. `skills/using-systematic/references/*-profile.md` are fully exempt (designated identifier home). Interaction-idiom lines (containing both `in OpenCode` and `in Pi`) are exempt — the sanctioned multi-harness binding.
- Wire as check #13: `CheckResult` field, printer, `totalViolations` term, header list — violation-or-nothing (no warning channel).
- Remediation message: name the identifier, the file, and the one action ("rephrase as a neutral operation; exact syntax belongs in the harness profile"). Document the scope limit in a comment (lexical tokens only, per honest-ban rule).

**Test scenarios:**
- Happy path: current repo state passes.
- Error path: fixture migrated skill with `todowrite` in prose → violation (AE3).
- Error path: fixture migrated skill with `task(` inside a fence → violation (strict scope).
- Happy path: profile file with `task(` inside a fence → clean.
- Error path: profile file with `todowrite` in prose → violation.
- Edge case: skill with malformed `metadata` (non-string value) → treated as unmigrated (mirrors runtime drop), no violation.
- Edge case: unmigrated skill with `task(` → no violation.

**Verification:** gate green on the repo; all seven fixtures pass; `bun scripts/content-integrity.ts` output lists the new check.

- [x] **Unit 7: HARNESSES.md — evidence-backed harness compatibility reference**

**Goal:** A root-level `HARNESSES.md` documents similarities, differences, compatibility, and tools across every harness this feature touches (OpenCode, Pi, Claude Code, Codex, Copilot, Gemini), with EVERY tool mention mapping to verifiable evidence.

**Requirements:** User directive 2026-07-17; extends R9's honesty posture into a standing reference.

**Dependencies:** Units 1, 4 (profiles + idiom bindings are the in-repo ground truth it cites)

**Files:**
- Create: `HARNESSES.md`
- Modify: `skills/using-systematic/references/opencode-profile.md`, `skills/using-systematic/references/pi-profile.md`, `AGENTS.md`; root markdown is outside gate skill scope

**Approach:**
- Structure: per-harness section (role: controlled vs deferred) + a cross-harness capability matrix (the four divergent capabilities × six harnesses) + compatibility notes (what Systematic ships/verifies per harness).
- Evidence rule (non-negotiable): every named tool carries a citation — in-repo source (`src/pi.ts`, `src/lib/pi-delegate-tool.ts`, profile files, `tests/integration/pi.test.ts`), local installed/cloned source (`node_modules/@earendil-works/pi-coding-agent/`, `.slim/clonedeps/repos/anomalyco__opencode/`), or an external authoritative URL (official docs/repo) gathered by research. Tool names with no verifiable source are listed as UNVERIFIED with the strongest available provenance (e.g., "named in obra/superpowers translation tables") or omitted.
- Deferred-harness sections state explicitly: prose-level binding only, no Systematic-shipped profile, consume-at-own-risk (mirrors the pi-harness.mdx honesty note).

**Test scenarios:**
- Test expectation: none automated — documentation; the evidence audit (every tool → citation) is recorded in the PR body as a checklist.

**Verification:** every tool mention has a citation; content-integrity clean (root file outside skill scans, but run anyway); no session/process taxonomy in the text.

- [ ] **Unit 6: Pi harness proof scenario**

**Goal:** Mechanical evidence: a Pi session with the migrated set active receives no instruction naming absent tools.

**Requirements:** R8; AE1, AE4, AE5

**Dependencies:** Units 1-3 (profiles inlined, orchestrating-subagents rewritten)

**Files:**
- Modify: `tests/integration/pi.test.ts`
- Test: itself

**Approach:**
- Extend the existing describe block (fixture/mock-model/tarball infra as-is; hard-fail guard already present).
- Scenario A (AE5): extend the existing bootstrap test — assert the composed system prompt contains the Pi profile marker on a plain prompt.
- Scenario B (AE1/AE4): script the model to call `systematic_skill` for `systematic:orchestrating-subagents`; after `tool_execution_end`, assert (a) the returned skill body contains zero banned identifiers, (b) the full model-visible text (system/developer payload + tool result) contains no `task(`, `todowrite`, or OpenCode `question`-tool instruction, (c) the payload DOES contain the Pi profile's sequential-delegation guidance (positive marker, not absence-only).

**Execution note:** Payload scan per the Pi-harness learning — the system prompt is not exposed by RPC; the mock model's captured requests are ground truth.

**Test scenarios:** (the unit IS the tests — scenarios A and B above)

**Verification:** `bun test tests/integration/pi.test.ts` green (7 scenarios total); runtime stays within the suite's existing budget (~15s).

## System-Wide Impact

- **Interaction graph:** bootstrap composition feeds every OpenCode session (plugin transform hook) and every Pi session (`before_agent_start`); profile block lands inside the existing sentinel — idempotency inherited, pinned by tests.
- **API surface parity:** `BootstrapDeps` gains an optional field — additive, no consumer breaks. `bun run build` type surface unchanged externally (no new exports from `src/index.ts` — loader constraint).
- **Unchanged invariants:** `INTERNAL_AGENT_SIGNATURES`, `applyBootstrapContent`, Pi composition helper, `systematic_skill`/`systematic_delegate` registration, discovered-skills-as-commands emission — all untouched.
- **Integration coverage:** the Pi harness scenario is the only cross-layer proof; OpenCode-side behavior is covered by unit snapshot + idempotency tests (no OpenCode subprocess scenario needed — the profile is inert prose there).
- **Error propagation:** missing profile file at load → same failure mode as missing using-systematic SKILL.md today (bootstrap returns degraded content); Unit 2 must not introduce a new throw path.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Neutral prose reduces OpenCode instruction-following on delegation | OpenCode profile carries the concrete `task(` syntax in the same system prompt; spine skills outside the migrated set keep concrete names |
| Bootstrap growth degrades every session | Size measured in Unit 2 tests; ≤~600 tokens/harness budget; trim rule pre-agreed |
| Gate false-positives on future legitimate prose | Bounded lexical list + per-scope fence rule + documented scope limit; remediation names the one action |
| Registry/docs drift from description edits | `registry:drift` + `docs:generate` in the verification gates |
| orchestrating-subagents rewrite loses workflow substance | Re-voicing constraint in Unit 3; ce:review autofix pass before PR |

## Documentation / Operational Notes

- R9 honesty note lands in `docs/src/content/docs/guides/pi-harness.mdx` (one paragraph: skill prose targets OpenCode and Pi; other harnesses consume at their own risk this increment) — fold into Unit 4's PR.
- Release: ships as a v3.x minor (`feat:`); no breaking surface.

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-16-harness-portable-skills-requirements.md
- Oracle assessment + five-persona document-review (2026-07-16, session records)
- Related code: `src/lib/bootstrap.ts`, `src/pi.ts`, `scripts/content-integrity.ts`, `tests/integration/pi.test.ts`
- Prior art: obra/superpowers@v5.1.0 translation tables (deferred-harness shape)
