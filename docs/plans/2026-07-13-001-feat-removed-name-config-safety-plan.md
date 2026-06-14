---
title: "feat: warn-and-ignore removed bundled names in disable lists"
type: feat
status: executed-pending-pr
date: 2026-07-13
origin: docs/brainstorms/2026-07-13-v3-cleanup-release-requirements.md
---

# feat: warn-and-ignore removed bundled names in disable lists

## Overview

Add a forward-compatible safety net so that future removal of a bundled skill or agent cannot brick plugin load for users who disabled that skill/agent. Today `disabled_skills` and `disabled_agents` are strict enums; an unknown name throws uncaught and aborts plugin load. This patch introduces a known-removed-names mechanism: names on that list are accepted, dropped from the effective config, and reported with a `[systematic]` warning. Genuinely-invalid names still fail strict validation.

This ships as a v2.x patch BEFORE the v3.0.0 cleanup (which deletes `orchestrating-swarms` and `claude-permissions-optimizer`), so the safety net exists before any skill is actually removed. The patch is behavior-neutral today: with an empty removed-names list, validation behaves exactly as it does now.

## Problem Frame

Verified release-blocker (see origin: `docs/brainstorms/2026-07-13-v3-cleanup-release-requirements.md`). `disabled_skills` is `z.array(z.enum(skillNames))` and `disabled_agents` is `z.array(z.enum([...agentNames, ...qualifiedAgentIds]))` (`src/lib/config-schema.ts:315-342`). A name not in the enum fails `safeParse`; `loadConfigSource` then calls `throwTopLevelConfigSchemaError`, which throws (`src/lib/config.ts:276-299, 238-274`). That throw escapes uncaught from both plugin init (`src/index.ts`) and the config hook (`src/lib/config-handler.ts:513-528`), aborting plugin load.

v2.19.0 deprecation guidance told users to set `disabled_skills: ["orchestrating-swarms"]`. When v3 deletes that skill, those exact users would be bricked on upgrade. Shipping the warn-and-ignore net first means the v3 deletion only has to add names to the removed list, not also introduce new validation behavior in the same breaking release.

## Requirements Trace

- R1. A name on the known-removed list, present in `disabled_skills` or `disabled_agents`, is accepted by validation (no throw), dropped from the effective config, and reported via a `[systematic]` warning naming the stale entry and pointing at cleanup.
- R2. Strict validation is preserved for genuinely-unknown names (typos, never-existed names) in both fields: they still throw the existing actionable error. The accepted set is a strict disjoint union of current bundled names and explicitly-listed removed names, with no normalization, aliasing, or prefix inference.
- R3. No accepted/rejected-config behavior change for existing inputs when the removed-names list is empty (this patch ships with an empty list). This is narrower than "behavior-neutral": an invariant test asserts current valid configs still parse and current invalid configs still throw, including error-message stability where user-visible.
- R4. The accept-and-drop path is proven NOW via tests that pass synthetic removed names through the schema factory (the factory takes name-set options), so the mechanism is exercised even though the shipped production list is empty.
- R5. A durable gate asserts removed-name lists never overlap current bundled names (so a removed entry can never shadow or backdoor a live name).
- R6. The warning is deduplicated per load invocation (stateless, keyed to a single load), not via sticky module-global state that could suppress unrelated later warnings in a long-lived process. If plugin-init and the config hook are separate loads that each warn once, that is acceptable and documented.
- R7. The schema generator threads the same removed-names so the published JSON Schema enum and the runtime accept the same set — preventing editor/runtime divergence once the list is populated in v3. (No-op now with an empty list.)

## Scope Boundaries

- This patch does NOT delete any skill or agent. `orchestrating-swarms` and `claude-permissions-optimizer` remain present and valid.
- The removed-names list ships EMPTY in this patch. Populating it happens in v3.0.0 when the skills are actually deleted.
- No change to `disabled_commands` (already a permissive `z.array(z.string())`).
- No change to the strict `agents.<key>` overlay validation or any other config field.

### Deferred to Separate Tasks

- Populating the removed-names list and deleting the skills: v3.0.0 (`docs/plans/2026-06-05-001` to be superseded by the v3 plan from the new brainstorm).
- The JSON Schema enum's treatment of removed names (deprecation wording vs divergence): resolve in v3 when names are actually removed, since the schema only matters once a name is removed.

