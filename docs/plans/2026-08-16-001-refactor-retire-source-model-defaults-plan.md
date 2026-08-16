---
title: 'refactor: Retire source-owned model defaults'
type: refactor
status: active
date: 2026-08-16
origin: docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md
---

# refactor: Retire source-owned model defaults

## Overview

Systematic pins every bundled agent to a provider/model pair chosen in August 2026. `src/lib/source-model-defaults.ts` holds a five-category table of provider chains, a closed seven-provider union ordered by observed OMO usage frequency, and a resolver that walks the chain against discovered availability. When nothing matches, it returns the first provider's first model anyway.

This plan deletes that table, the union, the frequency lore, the resolver, and the availability-discovery subsystem that exists only to feed it. Bundled agents inherit the invoking model. Opinionated per-category routing survives where it belongs — as explicit, opt-in user configuration.

This is the second Phase 2 wedge of the Bitter Lesson program (see origin), following the bootstrap catalog deletion.

## Problem Frame

Systematic's product thesis is that it should get better as models get better. Source-owned model defaults invert that: they freeze a snapshot of the model market into the package, and a user running a stronger model than the table knows about gets silently downgraded to whatever was good in August 2026.

The concrete failure is in `resolveSourceModel` (`src/lib/source-model-defaults.ts:409-429`). Availability discovery is already honest — `src/lib/model-availability.ts` collapses failed or empty discovery to `unknown`, and `src/lib/config-handler.ts:651-661` correctly skips pinning in that case, letting OpenCode inherit. The broken path is *known-but-unmatched*: availability resolves successfully, contains none of the category's configured pairs, and the resolver falls through to the first entry in the table regardless of whether that model is available to the user at all.

For an `anthropic`-only user invoking a design agent, that means being pinned to `vercel/v0-1.5-md`. The pin is not a preference; it is a guess presented as policy.

The initiative frames this as one of several static routing assumptions to remove (see origin: I5). Research showed the assumptions are not separable in practice — the fallback exists to serve the table, the closed union exists to validate the table, the frequency lore exists to order the table, and the availability subsystem exists to evaluate the table. Removing one and keeping the rest leaves an incoherent middle state.

## Requirements Trace

- R1. Bundled agents default to the invoking model rather than a source-owned provider/model pair.
- R2. Explicit user and custom configuration remains the only unconditional model override, with existing trust semantics unchanged.
- R3. `model: null` continues to clear an inherited or overlaid model and restore parent-model inheritance.
- R4. No provider name, closed provider union, or usage-frequency assumption remains in runtime policy.
- R5. Model and provider identifiers are validated structurally, not against a closed commercial catalog.
- R6. No automatic model escalation or scorecard-driven routing is introduced.
- R7. Machinery that becomes unreachable is deleted in the same wedge rather than left dormant.
- R8. Generated documentation, registry artifacts, and architecture guidance describe the post-deletion reality.

## Scope Boundaries

- No change to config precedence (`custom > project > user > defaults`), to `SECURITY_OVERLAY_FIELDS`, or to the rule that project config cannot set `model`. Research confirmed these already satisfy R2 and R3 without modification.
- No change to Pi export behavior. `src/lib/pi-subagents-export.ts:687-707` resolves models only from explicit overlays and never consumed the source table.
- No change to the Claude Code bundle. It flattens bundled markdown, which is required to be model-free and stays that way.
- No change to `registry/files/profiles/omo/oh-my-opencode.jsonc`. Its per-category model policy is independent, explicit, and opt-in — exactly the shape R2 endorses. It is reviewed for coherence, not edited.
- No automatic escalation, capability-based model selection, or scorecard routing. Describing task needs as capabilities is initiative-level future work, not part of this deletion.
- Bundled agent markdown stays model-free. The deletion target is the TypeScript emission layer; nothing migrates into agent content.

### Why this is one wedge, not several

The parent contract requires "a narrow first wedge, paired deletion or narrowing slice, and explicit non-goals," and the initiative title says one assumption at a time. This plan is read against that bar as follows.

