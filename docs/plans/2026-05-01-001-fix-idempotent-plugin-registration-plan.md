---
title: 'fix: make plugin registration idempotent across duplicate config sources'
type: fix
status: active
date: 2026-05-01
---

# fix: make plugin registration idempotent across duplicate config sources

## Overview

Add an empirically gated idempotency fix for duplicate Systematic plugin loads when the same plugin is listed in multiple OpenCode config sources. The work starts with a temporary Phase 0 factory probe in `src/index.ts` and pauses for a real OpenCode observation before any singleton code is shipped. If the probe confirms the same-process duplicate-factory pattern the user described, implementation proceeds with a `globalThis` + `Symbol.for(...)` singleton helper modeled on `opencode-copilot-delegate`, plus factory wiring, isolation tests, and full verification. If the probe shows a materially different pattern, implementation stops and reports instead of forcing the wrong architecture.

Single-config users should see no behavior change. Duplicate-config users should end up with one effective plugin registration per process, one bounded duplicate warning per process, and no duplicate `systematic_skill` entries in host-visible tool listings.

## Problem Frame

OpenCode can invoke a plugin factory once per config source that references the plugin. When both a project-level config and a user-level config list Systematic, the plugin factory can run twice in the same process. Systematic's current factory at `src/index.ts` has no singleton guard and does meaningful per-call work:

- loads config with `loadConfig(directory)`
- snapshots bootstrap content with `getBootstrapContent(...)`
- creates the config hook with `createConfigHandler(...)`
- creates the `systematic_skill` tool with `createSkillTool(...)`
- returns hook closures that register config mutations, tool definitions, and system-prompt injection

That makes the duplicate observable as duplicate tool registration, duplicate init side effects, and duplicated closure state. The requested fix is the same per-process singleton pattern already used in `opencode-copilot-delegate`.

The important Systematic-specific trap is that the current factory also captures caller-scoped state (`directory`, merged config, bootstrap snapshot, disabled lists, and `client.app.log`). A whole-hooks singleton is only safe if the real duplicate path does not expose meaningful caller variance. The plan therefore treats the Phase 0 probe as a hard gate rather than a box-checking exercise.

## Requirements Trace

### Probe Validation

- R1. Confirm the current Systematic plugin factory matches the problem shape: real init work, real hook registration, no existing singleton guard.
- R2. Add a temporary pre-flight probe at the top of the factory body and verify the real OpenCode loader behavior before implementation.
- R3. Build the local plugin, temporarily point the user-level OpenCode plugin entry at the local `dist/index.js`, and stop for the user's pasted probe output.

### Singleton Contract

- R4. If and only if the probe matches the expected duplicate-factory pattern, add a per-process singleton helper using `globalThis`, `Symbol.for(...)`, cached `Promise<Hooks>`, PID matching, one-shot duplicate warning, and swallowed `onDuplicate` exceptions.
- R5. Keep `_resetPluginSingleton()` test-only and ensure production code never calls it.

### Test Isolation

- R6. Add the requested 8 unit tests for the singleton helper.
- R7. Update factory-driving tests so singleton state cannot leak across cases.

### Verification And Handoff

- R8. Verify full quality gates: tests, typecheck, lint, and build.
- R9. End execution with a local feature branch and local commit only; do not push or open a PR without explicit follow-up.

## Scope Boundaries

- No OpenCode upstream changes, issue filing, or host-side loader modifications.
- No unrelated refactors inside `src/index.ts`, `src/lib/config-handler.ts`, `src/lib/skill-tool.ts`, or `src/lib/bootstrap.ts` beyond the work needed to support safe idempotency.
- No public documentation or README update in this pass.
- No permanent probe or debug logging shipped in the final diff.
- No release-system migration. This repo uses semantic-release, not Changesets.

### Deferred to Separate Tasks

- If the Phase 0 probe shows differing caller-scoped inputs that make a whole-hooks singleton unsafe, the fallback design work (for example, narrowing the singleton to package-static runtime state or redesigning duplicate registration boundaries) should be handled as a fresh planning decision instead of being improvised mid-implementation.

## Context & Research

### Relevant Code and Patterns

