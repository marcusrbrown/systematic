---
title: Provider Availability Hardening (empty-discovery + lifecycle reorder)
type: fix
status: completed
date: 2026-05-14
origin: docs/brainstorms/2026-05-14-provider-availability-hardening-requirements.md
shipped: "PR #372 (v2.14.3); cache-empty follow-up PR #378 (v2.14.4) closes #373"
---

# Provider Availability Hardening (empty-discovery + lifecycle reorder)

## Overview

Two correctness fixes for `getAvailableModels` and the surrounding config-hook lifecycle, shipping as a single `fix(overlay):` patch (v2.14.3):

1. **Empty-discovery collapses to `'unknown'`**: when `client.config.providers()` succeeds but produces an empty `models` set, treat that as discovery failure for source-default-pinning purposes. Bundled agents inherit OpenCode's parent model instead of being pinned to a last-resort "first provider's first model" entry the user cannot access.
2. **Discovery runs before validation**: reorder `createConfigHandler` so `getAvailableModels` is called before any validator that can throw. The discovery result is computed and available before any user-config check (or bundled-source invariant) has a chance to abort the config hook. This both removes a real diagnostic ambiguity ("did we reach discovery, or did we fail in validation first?") and prepares the lifecycle for future DX hardening that will require validation to run with the availability picture in hand.

## Problem Frame

v2.13.0 introduced the `ModelAvailability` envelope with `status: 'api' | 'cache' | 'unknown'` so consumers could distinguish "live answer" from "cache fallback" from "total discovery failure." The downstream consumer in `src/lib/config-handler.ts:553-556` gates on `availability.status !== 'unknown'` — anything else admits the result.

Two correctness gaps surfaced after v2.14.2 shipped:

- When `client.config.providers()` returns `200 OK` with `data.providers = []`, the envelope is `{ status: 'api', models: <empty Set> }`. The gate at line 553 admits it. `resolveSourceModel` iterates over the empty set, no entries match, and the function falls through to the "last-resort: first provider's first model" path at `src/lib/source-model-defaults.ts:444-451`. Bundled agents emit `model: anthropic/claude-opus-4-7` even when the user has no Anthropic auth configured — exactly the wrong-model-pinning failure mode v2.13.0 was supposed to prevent.

- `assertSourceCategoryModelCoverage` and `validateAgentOverlays` both run at `src/lib/config-handler.ts:537-543`, BEFORE `getAvailableModels` on line 551. If either throws, the config hook exits early and discovery is never attempted. The May 14 local-vs-global investigation could not confirm whether Systematic actually reached provider discovery; a 200 response in logs proves the OpenCode endpoint works, not that Systematic called it.

Empirical anchor (resolved during planning): `mergeProvider` in `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1115` only adds a provider to `state.providers` when one of four signals fires — config block (`source: "config"` at line 1177/1332), env var present (`source: "env"` at line 1271), `auth.json` entry with `type: "api"` (line 1283), or plugin `auth.loader` registered (line 1306). The `/config/providers` endpoint at `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:24-29` returns `Object.values(state.providers)`. **Result: logged-out, unconfigured, and unauthenticated providers all converge to the same SDK shape — an empty `providers` array.** The three empty cases the brainstorm's adversarial review surfaced are operationally identical from Systematic's vantage point, which validates the brainstorm's working assumption that `models.size === 0` is the correct trigger for R1.

## Requirements Trace

- **R1.** Empty-discovery collapses to `'unknown'` for source-default-pinning (see origin: `docs/brainstorms/2026-05-14-provider-availability-hardening-requirements.md`)
- **R2.** Validation ordering: discover first, validate second
- **R3.** Warning surface uses `console.warn` with `[systematic]` prefix (constraint, not a unit — no new warnings are added in this PR; the constraint is fixed for any future work and enforced by review)
- **R4.** Documentation reflects empty-discovery degradation

## Scope Boundaries

- **In scope**: empty-discovery collapse, validation reorder, test coverage for both, docs update describing the empty-discovery degradation in prose
- **Out of scope** (deferred to companion brainstorm `2026-05-14-provider-availability-dx-hardening-requirements.md`):
  - `validateAgentOverlays` warn-instead-of-throw + validator API refactor
  - Process-scoped memoization of `ModelAvailability` and TTL design
  - Aggregated warning surface
  - CLI subcommand to inspect availability state

