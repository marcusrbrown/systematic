---
title: "fix: Keep loaded systematic_skill output visible after OpenCode prunes it"
type: fix
status: completed
date: 2026-10-20
---

# fix: Keep loaded systematic_skill output visible after OpenCode prunes it

## Overview

OpenCode's opt-in `compaction.prune` setting replaces older completed tool results with `[Old tool result content cleared]`. The native `skill` tool is the only exemption. Systematic's `systematic_skill` results are therefore eligible, and a skill loaded early in a long session can silently lose its body. This plan adds an `experimental.chat.messages.transform` hook to the OpenCode entry, `src/index.ts`. On the request being assembled, the hook clears the compacted flag of completed `systematic_skill` parts, so the model receives the stored body again. Storage is never written. Pi's entry, `src/pi.ts`, is separate and has no prune, and Claude Code uses its native Skill tool, so both are unaffected.

## Problem Frame

Issue #1028. In OpenCode v1.19.3:
- `PRUNE_PROTECTED_TOOLS = ["skill"]` (`packages/opencode/src/session/compaction.ts:31`). No hook or config lets a plugin tool opt in.
- Prune sets only `part.state.time.compacted` and persists the part with `updatePart`. `state.output` is kept, and it is usually the full skill body because the truncation restore runs first.
- `MessageV2.toModelMessagesEffect` emits the placeholder whenever `time.compacted` is set (`session/message-v2.ts:303`).
- The prompt loop rebuilds `msgs` from storage on every iteration (`session/prompt.ts:1092`). It calls `experimental.chat.messages.transform` (`:1255`) just before `toModelMessagesEffect(msgs, model)` (`:1262`), and nothing writes `msgs` back.

So a request-only edit to the flag restores the body the model sees and leaves storage alone. This gives `systematic_skill` the same visibility the native `skill` tool already has.

## Requirements Trace

- R1. In a session with `compaction.prune` enabled, the next request after a `systematic_skill` result is pruned carries that result's stored body, not the placeholder.
- R2. The plugin never persists the change. The stored part stays compacted.
- R3. Other tools' pruned results keep the placeholder.
- R4. The hook never throws to the host. Each per-part edit is valid on its own, so a failure partway through leaves the request no worse than the placeholder.
- R5. Duplicate plugin registration gives the same result as a single registration.
- R6. Docs state the guarantee exactly: the body survives prune and the retained tail, not full-session summarization.

## Scope Boundaries

- Only completed `systematic_skill` parts. Other tools, and the native `skill` tool, which prune already exempts, are left alone.
- Full-session summarization is out of scope. Skills before the retained tail are lost the same way native `skill` results are.
- The full-session summarizer receives a 2 KB slice of a restored body instead of the placeholder, because OpenCode runs the same transform on a clone before summarizing and truncates each part. This is an accepted side effect. It is documented and not tested.
- No bound on how many restored bodies a request carries. Auto-compaction (`isOverflow`) already limits the cost.
- No opt-out setting. A user who doesn't want this leaves `compaction.prune` off.
- No upstream issue, because upstream has moved off OpenCode v1.
- Prune still counts our skill bodies toward its 40k `PRUNE_PROTECT` window, where native `skill` is skipped before the estimate. A plugin can't change that, so it is documented and not fixed.

## Context & Research

### Relevant Code and Patterns

- `src/index.ts`: `REGISTERED_PLUGIN_HOOKS`, the hooks object, and the best-effort try/catch around `tool.execute.after` (`restoreSkillOutput`).
- `src/lib/skill-tool.ts`: `restoreSkillOutput` matches the literal `'systematic_skill'`. `isRecord`-style narrowing of host `output`. The truncation store (`createSkillOutputStore`) is a separate stage and is unchanged.
- `tests/integration/skill-delivery.test.ts`: the real-host harness with a mock provider, `buildProviderConfig`, `CE_REVIEW_FINAL_LINE`, `toolResultContent`, and scenarios a–e.
- `tests/unit/plugin.test.ts`: the exact registered-hook key list and the plugin-surface helpers (`loadSurface`/`expectDefined`, `loadHooks`).
- `tests/unit/skill-tool.test.ts`: the `describe('restoreSkillOutput')` pattern for builder-based unit tests.
- `scripts/content-integrity.ts` `HOOK_PARITY_DOCUMENTS` (`ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`, `.github/copilot-instructions.md`) keeps the documented hook lists in step with the registered hooks. It checks lists, not prose.