The wedge contains exactly one behavior change: bundled agents stop receiving a source-owned model and inherit the invoking one. Units 1-3 are that change, staged so each step is separately reviewable. Everything after is what the contract itself demands of a wedge, not additional scope:

- Unit 4 is the **paired deletion**. `getAvailableModels` has exactly one production consumer, so the availability subsystem becomes unreachable the moment Unit 3 lands. Deferring it means merging roughly 380 lines of unreachable runtime code and 1,020 lines of tests exercising code nothing calls — the dormant-machinery outcome the program exists to prevent, and precisely what "paired deletion" is meant to avoid.
- Unit 5 is the **eval evidence**. The contract requires "baseline and candidate eval cases, including rule-specific ablations and counterexamples." A wedge that changes behavior without its counterexample is the gate-skipping failure this program was built to stop.
- Unit 6 is the **migration and rollback story**, which the contract lists as a required element. Its migration guidance is a ship condition for Unit 3, not follow-up polish.

The concurrency limit is also satisfied: the contract caps *concurrently active behavior-changing surfaces*, and this wedge presents one. Units 4-6 change no runtime behavior.

Units 3 and 6 land in the same change set. `docs/AGENTS.md:70-85` requires source, snapshot, and generated docs to move together, so Unit 3 must not merge on its own — splitting them would leave the repository contradicting the generation contract this plan cites.

### Deferred to Separate Tasks

- Reporting model availability in the `systematic capabilities` diagnostic: the origin initiative expects the diagnostic to eventually explain available models. If that is built, it must be a read-only observation in the snapshot's own non-authoritative idiom, not a revival of the defaulting path this plan deletes.
- Capability-and-constraint task descriptions (context size, tool use, vision, cost ceiling, reasoning strength) as a replacement vocabulary for provider names: named in the origin initiative, earns its own plan.
- `STRUCTURE.md` drift: it documents six agent categories and 51 agents; the tree has five and 37. Unrelated to this wedge.

## Context & Research

### Relevant Code and Patterns

- `src/lib/source-model-defaults.ts` — the deletion target. Frequency lore at `:8-10`, `ProviderID` union at `:27-35`, `SOURCE_CATEGORY_MODEL_DEFAULTS` at `:220-335`, `formatForDocs` at `:349-379`, `resolveSourceModel` with the last-resort fallback at `:393-429`.
- `src/lib/config-handler.ts` — `applySourceModelDefault()` at `:276-290`, called from `applyAgentOverlays()` at `:245-273` before user overlays; availability discovery at `:637-670`; the unknown-availability skip at `:651-661`; `model: null` clearing at `:341-361`.
- `src/lib/model-availability.ts` — availability discovery, fallback cache reads, and `WeakMap` memoization. `getAvailableModels` has exactly one production consumer, `src/lib/config-handler.ts:656`.
- `src/lib/agent-overlays.ts:104-145` — validates that every bundled agent category has source-default coverage.
- `src/lib/removed-names.ts` and `src/lib/config.ts:736-779` — the repository's established pattern for shipping a compatibility mechanism ahead of a deletion.
- `registry/files/profiles/omo/oh-my-opencode.jsonc:31-49` — independent explicit per-category model policy; the landing zone for opinionated routing.

### Institutional Learnings

- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` — establishes that empty or unknown availability should collapse to `unknown` and callers should inherit rather than guess. This plan completes the half of that guidance that was never implemented. The doc will need a refresh once the source-default mechanism it describes no longer exists.
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — `model` must stay trust-protected and higher-trust values must survive lower-trust same-key overlays.
- `docs/solutions/developer-experience/local-systematic-overrides-global-2026-05-14.md` — emitted Systematic config must be distinguishable from native user config so stale generated defaults are not preserved by merge order.
- `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md` — generated personas stay model-free; project config must not grant model selection.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` — schema, generator, and docs must move together, and the generator's self-read is cache-sensitive.

### External References

None. This is Systematic's own policy code; the constraints are internally defined and the local patterns are strong.

## Key Technical Decisions