## Context & Research

### Relevant Code and Patterns

- `src/lib/config-schema.ts:270-366` — `createSystematicConfigSchema(opts)` factory already takes `{ agentNames, qualifiedAgentIds, skillNames }`. The removed-names mechanism extends this options object.
- `src/lib/config-schema.ts:315-342` — the two strict enum fields to modify.
- `src/lib/config.ts:276-299` — `loadConfigSource` calls `safeParse` then throws on failure, and on success returns RAW config (not `result.data`) to preserve merge precedence. The post-parse drop+warn lives here, computed from raw config.
- `src/lib/config.ts:238-274` — `throwTopLevelConfigSchemaError` (the throw path that must NOT fire for removed names).
- `src/lib/bundled-names.ts` — `BUNDLED_SKILL_NAMES`, `BUNDLED_AGENT_NAMES`, `BUNDLED_AGENT_QUALIFIED_IDS`. The removed-names constants live alongside these (or in a dedicated module).
- `scripts/content-integrity.ts` — pattern for a durable gate, if a gate is warranted (e.g., to assert removed names never overlap current bundled names).
- `tests/unit/config.test.ts` and `tests/unit/config-schema.test.ts` — test homes.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` and the v2.5.0/v2.12.2 incidents: a throw escaping the plugin entry/hook removes ALL Systematic functionality. This is the failure class being prevented.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`: when a runtime accepts-but-drops input, mirror the rule in a gate so the contract cannot silently drift.

## Key Technical Decisions