- `src/index.ts` is the default plugin factory. It already uses one module-scope flag (`hasLoggedInit`) and returns three hook surfaces: `config`, `tool.systematic_skill`, and `'experimental.chat.system.transform'`.
- `src/lib/config.ts` resolves merged config from user and project config roots via `loadConfig(directory)`. This makes merged config directory-scoped, not package-scoped.
- `src/lib/config-handler.ts` builds a config hook that captures `directory` and bundled content paths, then re-runs `loadConfig(directory)` inside the returned hook. Existing config entries win over bundled entries.
- `src/lib/skill-tool.ts` builds the `systematic_skill` tool from bundled skills plus `disabledSkills`. It caches description metadata in closure state, which is safe only when the captured disabled list is the correct one.
- `src/lib/bootstrap.ts` currently snapshots bootstrap content once per plugin init. Existing tests already pin the restart-required behavior for custom bootstrap file edits.
- `tests/unit/plugin.test.ts` is the primary factory-facing test file. It already dynamically imports `src/index.ts`, checks default-export shape, and verifies bootstrap snapshot semantics.
- `tests/unit/config-handler.test.ts` and `tests/unit/skill-tool.test.ts` show the repo's standard testing style: real temp directories, real filesystem fixtures, `bun:test`, and minimal mocking.
- `tests/manual/session-compacting-probe.ts` and `tests/manual/companion-aware-probe.ts` are the closest local precedents for a Phase 0 probe: temporary instrumentation, real `opencode serve`, explicit pass/fail verdicts, and a hard stop when the observed host behavior diverges from the design assumption.
- External precedent: `opencode-copilot-delegate/src/runtime/plugin-singleton.ts` and `opencode-copilot-delegate/src/index.ts` show the exact requested singleton helper and plugin-factory wiring pattern.
- `package.json` and `.releaserc.yaml` confirm that Systematic uses semantic-release. There is no `.changeset/` directory or Changesets automation.
- `.opencode/` does not contain a checked-in plugin registration example, so the Phase 0 reproduction setup must be documented explicitly instead of assuming host-config knowledge.

### Institutional Learnings