### Deferred to Separate Tasks

- DX-hardening follow-up (warn-mode validators + memoization) — separate brainstorm, separate PR, no timeline commitment

## Context & Research

### Relevant Code and Patterns

- `src/lib/model-availability.ts:43-65` — `DiscoveryStatus`, `ModelAvailability`, `emptyAvailability()` factory (the empty-set construction primitive R1 builds on)
- `src/lib/model-availability.ts:251-303` — `getAvailableModels` current implementation including timeout race, fallback cache, and client-shape defensive guard. Three branches return: cache-failure path (line 296), timeout fallback (line 287), and the API-success path (line 299-302). R1 modifies the API-success return.
- `src/lib/config-handler.ts:514-617` — `createConfigHandler` body. Current order at lines 537-556 is the target of R2's reorder.
- `src/lib/source-model-defaults.ts:415-451` — `resolveSourceModel`; the last-resort-pin fallback at lines 444-451 is the failure mode R1 prevents (no behavior change needed in `resolveSourceModel` itself — when `availabilitySet` is `undefined`, `applySourceModelDefault` already skips pinning).
- `src/lib/config-handler.ts:296-310` — `applySourceModelDefault` early-return when `availabilitySet` is `undefined` (already handles R1's downstream effect)
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1115-1336` — `mergeProvider` and the four provider-population sources; reference for the R1 empirical anchor

### Institutional Learnings

- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` — auth.json was signal 4 of 4; the v2.13.0 architectural intent was "skip pinning when we cannot prove the user can call the model." R1 extends that intent to authoritatively-empty API responses.
- Memory `#2963` — `ModelAvailability.models` is `ReadonlySet<string>`; `emptyAvailability()` is a factory (each caller gets a fresh Set). R1 reuses the factory.
- Memory `#2962` — `models.json` cache shape + 16MB cap + fd-bounded read. No changes here; R1 is the API-success branch.

### External References

None — internal refactor with empirical grounding from clonedeps.

## Key Technical Decisions

- **R1 trigger is `models.size === 0` after `buildSetFromProviders`**: resolved empirically against `.slim/clonedeps/repos/anomalyco__opencode/` during planning. The cases inspected (no providers configured, configured-but-unauthenticated, configured-but-logged-out) all produce no usable models. Other empty-shape variants (e.g., `enabled_providers` set with no auth, plugin `auth.loader` returning nothing, `disabled_providers` filtering) may produce non-empty `providers` arrays but still zero discovered models. The threshold checks `set.size === 0` after `buildSetFromProviders`, which catches all variants regardless of upstream SDK shape — the load-bearing claim is "no usable models means skip pinning," not a specific provider-array shape.
- **R2 reorder places BOTH validators after discovery**: simpler than the brainstorm's step-by-step variant. `getAvailableModels` runs first; THEN `assertSourceCategoryModelCoverage` (still throws on Systematic-development bug); THEN `validateAgentOverlays` (still throws — unchanged in this PR per scope). The discovery result is computed before either validator has a chance to abort, eliminating the diagnostic ambiguity. **This is a deliberate lifecycle seam**, not a coincidental rearrangement: any future validator that needs to consult availability (e.g., "reject an overlay whose target model is not in the availability set") gets the discovery result already in scope. The companion DX brainstorm covers exactly that class of future work; the reorder here is its prerequisite. Future maintainers must not move discovery back down because current validators don't consume it.
- **No new `console.warn` calls in this PR**: R1 is silent — empty discovery returning `'unknown'` is the same observable behavior path the existing `'unknown'` envelope produces. R3 fixes the warning prefix going forward but doesn't add warnings here.
- **Docs change is prose, outside generated delimiters**: the configuration.mdx update adds a sentence to the existing prose section about availability-aware resolution. Does not touch the `SYSTEMATIC:SOURCE-DEFAULTS:START/END` generated block.
- **TDD discipline**: each implementation unit has a failing test added FIRST, then implementation. Memory `#2767` requirement.

## Open Questions

### Resolved During Planning

- **R1 empirical trigger** (was: "what shape does `client.config.providers()` return for configured-but-logged-out providers?"): resolved via clonedeps inspection. All empty cases produce identical SDK shape: empty `data.providers` array. `models.size === 0` is the correct trigger.
- **Step 4 vs 5 reorder** (was: "validators between discovery and resolution, or after?"): resolved — both validators move after `getAvailableModels`. Simpler model, no special-casing.

### Deferred to Implementation

- **Exact docs prose** for the empty-discovery degradation in `configuration.mdx`: short addition (1-3 sentences) describing the behavior. Implementer chooses wording during execution.
- **Solution doc category**: `best-practices` or `integration-issues` — decide at compound stage based on which framing dominates the writeup.

## Implementation Units

### Unit 1: Empty-discovery collapses to `'unknown'`

**Goal:** When `client.config.providers()` succeeds but produces an empty `models` set, return `{ status: 'unknown', models: emptyAvailability().models }` so downstream consumers skip source-default pinning.

**Requirements:** R1

**Dependencies:** none

**Files:**
- Modify: `src/lib/model-availability.ts`
- Test: `tests/unit/model-availability.test.ts`

**Approach:**
- In `getAvailableModels`, after `buildSetFromProviders` produces the success-path `Set`, branch on `set.size === 0`. If empty, return `emptyAvailability()` instead of `{ status: 'api', models: <emptySet> }`. Preserves the three-status taxonomy at the type level; only the threshold shifts.
- Inline comment near the new threshold references the empirical anchor in `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1115-1336` so future readers see the evidence for why empty-`'api'` is treated the same as total discovery failure.

**Execution note:** Test-first. Add a failing test for the empty-providers case before modifying `getAvailableModels`.

**Patterns to follow:**
- `src/lib/model-availability.ts:251-303` — match the existing return-shape pattern; reuse `emptyAvailability()` (local factory in the same module — `new Set<string>()` per call, no shared singleton)
- `src/lib/model-availability.ts:43-55` — preserve the documented `DiscoveryStatus` semantics (no taxonomy change)

**Test scenarios:**
- Happy path: `client.config.providers()` returns `{ data: { providers: [<non-empty>], default: {} }, error: undefined }` → returns `{ status: 'api', models: <non-empty Set> }` (existing behavior, regression coverage)
- **NEW**: `client.config.providers()` returns `{ data: { providers: [], default: {} }, error: undefined }` → returns `{ status: 'unknown', models: <empty Set> }` (R1 collapse for the most-common empty case)
- **NEW**: `client.config.providers()` returns `{ data: { providers: [{ id: 'fake', models: {} }], default: {} }, error: undefined }` → providers list non-empty but no models → `models.size === 0` → returns `{ status: 'unknown', models: <empty Set> }` (catches the adversarial-flagged edge cases where SDK shape is non-empty but no usable models)
- Edge case: `models` Set is fresh per call (factory pattern, regression coverage against accidental shared-mutable-state regression — `emptyAvailability()` is currently `new Set<string>()` per call; the test guards against a future optimization that would replace it with a shared singleton)

**Verification:**
- The R1 collapse fires whenever `models.size === 0` regardless of underlying signal
- Downstream consumer in `config-handler.ts` (already tested separately) observes `availability.status === 'unknown'`, sets `availabilitySet = undefined`, and bundled agents inherit parent model

### Unit 2: Validation reorder — discover first, validate second

**Goal:** Reorder `createConfigHandler` so `getAvailableModels` is invoked before any validator that can throw.

**Requirements:** R2

**Dependencies:** Unit 1 (so R1's empty-discovery behavior is in place when the reorder enables more code paths to reach it)

**Files:**
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Move the `await getAvailableModels(deps.client)` call (currently line 550-552) to immediately AFTER `buildBundledAgentInventory` (currently line 533-536) and BEFORE both `assertSourceCategoryModelCoverage` (line 537) and `validateAgentOverlays` (line 538-543).
- New order: load config → build inventory → call `getAvailableModels` → `assertSourceCategoryModelCoverage` → `validateAgentOverlays` → `resolveAgentOverlaySet` → `collectAgents`.
- `availabilitySet` computation (the `status !== 'unknown'` gate at lines 553-556) stays attached to the `getAvailableModels` call site — moves with it.
- No new behavior; ordering refactor only.

**Execution note:** Test-first. Add a test that mocks `client.config.providers()` to fire a tracking side-effect (e.g., increment a counter), and asserts the counter increments even when subsequent validators would throw. That test fails today and passes after the reorder.

**Patterns to follow:**
- `src/lib/config-handler.ts:514-563` — preserve all dependencies; the reorder is purely a statement-shuffle within `createConfigHandler`
- Existing test patterns in `tests/unit/config-handler.test.ts` that inject a stub `client` (e.g., the new test added in PR #370 for the defensive `typeof client.config?.providers === 'function'` guard)

**Test scenarios:**
- Happy path: validators don't throw; discovery completes; downstream resolution sees the availability set (regression coverage for the reorder being transparent in the no-error case)
- **NEW**: validators would throw (e.g., `validateAgentOverlays` finds an unknown agent reference) AND `client.config.providers()` is stubbed with a tracking spy that resolves BEFORE the validator throw point. The test asserts the spy was invoked (and resolved) before the validator's throw site — not just "called once eventually" but "discovery happened before the throw." Failure mode this catches: a future refactor that moves discovery back down or defers it behind another validator path that still doesn't execute when validation throws.
- **NEW**: validators don't throw AND `client.config.providers()` is undefined → reorder doesn't break the no-client path (existing defensive behavior, regression coverage)
- Edge case: `assertSourceCategoryModelCoverage` throws (e.g., a synthetic missing-category inventory) — discovery has already completed; the throw happens after; test asserts the tracking spy fired and resolved before the throw

**Verification:**
- Order in `createConfigHandler` body matches: load → inventory → discovery → coverage assert → overlay validation → resolve → collect
- `tests/unit/config-handler.test.ts` `describe('createConfigHandler', …)` retains all existing passing tests (no regression in any of the 50+ existing scenarios)
- Discovery is observable before any validator throw via the new tracking-spy test

### Unit 3: Documentation update for empty-discovery degradation

**Goal:** Add prose to `docs/src/content/docs/getting-started/configuration.mdx` describing the empty-discovery degradation so users know to expect bundled agents inheriting parent model when no providers are connected.

**Requirements:** R4

**Dependencies:** Unit 1 (the behavior must exist before docs describe it)

**Files:**
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`
- Test: none — documentation-only change validated by `bun run docs:build`

**Approach:**
- Locate the existing "Availability-Aware Resolution" subsection (preserved across the v2.13.0 → v2.14.2 doc updates).
- Add 1-3 sentences inside the prose section (OUTSIDE the `SYSTEMATIC:SOURCE-DEFAULTS:START/END` generated delimiters) describing: (a) when **availability discovery yields no usable models**, Systematic skips source-default pinning, (b) bundled agents inherit OpenCode's parent model in that state, (c) the user can verify provider connectivity via `opencode auth list`.
- **Wording note (from review)**: prefer "no usable models" over "no providers connected" — the latter is too coarse and misreads the partial-provider-failure case where some providers are up but produce no usable models. "No usable models" matches the actual R1 threshold and the user-observable behavior regardless of why models are missing.
- Avoid promising a specific warning message — Unit 3 does NOT add warnings (per Key Technical Decisions). The doc is descriptive of the silent-skip behavior.

**Execution note:** Documentation-only. No test scenarios; `bun run docs:build` is the only verification.

**Patterns to follow:**
- Existing prose-vs-generated separation in `configuration.mdx` (the `SYSTEMATIC:SOURCE-DEFAULTS:START/END` delimited block is owned by `docs/scripts/generate-config-reference.ts`; everything outside is manual)
- Memory `#2685` — `bun run docs:build` must pass; MDX errors are blocking

**Test scenarios:**
Test expectation: none — pure documentation change; the only failure mode is MDX parse error caught by `docs:build`.

**Verification:**
- `bun run docs:build` succeeds and renders the new prose
- The added sentences are outside `SYSTEMATIC:SOURCE-DEFAULTS:START/END` delimiters (manual content, not regenerated)

## System-Wide Impact

- **Interaction graph:** `getAvailableModels` is consumed only by `createConfigHandler` in `src/lib/config-handler.ts:551`. R1 changes which envelope shape is returned; R2 changes when that consumer's call happens. No other consumer.
- **Error propagation:** Unchanged. `getAvailableModels` still never rejects; validators still throw with the same messages and same semantics. R2's reorder doesn't change which errors surface, only their relative timing.
- **API surface parity:** No exported-symbol changes. `ModelAvailability` envelope shape unchanged; `DiscoveryStatus` union unchanged; `getAvailableModels` signature unchanged.
- **Integration coverage:** The mixed-version OpenCode probe (existing) exercises the real config-handler call path including `getAvailableModels`. The reorder is observable end-to-end through that probe.
- **Unchanged invariants:**
  - Three-status taxonomy preserved (`'api'` / `'cache'` / `'unknown'`)
  - `emptyAvailability()` factory contract (fresh Set per call) preserved
  - `assertSourceCategoryModelCoverage` and `validateAgentOverlays` throw semantics preserved (DX brainstorm covers any future change)
  - No new warnings emitted in this PR; existing warnings in `model-availability.ts` keep their messages

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| R1 trigger misclassifies a legitimately-empty edge case (e.g., a future OpenCode version that uses empty `providers` to mean "providers exist but suspended") | Empirical anchor from clonedeps shows current behavior is consistent across all empty cases. If a future SDK shape introduces a distinct meaning, the trigger logic can be tightened with a follow-up. Inline comment near the threshold cites the evidence for future readers. |
| R2 reorder breaks an implicit ordering assumption in a validator | All existing `tests/unit/config-handler.test.ts` cases must continue to pass. The validators don't depend on each other's outputs — they read different parts of `inventory` and `overlays`. Risk is low. |
| R2 reorder is observable to a plugin that depends on the call-ordering side-effect | Intra-hook call order is not part of the plugin contract: no exported plugin API surfaces the order of `getAvailableModels` vs validators within a single config-hook invocation. The PR-#370 multi-source plugin order is a separate concern (cross-hook sequencing across plugin sources); the R2 reorder is intra-hook only and not observable to other plugins via the documented `PluginInput`/`Hooks` surface. |
| Docs update misuses the `SYSTEMATIC:SOURCE-DEFAULTS:START/END` delimiters | Plan explicitly directs the prose to live OUTSIDE the generated block. Memory `#2685` enforces `docs:build` in the gate. Generator's idempotency check (existing test) catches any accidental delimiter modification. |
| Companion DX brainstorm becomes redundant if these fixes feel sufficient | Acceptable. The companion is deferred and can be re-evaluated after v2.14.3 ships. |

## Documentation / Operational Notes

- No rollout coordination needed — patch release, no migration.
- Solution doc to be written at compound stage (post-merge) capturing the lesson "empty success is a kind of failure for our purposes" + the discovery-before-validation lifecycle pattern.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-14-provider-availability-hardening-requirements.md`
- **Companion brainstorm (deferred):** `docs/brainstorms/2026-05-14-provider-availability-dx-hardening-requirements.md`
- **Source files:** `src/lib/model-availability.ts`, `src/lib/config-handler.ts`, `src/lib/source-model-defaults.ts`
- **Test files:** `tests/unit/model-availability.test.ts`, `tests/unit/config-handler.test.ts`
- **Docs file:** `docs/src/content/docs/getting-started/configuration.mdx`
- **Cloned OpenCode source (R1 empirical anchor):** `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1115-1336`, `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:24-29`
- **Related PRs:** PR #358 (v2.13.0 — `client.config.providers()` introduction), PR #370 (v2.14.2 — local-vs-global plugin override, multi-source plugin load became a real configuration)
- **Memories:** `#3010` (the original follow-up trigger; framing refined by Phase 0/1 grounding and document review), `#2963` (`ModelAvailability.models` is `ReadonlySet<string>`, `emptyAvailability()` is a factory), `#2962` (`models.json` cache shape), `#2734` (`fix:` → semantic-release patch), `#2767` (TDD discipline)