- **Delete the whole cluster rather than the named first slice.** The origin initiative names fallback-to-first-provider as the first deletion slice, implying a ladder. Research showed the rungs are not independently coherent: the union validates the table, the lore orders it, the resolver evaluates it, and the availability subsystem feeds it. Shipping only the fallback leaves market lore in a module whose sole remaining purpose is to express it. The units below preserve the intended sequencing as ordered, independently revertable steps within one wedge.
- **Delete the availability subsystem rather than preserve it for future use.** It becomes unreachable the moment the table is gone. Keeping ~380 lines of discovery, cache-path resolution, and memoization against a hypothetical future consumer is the dormant-machinery pattern the program exists to remove. It remains in git history, and a future diagnostic consumer would want a read-only reporting shape rather than a defaulting gate.
- **Structural identifier validation, not a closed catalog.** `ProviderID`'s seven literals are replaced by shape validation (non-empty, whitespace-free, and for pairs, a single separator). A new provider becomes usable without a Systematic release, satisfying R5 without introducing a registry of blessed vendors.
- **Opinionated routing moves out of the default path, and for most users it is removed rather than relocated.** Users who want per-category model policy can express it in explicit config, and OCX/OMO installers inherit a curated version from the registry profile. Users who install the plain npm package get neither: they lose category-aware routing outright and gain nothing automatic in its place. That is the accepted cost of moving the opinion from the package to the user, but it is a removal for that audience and the plan does not claim otherwise.
- **No compatibility window for the emitted default, but the prior mapping must remain recoverable.** The removed-names pattern applies to user-authored config values that would otherwise break on upgrade, and nothing user-authored references `SOURCE_CATEGORY_MODEL_DEFAULTS`. Restoring a prior pin is therefore a config edit, not a migration. The gap is knowledge, not mechanism: after upgrading, a user can no longer read the table they were implicitly using, so "set it explicitly" asks them to reproduce a mapping the upgrade deleted. Unit 6 publishes that mapping as migration documentation so the pre-deletion behavior stays reconstructible without release archaeology.

## Open Questions

### Resolved During Planning

- Does removing source defaults require cross-harness projection work? No. Pi resolves models only from explicit overlays and Claude Code's bundle is model-free markdown. The wedge is OpenCode-only.
- Do trust boundaries need changes to satisfy "explicit user config is the only unconditional override"? No. Project-level `model` already throws (`src/lib/config.ts:946-957`), user and custom are honored, and `model: null` already restores inheritance.
- Is fallback-to-first-provider in `model-availability.ts`, as the origin initiative states? No. That module is already honest. The guess is in `resolveSourceModel` (`src/lib/source-model-defaults.ts:409-429`).
- Should the OMO registry profile's model policy be removed too? No. It is explicit, opt-in, user-installed configuration — the endorsed shape, not the anti-pattern.

### Deferred to Implementation

- Whether `deps.client` and the `OpencodeClientLike` plumbing in `src/lib/config-handler.ts` become entirely unused once availability discovery is deleted, or retain other consumers. Determined by reading the call graph after Unit 4's deletion lands.
- The exact residual surface of `src/lib/source-model-defaults.ts` after Unit 3 — whether any helper (for example `readBundledAgentCategories`) has a non-default consumer worth relocating, or the module deletes outright.
- Whether `tests/unit/agent-overlays.test.ts:634-688` survives as a modified assertion or is removed with the coverage-validation behavior it exercises.

## Implementation Units

- [x] **Unit 1: Stop guessing when availability is known but unmatched**

**Goal:** Delete the last-resort return in `resolveSourceModel` so an unmatched category yields no model and the agent inherits the invoking model.