- `docs/solutions/integration-issues/workflow-command-prompt-dry-run-integration.md`: comments and convention are not enough; use a mechanical guard and test the real invocation path.
- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md`: verify with a different mechanism than the implementation mechanism. Here that means a real loader probe plus unit tests, not unit tests alone.
- `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`: cache/idempotency behavior changes need explicit regression coverage and coupled-surface verification.
- Repo memory: Phase 0 empirical probes are the right way to validate uncertain host behavior before shipping V1 logic.

### External References

- `opencode-copilot-delegate/src/runtime/plugin-singleton.ts` (external sibling repo, PR #76)
- `opencode-copilot-delegate/src/index.ts` (external sibling repo, current duplicate-factory wiring)

## Key Technical Decisions

- **Phase 0 is a hard gate, not optional setup.** Implementation does not proceed until the real OpenCode loader output is observed and confirmed.
- **A whole-hooks singleton is only allowed if later duplicate invocations are semantically equivalent to the first one for all singleton-sensitive behavior.** Same PID and `count=1` resets prove duplicate loading, but they do not prove safety by themselves. The probe must emit comparable fingerprints for the effective inputs that shape returned hooks: resolved `directory`, merged config values that affect hook behavior, disabled skill lists, bootstrap source or snapshot inputs, and any caller-specific logging assumptions.
- **This plan adopts the `opencode-copilot-delegate` pattern only as the transport mechanism, not as proof of caching scope.** Reuse the boring parts (`globalThis`, `Symbol.for(...)`, cached `Promise<T>`, PID equality check, one-shot `warned`, swallowed `onDuplicate` exceptions), but justify whole-hooks caching from Systematic's own state model.
- **Whole-hooks singleton means first successful initialization wins for the process.** That tradeoff is acceptable only if duplicate invocations are redundant host replays. If later calls would have produced different host-visible tool surfaces, config effects, bootstrap output, or logging routing, the architecture is wrong and implementation stops.
- **Material caller variance is a stop condition.** Treat differing effective disabled-skill sets, differing bootstrap inputs, differing config-derived behavior, or any evidence that later invocations would have produced different hooks or prompt or tool surfaces as fail or ambiguous outcomes rather than implementation details to wave away.
- **Whole-hooks reuse is not assumed to solve duplicate registration by magic.** The implementation must verify the actual host-visible surface that motivated the change: duplicate `systematic_skill` registration in OpenCode's tool listings. Reusing the same hooks object is acceptable only if the post-change probe proves the host no longer exposes duplicate tool entries.
- **If the probe shows differing caller-scoped inputs, stop instead of improvising.** That is a design fork, not an implementation detail. The follow-up path should evaluate smaller dedupe boundaries, such as deduping only host registration side effects or isolating package-static runtime state from caller-scoped state.
- **Rejected init stays sticky for the process lifetime if the singleton is approved.** This matches the sibling precedent and keeps the helper simple: cache the in-flight or rejected `Promise<Hooks>` and require process restart for recovery rather than adding retry state that weakens the once-only contract.
- **The duplicate warning exists to make suppressed later invocations observable.** Final implementation should log once per process that a duplicate factory call was ignored and the existing hooks are being reused. It should include enough detail to debug duplicate registration, but should not ship the probe's verbose path or config dump.
- **The singleton helper should live at `src/lib/plugin-singleton.ts`.** Systematic already centralizes small reusable helpers under `src/lib/`; creating a top-level `src/runtime/` namespace for a single file adds structure without paying rent.
- **Probe instrumentation is temporary and must be removed before the implementation commit.** The final diff should ship only the singleton helper, factory wiring, tests, and any release-signal artifact required by the repo's actual tooling.
- **Preserve the current bootstrap contract.** Once the final singleton is in place, bootstrap content must still be stable for the duration of the initialized plugin context; the idempotency fix must not silently reintroduce per-request bootstrap reads.

## Open Questions

### Resolved During Planning

- **Does the problem shape apply to Systematic?** Yes. `src/index.ts` is a default-exported `Plugin` factory, it performs meaningful init work, it returns hook registrations, and it currently has no singleton guard.
- **Is external framework research needed?** No. The repo plus the `opencode-copilot-delegate` precedent already provide the relevant implementation pattern and host-facing constraints.
- **Should the plan assume literal Changesets support?** No. The repo uses semantic-release, so the implementation should carry forward the requested minor-release intent through that mechanism instead.
- **Should probe tooling be formalized as a permanent test helper first?** No. The fastest safe path is a temporary factory probe plus the existing real-host validation style used in `tests/manual/*probe.ts`.

### Deferred to Implementation

- **Exact helper file naming and export ordering inside `src/lib/plugin-singleton.ts`** can be finalized while writing the code, as long as the contract matches the approved pattern.
- **Whether any other factory-facing tests besides `tests/unit/plugin.test.ts` need `_resetPluginSingleton()`** should be finalized from a repo-wide search during implementation. Today `tests/unit/plugin.test.ts` is the obvious hit.
- **If the probe reveals mixed directory markers but the host still dedupes later hook registration by identity,** that nuance should still be reported back to the user before proceeding. The plan assumes a conservative stop-on-variance posture.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Safety Matrix

| Surface | Current Source | Expected Scope | Safe to Share via Process Singleton? |
|---|---|---|---|
| Bundled content paths | `src/index.ts` module constants | package / process | Yes |
| Package version read | `package.json` | package / process | Yes |
| Duplicate-warning state | singleton helper | process | Yes |
| `directory` | plugin factory input | caller / invocation | Only if Phase 0 proves duplicates do not vary meaningfully |
| Merged config | `loadConfig(directory)` | caller / invocation | Same constraint |
| Bootstrap snapshot | `getBootstrapContent(config, ...)` | caller / initialized plugin | Same constraint |
| `disabled_*` lists used by `createSkillTool(...)` | merged config | caller / invocation | Same constraint |
| `client.app.log` sink | plugin factory input | caller / invocation | Same constraint |

### Decision Flow

```text
Temporary factory probe -> observe real OpenCode duplicate-load behavior
  -> PASS: same-process duplicate reset with no unsafe caller variance
     -> add src/lib/plugin-singleton.ts
     -> wrap src/index.ts through plugInOnce(...)
     -> add helper tests + factory isolation tests
  -> FAIL / AMBIGUOUS: differing caller variance or unexpected module behavior
     -> remove probe
     -> stop and report findings
     -> re-plan instead of forcing a hooks singleton
```

## Implementation Units

- [ ] **Unit 1: Phase 0 empirical probe and safety gate**

**Goal:** Prove the real loader behavior before any singleton code ships.

**Requirements:** R1, R2, R3

**Dependencies:** None.

**Files:**
- Modify (temporary): `src/index.ts`

**Approach:**
- Add the temporary probe exactly at the top of the factory body in `src/index.ts`:
  - module-scope `let probeInvocationCount = 0`
  - increment per factory call
  - synchronous `console.warn(...)` with `count`, `process.pid`, `process.ppid`, `directory`, and timestamp
  - best-effort `client.app.log(...)` with `service: 'systematic-probe'` and matching structured `extra`
  - include comparable fingerprints for singleton-sensitive inputs, not just raw directory strings. At minimum emit:
    - `configFingerprint`: deterministic summary of `loadConfig(directory)` values that affect hook behavior (`disabled_skills`, `disabled_agents`, `disabled_commands`, `bootstrap.enabled`, `bootstrap.file`)
    - `bootstrapFingerprint`: whether bootstrap resolves to disabled, missing, bundled skill, or custom file, plus a stable digest of the snapshotted content when present
    - `toolFingerprint`: deterministic summary of the disabled-skill state passed into `createSkillTool(...)`
- Build the plugin so the local `dist/index.js` reflects the probe.
- Reproduce duplicate-source loading explicitly:
  - keep the project-level config source pointing at the local plugin under the repo being tested
  - temporarily switch the user-level OpenCode plugin entry to the same local built plugin path
  - preserve the pre-probe user-level config so it can be restored after observation
- Hand off to the user with the expected log pattern and wait for the pasted output before proceeding.
- Treat the probe as **pass / fail / ambiguous**:
  - **Pass:** same PID, duplicate invocations observed, both invocations start at `count=1`, and the duplicate calls are semantically equivalent for all singleton-sensitive inputs: resolved `directory`, merged config values that affect hook behavior, disabled-skill state, bootstrap inputs or snapshots, and any caller-specific logging assumptions.
  - **Alternate path:** duplicate invocation is reproduced, but the invocation count increments in-module (`count=1` then `count=2`). That still proves duplicate factory invocation, but it suggests a smaller module-scope idempotency fix may be more appropriate than a cross-module `globalThis` singleton. Stop and report this as an alternate design path.
  - **Fail:** duplicate invocation is not reproduced.
  - **Ambiguous / unsafe:** duplicate invocation is reproduced, but caller-scoped markers differ materially enough that a cached hooks object would be unsafe. Examples: differing effective disabled-skill sets, differing bootstrap inputs, differing config-derived behavior, or any evidence that later invocations would have produced different host-visible hooks or prompt or tool surfaces.
- Remove the probe before starting implementation work.

**Patterns to follow:**
- `tests/manual/session-compacting-probe.ts` for real-host validation structure and verdict language
- `tests/manual/companion-aware-probe.ts` for explicit pass / ambiguous / fail gating

**Test scenarios:**
- Test expectation: none -- this unit is a temporary manual probe, not shipped test coverage.

**Verification:**
- The user-provided log output is categorized as pass, alternate-path, fail, or ambiguous using the criteria above.
- No implementation code is started until the verdict is explicit.

- [ ] **Unit 2: Add the singleton helper and wrap the plugin factory**

**Goal:** Introduce per-process plugin-factory idempotency using the approved singleton contract, but only after Unit 1 passes.

**Requirements:** R4, R5

**Dependencies:** Unit 1 must pass.

**Files:**
- Create: `src/lib/plugin-singleton.ts`
- Modify: `src/index.ts`

**Approach:**
- Extract the current body of `SystematicPlugin` into a small internal initializer so the default export can be a thin wrapper around `plugInOnce(...)`.
- Implement `plugInOnce(...)` with the exact behavior requested:
  - `Symbol.for('systematic.singleton.v1')`
  - cache `Promise<T>` rather than resolved hooks
  - compare `process.pid`
  - flip `warned` before invoking `onDuplicate`
  - swallow synchronous `onDuplicate` exceptions
  - export `_resetPluginSingleton()` for tests only
- Wire `src/index.ts` so duplicate factory calls in the same process reuse the same in-flight hooks promise and emit one duplicate warning through both `console.warn(...)` and best-effort `client.app.log(...)`.
- Keep the diff minimal: no unrelated restructuring of config loading, bootstrap logic, tool registration, or hook shape.
- Re-run the same duplicate-source setup used in Unit 1 after the singleton lands and verify the actual host-visible outcome that motivated the change: duplicate `systematic_skill` entries disappear from tool listings.
- If Unit 1 surfaced unsafe caller variance, do not land this unit. Stop and return the probe findings instead.

**Patterns to follow:**
- `opencode-copilot-delegate/src/runtime/plugin-singleton.ts` for helper contract and test reset surface
- `opencode-copilot-delegate/src/index.ts` for `plugInOnce({ doInit, onDuplicate })` wiring
- `src/index.ts` current bootstrap snapshot comment and hook layout for minimal-diff preservation

**Test scenarios:**
- **Happy path:** first factory invocation runs the initializer and returns the hook set.
- **Happy path:** second invocation in the same PID reuses the cached hooks promise and does not re-run init.
- **Error path:** synchronous duplicate-warning callback failure does not block plugin init.
- **Integration:** the duplicate warning is emitted at most once per process even if the factory is invoked more than twice.

**Verification:**
- The singleton helper exists as a narrow reusable module.
- `src/index.ts` still exports only the default plugin factory.
- Duplicate invocations in the same PID reuse the cached initialization path when Unit 1's gate was satisfied.

- [ ] **Unit 3: Add helper coverage and preserve factory test isolation**

**Goal:** Lock the singleton contract in tests and prevent order-dependent failures caused by shared global state.

**Requirements:** R6, R7

**Dependencies:** Unit 2.

**Execution note:** Test-first. The helper tests should go red before the helper is finalized, and the factory-facing tests should fail until singleton reset hooks are in place.

**Files:**
- Create: `tests/unit/plugin-singleton.test.ts`
- Modify: `tests/unit/plugin.test.ts`
- Modify: `tests/unit/config-handler.test.ts` only if the implementation or search shows a direct plugin-factory dependency there
- Modify: `tests/unit/skill-tool.test.ts` only if the implementation or search shows a direct plugin-factory dependency there

**Approach:**
- Add the requested 8 tests for `plugInOnce(...)`, all using `_resetPluginSingleton()` in `beforeEach`.
- Update `tests/unit/plugin.test.ts` so every case that imports or calls the plugin factory runs with a clean singleton state.
- Add one factory-level regression test that exercises duplicate factory calls in a single process and proves the expected reuse / warning behavior without leaking state across tests.
- Keep the test search honest: search `tests/` for direct factory invocations or dynamic imports of `src/index.ts` and add reset hooks only where needed.

**Patterns to follow:**
- `tests/unit/plugin.test.ts` existing temp-dir + dynamic-import structure
- `tests/unit/config-handler.test.ts` and `tests/unit/skill-tool.test.ts` for `beforeEach` / `afterEach` isolation style

**Test scenarios:**
- **Happy path:** first invocation runs `doInit()` and returns the result.
- **Happy path:** second invocation in the same PID returns the same hooks reference by identity.
- **Edge case:** a different PID triggers a fresh init.
- **Edge case:** `onDuplicate` fires exactly once across multiple duplicates.
- **Edge case:** `onDuplicate` does not fire on the first invocation.
- **Concurrency:** `Promise.all([plugInOnce(...), plugInOnce(...)])` converges on the same resolved reference.
- **Error path:** `onDuplicate` exceptions are swallowed.
- **Error path:** after an `onDuplicate` throw, later duplicates remain silent because `warned` was already flipped.
- **Integration:** plugin tests remain isolated across cases even when the singleton helper uses `globalThis` state.

**Verification:**
- All eight singleton helper tests pass.
- Factory-facing tests no longer depend on file execution order.
- No test calls `_resetPluginSingleton()` from production code paths.

- [ ] **Unit 4: Full verification and local handoff**

**Goal:** Finish the change with full local verification and stop before any remote actions.

**Requirements:** R8, R9

**Dependencies:** Units 2 and 3.

**Files:**
- Modify: `package.json` only if the implementation uncovers a missing test or build script needed to verify the new helper

**Approach:**
- Run all required quality gates after the final code and test changes are in place.
- Summarize the release-classification judgment call in the handoff instead of editing release machinery during this local-only pass. Since the repo uses semantic-release and the work stops before push or PR creation, release classification stays with the eventual shipping commit or PR flow.
- Stop after the local branch is ready and the local commit exists; do not push or open a PR.

**Patterns to follow:**
- `package.json` verification scripts

**Test scenarios:**
- **Happy path:** full unit test suite passes with the new helper in place.
- **Happy path:** build, typecheck, and lint all pass after the singleton wiring lands.
- **Integration:** the built plugin still exports a default-only entry point and loads cleanly.
- **Integration:** host-visible duplicate registration is no longer reproduced under the same duplicate-config setup that triggered Unit 1.

**Verification:**
- `bun test` is green, including the new singleton coverage.
- `bun run typecheck`, `bun run lint`, and `bun run build` are green.
- The implementation summary clearly states diff stats, test count delta, and any judgment calls.
- Work stops before push and PR creation.

## System-Wide Impact

- **Interaction graph:** the change sits at the plugin entry boundary in `src/index.ts`, but its effects reach config registration (`src/lib/config-handler.ts`), tool registration (`src/lib/skill-tool.ts`), and bootstrap injection (`src/lib/bootstrap.ts`).
- **Error propagation:** singleton helper failures must surface as normal plugin init failures; duplicate-warning callback failures must never block plugin init.
- **State lifecycle risks:** this change introduces deliberate process-global state via `globalThis`; the implementation must bound that state to the singleton helper and cleanly reset it in tests.
- **API surface parity:** the exported plugin surface must remain `default` only. No new public plugin exports should appear.
- **Integration coverage:** unit tests alone are insufficient because the underlying bug depends on host loading behavior. The plan therefore requires both a real-loader probe and post-change host verification.
- **Unchanged invariants:** single-config behavior, bootstrap snapshot stability, and the existing hook names and config-tool contracts should remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Probe output does not match the expected duplicate-factory pattern | Treat as a stop condition and report findings instead of forcing the singleton |
| Duplicate invocations capture materially different caller-scoped inputs | Treat as an architecture fork; do not ship a whole-hooks singleton without a follow-up design pass |
| `globalThis` singleton state leaks across tests | Add `_resetPluginSingleton()` and call it in `beforeEach` for helper and factory-facing tests |
| Requested minor-release intent does not map cleanly onto this local-only pass | Document the judgment call in the handoff and leave release classification to the eventual shipping commit or PR flow |
| Temporary probe logging accidentally ships | Remove the probe before implementation commit and verify the final diff contains only the helper, wiring, and tests |

## Documentation / Operational Notes

- The user-level OpenCode config switch to the local built plugin path is a temporary local probe step, not a committed repo change.
- The implementation handoff should explicitly surface whether the Phase 0 probe passed cleanly or required a stop-and-report outcome.
- Execution should end with a local feature branch and local commit only. No push or PR creation happens in the initial implementation pass.

## Sources & References

- Related code: `src/index.ts`
- Related code: `src/lib/config.ts`
- Related code: `src/lib/config-handler.ts`
- Related code: `src/lib/skill-tool.ts`
- Related code: `src/lib/bootstrap.ts`
- Related tests: `tests/unit/plugin.test.ts`
- Related tests: `tests/unit/config-handler.test.ts`
- Related tests: `tests/unit/skill-tool.test.ts`
- Manual probe precedent: `tests/manual/session-compacting-probe.ts`
- Manual probe precedent: `tests/manual/companion-aware-probe.ts`
- External precedent: `opencode-copilot-delegate/src/runtime/plugin-singleton.ts`
- External precedent: `opencode-copilot-delegate/src/index.ts`
