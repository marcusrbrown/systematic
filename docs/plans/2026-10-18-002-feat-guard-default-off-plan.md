---
title: "feat: Turn the workflow guard off by default"
type: feat
status: active
date: 2026-10-18
---

# feat: Turn the workflow guard off by default

## Overview

The OpenCode workflow guard becomes opt-in. The default `workflow_guard.mode` changes from `observe` to `disabled`, and `disabled` becomes genuinely off: the plugin builds no operation observer, takes no init snapshot and makes no host session reads for the guard. The four `systematic_workflow_*` tools stay registered and return inert results. The guard guidance stops shipping in the shared bootstrap and appears only in OpenCode sessions with the guard enabled. Explicit `observe` and `protected` keep today's behaviour. This is a `feat` (minor) release with a behaviour-change note, not a breaking change.

## Problem Frame

The guard is frozen and its removal is tracked in #1153. Today every OpenCode user pays for it by default: in a git repository an explicit `disabled` plugin still makes 17 git calls at init and reads session history from the host on every hook, and `observe` adds two synchronous worktree snapshots per observed tool call during guarded skills. The guard guidance clause also ships to Pi and Claude Code, which have no guard runtime. The guard has no demonstrated catches, so the default should cost nothing.

## Requirements Trace

- R1. With no `workflow_guard` key, or with `{debug: true}` only, the resolved mode is `disabled`. Explicit `observe` and `protected` resolve unchanged.
- R2. A disabled plugin performs zero git invocations and zero guard host reads across init, the four tools, the tool hooks, `event` and the system transform.
- R3. When disabled, the four tools stay registered and every call returns a terminal result. No call stays `pending`.
- R4. The guard guidance appears in the OpenCode bootstrap exactly once when the guard is enabled. It never appears when the guard is disabled, and never in the Pi bootstrap or the Claude Code output style.
- R5. The guidance states what `disabled` means.
- R6. The generated schema and config reference, the hand-written configuration prose, ARCHITECTURE.md, `src/lib/AGENTS.md` and the copilot instructions state the new default and how to restore the old behaviour.
- R7. Tests that assert guard behaviour opt into a mode explicitly. Default-asserting tests are hermetic against the developer's home config.

## Scope Boundaries

- No guard removal and no hardening. The guard stays frozen.
- No change to explicit `observe` or `protected` behaviour.
- No runtime fast-path that skips creating the guard runtime when disabled. Once the observer and host reader are absent, nothing left performs I/O.
- No warning when project config sets `workflow_guard`. Project config was already ignored for this key, so it is documented only.
- With the guard enabled but `bootstrap.enabled: false` or a custom `bootstrap.file`, the guidance stays absent, as today.
- No telemetry.

### Deferred to Separate Tasks

- Remove the guard: #1153.
- Make `createReceiptClassifier`'s `web-tree-sitter` import lazy. The classifier is no longer constructed when disabled, but its module still loads.

## Context & Research

### Relevant Code and Patterns

- Defaults are set twice. `src/lib/config-schema.ts` has the zod defaults at `mode` and on the object, which feed the generated JSON schema and `validateConfig`. `src/lib/config.ts` has `DEFAULT_CONFIG.workflow_guard`, which is the runtime default, because the merge consumes raw JSONC.
- `src/index.ts` `initializePlugin` currently does all of this unconditionally:
  - builds the observer (`createOpencodeOperationObserver` runs `captureRootPin` git I/O at construction);
  - awaits `observer.snapshot()`;
  - builds the host-readback object;
  - passes all of them to `createOpencodeWorkflowGuard`;
  - registers `...workflowGuard.tools` and the hooks.
- `systematic_workflow_control` can only switch to `disabled`. `config.mode` is fixed per instance, so a plugin that starts disabled never needs an observer later.
- When the adapter has no host reader, `initializeSessionSteps` takes `publishFresh()` and makes no host read. The task rollup returns early without `hostReadback`, and `prepareOperation` skips observation when disabled.
- `writeBlockedCompleteResult` in `src/lib/opencode-workflow-guard.ts` writes a terminal result only for `no-active-epoch`. A disabled completion is rejected by the core with `disabled` and stays `pending`.
- `getBootstrapContent` (`src/lib/bootstrap.ts`) appends an optional `profileBlock` inside `<SYSTEMATIC_WORKFLOWS>`. `applyBootstrapContent` already strips and re-appends that block on every request and for every registration.
- The guidance clause is the last paragraph of `## Capability Resolution` in `skills/using-systematic/SKILL.md`. It is the only guard text in `skills/`.
  - Pi reaches it through `computeBootstrapContentSafe` (`src/pi.ts`).
  - Claude Code reads `SKILL.md` directly (`scripts/build-claude-code-plugin.ts`).
  - Neither passes the OpenCode profile block.