**Requirements:** R1, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/source-model-defaults.ts`
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/source-model-defaults.test.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- `resolveSourceModel` returns a nullable result. Unmatched availability produces no resolution rather than the first provider's first model.
- `applySourceModelDefault` treats a missing resolution the same way it already treats unknown availability: emit no `model` field, leaving inheritance intact.
- Unknown-category behavior (currently a throw) is unchanged in this unit; it disappears with the table in Unit 3.

**Execution note:** Characterization-first. `tests/unit/source-model-defaults.test.ts:383-394` currently documents the fallback while its comment implies it is testing provider matching. Pin the real current behavior before changing it so the diff shows an intentional behavior change rather than a corrected misunderstanding.

**Patterns to follow:**
- The existing unknown-availability skip in `src/lib/config-handler.ts:651-661` — the no-resolution path should converge on the same emission behavior.

**Test scenarios:**
- Happy path: availability contains a configured pair for the category → that pair is resolved and emitted, unchanged from today.
- Edge case: availability is non-empty but contains no pair for the category → no model is emitted and the agent config omits `model` entirely.
- Edge case: availability contains a different model from a configured provider (for example `anthropic/some-other-model` against an `anthropic` default) → no match, no emission. This inverts the existing assertion at `tests/unit/source-model-defaults.test.ts:383-394`.
- Error path: availability status is `unknown` → unchanged, no emission, inheritance preserved.
- Integration: an explicit user overlay for a category still overrides, and `model: null` still clears, with no source resolution present.

**Verification:**
- No code path returns a model that is absent from discovered availability.
- Agents whose category has no available match emit no `model` key.

- [x] **Unit 2: Remove the closed provider union and the frequency lore**

**Goal:** Replace `ProviderID`'s seven-literal union with structural validation and delete the usage-frequency rationale.

**Requirements:** R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/source-model-defaults.ts`
- Test: `tests/unit/source-model-defaults.test.ts`

**Approach:**
- Provider identifiers validate on shape rather than membership in a fixed set: non-empty, no whitespace, no embedded provider/model separator, no control characters, and no path separators. The last two matter because these identifiers flow into emitted config, cache keys, and log output; shape validation replaces the allowlist as the only thing standing between an arbitrary string and those sinks.
- Delete the module docblock's frequency justification (`:8-10`) and the "ordered by OMO empirical usage frequency" comment on the union.
- Ordering semantics within each category's chain remain positional and are unaffected; only the vendor allowlist is removed.

**Patterns to follow:**
- `src/lib/config-schema.ts` model-field validation for the shape of a structural identifier check.

**Test scenarios:**
- Happy path: a previously-listed provider identifier still validates.
- Happy path: a provider identifier outside the old union (for example `mistral`) now validates. This inverts the rejection assertion at `tests/unit/source-model-defaults.test.ts:150-168`.
- Edge case: empty string, whitespace-only, and internal-whitespace identifiers are rejected.
- Edge case: an identifier containing the provider/model separator is rejected so pairs cannot be smuggled into a provider slot.
- Edge case: identifiers containing control characters, newlines, or path separators are rejected, so nothing downstream has to sanitize them.

**Verification:**
- No closed set of vendor names remains in the module.
- A provider Systematic has never heard of passes validation.

- [x] **Unit 3: Retire the category default table and its resolution path**

**Goal:** Delete `SOURCE_CATEGORY_MODEL_DEFAULTS`, its schema, resolver, docs formatter, and coverage assertion, and remove source-default application from the config hook.

**Requirements:** R1, R4, R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Delete: `src/lib/source-model-defaults.ts`
- Delete: `tests/unit/source-model-defaults.test.ts`
- Delete: `tests/unit/__snapshots__/source-model-defaults.test.ts.snap`
- Modify: `src/lib/config-handler.ts`
- Modify: `src/lib/agent-overlays.ts`
- Test: `tests/unit/config-handler.test.ts`
- Test: `tests/unit/agent-overlays.test.ts`

**Approach:**
- Remove `applySourceModelDefault` and its call from `applyAgentOverlays`. Overlay application begins at category overlays.
- Remove the category-coverage validation in `src/lib/agent-overlays.ts:104-145`; with no table there is nothing to have coverage of. The related throw at `tests/unit/config-handler.test.ts:1602-1617` goes with it.
- Preserve every user-overlay behavior: category overlay, exact-agent overlay, precedence between them, `model: null` clearing, and permission reconstruction.
- If a helper in the deleted module has a surviving non-default consumer, relocate it rather than preserving the module as a shell.

**Execution note:** Characterization-first for the overlay precedence tests. The current suite proves source defaults interact correctly with user overlays; the same suite must prove user overlays behave identically with no source layer beneath them.

