---
title: "feat: Explicit agent temperature hardening"
type: feat
status: active
date: 2026-06-06
---

# feat: Explicit agent temperature hardening

## Overview

Make every bundled agent's resolved `temperature` explicit in its frontmatter, and change the runtime to respect explicit values instead of always overwriting them. This removes a hidden, converter-era inference heuristic from the runtime config path — a focused v2.x prerequisite that de-risks the eventual v3.0.0 converter removal. Zero runtime behavior change today.

**Why it's worth the explicit literals** (not just copying a heuristic into 51 files): it makes each agent's temperature auditable in source instead of hidden in a name/description regex; it lets the runtime stop inferring (the v3.0.0 converter removal can then delete the heuristic without changing behavior); and it brings temperature to parity with `mode`/`model`/`color` as gate-locked, source-visible agent config.

## Problem Frame

Two separate functions infer agent temperature from a name/description regex: `inferTemperature` in `src/lib/converter.ts` (CLI convert path) and `inferBuiltInTemperature` in `src/lib/agent-overlays.ts` (runtime config-hook path). They have byte-identical logic (0.1/0.2/0.3/0.6, default 0.3).

At runtime, `applyAgentOverlays` (`src/lib/config-handler.ts`) unconditionally assigns `result.temperature = inferBuiltInTemperature(name, description)` — overwriting both the converter-supplied value AND any explicit `temperature:` in agent frontmatter. Today 14 agents declare explicit `temperature: 0.1`, and all 14 happen to match their inferred value, so the override is behavior-neutral. But explicit frontmatter is silently ignored, and the resolved temperature for all 51 agents lives only in a heuristic, not in source.

Making temperature explicit + respecting it (fill-if-absent, mirroring the `mode` hardening shipped in v2.27.0) makes the values auditable and removes the runtime inference dependency before v3.0.0 deletes the converter.

## Requirements Trace

- R1. All 51 bundled agents declare an explicit `temperature:` in frontmatter equal to their current resolved value (zero behavior change).
- R2. The runtime stops overwriting explicit frontmatter temperature — `inferBuiltInTemperature` becomes a fill-if-absent fallback, not an unconditional override.
- R3. The content-integrity gate enforces that every bundled agent declares an explicit `temperature:`, locking the invariant.

## Scope Boundaries

- Not removing `inferTemperature` from `src/lib/converter.ts` — the converter still runs until v3.0.0; the converter's own temperature logic stays until converter removal.
- Not changing any agent's resolved temperature value — this is purely making the existing resolved values explicit and source-visible.
- Not a v3.0.0-complete patch — the other converter-injected fields (`steps`/`tools`/`permission`/`hidden`/`description`) remain for separate hardening.

### Deferred to Separate Tasks

- Removing `inferBuiltInTemperature` entirely once all agents declare explicit temperature and no caller relies on inference: v3.0.0 converter-removal work.
- Converter `inferTemperature` removal: v3.0.0 (converter removal).

## Context & Research

### Relevant Code and Patterns

- `src/lib/config-handler.ts` `applyAgentOverlays` (~line 265) — the unconditional override to change to fill-if-absent.
- `src/lib/agent-overlays.ts` `inferBuiltInTemperature` (~line 135) — the runtime heuristic; stays as fallback.
- `scripts/content-integrity.ts` `checkAgentMode` (~line 986) + `isAgentFile` — the exact pattern to mirror for `checkAgentTemperature`, wired into `main()` alongside the other agent checks.
- `agents/<category>/<name>.md` — 51 agent files; 14 already declare `temperature:`, 37 need it added.

### Institutional Learnings

- The `mode: subagent` hardening (v2.27.0) is the proven template: additive frontmatter + fill-if-absent runtime + content-integrity gate + a converter-equivalence test proving zero behavior change.

## Key Technical Decisions

- **Mechanically derive each resolved temperature** using the actual `inferBuiltInTemperature` function (not by hand), so the added values are provably the current runtime values. Verified distribution: 37 @ 0.1, 8 @ 0.2, 3 @ 0.3, 3 @ 0.6; the 14 existing explicit values all already match their inferred value (0 divergence).
- **Three-layer temperature precedence** (the fix preserves and clarifies this): the seed at the top of `applyAgentOverlays` uses the agent's explicit frontmatter `temperature` when present, else `inferBuiltInTemperature` as fallback; user category/exact overlays (`OVERLAY_ASSIGN_FIELDS` includes `temperature`) still apply AFTER the seed and correctly override when a user sets temperature in their own config. Precedence: **user overlay > explicit frontmatter > inferred fallback.** With no user config (the default path), the seed is the final value, so making frontmatter explicit is zero behavior change.
- **Fill-if-absent at the seed** (mirror `mode`): change the unconditional `result.temperature = inferBuiltInTemperature(...)` to use `result.temperature` when already set (frontmatter copied it via `loadAgentAsConfig`), else infer. Once R1 makes all 51 explicit, the inferred fallback is dormant but retained for safety. The overlay layer is untouched — user override behavior is preserved.
- **Gate requires explicit temperature** (`checkAgentTemperature`), parallel to `checkAgentModel`/`checkAgentMode`, scoped via `isAgentFile`. Fail closed: agent files with non-object/malformed frontmatter are a violation, not a silent bypass.
- **Gate wiring is full-path**: add `agentTemperatureViolations` to `CheckResult`, count it in `totalViolations()`, print it in `printResult()`, and invoke `checkAgentTemperature` in `checkContentIntegrity()` — not just `main()`. Mirror exactly how `checkAgentMode` is wired end-to-end.
- **Acceptance is resolved-value equivalence, not byte-identical output** — the converter still runs, so adding explicit `temperature:` to source can shift emitted YAML key ordering; what must hold is that the resolved `config.temperature` per agent is unchanged on the default (no-user-config) path.