- Pattern to reuse: `bootstrap.enabled: false` makes `getBootstrapContent` return null, and the hook skips injection. Disabled features skip their work at construction.

### Institutional Learnings

- Treat the schema as the source of truth: regenerate the committed schema and config reference, then run their drift gates (`docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`).
- Keep the guard's recovery and authorization guidance with the enabled guard, not in shared bootstrap text. Keep the `inactive` and `unavailable` states distinct (`docs/solutions/logic-errors/worktree-snapshot-limits-disable-guard-2026-10-15.md`, `docs/solutions/logic-errors/transient-timeout-disables-workflow-guard-2026-10-15.md`).
- The PR title sets the release type: `feat` is minor (`docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`).
- Quote metrics only from a clean baseline. Home config masks defaults (`docs/solutions/workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md`).

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/index.ts, src/lib/opencode-workflow-guard.ts, src/lib/workflow-guard.ts, src/lib/bootstrap.ts, src/pi.ts, src/lib/config.ts, src/lib/config-schema.ts, tests/unit and tests/integration guard suites",
  "freshness": {
    "vcs_reference": "52ce22bb8cb8a7f6dc592f1dfc96bd8195ee53cc"
  },
  "budget": {
    "max_search_passes": 8,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/bootstrap.ts getBootstrapContent (bootstrap.enabled null path)",
      "description": "A disabled feature returns null and the hook skips injection",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/bootstrap.ts getBootstrapContent profileBlock",
      "description": "Optional harness block appended inside the workflow block, stripped and re-added per request",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/workflow-guard.ts mode projection",
      "description": "Core disabled mode returns a disabled status and rejects activation, evidence and transitions",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts operationObservationApplies and observerReadbackApplies",
      "description": "Per-call gates that skip observation and readback outside an epoch, but not observer construction or host reads",
      "disposition": "insufficient",
      "insufficiency_reason": "They run after observer construction and the init snapshot, and every hook still reads host session history"
    },
    {
      "path_or_symbol": "src/lib/opencode-workflow-guard.ts transform disabled return",
      "description": "Suppresses the marker only after recoverFromHost has read session history",
      "disposition": "insufficient",
      "insufficiency_reason": "The host read happens before the disabled check"
    }
  ]
}
```

## Key Technical Decisions

- **Gate in `src/index.ts`, not in the adapter.** One predicate, `mode !== 'disabled'` (the same test the adapter uses), decides whether the observer, the init snapshot, the host-readback object and the receipt classifier are built. When disabled, those keys are omitted and a fixed placeholder identity replaces the snapshot digests. This is the smallest seam, and a probe showed it reaches zero git calls and zero host reads.
- **Keep the tools registered.** Unregistering them would turn stale calls into "unknown tool" errors. Disabled results are already inert except `complete`, which gets a terminal `rejected/disabled`.
- **Guidance rides the profile block.** It becomes a constant appended to the OpenCode `profileBlock` only when the guard is enabled, so the existing per-request strip and re-append handles dedupe and ordering. The constant lives in `src/lib/opencode-workflow-guard.ts`. It does not live in a skill reference file, which would ship to Claude Code and Pi and change the registry file list, nor in a new `src/lib` module.
- **The clause follows the configured mode, not live state.** A mid-session disable through `systematic_workflow_control` leaves the clause in place. That keeps the cached system prefix stable, and the added sentence tells the agent what `disabled` means.
- **`src/index.ts` keeps a single default export.** Named exports break the OpenCode loader. Any extracted helper stays local and unexported.

## Open Questions

### Resolved During Planning

- Should the guidance appear with a disabled or custom bootstrap? No, as today.
- Should there be an adapter fast-path for disabled hooks? No. It is frozen hardening.
- Should project-config `workflow_guard` warn? No. Document it only.
- Can control enable a disabled guard at runtime? No. It only switches to `disabled`.

### Deferred to Implementation

- Exact bootstrap byte length after the clause moves. Recompute it, don't guess.
- Whether `initializePlugin` stays under Biome's complexity limit, or needs a local helper.

## Implementation Units

- [ ] **Unit 1: Integration tests opt into the guard explicitly**

**Goal:** Every test that asserts guard behaviour sets its mode, so flipping the default cannot silently change what it tests.

**Requirements:** R7

**Dependencies:** None. Runs before the flip, so behaviour is unchanged.

**Files:**
- Modify: `tests/integration/fixtures/receipt-workflow-host.ts` (add a helper that writes `systematic.json` with the mode into the fixture's config directory)
- Modify: `tests/integration/question-attestation-opencode.test.ts`, `tests/integration/receipt-workflow-guard-real-host.test.ts`, `tests/integration/receipt-workflow-recovery.test.ts`, `tests/integration/skill-delivery.test.ts`, `tests/integration/receipt-workflow-dogfood.test.ts`

**Approach:**
- Call the helper only in guard-asserting tests, with `observe`. `question-attestation` must not use `protected`, because protected throws on the first veto.
- Make dogfood write config for both modes, not only `protected`.
- The helper asserts an enabled-guard sentinel, either a marker or a `state` other than `disabled`, so a missed opt-in fails instead of passing vacuously.
- Leave unchanged: `skill-command-probe`, `ce-review-return-validation`, `receipt-privacy`, the eval cases and `plugin.test.ts`. Guard-sensitive plugin tests already pin `protected`.
- Do not add a new integration file. The host-contract guard hard-codes the integration list and a pass floor.

**Test scenarios:**
- Integration: each opted-in suite passes unchanged with the explicit `observe` config.
- Edge case: a fixture run without the helper and with a disabled default fails the sentinel assertion.

**Verification:** The opted-in integration suites pass at the current default, and no assertion changes.

- [ ] **Unit 2: Flip the default and make default tests hermetic**

**Goal:** `disabled` becomes the resolved default in the schema and at runtime.

**Requirements:** R1, R6 (schema), R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config-schema.ts` (both defaults, plus the `.meta` descriptions saying it is off by default and that `observe` or `protected` enables it)
- Modify: `src/lib/config.ts` (`DEFAULT_CONFIG.workflow_guard`)
- Modify: `docs/public/schemas/v3/systematic-config.schema.json` (regenerated)
- Test: `tests/unit/config.test.ts`, `tests/unit/config-schema.test.ts`

