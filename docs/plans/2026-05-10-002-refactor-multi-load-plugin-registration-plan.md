---
title: 'refactor: Multi-load plugin registration with marker-based bootstrap idempotency'
type: refactor
status: completed
date: 2026-05-10
origin: docs/brainstorms/2026-05-10-multi-load-plugin-registration-requirements.md
---

# Multi-Load Plugin Registration

## Overview

Revert PR #335's `plugInOnce` singleton in favor of independent per-load plugin registration. Each invocation of `SystematicPlugin` runs `initializePlugin(input)` independently and returns its own hooks surface. Bootstrap injection becomes idempotent at the system-prompt level via the existing `<SYSTEMATIC_WORKFLOWS>` marker: each `experimental.chat.system.transform` invocation scans `output.system` for any prior block and replaces it in-place, so the last transform to run owns the final content. Under OpenCode's verified-FIFO hook iteration, this means the most-recently-registered plugin wins — which matches Marcus's dev workflow (project config loads after user config).

## Problem Frame

`plugInOnce` was added in PR #335 to suppress duplicate `systematic_skill` tool entries when the plugin was loaded by both user config and project config. But OpenCode registers tools per-source regardless of whether the hooks reference is shared, so the singleton's deduplication of the init work has no visible effect on the TUI tool catalog. What the singleton actually does in Marcus's dev setup is collapse the two distinct plugin loads onto whichever ran first — typically the npm-installed user-config version — silently shadowing the live `./src/index.ts` he is editing.

The real failure mode is downstream of registration: when N plugin sources each register an `experimental.chat.system.transform` hook, each call appends the same bootstrap content to `output.system[last]`, so the `<SYSTEMATIC_WORKFLOWS>` block stacks N× in every chat turn. The fix is marker-based replacement at injection time, not init-time deduplication.

(see origin: `docs/brainstorms/2026-05-10-multi-load-plugin-registration-requirements.md`)

## Requirements Trace

- R1 → Unit 2 (factory contract change in `src/index.ts`)
- R2 → Unit 2 (per-invocation hook surface)
- R3 → Unit 2 (per-invocation init work)
- R4 → Unit 1 (marker-replacement logic in `applyBootstrapContent`)
- R5 → Unit 1 (FIFO-dependent last-to-run wins)
- R6 → Unit 1 (per-turn scoping, no module-level state)
- R7 → Unit 2 (`hasLoggedInit` becomes per-init closure state)
- R8 → Unit 3 (delete singleton file, test file, and consumer imports)
- R9 → Unit 4 (memory + AGENTS.md updates)
- R10 → All units (external contract unchanged; existing tests stay green)

## Scope Boundaries

- No process-level resource coordination, version negotiation, or per-source metadata. Each load is independent.
- No backwards-compat shim for `plugInOnce`. The function and its consumers are deleted in the same PR.
- No new telemetry on multi-source registrations. Per-init log lines (R7) are the only signal.
- No support for nested `<SYSTEMATIC_WORKFLOWS>` blocks. The marker is uniquely owned by this plugin's output (verified during brainstorm).

## Context & Research

### Relevant Code and Patterns