**Patterns to follow:**
- `src/lib/pi-subagents-export.ts` overlay resolution, which already emits a model only when explicit config supplies one — the target shape for OpenCode emission.

**Test scenarios:**
- Happy path: a bundled categorized agent with no user config emits no `model` key.
- Happy path: a category-level user overlay emits its model for every agent in that category.
- Happy path: an exact-agent overlay takes precedence over a category overlay.
- Edge case: `model: null` at user level emits no model, unchanged.
- Edge case: an uncategorized agent behaves identically to a categorized one — previously they diverged, and that divergence disappears.
- Edge case: an agent category with no user overlay of any kind produces a config entry indistinguishable from a native model-free agent.
- Error path: project-level `model` still throws with the existing message.
- Integration: emitted config merges into an existing OpenCode config without disturbing native agents.

**Verification:**
- No source-owned provider or model literal remains in `src/`.
- Bundled agents appear in emitted config with no `model` key unless user config supplies one.

- [x] **Unit 4: Delete the unreachable availability subsystem**

**Goal:** Remove `src/lib/model-availability.ts` and its tests, now that its only production consumer is gone.

**Requirements:** R7

**Dependencies:** Unit 3

**Files:**
- Delete: `src/lib/model-availability.ts`
- Delete: `tests/unit/model-availability.test.ts`
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Remove the availability-discovery call and the `ReadonlySet` plumbing from the config hook.
- Determine whether `deps.client` retains other consumers. If it does not, remove it and its type from the handler's dependency surface; if it does, leave it and note what still needs it.
- Removing this also removes the `OPENCODE_MODELS_URL` fallback-cache path, the XDG cache-path resolution, the 16 MB cache guard, and the client-keyed memoization. None have another caller.

**Patterns to follow:**
- The bootstrap catalog deletion (`docs/plans/2026-08-14-001-refactor-bootstrap-catalog-deletion-plan.md`) — delete the code that a removed feature kept alive, in the same change, rather than leaving it dormant.

**Test scenarios:**
- Happy path: the config hook produces correct output with no availability discovery.
- Edge case: a config-hook invocation with no `client` supplied succeeds, where previously it drove a discovery branch.
- Integration: plugin load succeeds end to end with the module absent, and `src/index.ts` still exports only `default`.
- Error path: no import of the deleted module survives anywhere in `src/`, `scripts/`, or `tests/`.

**Verification:**
- Typecheck and build pass with the module deleted.
- No network or filesystem cache read occurs during config-hook execution.

- [x] **Unit 5: Prove the emitted-config contract in the eval harness**

**Goal:** Add a deterministic eval case asserting that bundled agents inherit and explicit user policy still wins, so the program's promotion gate has evidence rather than assertion.

**Requirements:** R1, R2, R3, R6

**Dependencies:** Unit 3

**Files:**
- Create: `evals/cases/opencode/` case definition for model inheritance
- Modify: `scripts/run-evals.ts`
- Modify: `scripts/eval-cases/opencode.ts`
- Test: `tests/unit/eval-contract.test.ts`

**Approach:**
- Observe emitted OpenCode configuration, not model output quality. The graded facts are structural: presence or absence of a `model` key per agent, and which value wins under each overlay shape.
- Register the case in the runner, not only in the case module. `scripts/run-evals.ts` hard-codes the case registry and per-case manifest parsing — `CASE_IDS` (`:16`), `CASE_ASSERTIONS` (`:450`), `CLI_USAGE` (`:706`), and `parseCaseManifest` (`:1320`) all need entries, or the case must explicitly reuse an existing case shape and add no new ID. Without this the case cannot register or execute.
- Persist only structural facts. Record per-agent model-key presence and the resolved value, never a serialized copy of emitted config, so no absolute path, overlay body, or credential-like string can reach a persisted artifact through this case.
- Stay inside I1's fixture-scoped, credential-free isolation contract. No live model calls, no network egress beyond the already-pinned runtime fetch, no provider credentials.
- The case is the counterexample the initiative contract asks for: it fails if a source-owned default reappears. To be worth that claim it must cover every bundled category rather than a fixture subset, so a reintroduction confined to one category cannot pass.