### Institutional Learnings

- `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`. Truncation and prune are separate stages. Verify at the model boundary against the pinned host. Its line about #1028 goes stale with this change.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`. Hooks run in FIFO order, and a plugin may be registered twice. Transforms must be idempotent.
- `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`. Host-dependent behavior is proven in the pinned-host Host Contract suite.
- `docs/solutions/workflow-issues/a-capability-that-works-has-not-named-its-cause-2026-08-24.md`. Isolate the mechanism with a negative control.
- `docs/solutions/workflow-issues/stop-patching-after-second-review-round-2026-10-15.md`. Add no speculative mechanism.

### External References

- OpenCode v1.19.3: `packages/plugin/src/index.ts`, where `experimental.chat.messages.transform(input: {}, output: { messages: { info, parts }[] })` mutates in place. Also `session/prompt.ts:1092,1255,1262`, `session/message-v2.ts:303,545-583`, and `session/compaction.ts:31,76-78,268-330,378-379`.
- `@cortexkit/opencode-magic-context` uses the same hook to manage the whole context and tells users to turn native prune off. `oh-my-opencode-slim` uses it for reminders and skill filtering. Neither un-prunes one specific tool.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "repository root: src/, tests/, docs/, ARCHITECTURE.md",
  "freshness": { "vcs_reference": "9c65c719" },
  "budget": { "max_search_passes": 12, "max_candidate_inspections": 20, "exhausted": false },
  "candidates": [
    {
      "path_or_symbol": "src/lib/skill-tool.ts:restoreSkillOutput",
      "description": "Restores the full systematic_skill body after host truncation in tool.execute.after, so the persisted state.output is usually the full body.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/skill-resolver.ts:resolveSkill/buildSkillContentOutput",
      "description": "Renders a skill body from a name and arguments; could rebuild a pruned result from state.input.",
      "disposition": "insufficient",
      "insufficiency_reason": "Prune keeps state.output, so the stored body is available; rebuilding would risk a body that differs from what the model first saw."
    },
    {
      "path_or_symbol": "src/lib/config-handler.ts:registerSkillsPaths",
      "description": "Adds the bundled skills directory to config.skills.paths for OpenCode native skill discovery.",
      "disposition": "insufficient",
      "insufficiency_reason": "The bootstrap and tool text direct the model to systematic_skill; moving loads to the native tool would re-architect skill delivery."
    }
  ]
}
```

## Key Technical Decisions

- **Request-only un-compact in the messages transform.** The hook runs after `msgs` is rebuilt from storage and before conversion, and nothing writes `msgs` back. Prune reads its own storage copy. The edit therefore reaches only the model request, and prune keeps working as before.
- **One mutation rule.** Assign a fresh `state.time` object without `compacted` onto the existing part's `state`, and change nothing else. Each part's edit is valid on its own. Storage is unaffected because `msgs` is rebuilt from storage on every loop iteration.
- **Exact tool-name match through one shared constant.** The part's `tool` is the registry key `systematic_skill`. One constant is shared with `restoreSkillOutput` so the two can't drift. No alias or prefix matching.
- **Best-effort with `unknown` input.** OpenCode calls the transform with a bare `yield*`, so a throw would fail the turn. The whole hook is wrapped in try/catch, and the callback parameters are `unknown`, narrowed before use.
- **OpenCode only, older hosts unchanged.** The hook is registered only in `src/index.ts`. A host that predates the hook never calls it, so behavior there is unchanged.
- **Restore whatever is stored.** If the truncation store missed, `state.output` holds the host preview plus its marker. Restoring that still beats the placeholder, so no special case.

## Open Questions

### Resolved During Planning

- *Can the transform persist edits?* No. `msgs` is rebuilt from storage each iteration and only `toModelMessagesEffect` reads it afterwards. Prune's `updatePart` acts on its own copy.
- *Does prune's walk change?* Not in a harmful way. A compacted `systematic_skill` part ends the walk with `break loop` like any other compacted part. Every older part was marked in the same pass.
- *Should the restored bodies be bounded?* No. The cost is self-limiting through auto-compaction, and the same skill loaded with different arguments produces a different body.
- *Where does the real-host proof live?* In scenario f of the existing `skill-delivery` suite, so the host-contract file list stays unchanged.
- *When does prune reach a part?* Walking newest to oldest, prune skips everything after the second-newest user message, and it runs once per prompt, forked, after the loop. At the end of prompt k, only parts from prompt k-2 and older are eligible.

### Deferred to Implementation

- *Exact filler sizes that trigger prune, and the `read` tool's argument key.* OpenCode's `Token.estimate` was not read, and the argument key is unverified against the scripted-tool shape. Both are calibrated once against the real host (target: above 20k pruned and 40k protected).
- *Whether the transform input carries extra keys at runtime.* Narrow defensively whatever is present.

## Implementation Units

- [x] **Unit 1: Request-only un-compact transform and its registration surfaces**

**Goal:** Register `experimental.chat.messages.transform`, clear the compacted flag on completed `systematic_skill` parts in the request, and keep every registration surface in step so each commit stays green.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `src/index.ts`
- Modify: `src/lib/skill-tool.ts`
- Modify: `ARCHITECTURE.md` (hook list)
- Modify: `.github/copilot-instructions.md` (hook list)
- Modify: `STRUCTURE.md` (prose hook mentions, edited by hand because the gate does not check prose)
- Test: `tests/unit/skill-tool.test.ts`
- Test: `tests/unit/plugin.test.ts` (the exact registered-key list)

**Approach:**
- Add a function next to `restoreSkillOutput` that walks `output.messages`. For each part where `type === 'tool'`, the tool is `systematic_skill`, the status is `completed` and `state.time.compacted` is set, it assigns a fresh `state.time` object without `compacted` onto the existing `state`. It changes nothing else.
- Export one constant for the tool name and use it in both functions.
- Register the hook in `src/index.ts` inside try/catch, with `unknown` callback parameters, and add it to `REGISTERED_PLUGIN_HOOKS`.
- Add the hook to the documented hook lists that `HOOK_PARITY_DOCUMENTS` checks, and to the `STRUCTURE.md` prose. `AGENTS.md` needs no edit.

**Execution note:** Write the unit tests test-first. Reuse the `describe('restoreSkillOutput')` pattern in `skill-tool.test.ts`, with one new part-builder helper. Reuse `loadSurface`/`expectDefined` or `loadHooks` in `plugin.test.ts`.

**Patterns to follow:**
- `restoreSkillOutput` and its after-hook wiring in `src/index.ts`.

**Test scenarios:**
- Happy path: a compacted, completed `systematic_skill` part has `compacted` removed. `state.output` and the other `time` fields are unchanged.
- Happy path: a compacted, completed `read` part in the same array keeps `compacted`.
- Edge case: `systematic_skill` parts in `pending`, `running` and `error` status are untouched.
- Edge case: a completed `systematic_skill` part without `compacted` is untouched, and the reference identity of its `state.time` is preserved. This is the only reference-identity assertion, and it applies to untouched parts only.
- Edge case: applying the function twice gives the same result as once.
- Edge case: `output.messages` is not replaced; the same array reference remains.
- Error path: missing `messages`, non-array `parts`, non-object parts, and a part whose `state.time` is not an object all leave the input unchanged without throwing.
- Error path: a throwing getter on `output.messages` makes the registered hook resolve without rejecting.
- Integration: the exact registered-key list in `plugin.test.ts` includes `experimental.chat.messages.transform`. Invoking the registered hook through the plugin surface clears the flag.
- Integration: two plugin instances with both registered transforms run in sequence give the same result as one instance.

**Verification:**
- Unit suites pass, and `bun scripts/content-integrity.ts` passes with the updated hook lists.
- Mutation check: matching any tool name fails the `read` test, and assigning onto the original `time` in place fails the reference-identity test.

- [x] **Unit 2: Real-host prune scenario**

**Goal:** Prove R1–R3 against the pinned OpenCode host.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/integration/skill-delivery.test.ts`
- Create: a large text fixture for `read` fillers (under the suite's existing fixture location)
- Modify: `tests/integration/host-contract-timings.json` (refresh the timings for this file)

**Approach:**
- Add a `compaction` option to `buildProviderConfig` that sets `compaction: { prune: true }`.
- The turn schedule follows how prune reaches parts: it skips everything newer than the second-newest user message and runs once per prompt, forked. At the end of prompt k, only parts from prompt k-2 and older are eligible.
- Scenario f:
  - Prompt 1: a `read` filler A (older, the negative control), then `systematic_skill` ce:review, then newer `read` fillers totalling more than 40k estimated tokens. The newer fillers sit inside the protect window, and the skill plus A make more than 20k prunable.
  - Prompts 2 and 3: short text turns.
  - After prompt 3, poll storage by the skill's `callID` until `time.compacted` is set, and check that A is compacted too.
  - Prompt 4 carries the assertions.
- `toolResultContent` returns the first captured request that carries the `tool_call_id`, which is the pre-prune copy. Scope the lookup to the requests captured during prompt 4, by slicing from the request count recorded before prompt 4.
- The read argument key and the filler sizes are calibrated during implementation.
- The isolated test host sets `OPENCODE_DISABLE_PRUNE=1`, which forces prune off after the config merge, so the scenario clears it for its own host.
- Before pruning, assert that the stored skill output contains `CE_REVIEW_FINAL_LINE`, which shows the truncation store hit.

**Test scenarios:**
- Integration: prompt 4's request carries the skill result with `CE_REVIEW_FINAL_LINE` and without `[Old tool result content cleared]`.
- Integration (negative control): in the same request, filler A carries the placeholder, which shows that prune was active.
- Integration: after prompt 4, storage still marks the skill part `compacted`.

**Verification:**
- Scenario f passes on the real host. Removing the hook registration makes the skill assertion fail while filler A still shows the placeholder. The host-contract guard still passes with the pass floor unchanged.

- [x] **Unit 3: Prose docs**

**Goal:** Make the prose docs state the guarantee and its limits exactly.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `docs/src/content/docs/guides/architecture.mdx` (not covered by the gate, and already stale: its diagram omits `tool.execute.after`, and line 18 says "three primary")
- Modify: `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md`

**Approach:**
- In `architecture.mdx`, fix the diagram and the hook count by hand, and rewrite the prune caveat. It should say the body survives prune and the retained tail but not full-session summarization, that prune still counts the body toward its protect window, and that the summarizer sees a 2 KB slice. State that the hook is OpenCode-only and that a host that predates it never calls it, so behavior there is unchanged.
- Add a short prune section to the truncation solution doc and update its #1028 line.
- Leave historical plans unchanged.

**Test expectation:** none. This unit is prose only.

**Verification:**
- markdownlint and `bun scripts/content-integrity.ts` pass on the changed files. Run `bun run docs:build` once at the end, then check `git status` for generator churn.

## System-Wide Impact

- **Interaction graph:** a new hook runs on every main-loop request and on the compaction summarizer's clone. It runs alongside other plugins' messages transforms in FIFO order and touches only one flag on our own parts.
- **Error propagation:** the hook swallows its own errors, because a throw would fail the user's turn.
- **State lifecycle:** no stored state changes. Prune still marks and counts our parts.
- **API surface parity:** OpenCode only. Pi's entry is `src/pi.ts`. It registers `systematic_skill` but has no prune. Claude Code uses its native Skill tool.
- **Unchanged invariants:** the truncation restore, the bootstrap system transform, the stored session history, and the native `skill` tool's behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A future OpenCode version persists the transform output or reuses `msgs` after conversion | Scenario f asserts storage still marks the part compacted. A host bump that breaks this fails Host Contract. |
| Restored skill bodies raise per-request tokens in long sessions | The cost matches native `skill`. Auto-compaction bounds it. Documented. |
| Prune fillers are too small to trigger prune on the real host | Calibrate once while implementing. The scenario polls for the compacted flag and does not sleep. |

## Sources & References

- Related issue: #1028
- Related code: `src/lib/skill-tool.ts`, `src/index.ts`, `tests/integration/skill-delivery.test.ts`
- External: OpenCode v1.19.3 `packages/opencode/src/session/{prompt,message-v2,compaction}.ts`, `packages/plugin/src/index.ts`