- `src/index.ts` — `SystematicPlugin` default export wrapping `initializePlugin` via `plugInOnce`. `applyBootstrapContent` helper (lines ~22–32). Module-level `hasLoggedInit` flag.
- `src/lib/plugin-singleton.ts` — `plugInOnce` + `_resetPluginSingleton`. ~100 LOC.
- `src/lib/bootstrap.ts` — `getBootstrapContent` returns content wrapped in literal `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>` tags (lines 71, 79 in current main).
- `tests/unit/plugin-singleton.test.ts` — 5 test cases targeting `plugInOnce` behavior. Deleted in Unit 3.
- `tests/unit/plugin.test.ts` and `tests/integration/opencode.test.ts` — both import `_resetPluginSingleton` for `beforeEach` cleanup. Imports + reset calls removed in Unit 3.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` (PR #335 origin) — documented the duplicate-tool-entry symptom that motivated `plugInOnce`. The fix-via-singleton turned out to be over-correction; OpenCode registers tools per-source even with a shared hooks reference. After this plan ships, the learning needs a follow-up note that the singleton was removed and the real correctness contract is now marker-based bootstrap idempotency.
- `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md` — root-cause elimination over symptom workarounds. The `plugInOnce` abstraction is exactly the kind of working-around-the-symptom that the rule targets. Deleting it satisfies the principle.

### External References

External research was skipped; local code and the brainstorm's OpenCode verification were enough.

## Key Technical Decisions

- **Marker-replacement scans the whole `output.system` array, not just `[last]`.** Cheaper than detecting upstream insertion-order changes and harmless if no other slot ever holds the marker. Resolves brainstorm Q1.
- **Non-greedy regex match: `/<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/`.** Survives content with literal `<` characters and handles multi-line block content. Resolves brainstorm Q2.
- **Detect-and-REPLACE, not detect-and-skip.** Gives last-to-run wins (= most-recently-registered wins under FIFO), which matches Marcus's project-after-user load order.
- **Per-init log lines.** `hasLoggedInit` moves into the `initializePlugin` closure. With two sources the process emits two init logs — honest signal that init ran twice.
- **Delete `plugin-singleton.ts`, don't repurpose it.** Per Marcus's root-cause-over-workaround preference and the brainstorm's Key Decision.

## Open Questions

### Resolved During Planning

- Q1 (replacement scope: `[last]` vs whole array): **Whole array.** Walk every slot, replace any match. Cheap and survives insertion-order changes.
- Q2 (closing-tag detection: literal vs regex vs split): **Non-greedy regex** `/<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/`.

### Additional Planning Checks

- Q3 (hidden init coupling): **None.** Feasibility-reviewer verified `loadConfig`, `createConfigHandler`, `createSkillTool` are stateless.
- Q4 (external consumers of `plugin-singleton`): **Zero.** Only intra-repo test imports.

### Deferred to Implementation

- The exact `applyBootstrapContent` signature when the helper grows. Likely takes the same `output` and `content` params; whether it returns the mutated array or mutates in-place is an implementation taste call, both work.

## Implementation Units

- [x] **Unit 1: Marker-based bootstrap idempotency**

**Goal:** Make `applyBootstrapContent` idempotent so multiple plugin registrations leave exactly one `<SYSTEMATIC_WORKFLOWS>` block in the final system prompt.

**Requirements:** R4, R5, R6

**Dependencies:** None — landable independently. (Units 2 + 3 depend on this not regressing.)

**Files:**
- Modify: `src/index.ts` (the `applyBootstrapContent` helper, ~lines 22–32 on current main)
- Test: `tests/unit/plugin.test.ts` (new describe block for marker-replacement behavior)

**Approach:**
- Walk every entry in `output.system`. For each entry, run the non-greedy regex `/<SYSTEMATIC_WORKFLOWS>[\s\S]*?<\/SYSTEMATIC_WORKFLOWS>/`.
- If exactly one entry matches, replace the matched block in that entry with the new content. (Do not append; the replacement IS the apply.)
- If zero entries match, append the new content using the current behavior (concat to `system[last]` if non-empty, push if empty).
- Stop after the first replacement; no separate multi-match warning branch.
- The function still mutates `output.system` in-place; no return value change needed.

**Execution note:** Test-first. The whole point of the change is observable in test scenarios on the helper; write the marker-replacement test before touching the helper body.

**Patterns to follow:**
- The existing `applyBootstrapContent` signature `(output: { system: string[] }, content: string): void`.
- Bootstrap content wrapping in `src/lib/bootstrap.ts:71-79` uses literal `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>` tags.

**Test scenarios:**
- Happy path: `output.system = []`, apply content with marker, asserts one entry pushed.
- Happy path: `output.system = ["existing system prompt"]`, apply content with marker, asserts the marker block is appended to `[0]` (no prior block to replace).
- Happy path (the core regression-prevention case): `output.system = ["existing prompt with <SYSTEMATIC_WORKFLOWS>OLD CONTENT</SYSTEMATIC_WORKFLOWS> embedded"]`, apply content with NEW block, asserts the array length is still 1 AND the resulting string contains exactly one `<SYSTEMATIC_WORKFLOWS>` opening tag AND contains `NEW CONTENT` AND does NOT contain `OLD CONTENT`.
- Happy path: same as above but the marker block lives in `output.system[2]` not `[last]` — asserts the walker finds and replaces a non-last slot.
- Edge case: content has multi-line bodies. Asserts the non-greedy regex stops at the FIRST closing tag, not the last.
- Integration: simulate two transform invocations in sequence on the same `output.system` array (mocking what OpenCode does for two registrations). After both, assert exactly one marker block remains and its content is from the second call.

**Verification:**
- All 5 new test scenarios pass.
- Existing bootstrap-injection tests in `tests/unit/plugin.test.ts` still pass (the helper's single-load behavior is unchanged).

- [x] **Unit 2: Remove `plugInOnce` from the factory; per-invocation init**

**Goal:** `SystematicPlugin` runs `initializePlugin(input)` on every invocation. Each call returns its own hooks surface. `hasLoggedInit` moves into the per-init closure.

**Requirements:** R1, R2, R3, R7

**Dependencies:** Unit 1 (the marker-replacement must already be in place so two registrations don't ship duplicate bootstrap content in production).

**Files:**
- Modify: `src/index.ts` — remove `plugInOnce` import, replace the `SystematicPlugin` body to call `initializePlugin(input)` directly, move `let hasLoggedInit = false` from module scope into `initializePlugin`'s closure.

**Approach:**
- Drop the `import { plugInOnce } from './lib/plugin-singleton.js'` line.
- Replace `SystematicPlugin` body with `return initializePlugin(input)` (or equivalent — `const hooks = await initializePlugin(input); return hooks`).
- Inside `initializePlugin`, declare `let hasLoggedInit = false` as the first statement of the function body so each invocation gets its own.
- All other code paths in `initializePlugin` (config-handler factory, skill tool factory, transform hook closure, log gate read/write) keep working unchanged — they already read `hasLoggedInit` from lexical scope, which now resolves to the per-init closure copy.

**Execution note:** Standard. The change is small and the existing tests in `tests/unit/plugin.test.ts` will catch most regressions.

**Patterns to follow:**
- The current `initializePlugin` body structure (no change needed beyond the one new local `let` declaration).

**Test scenarios:**
- Happy path: call `SystematicPlugin(input)` twice in the same process. Assert each call returns a distinct hooks reference (`result1 !== result2`).
- Happy path: each returned hooks object has its own `tool.systematic_skill`, its own `config`, its own `experimental.chat.system.transform` — assert all three are distinct function references between the two calls.
- Integration: call `SystematicPlugin(input)` twice, invoke each call's transform hook on the SAME `output.system` array in sequence. Assert that after both invocations, exactly one `<SYSTEMATIC_WORKFLOWS>` block is present (Unit 1's marker-replacement working end-to-end across independent registrations).
- Integration: call `SystematicPlugin(input)` twice. Each call's `init` should fire its own log via the mocked client — assert `client.app.log` was called twice with `message: 'Systematic plugin initialized'`.
- Edge case: call `SystematicPlugin(input)` and then invoke its transform hook twice on different `output.system` arrays (simulating two chat turns). Assert each turn produces exactly one marker block — i.e., `hasLoggedInit` does NOT gate the marker-replacement; the log gates the log, the marker logic gates the marker.

**Verification:**
- All 5 new test scenarios pass.
- All existing tests in `tests/unit/plugin.test.ts` that don't reference `_resetPluginSingleton` continue to pass.

- [x] **Unit 3: Delete the singleton file, test file, and consumer imports**

**Goal:** Remove `src/lib/plugin-singleton.ts`, `tests/unit/plugin-singleton.test.ts`, and the `_resetPluginSingleton` imports + `beforeEach`/`afterEach` calls in the two consumer test files.

**Requirements:** R8

**Dependencies:** Units 1 + 2. The file deletion must happen AFTER the consumers stop importing from it, otherwise tests fail mid-PR.

**Files:**
- Delete: `src/lib/plugin-singleton.ts`
- Delete: `tests/unit/plugin-singleton.test.ts`
- Modify: `tests/unit/plugin.test.ts` (remove `_resetPluginSingleton` import + the `beforeEach(() => _resetPluginSingleton())` call at line 15)
- Modify: `tests/integration/opencode.test.ts` (remove `_resetPluginSingleton` import + the two reset calls at lines 112 and 129)

**Approach:**
- Remove the imports first, then the reset calls. The reset calls become no-ops once the singleton is gone, but removing them keeps the test code clean and avoids leaving dead references for future readers.
- Verify the two consumer test files still have working setup/teardown for whatever they were resetting around (probably nothing else — the singleton reset was the only `beforeEach` content in `plugin.test.ts:15`).
- Delete the singleton file and its test file last. At this point the typecheck must pass — no consumer imports remain.

**Execution note:** Standard. Mechanical deletion guided by Unit 2's tests already covering the per-load behavior the singleton was no longer responsible for.

**Patterns to follow:**
- Direct file deletion via `rm` or the IDE; no AST refactoring needed.

**Test scenarios:**
- Test expectation: none for the file-deletion itself. The behavior the deleted tests covered (cached hooks reference, single init across PIDs) was actively wrong per the brainstorm, so deleting them is the point.
- The Unit 1 + 2 test suites collectively cover the desired multi-load behavior.

**Verification:**
- `bun test tests/unit` passes (current main baseline: 702 tests; re-record the exact count after Units 1 + 2 land).
- `bun test tests/integration` passes (25 tests, no count change).
- `bun tsc --noEmit` passes — no dangling imports.
- `grep -rn 'plugin-singleton\|_resetPluginSingleton\|plugInOnce' src/ tests/` returns zero matches.

- [x] **Unit 4: Update memory, AGENTS.md, and docs/solutions**

**Goal:** Replace the project memory documenting PR #335's "first wins" model with the new "each load registers independently; bootstrap is marker-deduplicated at injection time" model. Update AGENTS.md if it references the singleton. Add a follow-up note to the relevant solution doc.

**Requirements:** R9

**Dependencies:** Units 1–3 complete. Memory updates happen during the implementation, not after, so the memory accurately describes shipped behavior.

**Files:**
- Modify: project memory (via `ctx_memory` tool) — find and update or replace the memory documenting PR #335's singleton model.
- Modify: `src/lib/AGENTS.md` — if it currently references `plugin-singleton.ts` or `plugInOnce`, replace with a description of the marker-based idempotency model.
- Modify: `AGENTS.md` (root) — same check; update if it references the singleton in the Code Map or Where to Look.
- Modify: `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — append a follow-up section noting the singleton was removed and that marker-based idempotency is the current contract.