- **Enum accepts current ∪ removed; drop+warn happens post-parse in `config.ts`, NOT in a Zod transform.** Add `removedSkillNames`/`removedAgentNames` to the factory options and include them in the enum tuples so removed names do not throw. But `loadConfigSource` deliberately returns RAW config (not `result.data`) to preserve merge precedence (`src/lib/config.ts:293-297`), and a Zod transform cannot cleanly surface "which names were dropped" back to the loader. So: after `safeParse` succeeds, compute the dropped-name set by comparing the raw `disabled_*` arrays against the current allowed-set, warn, and leave the raw config object untouched. The effective drop (removing the name from what's applied) happens where disabled names are consumed, or via a returned `{ dropped }` companion — implementer's choice, but raw config is not mutated.
- **Strict disjoint union, no normalization.** The accepted set is exactly current-names + explicitly-removed-names. No case-folding, aliasing, or bare/qualified inference that could let an otherwise-invalid name through the "removed" bucket. A gate asserts removed and current sets never overlap.
- **Warn, don't silently drop.** The `[systematic]` warning names each dropped entry and points at cleanup, but never fails load.
- **Empty list ships now; mechanism proven by synthetic-name tests.** The production removed-list is empty, so there is no user-visible behavior change for existing configs. The accept-and-drop path is proven now by passing synthetic removed names through the factory in tests, not deferred to v3.
- **Stateless per-load dedup.** Deduplicate warnings within a single load invocation. Do not use sticky module-global suppression that could swallow unrelated later warnings in a long-lived process. Init and config-hook are separate loads; each warning once is acceptable.
- **Generator threads removed-names too.** `scripts/generate-config-schema.ts` passes the same removed-names into the factory so the published JSON Schema enum matches runtime acceptance, avoiding editor/runtime divergence when the list is populated in v3.
- **`fix:` not `feat:`.** This prevents a latent plugin-load brick; corrective framing is honest. It is a patch release.

## Open Questions

### Resolved During Planning

- Where does the drop+warn live — schema transform or post-parse in `config.ts`? Resolved: **post-parse in `config.ts`**, not a Zod transform. `loadConfigSource` returns raw config (not `result.data`) to preserve merge precedence (`src/lib/config.ts:293-297`); a transform cannot surface the dropped-set back to the loader cleanly. After `safeParse` succeeds, compute dropped names by comparing raw `disabled_*` against the current allowed-set, warn, and leave raw config untouched.
- Should removed names also be accepted in `agents.<key>` overlays? Resolved: NO. This patch scopes only the two disable lists (the documented brick path). Overlay keys referencing a removed agent are a separate, lower-frequency case and stay strict for now.
- Schema/runtime divergence? Resolved: the generator threads removed-names too (R7), so the published schema enum matches runtime. No-op now (empty list), aligned by construction when v3 populates it.
- `feat:` vs `fix:`? Resolved: `fix:` (prevents a latent brick), patch release.

### Deferred to Implementation

- Exact `[systematic]` warning wording and whether it links to a docs anchor (the migration doc lands in v3; for now the warning can name the entry and say it is no longer a bundled name).

## Implementation Units

- [x] **Unit 1: Removed-names mechanism in the schema factory**

**Goal:** Accept known-removed names in `disabled_skills`/`disabled_agents` without throwing, while preserving strict rejection for unknown names.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Create: `src/lib/removed-names.ts` — `REMOVED_BUNDLED_SKILL_NAMES`, `REMOVED_BUNDLED_AGENT_NAMES`, both empty arrays in this patch
- Modify: `src/lib/config-schema.ts` — extend `SystematicConfigSchemaOptions` + `createSystematicConfigSchema` to accept removed names and include them in the enum tuples so they parse; the default runtime `SystematicConfigSchema` passes the (empty) constants
- Modify: `scripts/content-integrity.ts` — gate: removed-name lists must not overlap current bundled names (R5)
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Extend the factory options with `removedSkillNames`/`removedAgentNames`; the enum for each field accepts the strict disjoint union `current ∪ removed` (no normalization/aliasing).
- The schema only ACCEPTS removed names (no throw). The actual drop+warn is Unit 2's post-parse step in `config.ts` (the schema returns the array as-parsed; the loader computes/drops). Keep the enum change minimal.
- The default runtime schema passes the empty removed-name constants so existing behavior is unchanged.
- Genuinely-unknown names remain outside both sets and still fail the enum.
- Add the overlap gate so a removed name can never shadow a live bundled name.

**Execution note:** Implement test-first — write the failing "removed name does not throw" test before changing the schema. Pass synthetic removed names through the factory in tests (R4) to exercise the path despite the empty production list.

**Patterns to follow:**
- `createSystematicConfigSchema` options pattern (`src/lib/config-schema.ts:270-366`).
- `bundled-names.ts` constant style; `checkAgentMode`/`checkAgentTemperature` gate style in `content-integrity.ts`.

**Test scenarios:**
- Happy path: schema built with synthetic `removedSkillNames: ["gone-skill"]` parses `disabled_skills: ["gone-skill"]` without throwing.
- Edge case: mixed `disabled_skills: ["gone-skill", "ce:plan"]` parses without throwing.
- Error path: `disabled_skills: ["never-existed"]` still fails validation (in neither set).
- Disjoint-union: a removed name that equals a current name is rejected by the overlap gate (cannot register a removed name that shadows a live one).
- Invariant (R3): with empty removed lists, a removed-style name throws exactly as today, and current valid configs parse identically.
- Same coverage for `disabled_agents` (bare and qualified IDs); confirm no qualified/bare inference lets an invalid name through.

**Verification:**
- The factory accepts synthetic removed names without throwing; unknown names still throw; the overlap gate rejects removed/current collisions.

- [x] **Unit 2: Warn on dropped names + wire through config load**

**Goal:** After a successful parse, drop removed names from the effective config and emit a stateless, per-load-deduplicated `[systematic]` warning, without mutating raw config or failing load.

**Requirements:** R1, R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config.ts` — on `safeParse` success, compare raw `disabled_skills`/`disabled_agents` against the current allowed-set, compute the dropped set, emit the warning, and apply the drop where disabled names are consumed (or via a returned companion). Do NOT mutate the raw config object (`config.ts:293-297` preserves it for merge precedence).
- Test: `tests/unit/config.test.ts`

**Approach:**
- Drop+warn happens post-parse in the loader, not in a Zod transform (the loader returns raw config by design).
- Compute the dropped set from raw `disabled_*` minus current allowed names; warn naming each dropped entry.
- Dedup within a single load invocation only (stateless — e.g., a local set per `loadConfigWithSources` call). No sticky module-global suppression. If init and the config hook are separate loads that each warn once, that is accepted and documented.
- Preserve raw-config-for-merge semantics; the drop affects effective applied config, not the merge inputs.

**Execution note:** Test-first — assert the warning is emitted and load succeeds before wiring.

**Patterns to follow:**
- Existing `[systematic]` warning style (provider-availability warnings).
- The raw-config-preservation merge handling in `loadConfigWithSources`.

**Test scenarios:**
- Happy path: a config with a synthetic removed name loads successfully AND emits a `[systematic]` warning naming the entry.
- Error path: a config with an unknown name still throws the actionable schema error (warning path does not swallow it).
- Edge case: empty removed-name list → no warning, no behavior change.
- Dedup: within one load, the same stale entry warns once; across separate init+hook loads, each-once is acceptable (assert no sticky cross-load suppression of a DIFFERENT entry).
- Integration: merge precedence across config sources is unchanged when a removed name is dropped from one source; raw config object is not mutated.

**Verification:**
- Removed names warn-and-load end to end; unknown names still throw; dedup is per-load and stateless; raw config preserved.

- [x] **Unit 3: Thread removed-names through the schema generator**

**Goal:** Keep the published JSON Schema enum aligned with runtime acceptance so editors and runtime agree once the list is populated.

**Requirements:** R7

**Dependencies:** Unit 1

**Files:**
- Modify: `scripts/generate-config-schema.ts` — pass the removed-name constants into `createSystematicConfigSchema` so generated enums include them
- Test: `tests/unit/config-schema.test.ts` or the schema-generation test home

**Approach:**
- The generator already builds the schema via the factory with filesystem-discovered names; thread the removed-name constants alongside.
- No-op now (empty list); proven via a synthetic-name test asserting the generated enum would include a removed name.

**Execution note:** Verify generator output is byte-stable with the empty list (no drift) and includes a synthetic removed name when one is provided.

**Patterns to follow:**
- Existing generator factory call in `scripts/generate-config-schema.ts`.

**Test scenarios:**
- Happy path: generator with a synthetic removed name emits a schema whose `disabled_skills` enum includes that name.
- Regression: with the empty production list, generated schema is byte-identical to current (no drift).

**Verification:**
- Generated schema enum matches the runtime accepted set; empty-list output is unchanged (drift check passes).

## System-Wide Impact

- **Interaction graph:** config loading runs in plugin init (`src/index.ts`) and the config hook (`src/lib/config-handler.ts`); both must tolerate removed names identically.
- **Error propagation:** the change narrows what throws — removed names no longer throw; everything else still does.
- **State lifecycle risks:** dropped names must not alter merge precedence or raw-config preservation.
- **API surface parity:** only `disabled_skills`/`disabled_agents` change; `disabled_commands` and overlay keys are untouched.
- **Unchanged invariants:** strict validation for unknown names and overlay fields; `src/index.ts` still exports only `default`; the schema's `.strict()` top-level behavior is preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Enum expansion leaks acceptance of an invalid name | Strict disjoint union, no normalization/aliasing; overlap gate (R5) rejects removed/current collisions; tested for bare + qualified IDs. |
| Mechanism unproven because production list is empty | Synthetic removed names exercise the accept-and-drop path in tests now (R4). |
| Warning dedup becomes sticky global state, suppressing unrelated warnings | Stateless per-load dedup only (R6); test asserts no cross-load suppression of a different entry. |
| Drop mutates raw config and breaks merge precedence | Post-parse drop computes from raw but does not mutate it; integration test merge across sources (config.ts:293-297). |
| Schema/runtime divergence when v3 populates the list | Generator threads the same removed-names (R7); enum matches runtime by construction. |
| "Behavior-neutral" overclaim | Narrowed to "no change for existing inputs"; invariant test asserts current valid parse / invalid throw with empty list. |

## Documentation / Operational Notes

- No accepted/rejected-config behavior change for existing inputs (empty list), so no user-facing migration doc is needed in this patch. The v3 release that populates the list owns the migration guidance.
- `fix:` → patch release. This prevents a latent plugin-load brick; corrective framing is honest and the change adds no user-visible behavior for existing configs.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-07-13-v3-cleanup-release-requirements.md`
- Verified failure path: `src/lib/config-schema.ts:315-342`, `src/lib/config.ts:238-299`, `src/index.ts`, `src/lib/config-handler.ts:513-528`
- Oracle sequencing recommendation (this session): ship the safety net as a v2.x patch before the v3 deletion.
- Related future plan: v3.0.0 cleanup (to be written from the same origin brainstorm).