**Approach:**
- Default-asserting tests load config with an empty temp home and no custom config dir, because the developer's home config can set any mode.
- The project-config privacy test currently uses `{mode: 'disabled', debug: true}`, which now equals the default. Change its payload to `{mode: 'protected', debug: true}` and assert that the result stays `disabled` / `false`.

**Execution note:** Flip the four default-pinning assertions first and watch them fail.

**Test scenarios:**
- Happy path: an empty config resolves `{mode: 'disabled', debug: false}` in both the zod parse and `loadConfig`.
- Edge case: `{debug: true}` only resolves `mode: 'disabled'`.
- Happy path: a user `observe` or `protected` survives the merge unchanged.
- Error path: project config `{mode: 'protected', debug: true}` is stripped, and the resolved mode is the default `disabled`.
- Error path: an invalid mode still fails validation.

**Verification:** Config suites pass. `schema:drift` is clean after regeneration.

- [ ] **Unit 3: Disabled means off in the plugin**

**Goal:** A disabled plugin builds no observer, takes no snapshot, makes no guard host reads, and returns terminal tool results.

**Requirements:** R2, R3

**Dependencies:** Unit 2

**Files:**
- Modify: `src/index.ts`
- Modify: `src/lib/opencode-workflow-guard.ts` (`writeBlockedCompleteResult` also writes a terminal `rejected/disabled` result)
- Test: `tests/unit/plugin.test.ts`, or a new `tests/unit/plugin-guard-disabled.test.ts`
- Test: `tests/unit/opencode-workflow-guard.test.ts`

**Approach:**
- When the mode is `disabled`, skip constructing the observer, the init snapshot, the host-readback object and the receipt classifier. Pass a fixed placeholder identity, and omit the keys from the guard options.
- Keep the tools, the hooks, `event` and the transform registered.
- Add `workflowGuardMode` to the init log's `extra`. This goes to the local host log only.

**Execution note:** Write the plugin-level zero-I/O test first and watch it fail on today's code, which makes 17 git calls in a repository.

**Patterns to follow:** The fake-client pattern in `tests/unit/plugin.test.ts`. Pin the mode through `OPENCODE_CONFIG_DIR`, as the existing protected-mode plugin tests do.

**Test scenarios:**
- Integration: with an explicit `disabled` config, a fake `git` shim first on `PATH` and a client that counts `session.messages` and `session.children`, drive init, all four tools, before and after hooks for `bash`, `write` and `task` (with a child session id), `event` and the transform. Expect 0 git calls, 0 session reads, no marker and no throw. The shim's log-path variable must not start with `GIT_`, because the observer strips those.
- Integration: positive control. The same harness with `observe` shows more than 0 git calls, which proves the shim is live.
- Happy path: disabled `systematic_workflow_complete` returns terminal `rejected` with reason `disabled`, not `pending`.
- Happy path: disabled `status` reports `disabled`. `start` is rejected as `disabled`. `control` with `mode: 'disabled'` returns `disabled`, and other input returns `control-not-enabled`.
- Edge case: an adapter built with `mode: 'disabled'` and no observer, reader or classifier throws from no tool or hook.

**Verification:** The zero-I/O test passes and its positive control fails without the shim. The guard suites pass unchanged in explicit modes.