**Patterns to follow:**
- The `host-skill-coverage` case added by the bootstrap catalog deletion — a structural observation graded against an expected set, used as a standing regression gate.

**Test scenarios:**
- Happy path: with no user config, every bundled agent in every bundled category emits no `model` key — enumerated across categories, not sampled.
- Happy path: with a category overlay, every agent in that category carries the overlay's model and agents outside it still omit `model`.
- Edge case: with an exact-agent overlay layered on a category overlay, the exact value wins.
- Edge case: `model: null` produces omission, not a null literal, in emitted config.
- Edge case: the availability-known and availability-unknown paths both produce omission, so a reintroduced default cannot hide in whichever path the fixture happens not to exercise.
- Error path: project-level `model` fails the case with the trust-boundary error rather than silently applying.
- Error path: the persisted artifact contains only structural facts — asserted directly, so a future change that starts serializing emitted config fails the privacy contract loudly.

**Verification:**
- The case passes at the pinned runtime and fails if source-owned defaulting is reintroduced in any bundled category or either availability path.

- [x] **Unit 6: Reconcile generated docs, architecture guidance, and registry artifacts**

**Goal:** Make every generated and hand-written surface describe the post-deletion reality.

**Requirements:** R8

**Dependencies:** Unit 3, Unit 4. Lands in the same change set as Unit 3 — see "Why this is one wedge, not several."

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/AGENTS.md`
- Modify: `docs/src/content/docs/reference/configuration.mdx` (regenerated)
- Create: migration guidance recording the pre-deletion per-category mapping
- Verify: `registry/files/profiles/omo/oh-my-opencode.jsonc`

**Approach:**
- `ARCHITECTURE.md` and `AGENTS.md` both state that TypeScript owns opinionated model defaults emitted at runtime. After this wedge that is false. Rewrite to state that bundled agents inherit the invoking model and that model policy is user-owned, while keeping the model-free markdown invariant which still holds.
- Regenerate the configuration reference; its provider-chain and source-default tables (`docs/src/content/docs/reference/configuration.mdx:99-105`) have no source to generate from any more.
- Follow the generation contract in `docs/AGENTS.md:70-85`: source change, snapshot, and generated docs move together rather than drifting across commits.
- Publish the deleted per-category mapping as migration guidance, so a user who was implicitly relying on it can see what they were getting and reproduce it in explicit config. Without this, "set it explicitly" asks users to recover a table the upgrade removed from their installation.
- Say plainly which audiences are affected: OCX/OMO installers inherit curated routing from the registry profile, and plain npm consumers lose category-aware routing unless they opt in. Do not describe this as a pure relocation.
- Review the OMO profile for coherence with the new story and confirm registry drift stays clean. Do not edit its model policy.

**Patterns to follow:**
- The bootstrap catalog deletion's `ARCHITECTURE.md` update, which documented per-harness discovery semantics as part of the same change rather than as follow-up.

**Test scenarios:**
- Test expectation: none for `ARCHITECTURE.md` and `AGENTS.md` prose — verified by the content-integrity gate and human review.
- Happy path: `bun run docs:generate` produces no reference to source model defaults, and `bun run docs:build` succeeds.
- Happy path: the migration guidance records every category's prior provider chain, so the pre-deletion mapping is reconstructible from the repository alone.
- Happy path: `bun run registry:drift` reports no drift.
- Error path: `bun run scripts/content-integrity.ts` reports clean, with no phantom references to the deleted module.

**Verification:**
- No committed document describes source-owned model defaults as current behavior.
- Generated artifacts regenerate cleanly from the post-deletion source.

## System-Wide Impact

- **Interaction graph:** The OpenCode `config` hook is the only runtime consumer. `applyAgentOverlays` loses its first layer; category and exact overlays are unaffected. Pi export and the Claude Code build are untouched because neither reads the source table.
- **Error propagation:** The unknown-category throw in `resolveSourceModel` and the coverage-validation throw in `agent-overlays.ts` both disappear with their subjects. Project-level `model` rejection is unchanged and remains the trust boundary's loud failure.
- **State lifecycle risks:** Deleting the `WeakMap` availability cache removes per-process memoization. Nothing else reads it, and no persisted state is involved. The `OPENCODE_MODELS_URL` cache file is read-only and simply stops being read.
- **API surface parity:** `src/index.ts` must continue to export only `default`. Deleting modules must not perturb the export shape.
- **Integration coverage:** Unit tests cannot prove the emitted config is correct end to end; Unit 5's eval case and the existing config-handler integration coverage carry that.
- **Unchanged invariants:** Config precedence, `SECURITY_OVERLAY_FIELDS`, the project-config model prohibition, `model: null` semantics, and the model-free bundled-markdown rule are all explicitly unchanged. This plan removes a default, not a boundary.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Users who relied on the implicit table see agents switch to their invoking model without warning | This is the intended behavior change, and it resolves toward the model the user actually chose. Unit 6 publishes the deleted mapping as migration guidance so the prior behavior stays reconstructible after upgrade, and release notes call the change out directly. |
| Plain npm consumers lose category-aware routing with no automatic replacement, unlike OCX/OMO installers who inherit the registry profile | Stated explicitly rather than framed as relocation, in both the plan and the release notes, with the migration guidance from Unit 6 as the recovery path. If curated routing turns out to matter to that audience, the answer is a shipped opt-in profile, not a return to source-owned defaults. |
| Deleting the availability subsystem removes machinery a future capability diagnostic may want | Recorded as a Key Technical Decision with rationale. Git history preserves it, and a diagnostic consumer needs a read-only reporting shape rather than a defaulting gate. |
| Six units in one wedge is a large diff for review | Units are ordered and independently revertable, each with its own tests. Units 1-2 are behavior-scoped, 3-4 are deletions, 5-6 are evidence and documentation. |
| Generated docs drift from source mid-wedge | Unit 6 follows the `docs/AGENTS.md` contract explicitly, and `registry:drift` plus `content-integrity` gate the result. |
| A future contributor reintroduces source-owned defaulting | Unit 5's eval case fails if a bundled agent's emitted config regains a `model` key without user config. |

## Documentation / Operational Notes

- Release notes should state plainly that bundled agents now inherit the invoking model, that users wanting per-category routing should set it explicitly, and that the OMO registry profile continues to provide a curated version for installers who use it. They should also name the audience split: plain npm consumers lose curated routing and need the migration guidance to reproduce it.
- The migration guidance from Unit 6 is the artifact that makes the no-compatibility-window decision defensible. If it does not ship with the deletion, the deletion should not ship either.
- Conventional type for the merge: this is user-visible behavior change. `refactor` publishes nothing in this repository (see `docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`); `feat` or `fix` is the honest header depending on whether the framing is "agents now inherit" or "agents no longer get pinned to unavailable models."
- After this lands, `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` describes a mechanism that no longer exists and needs a refresh pass.

## Sources & References

- **Origin document:** [`docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md`](2026-08-13-001-refactor-bitter-lesson-harness-plan.md) — initiative I5, Phase 2 wedge sequencing, and the Program Initiative Contract
- Prior wedge: [`docs/plans/2026-08-14-001-refactor-bootstrap-catalog-deletion-plan.md`](2026-08-14-001-refactor-bootstrap-catalog-deletion-plan.md) — Phase 2 wedge 1, paired-deletion precedent
- Eval foundation: [`docs/plans/2026-08-13-003-feat-local-opencode-eval-foundation-plan.md`](2026-08-13-003-feat-local-opencode-eval-foundation-plan.md) — the harness Unit 5 extends
- Deletion-staging precedent: [`docs/plans/2026-07-06-001-feat-removed-name-config-safety-plan.md`](2026-07-06-001-feat-removed-name-config-safety-plan.md)
- Primary deletion target: `src/lib/source-model-defaults.ts`
- Primary consumer: `src/lib/config-handler.ts`
- Related PR: #786 (Phase 2 wedge 1)