**Approach:**
- Search project memory for "plugInOnce", "plugin singleton", "first wins", "PR #335" — get the memory ID, then either update or delete-and-rewrite.
- Grep `src/lib/AGENTS.md` and `AGENTS.md` for `plugin-singleton`, `plugInOnce`, `_resetPluginSingleton` — update any matches.
- The solution doc gets a new dated subsection: "### 2026-05-10 follow-up: singleton removed". Brief paragraph explaining what changed and why; link to the brainstorm and this plan.

**Execution note:** Standard. Mechanical content updates.

**Patterns to follow:**
- Memory updates: use `ctx_memory({ action: 'update', id, content })` or delete-and-rewrite via `ctx_memory({ action: 'delete', id })` then `ctx_memory({ action: 'write', category, content })`.
- AGENTS.md format: match the existing entry style (Code Map table or Where to Look bullet).

**Test scenarios:**
- Test expectation: none — pure documentation/memory updates with no behavioral surface.

**Verification:**
- `grep -rn 'plugin-singleton\|plugInOnce\|first wins' AGENTS.md src/lib/AGENTS.md` returns zero matches (or only the new "this was removed" note in the solution doc).
- `ctx_memory({ action: 'list' })` shows the new memory and not the old one.

## System-Wide Impact

- **Interaction graph:** The transform hook fires per registered plugin source per chat turn. The new marker logic is the only coordination point between registrations.
- **Error propagation:** No new error paths. The marker-replacement is a pure string op on `output.system` entries; if the regex fails to match it falls through to the existing append path (current behavior).
- **State lifecycle risks:** `hasLoggedInit` moves from module-level to per-init closure. Module-level state was effectively process-global; the new state is bound to one invocation. No persistence concerns.
- **API surface parity:** External contract unchanged — same default export shape, same hook names, same tool name `systematic_skill`. R10.
- **Integration coverage:** Unit 1's integration test + Unit 2's integration test together prove the end-to-end multi-load case. The mocked `output.system` array shape mirrors what OpenCode passes (verified during brainstorm against `packages/opencode/src/session/llm.ts`).
- **Unchanged invariants:** `loadConfig`, `createConfigHandler`, `createSkillTool`, `getBootstrapContent`, `INTERNAL_AGENT_SIGNATURES` skip heuristic — all untouched. Bootstrap content shape (`<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>`) is preserved exactly because the marker uses the existing tags.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| OpenCode reverses hook iteration order in a future version, flipping "most-recently-registered wins" to "first-registered wins" | Marker-replacement still produces exactly one block; the winning content changes but the system stays correct. Brainstorm Dependencies section documents this dependency on FIFO. |
| OpenCode clones `output.system` per hook invocation (would break marker coordination across registrations) | Feasibility-reviewer verified the same object reference is passed today. If OpenCode changes this in a future release, the marker mechanism degrades to per-source bootstrap stacking — the same bug we're fixing. Add a CI integration test that asserts the cross-hook sharing if OpenCode versions us forward into trouble. (Deferred — not blocking v1.) |
| A non-Systematic plugin or OpenCode subsystem starts emitting the literal `<SYSTEMATIC_WORKFLOWS>` tag | Brainstorm verified no current emitters. If a future change introduces one, the marker would over-match and produce incorrect content. Documented as scope boundary. |

## Documentation / Operational Notes

- PR body should note the multi-source behavior change; no CHANGELOG or migration guide beyond that.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-10-multi-load-plugin-registration-requirements.md`
- Related PR: #335 (the singleton being reverted) — see `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`
- OpenCode source verified during brainstorm: `packages/opencode/src/plugin/index.ts` (FIFO hook iteration), `packages/opencode/src/session/llm.ts` (shared `output` object reference)
- Project memories: `#2065` (the "first wins, hooks reference shared" decision being inverted by R9 of this plan)