- [ ] **Unit 4: Guidance only where the guard runs**

**Goal:** Move the guard clause out of the shared bootstrap and into enabled-only OpenCode composition.

**Requirements:** R4, R5

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/using-systematic/SKILL.md` (remove the guard paragraph from `## Capability Resolution`)
- Modify: `src/lib/opencode-workflow-guard.ts` (export the guidance constant: the moved paragraph, a one-line lead-in, and the sentence on `disabled`)
- Modify: `src/index.ts` (append the constant to the OpenCode `profileBlock` only when the guard is enabled)
- Modify: `src/lib/AGENTS.md` (note the constant in the guard module's row)
- Test: `tests/unit/bootstrap.test.ts`, `tests/unit/__snapshots__/bootstrap.test.ts.snap`, `tests/unit/build-claude-code-plugin.test.ts`, the Pi bootstrap test

**Approach:**
- The sentence on `disabled` reads: "`disabled` means the user turned the guard off; do not call the workflow tools."
- The clause keeps its current wording otherwise. This is a move, not a rewrite.

**Test scenarios:**
- Happy path: with the guard enabled, the OpenCode bootstrap contains the clause exactly once, inside the workflow block, after the profile and before the guard marker.
- Edge case: two plugin registrations in one request still yield one clause.
- Happy path: with the guard disabled, the OpenCode bootstrap contains no `systematic_workflow_` or workflow-guard text.
- Happy path: neither the Pi bootstrap nor the Claude Code output style built from the repository contains that text.
- Edge case: with `bootstrap.enabled: false`, there is no clause even when the guard is enabled.
- Update: recompute the bootstrap length pin and the snapshots, and rewrite the test that asserted the clause is present in the default bootstrap.

**Verification:** Bootstrap, Pi and Claude Code suites pass. `registry:drift` and the Pi persona check are clean, and the diff shows no registry change.

- [ ] **Unit 5: Docs**

**Goal:** Every doc states the new default and the restore path.

**Requirements:** R6

**Dependencies:** Units 2–4

**Files:**
- Modify: `docs/src/content/docs/reference/configuration.mdx` (edit the hand-written guard prose and example outside the generated sentinels; regenerate the generated block)
- Modify: `ARCHITECTURE.md` (the hook list and the guard section: default off, and disabled builds no observer and takes no init snapshot)
- Modify: `.github/copilot-instructions.md` (the guard default)
- Modify: this plan (mark completed)

**Approach:**
- Regenerate only the schema and the config reference generator. Full `docs:generate` calls the GitHub API.
- The restore snippet is `{"workflow_guard":{"mode":"observe"}}` in the user-level `systematic.json`. Project config cannot set it.
- Leave historical plans, solution docs and `CHANGELOG.md` untouched.

**Test expectation:** none. Docs only. The schema and config generators plus content-integrity cover it.

**Verification:** `schema:drift` is clean, the config reference shows the `disabled` default, content-integrity and markdownlint are clean, and no current doc still claims `observe` is the default.

## System-Wide Impact

- **Interaction graph:** `initializePlugin` constructs everything. Hooks, tools, `event` and the transform keep their registration, so host contracts don't change.
- **API surface parity:**
  - The four tools stay registered.
  - Receipt metadata and the guard marker disappear from default OpenCode sessions.
  - Pi and Claude Code lose about 2.4 KB of irrelevant prompt text.
- **Unchanged invariants:**
  - Explicit `observe` and `protected` behave as today.
  - `workflow_guard` stays trust-protected, so project config is still stripped.
  - `systematic_workflow_control` still only disables.
- **Integration coverage:** the zero-I/O proof and the bootstrap composition across two registrations need plugin-level tests. Adapter tests can't see `src/index.ts`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Users on the implicit default silently lose observe status, receipts and markers | A behaviour-change paragraph with the restore snippet in the PR body and release notes. `feat` gives it a minor release. |
| A guard test passes vacuously after the flip | Unit 1 lands the explicit opt-in first, and the helper asserts an enabled sentinel. |
| Home config masks default tests | Default tests load with an empty temp home and no custom config dir. |
| The zero-I/O test proves nothing because the shim is not on the observer's path | A positive control in `observe` must see more than 0 git calls. |

## Documentation / Operational Notes

- PR title: `feat(guard): turn the workflow guard off by default`.
- The PR body gets a short "Behavior change" paragraph. It names who is affected: OpenCode users with no `workflow_guard` key, or with `debug` only. It gives the restore snippet and says it is not a breaking change.

## Sources & References

- Related issues: #1153 (removal)
- Related code: `src/index.ts`, `src/lib/opencode-workflow-guard.ts`, `src/lib/bootstrap.ts`, `src/lib/config.ts`, `src/lib/config-schema.ts`, `skills/using-systematic/SKILL.md`
