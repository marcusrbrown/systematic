---
title: 'refactor: Delete the duplicated bootstrap skill catalog'
type: refactor
status: completed
date: 2026-08-14
origin: docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md
---

# refactor: Delete the duplicated bootstrap skill catalog

## Overview

Systematic injects a verbose `<available_skills>` catalog into the bootstrap system prompt. Measurement shows it is 11,911 characters — 65.6% of the entire 18,145-character bootstrap payload — and that every skill name and description it carries is already present in the running context twice over: once in OpenCode's own host-rendered skill catalog, and once in the `systematic_skill` tool description.

This plan removes that third copy. It is the first behavior-changing slice of initiative I2 in the parent program (see origin: `docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md`), and it is deliberately narrow: measure first, assert host coverage at the pinned runtime, then delete the catalog and the code that becomes dead with it.

## Problem Frame

The parent program frames I2 as "move large catalogs out of global context, then delete the superseded payload." Research reduced that to a sharper and smaller problem: the catalog is not a mechanism that needs replacing. Its replacement already runs in production.

`registerSkillsPaths()` in `src/lib/config-handler.ts` unconditionally registers the bundled skills directory into OpenCode's native `skills.paths`. The host therefore discovers every bundled Systematic skill and renders its own catalog into the session. Independently, `buildSkillToolDescription()` in `src/lib/skill-resolver.ts` embeds a compact catalog of the same skills in the `systematic_skill` tool description.

The result is three catalogs describing the same 23 skills, and ours is the worst of them:

| Property | Host native catalog | `systematic_skill` description | Bootstrap catalog (this plan's target) |
|---|---|---|---|
| Freshness | Live; emits a supersede notice when the set changes | Rebuilt per plugin load | Static snapshot taken once at plugin init |
| Permission awareness | Filters skills denied to the active agent | None | None |
| Skill names + descriptions | Yes | Yes | Yes |
| Absolute machine paths | Host-owned | No | Yes |
| Owner | OpenCode | Systematic | Systematic |

Ours is the stale, permission-blind copy, and it is the only one that writes absolute machine paths into the prompt. The repository already treats those paths as a defect on another surface: `tests/unit/build-claude-code-plugin.test.ts` asserts the Claude Code bundle contains no `<location>` tag, under the rationale that absolute machine paths must not leak into shipped artifacts.

## Requirements Trace

- R1. The bootstrap system prompt no longer contains a Systematic-rendered `<available_skills>` catalog.
- R2. Every non-disabled bundled skill remains discoverable to the model on OpenCode after deletion, evidenced by observation of the running host rather than by assumption.
- R3. Every non-disabled bundled skill remains discoverable on Pi after deletion, where no host-rendered catalog exists.
- R4. Deletion is gated: the eval suite must observe host coverage at the pinned runtime before the catalog is removed, and must fail closed when that observation is inconclusive.
- R5. Absolute machine paths are no longer emitted into the OpenCode or Pi system prompt.
- R6. Code that becomes unreachable as a result of the deletion is removed in the same change, not left as unused exports.
- R7. Bootstrap injection semantics — marker handling, idempotency across duplicate plugin registration, and preservation of foreign prompt content — are unchanged.
- R8. Claude Code output is byte-unchanged.
- R9. Disabled-skill and model-invocation filtering behavior is preserved wherever a catalog is still rendered.
- R10. Host catalog coverage is re-verified whenever the pinned OpenCode runtime changes, not measured once.
- R11. The behavior when `systematic_skill` is unavailable or denied is stated explicitly for each harness, and is not left to inference.

Advances parent requirements R5-R8, R15, R22-R24, R31-R32, R34, and R36.

## What This Plan Does and Does Not Prove

Stated plainly, because three independent review lanes converged on it.

**Proves:** the deleted content is duplicated elsewhere in the same context; the host catalog covers every non-disabled bundled skill at the pinned runtime; bootstrap composition, idempotency, and marker handling are unchanged; no code path still depends on the deleted surface.

**Does not prove:** that model behavior is unchanged. Identical content at a different prompt position, with different framing and one fewer repetition, can shift model behavior. This plan argues equivalence from content and coverage; it does not measure routing.

That gap is accepted deliberately, not overlooked. Measuring it needs a credentialed live-model eval tier, which contradicts the fixture-scoped, credential-free isolation contract approved for the eval foundation and would need its own plan and privacy review.

The claim this plan makes is therefore **content deduplication with coverage evidence** — not "proven behavior-neutral" and not "improves routing." Anyone citing this work later should carry that distinction forward.

**Revisit trigger:** if skill-selection quality is suspected to regress after this ships, the first response is to build the behavioral eval tier, not to restore the catalog by reflex. Restoring it without measurement would re-add the duplication without resolving the question.

## Scope Boundaries

- The `systematic_skill` tool and its compact catalog are not modified. Whether that tool itself duplicates the host's native `skill` tool is a separate question.
- `renderCatalogCompact()` stays. It is the tool description's live dependency.
- No change to agent catalogs, persona taxonomy, or `buildAgentCatalog()`.
- No new eval harness tier, no credentialed model access, and no network egress beyond the already-pinned runtime fetch. I1's fixture-scoped, credential-free isolation contract is unchanged.
- No change to config precedence, trust boundaries, or `SECURITY_OVERLAY_FIELDS`.

### Deferred to Separate Tasks

- Evaluating whether `systematic_skill` should be retired in favor of the host's native `skill` tool: needs its own plan, and depends on Pi and Claude Code parity that this plan does not establish.
- Live-model routing evaluation: would require a credentialed eval tier that contradicts I1's approved isolation contract. If a future initiative wants it, it earns its own plan and its own privacy review.
- The lazy `cachedDescription` / `cachedParameterHint` staleness in `src/lib/skill-tool.ts` when config changes mid-session: pre-existing, unrelated to this deletion.

## Context & Research

### Relevant Code and Patterns

- `src/lib/bootstrap.ts` — `getBootstrapContent()` assembles the payload and holds the single production call to `renderCatalogVerbose()`. `applyBootstrapContent()` owns marker stripping and idempotent re-injection.
- `src/lib/skill-catalog.ts` — `renderCatalogVerbose()` (deletion target), `renderCatalogCompact()` (retained), `buildCatalogEntries()` (retained; owns disabled and model-invocation filtering).
- `src/lib/skill-tool.ts` — `formatSkillsXml()` is already dead: it has no production caller and is referenced only by its own tests.
- `src/lib/config-handler.ts` — `registerSkillsPaths()` is the reason host coverage exists at all. It is the load-bearing fact behind this plan.
- `src/lib/skill-resolver.ts` — `buildSkillToolDescription()`, the surviving catalog surface.
- `scripts/eval-cases/opencode.ts` — probe and graders. The probe records plugin-load health, transform health, and `<SYSTEMATIC_WORKFLOWS>` block count; it does not inspect prompt contents.
- `scripts/run-evals.ts` — case manifest parsing, fixed `CASE_IDS`, four-outcome taxonomy.
- `tests/integration/fixtures/receipt-workflow-host.ts` — `assertWorkflowSystem()` requires `<available_skills>` and specific skill names in `system[0]`. This is a hard dependency, not a snapshot, and blocks deletion until updated.

### Institutional Learnings

- `docs/plans/2026-07-21-002-test-receipt-workflow-capabilities-plan.md` — probe health is separate from behavior; a probe that cannot distinguish outcomes must not report a green one. Directly shapes R4's fail-closed gate.
- `docs/solutions/best-practices/subagent-stop-prose-behavioral-null-result-2026-05-20.md` — a null result may mean the probe was incapable, not that the behavior is safe.
- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — absence of output is not proof of execution; the probe must confirm the path ran.
- `docs/solutions/security-issues/redos-after-plugin-trust-boundary-inversion-2026-05-11.md` — bootstrap marker handling is a security boundary. This plan removes a section from generated content and must not touch the strip-and-replace logic.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — injection must stay idempotent across multiple registrations.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md` — Pi composition must preserve foreign, non-Systematic prompt content.
- `docs/plans/2026-04-17-002-refactor-truth-reset-plan.md` — delete stale infrastructure only after the replacement is independently verified.

### External References

- `.slim/clonedeps/repos/anomalyco__opencode/` at v1.17.6 — `packages/opencode/src/skill/index.ts` (`fmt`, `available`) and `packages/core/src/skill/guidance.ts` show the host's catalog rendering and permission filtering. Read-only reference. The clone is *not* the pinned eval runtime, which is why host coverage is asserted at runtime rather than inferred from this source.

## Key Technical Decisions

- **Assert host coverage rather than assume it.** The clone is pinned at v1.17.6 while evals pin 1.18.5, and catalog rendering is host-version-dependent. Coverage becomes a measured precondition of deletion.
- **Delete for OpenCode and Pi together, with no harness branch.** Adding a harness conditional would introduce exactly the kind of special-casing the parent program exists to remove, and would need deleting later. Pi keeps full coverage through the `systematic_skill` description, which carries all names and descriptions.
- **Measurement lands before deletion, as separate units.** The instrument must be trustworthy before it is used as a gate.
- **Delete dead code in the same change.** Leaving `renderCatalogVerbose()` and `formatSkillsXml()` as unused exports preserves the illusion of a supported surface.
- **Drop `<location>` rather than relocate it.** No production code reads it back, the repository already classifies absolute paths in generated artifacts as a defect, and their presence invites models to read `SKILL.md` directly — bypassing the permission gate and metadata hooks in `createSkillTool()`.
- **No credentialed eval tier.** The honest claim is duplicate removal, not model-routing improvement, so the evidence needed is coverage and composition — both mechanically observable. The cost of this choice is stated above rather than buried.
- **Host coverage is a standing gate, not a one-time proof.** The Unit 2 case stays in the corpus permanently and must be re-run whenever the pinned runtime version changes. A version bump without a passing coverage run is treated as an unverified host, because catalog rendering is host-owned and can change under us.
- **State the unavailable-tool behavior per harness rather than generalizing.** OpenCode and Pi have materially different fallbacks, and the weaker one must not hide behind the stronger.

## Deletion Standard for Later Slices

This is the program's first live deletion, so it sets precedent. The standard it establishes:

- Deletion is justified by **demonstrated redundancy plus observed coverage of the replacement**, never by size or duplication alone.
- The replacement path must be identified, already running, and asserted by a test that fails when the replacement stops covering it.
- Where evidence stops short of proving behavioral equivalence, the plan says so in its own text — as this one does above.
- "Smaller" is not a success criterion. It is a side effect. A slice that reduces payload while weakening a capability has failed, whatever the character count says.

## Open Questions

### Resolved During Planning

- Does query-based discovery need building? No. It is already live in all three harnesses.
- Do the bootstrap catalog and the tool description actually carry the same content? Yes — measured: all 23 names and all 23 descriptions appear in both.
- Does anything consume the `<location>` URLs? No production code does. The only references are test assertions, and one of them exists to forbid the tag.
- Are custom `bootstrap.file` users affected? No. That path returns file contents verbatim and never renders a catalog.
- Does deletion break Claude Code? No. `buildOutputStyleContent()` already omits the catalog.

### Deferred to Implementation

- Whether the pinned 1.18.5 host renders a catalog covering every non-disabled bundled skill. This is Unit 2's measurement and the plan's stop condition — if coverage does not hold, deletion does not proceed.
- The exact probe event fields needed to capture prompt composition without recording prompt text that would violate I1's persistence privacy rules.
- Whether `tests/integration/fixtures/receipt-workflow-host.ts` should assert the host catalog instead of the Systematic one, or drop the catalog assertion entirely and keep only the workflow-block invariants.

## Implementation Units

- [x] **Unit 1: Give the eval probe the ability to observe prompt composition**

**Goal:** Extend the probe and result schema so a case can state, as evidence, which catalogs are present in the injected system prompt and how large the bootstrap payload is.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `scripts/eval-cases/opencode.ts`
- Modify: `scripts/run-evals.ts`
- Test: `tests/integration/eval-runner.test.ts`
- Test: `tests/unit/eval-contract.test.ts`

**Approach:**
- Record bounded, structured facts only — catalog presence flags, entry counts, skill-name sets, and payload sizes. Do not persist raw prompt text; it would collide with the fail-closed privacy validation shipped in I1.
- Keep the four-outcome taxonomy. An observation the probe could not make is `infra_failure`, never `success`.
- Distinguish three states explicitly: catalog observed, catalog observed absent, and observation impossible. Collapsing the third into either of the first two is the false-green this unit exists to prevent.

**Execution note:** Test-first. The probe is the instrument every later gate depends on, so its failure modes need pinning before its success path.

**Patterns to follow:** existing probe event recording and `gradeBootstrapProbe()` in `scripts/eval-cases/opencode.ts`; bounded fact shapes in `scripts/run-evals.ts`.

**Test scenarios:**
- Happy path: a run with the current bootstrap reports the Systematic catalog present with 23 entries and a payload size in the expected range.
- Happy path: recorded facts round-trip through result serialization unchanged.
- Edge case: zero discoverable skills reports catalog-absent rather than observation-impossible.
- Error path: a probe that never observes a chat transform yields `infra_failure`, not a passing catalog-absent result.
- Error path: attempting to persist raw prompt text trips the existing privacy validator.
- Integration: recorded facts survive the write-then-rename persistence ordering with the manifest written last.

**Verification:**
- A run against unmodified `main` reports the Systematic catalog as present, proving the instrument detects what it is about to be used to delete.
- No new absolute paths or prompt text appear in persisted artifacts.

- [x] **Unit 2: Assert host catalog coverage at the pinned runtime**

**Goal:** Establish, by observation, that OpenCode's native catalog covers every non-disabled bundled skill at the pinned runtime — the precondition for deletion.

**Requirements:** R2, R4

**Dependencies:** Unit 1

**Files:**
- Create: `evals/cases/opencode/host-skill-coverage.json`
- Modify: `scripts/eval-cases/opencode.ts`
- Modify: `scripts/run-evals.ts`
- Test: `tests/integration/eval-runner.test.ts`
- Test: `tests/unit/eval-contract.test.ts`

**Approach:**
- Register a new case ID and its manifest assertions alongside the existing two.
- Grade coverage as a set relationship: every non-disabled bundled skill name must appear in the host-rendered catalog. Report the missing set on failure rather than a bare boolean.
- Treat partial coverage as failure. A catalog listing most skills is not a replacement for one listing all of them.
- If the host renders no catalog at the pinned version, the case fails and the plan stops at this unit. That outcome is a legitimate result, not a defect to work around.
- `CASE_IDS` in `scripts/run-evals.ts` is a fixed tuple and `tests/unit/eval-contract.test.ts` asserts its exact contents. Both must be updated when the new case is registered, or the contract test fails before the new case ever runs.
- Keep the case in the corpus after deletion ships. It is the standing regression gate for R10, not scaffolding to remove.

**Execution note:** Test-first.

**Patterns to follow:** case-manifest validation in `scripts/run-evals.ts`; deterministic grading in `gradeBootstrapProbe()`.

**Test scenarios:**
- Happy path: at the pinned runtime, the host catalog covers all non-disabled bundled skills and the case reports `success`.
- Edge case: a skill excluded via `disabled_skills` is absent from both catalogs and does not count as a coverage gap.
- Edge case: a skill marked `disableModelInvocation` is handled per existing filter semantics without failing coverage.
- Error path: a simulated missing skill in the host catalog produces failure naming the missing entry.
- Error path: a host that renders no catalog yields a failing, clearly-labelled outcome rather than a vacuous pass.
- Integration: the case runs in both source and packed-installed modes with consistent results.
- Integration: the `CASE_IDS` contract test passes with the new case registered.

**Verification:**
- Coverage is reported from observed host output at the pinned runtime, with the missing set empty.
- The case fails loudly when coverage is incomplete.
- The case remains registered and runnable after Unit 3, so a later runtime bump re-exercises it.

- [x] **Unit 3: Delete the bootstrap catalog and the code it kept alive**

**Goal:** Remove the catalog from generated bootstrap content and delete the code paths that become unreachable.

**Requirements:** R1, R5, R6, R7, R9

**Dependencies:** Unit 2 passing

**Files:**
- Modify: `src/lib/bootstrap.ts`
- Modify: `src/lib/skill-catalog.ts`
- Modify: `src/lib/skill-tool.ts`
- Modify: `tests/unit/bootstrap.test.ts`
- Modify: `tests/unit/skill-catalog.test.ts`
- Modify: `tests/unit/skill-tool.test.ts`
- Modify: `tests/integration/fixtures/receipt-workflow-host.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Remove the `renderCatalogVerbose()` call and its section assembly from `getBootstrapContent()`, leaving the surrounding sections and their separators intact.
- Delete `renderCatalogVerbose()` from `src/lib/skill-catalog.ts` and `formatSkillsXml()` from `src/lib/skill-tool.ts`, along with imports and tests that exist solely to exercise them.
- Do not touch `applyBootstrapContent()`, marker handling, or idempotency logic. The payload shrinks; the injection contract does not move.
- Update `assertWorkflowSystem()` in the receipt fixture. It currently requires `<available_skills>` and named skills in `system[0]`; the workflow-block invariants it also enforces must survive unchanged.
- Refresh the byte-pinned bootstrap snapshots and the I2a non-interference characterization tests. Those tests were written to prove I2a changed nothing, so their update here is the intended signal that this change is the one altering bootstrap bytes.

**Execution note:** Characterization-first. Re-run the pinned bootstrap tests before editing so the pre-deletion baseline is explicit, then update the snapshots as a deliberate act rather than a mechanical regeneration.

**Patterns to follow:** existing section assembly in `getBootstrapContent()`; snapshot conventions in `tests/unit/bootstrap.test.ts`.

**Test scenarios:**
- Happy path: generated bootstrap contains no `<available_skills>` block and no `<location>` tag.
- Happy path: `using-systematic` body, skill usage template, and harness profile block remain present, ordered, and correctly separated.
- Happy path: measured bootstrap size drops by approximately 11,900 characters.
- Edge case: zero discoverable skills produces well-formed bootstrap with no empty-section artifacts.
- Edge case: all skills disabled behaves identically to zero skills.
- Edge case: a custom `bootstrap.file` override still returns file contents verbatim.
- Error path: `renderCatalogCompact()` and the `systematic_skill` description still list all 23 skills, proving the retained surface was not collaterally damaged.
- Integration: repeated `applyBootstrapContent()` calls remain idempotent and leave exactly one workflow block.
- Integration: duplicate plugin registration still produces a single workflow block.
- Integration: the receipt-workflow host fixture passes with its workflow-block invariants intact.

**Verification:**
- Unit 1's probe now reports the Systematic catalog absent while Unit 2's host coverage still reports complete.
- Claude Code bundle output is byte-unchanged.
- No unused exports remain from the deleted surface.

- [x] **Unit 4: Confirm Pi coverage and record the cross-harness posture**

**Goal:** Verify Pi retains full skill discoverability without a host-rendered catalog, state the unavailable-tool contract per harness, and document the resulting architecture.

**Requirements:** R3, R8, R10, R11

**Dependencies:** Unit 3

**Files:**
- Test: `tests/unit/pi.test.ts`
- Test: `tests/unit/build-claude-code-plugin.test.ts`
- Modify: `ARCHITECTURE.md`

**Approach:**
- Pi has no host-rendered catalog, so its coverage rests entirely on the `systematic_skill` tool description. Assert that directly rather than inferring it from the OpenCode result. `registerSkillsPaths()` is called only from the OpenCode config handler; Pi has no equivalent, so the OpenCode fallback argument does not transfer and must not be reused for Pi.
- State the unavailable-tool contract explicitly per harness, since the fallbacks differ in strength:
  - **OpenCode** — bundled skills are registered into native `skills.paths`, so the host's own `skill` tool continues to discover and load them even if `systematic_skill` is denied. Degraded, not lost.
  - **Pi** — discovery depends solely on the `systematic_skill` tool description. If that tool is absent or denied, Pi has no remaining discovery surface. This is a real reduction in resilience relative to today, where the bootstrap catalog at least named the skills, and it is accepted knowingly rather than papered over.
  - **Claude Code** — already on the no-catalog path via its native Skill tool; unaffected.
- Record in `ARCHITECTURE.md` where skill discovery comes from per harness, the unavailable-tool contract above, and that bootstrap deliberately does not carry a catalog.
- Record the host-upgrade revalidation rule (R10) alongside it, so a future runtime bump has a written obligation attached rather than relying on someone remembering this plan.

**Test scenarios:**
- Happy path: Pi's `systematic_skill` description lists every non-disabled bundled skill by name and description.
- Happy path: Pi bootstrap composition still preserves foreign, non-Systematic prompt content.
- Happy path: Claude Code output style remains byte-identical and still contains no `<available_skills>` or `<location>`.
- Edge case: disabled skills are absent from Pi's tool description.
- Edge case: with `systematic_skill` unavailable on OpenCode, bundled skills remain registered in `skills.paths` and reachable through the host's native skill tool.

**Verification:**
- Each harness has a named, tested discovery path, and none of them is the deleted bootstrap catalog.
- The unavailable-tool contract is written down per harness, including the case where Pi has no fallback.

## System-Wide Impact

- **Interaction graph:** `getBootstrapContent()` feeds the OpenCode chat transform hook and Pi's prompt composition. Both lose the catalog section simultaneously; neither loses discoverability.
- **Error propagation:** Eval observation failures must surface as `infra_failure` and block promotion. A case that cannot observe must not report success.
- **State lifecycle risks:** Bootstrap is snapshotted once per plugin init and the tool description caches lazily. This plan changes payload content only, so it neither introduces nor resolves that staleness.
- **API surface parity:** `renderCatalogCompact()` and `buildCatalogEntries()` remain the shared catalog surface for every harness after `renderCatalogVerbose()` is gone.
- **Integration coverage:** The receipt-workflow fixture is the one integration surface with a hard dependency on the catalog; unit tests alone will not catch its breakage.
- **Unchanged invariants:** marker stripping and idempotent re-injection in `applyBootstrapContent()`; config precedence and trust boundaries; `systematic_skill` resolution, permission prompt, and metadata; content-integrity gates; Claude Code bundle bytes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Host catalog coverage differs at 1.18.5 from the v1.17.6 reference clone | Unit 2 measures coverage at the pinned runtime and stops the plan if it does not hold |
| Host changes catalog rendering on a later upgrade, silently breaking coverage after this ships | R10: the Unit 2 case stays in the corpus as a standing gate and must pass on any pinned-runtime bump; ARCHITECTURE.md records the obligation |
| Model behavior degrades despite identical content, and coverage evals stay green | Accepted and disclosed in "What This Plan Does and Does Not Prove", with a named revisit trigger; not claimed as proven-neutral |
| Pi loses discovery entirely if `systematic_skill` is denied or absent | Documented as an explicit per-harness contract in Unit 4 rather than left implicit; Pi's weaker position is stated, not averaged away |
| Deletion looks green because the eval harness cannot see prompt contents | Unit 1 lands the observation capability first and proves it detects the catalog before it is used to confirm absence |
| Pi silently loses discoverability, having no host catalog | Unit 4 asserts Pi coverage directly rather than generalizing from OpenCode |
| Snapshot churn hides an unintended bootstrap change | Characterization-first execution in Unit 3; assertions on retained sections, not just on the removed one |
| Receipt-workflow fixture breaks mid-plan | Identified in advance as a hard dependency and updated within Unit 3 |
| A user denies the `systematic_skill` permission | Host-registered `skills.paths` keeps skills reachable through the native `skill` tool; Unit 2 evidences that path |

## Documentation / Operational Notes

- `ARCHITECTURE.md` gains a short statement of per-harness skill discovery, the unavailable-tool contract, the deliberate absence of a bootstrap catalog, and the host-upgrade revalidation obligation.
- No migration, config change, or user action is required.
- Operationally, the visible change is a smaller prompt. That is the side effect, not the goal — the goal is one authoritative, permission-aware catalog instead of three, one of which was stale and leaked absolute machine paths.

## Sources & References

- **Origin document:** [docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md](docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md), initiative I2
- Sibling plans: `docs/plans/2026-08-13-002-feat-read-only-capability-diagnostic-plan.md`, `docs/plans/2026-08-13-003-feat-local-opencode-eval-foundation-plan.md`
- Related code: `src/lib/bootstrap.ts`, `src/lib/skill-catalog.ts`, `src/lib/config-handler.ts`, `src/lib/skill-resolver.ts`, `scripts/eval-cases/opencode.ts`
- Host reference: `.slim/clonedeps/repos/anomalyco__opencode/` at v1.17.6 (read-only)