## Implementation Units

- [ ] **Unit 1: Add explicit temperature to all bundled agents**

**Goal:** Every bundled agent declares an explicit `temperature:` equal to its current resolved value.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: the 37 `agents/<category>/<name>.md` files lacking `temperature:` (the 14 with explicit values are already correct and stay untouched)

**Approach:**
- Derive each agent's resolved temperature with the actual `inferBuiltInTemperature(name, description)` function (name = filename stem, description = frontmatter description). Add `temperature: <value>` to frontmatter for the 37 that lack it. Additive only; no existing value changes.

**Patterns to follow:**
- The v2.27.0 `mode: subagent` additive-frontmatter pass.

**Test scenarios:**
- Test expectation: none — pure additive frontmatter data; behavior preservation is proven mechanically in Unit 2.

**Verification:**
- All 51 agents have an explicit `temperature:`; the resolved temperature per agent (via the runtime path) is unchanged from before.

- [ ] **Unit 2: Respect explicit temperature at runtime + gate + equivalence test**

**Goal:** Runtime respects explicit frontmatter temperature (fill-if-absent), the gate enforces explicit temperature, and an equivalence test proves zero behavior change.

**Requirements:** R2, R3

**Dependencies:** Unit 1 (gate must pass against the hardened tree)

**Files:**
- Modify: `src/lib/config-handler.ts` (fill-if-absent in `applyAgentOverlays`)
- Modify: `scripts/content-integrity.ts` (`checkAgentTemperature` + wire into `main()`)
- Test: `tests/unit/config-handler.test.ts` (fill-if-absent + equivalence)
- Test: `tests/unit/content-integrity.test.ts` (`checkAgentTemperature` cases)

**Approach:**
- In `applyAgentOverlays`, change the unconditional temperature seed to use `result.temperature` when already set (frontmatter), else `inferBuiltInTemperature(...)`. Leave the overlay layer untouched so user overlays still override. Add `checkAgentTemperature` mirroring `checkAgentMode` (require explicit `temperature:` on every `isAgentFile`; fail closed on non-object frontmatter). Wire it end-to-end: `CheckResult.agentTemperatureViolations`, `totalViolations()`, `printResult()`, and `checkContentIntegrity()`.

**Execution note:** Test-first. RED: a test proving an agent with explicit `temperature` different from its inferred value is preserved (currently fails because the override clobbers it); a gate test proving a missing `temperature:` is flagged. GREEN: the fill-if-absent change + `checkAgentTemperature`.

**Patterns to follow:**
- `checkAgentMode` structure and its tests; the v2.27.0 convert-both-ways equivalence test.

**Test scenarios:**
- Happy path: agent with explicit `temperature: 0.5` keeps 0.5 after `applyAgentOverlays` (proves fill-if-absent — fails before the change).
- Happy path: agent with no explicit temperature still resolves to `inferBuiltInTemperature` value (fallback intact).
- Integration (precedence): a user category/exact overlay setting `temperature` still overrides explicit frontmatter (proves the overlay layer is untouched — user override preserved).
- Edge case: non-object / malformed frontmatter is flagged by `checkAgentTemperature` (fails closed, no silent bypass), unlike the original `checkAgentMode` `continue`.
- Error path: an agent file missing `temperature:` produces a gate violation and non-zero `totalViolations()`.
- Integration: the gate passes against the current hardened tree (all 51 agents).

**Verification:**
- Explicit frontmatter temperature is preserved at runtime; `checkAgentTemperature` flags any agent lacking explicit temperature; the full gate passes against the hardened tree; resolved temperatures are unchanged for all 51 agents.

## System-Wide Impact

- **API surface parity:** `temperature` joins `mode`/`model`/`color` as gate-enforced bundled-agent frontmatter invariants.
- **Unchanged invariants:** no agent's resolved temperature changes; bundled agents still omit `model`; `src/index.ts` still exports only `default`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A derived value is wrong, silently changing an agent's temperature | Derive mechanically via the actual `inferBuiltInTemperature` function; the equivalence test asserts resolved-value parity. |
| Fill-if-absent change regresses the no-explicit fallback path | Test asserts agents without explicit temperature still resolve to the inferred value. |

## Sources & References

- Related code: `src/lib/config-handler.ts`, `src/lib/agent-overlays.ts`, `scripts/content-integrity.ts`
- Prior art: the v2.27.0 agent `mode` hardening
