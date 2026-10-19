---
title: "feat: Remove the workflow guard"
type: feat
status: active
date: 2026-10-19
---

# feat: Remove the workflow guard

## Overview

This removes the OpenCode workflow guard entirely: its runtime, the receipt ledger and operation observer, the four `systematic_workflow_*` tools, the guard hooks, the guard tests and suites, and the guard's tree-sitter dependencies. The `workflow_guard` config key keeps loading. It is accepted, warned about, and ignored, so the release is a minor, not a major.

## Problem Frame

The guard is an observation gate for an honest agent, and it has not caught a real skipped step. It is about 19.5k source lines and about 45k test lines. More than 24 PRs have fixed it, most of them closing a hole the previous fix exposed. Every observed tool call took two synchronous worktree snapshots. Since 3.23.0 it has been off by default, frozen, and built only when a user opts in (#1158). #1153 tracks removing it.

## Requirements Trace

- R1. The plugin no longer constructs a guard, observer, classifier or host reader. It no longer registers `systematic_workflow_start`, `systematic_workflow_status`, `systematic_workflow_complete` or `systematic_workflow_control`, and no longer registers the guard-only hooks.
- R2. Skill output restore, the bootstrap transform, the `config` hook and the harness profile block behave as they did before for every user.
- R3. A config that still carries `workflow_guard` loads from any source (user, custom, project) and with any value. Each distinct file that carries the key produces one warning that names the file, never echoes the value, and links to the configuration reference. The key has no effect.
- R4. Every other unknown top-level key, typos included, still fails strict validation.
- R5. The published JSON schema still accepts `workflow_guard`, marked deprecated, so editors do not flag unmigrated configs.
- R6. The guard modules, their tests, the four guard-only integration suites and the guard-only fixture helpers are deleted. Each piece of retained code has a named non-guard consumer.
- R7. The Host Contract still covers real-host plugin load, skill delivery and output restore. Its expected-file list, timings and pass floor match the remaining suite.
- R8. `web-tree-sitter` and `tree-sitter-bash` are no longer dependencies.
- R9. Current docs no longer describe the guard as live. Guard plans and guard solution docs are marked superseded and point to one decision doc.
- R10. The change releases as a minor with no breaking-change marker. The release notes name the four removed tools and the ignored key.

## Scope Boundaries

- No replacement mechanism.
- Skills keep their existing workflows. No bundled skill or agent references the guard.
- The fixture file `tests/integration/fixtures/receipt-workflow-host.ts` keeps its name. Only its guard helpers go.
- No change to the shard count or the Host Contract workflow shape.
- Historical plans and solution docs are marked, not deleted. `CHANGELOG.md` is untouched.

### Deferred to Separate Tasks

- #1147: git-env isolation for the non-guard fixture helpers.
- Closing #1090, #1125, #1081, #740 and #854 as obsolete once this merges.

## Context & Research

### Relevant Code and Patterns

- Deletion closure: `src/lib/opencode-workflow-guard.ts`, `src/lib/workflow-guard.ts`, `src/lib/opencode-operation-observer.ts`, `src/lib/receipt-classifier.ts`, `src/lib/receipt-ledger.ts`, `src/lib/receipt-readback.ts` and `src/lib/question-attestation.ts`. These import only each other. Apart from them, `src/index.ts` is the only importer. Only `receipt-classifier.ts` imports the tree-sitter packages.
- Code that stays: `src/lib/skill-tool.ts` (skill output store and restore) and `src/lib/bootstrap.ts`. The guard imports `INTERNAL_AGENT_SIGNATURES` from `bootstrap.ts`, never the reverse.
- Hook parity: `REGISTERED_PLUGIN_HOOKS` in `src/index.ts` is checked against the hook docs by `scripts/content-integrity.ts` (`HOOK_PARITY_DOCUMENTS`).
- Codemap and module-table completeness for `src/lib/` modules is gate-enforced in `ARCHITECTURE.md` and `src/lib/AGENTS.md`.
- Removed-name precedent: `src/lib/removed-names.ts` widens the schema to accept removed values, then drops them and warns after the merge through the config `warningSink`. It is value-level only, so a top-level key needs a new entry point.
- Config loading: `loadConfigSource` and `loadConfigWithSources` in `src/lib/config.ts`. Today a project `workflow_guard` is stripped without a warning and recorded as "blocked". A user or custom `workflow_guard` is merged. A malformed value throws at init.
- Schema generation: `scripts/generate-config-schema.ts` warns against a published schema that is stricter than the runtime. `docs/scripts/generate-config-reference.ts` renders sections from `TOP_LEVEL_KEYS` and requires examples on described fields.
- Host Contract: `scripts/host-contract-guard.ts` (`EXPECTED_SUITE_FILES`, `EXEMPT_SKIPS`, `PASS_FLOOR`) and `tests/integration/host-contract-timings.json`. `tests/unit/host-contract-workflow.test.ts` fails if the timings name a missing file.

### Institutional Learnings

- `docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md`: list every importer and every observable output before deleting.
- `docs/plans/2026-07-06-001-feat-removed-name-config-safety-plan.md`: accept only the known removed names, warn, keep typos strict, and keep the schema and runtime in agreement.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`: generate the schema from its source and check for drift.
- `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`: recompute the Host Contract lists against the remaining suite rather than lowering them mechanically.
- `docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md` and `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`: `refactor` publishes nothing. Commit bodies and the PR body are public release-note input.
- `docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`: the existing `status: superseded` plus `superseded_by` pattern.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/index.ts, src/lib/config.ts, src/lib/config-schema.ts, src/lib/removed-names.ts, src/lib/capability-snapshot.ts, src/lib/config-protected-fields.ts, scripts/generate-config-schema.ts, docs/scripts/generate-config-reference.ts, scripts/host-contract-guard.ts",
  "freshness": {
    "vcs_reference": "90bf6364"
  },
  "budget": {
    "max_search_passes": 6,
    "max_candidate_inspections": 12,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/removed-names.ts",
      "description": "Accepts known removed disable-list values, then drops them and warns after merge",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts warnDroppedNames and the loadConfigWithSources warningSink",
      "description": "Deduplicated config warnings through the injectable warning sink",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config.ts emitTopLevelProtectedFieldWarning and sanitizeDiagnosticText",
      "description": "Path-sanitized top-level field warning text",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config.ts loadConfigSource",
      "description": "Shared per-source parse used by user, custom and project config",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **Keep the key in the schema as a deprecated stub.** It is typed as unknown and optional, with a description, an example and a deprecated marker. No strip happens before the parse. This keeps the runtime, the published schema and `validateConfig` in agreement (R4, R5). It also matches the removed-names precedent, which widens the schema and then drops the key, and the generator's rule against a schema that is stricter than the runtime. `TOP_LEVEL_KEYS` keeps the key, so the rendered section becomes the warning's link target.
- **Detect presence, not value.** A source that carries the key warns whatever its value. The loader reports the removed keys it found to its caller. `loadConfigWithSources` warns once per distinct real file and key through the raw `warningSink`. It does not use the bounded or alias-buffered project sink, so the warning can't be capped or folded into the alias notice. No module-global dedupe: OpenCode loads config at least twice per start, and the duplicate warnings match the existing `disabled_*` behavior.
- **Warn for project config too, and stop throwing on bad values.** A removed key has no trust implication, so the earlier silent project strip no longer applies. A dead key with a bad value must not stop the plugin from starting.
- **Keep the warning text harness-neutral.** Pi reads the same user file, so the text names the key and the file and says it is ignored. It does not say "OpenCode".
- **Remove the key from every protected and authority list.** That covers `PROJECT_ALWAYS_PROTECTED_FIELDS`, `collectProjectProtectedFields`, `CONFIG_AUTHORITY_FIELD_PATHS`, `config-protected-fields.ts` and the capability snapshot. `systematic capabilities` loses three facts. The format only shrinks, so its version stays the same.
- **Delete the tools rather than stubbing them.** A model that still calls one gets OpenCode's non-fatal invalid-tool result. The guidance that taught the tool names shipped only with the guard enabled.
- **Replace the guard-absence tests with positive shape tests.** The plugin's tool keys must be exactly the skill tool. Its hook keys must equal `REGISTERED_PLUGIN_HOOKS`. Text-absence tests for a deleted feature go.
- **Release as `feat`.** A minor release, with no breaking-change marker. A `refactor` title would publish nothing.
- **Mark history with a single decision doc.** Guard-subject plans and solution docs get `status: superseded` with `superseded_by` pointing at one new decision doc. That doc records the removal and links #1153. Docs that only mention the guard stay unmarked. `plugin-tool-output-truncated-before-after-hook` is annotated only, because its restore behavior stays.

## Open Questions

### Resolved During Planning

- Do any non-guard consumers need guard code? No. Question attestation, the capability snapshot, Pi and the Claude Code build use no guard module. The capability snapshot and config use only key names.
- Does removal change emitted bootstrap, Pi or Claude Code artifacts for default users? No. The default-config profile block is identical, and Pi and Claude Code never carried guard text.
- Does the pass floor still hold? Yes. About 167 integration tests remain against a floor of 120.
- Is session state migrated? No. The guard wrote nothing to disk. Its markers and receipt metadata in old history become inert.

### Deferred to Implementation

- The exact warning wording and the anchor slug of the config reference section.
- Whether VS Code shows the deprecated marker on a draft-07 schema. If it doesn't, add a deprecation message alongside it.
- The final superseded manifest. Generate it by grep at implementation time and record a disposition for every hit.

## Implementation Units

- [ ] **Unit 1: Unwire the guard from the plugin entry and remove its suites**

**Goal:** The plugin no longer builds or registers anything for the guard. The guard-only tests, integration suites and fixture helpers are gone. Config handling is unchanged.

**Requirements:** R1, R2, R6, R7

**Dependencies:** None

**Files:**
- Modify: `src/index.ts`, `ARCHITECTURE.md` (hook bullets and the Bird's Eye guard paragraph), `.github/copilot-instructions.md`, `STRUCTURE.md`
- Modify: `scripts/host-contract-guard.ts`, `tests/integration/host-contract-timings.json`
- Modify: `tests/integration/skill-delivery.test.ts`, `tests/integration/skill-command-probe.test.ts` (dangling comment), `tests/integration/fixtures/receipt-workflow-host.ts`
- Modify: `tests/unit/plugin.test.ts`, `tests/unit/bootstrap.test.ts`, `tests/unit/pi.test.ts`, `tests/unit/build-claude-code-plugin.test.ts`, `tests/unit/receipt-workflow-host.test.ts`, `tests/unit/host-contract-guard.test.ts`
- Delete: `tests/unit/plugin-guard-disabled.test.ts`, after moving its fixture git-isolation tests into a kept file
- Delete: `tests/integration/receipt-workflow-recovery.test.ts`, `tests/integration/receipt-workflow-dogfood.test.ts`, `tests/integration/receipt-workflow-guard-real-host.test.ts`, `tests/integration/question-attestation-opencode.test.ts`

**Approach:**
- From `src/index.ts`, remove:
  - the guard imports
  - registration identity, the placeholder identity, the host readback and the guard options
  - guard construction, the four tools, the before hook and the event hook
  - the transform guard call and the init-log mode field
- In `src/index.ts`, keep:
  - skill output restore in the after hook
  - the bootstrap transform
  - the `config` hook
- Reduce the profile composition to the harness profile alone.
- Drop the two guard-only hooks from `REGISTERED_PLUGIN_HOOKS`, and update the hook docs in the same unit.
- In skill delivery, drop the two guard scenarios and their helper, and keep the five delivery and restore scenarios. Then delete the guard fixture helpers and their unit tests.
- Delete the four suites, their `EXPECTED_SUITE_FILES` entries and their timings keys together. Refresh the stale pass-floor comment, and keep the floor at 120.

**Execution note:** Move the fixture git-isolation tests into a kept file before deleting `plugin-guard-disabled.test.ts`.

**Patterns to follow:** The existing `plugin.test.ts` harness for building hooks from `src/index.ts`.

**Test scenarios:**
- Happy path: the plugin's tool keys are exactly the skill tool.
- Happy path: the plugin's hook keys equal `REGISTERED_PLUGIN_HOOKS`, which no longer lists the before or event hooks.
- Happy path: a skill load still has its output restored by the after hook. The skill-delivery scenarios still cover restore and the output-limit back-off.
- Happy path: the default-config system prompt carries the bootstrap and harness profile and no guard marker. Its bytes match the base commit.
- Integration: the fixture git-isolation tests still pass from their new home.
- Edge case: a config that sets `workflow_guard.mode` to `observe` still loads in this unit and builds nothing.

**Verification:**
- Unit, typecheck, Biome and content-integrity all pass.
- The integration suite passes, with the opencode processes it spawns reaped afterwards.
- `host-contract-guard` reports no missing files over the remaining suite.

- [ ] **Unit 2: Delete the guard runtime modules**

**Goal:** The seven guard modules and their unit tests are deleted, and the codemap and module table match.

**Requirements:** R6, R9

**Dependencies:** Unit 1

**Files:**
- Delete: `src/lib/opencode-workflow-guard.ts`, `src/lib/workflow-guard.ts`, `src/lib/opencode-operation-observer.ts`, `src/lib/receipt-classifier.ts`, `src/lib/receipt-ledger.ts`, `src/lib/receipt-readback.ts`, `src/lib/question-attestation.ts`
- Delete: the 12 guard-only unit test files: `tests/unit/opencode-operation-observer.test.ts`, `tests/unit/opencode-workflow-guard.test.ts`, `tests/unit/workflow-guard.test.ts`, `tests/unit/workflow-guard-recovery.test.ts`, `tests/unit/receipt-ledger.test.ts`, `tests/unit/receipt-ledger-persistence.test.ts`, `tests/unit/receipt-readback.test.ts`, `tests/unit/receipt-operations.test.ts`, `tests/unit/receipt-classifier.test.ts`, `tests/unit/receipt-privacy.test.ts`, `tests/unit/receipt-duplicate-replay.test.ts`, `tests/unit/question-attestation.test.ts`
- Modify: `ARCHITECTURE.md` (codemap rows and the Cross-Cutting guard, receipt and observer sections), `src/lib/AGENTS.md` (prose, data flow, module rows)

**Approach:** Delete each module and its importers in the same unit, so the test typecheck passes at every commit. Rewrite the host-contract text in `ARCHITECTURE.md` that mentions receipt evidence. Don't touch `<SYSTEMATIC_WORKFLOWS>` or any non-guard use of "receipt".

**Test expectation:** none. This is a pure deletion, and Unit 1's shape tests cover the observable surface.

**Verification:**
- Content-integrity passes, which includes the codemap and module-table completeness checks.
- Typecheck over tests and scripts passes.
- A search for the four exact tool names finds hits only in historical docs and `CHANGELOG.md`.

- [ ] **Unit 3: Accept, warn on, and ignore the removed `workflow_guard` key**

**Goal:** `workflow_guard` becomes a deprecated, ignored key that warns from any source and never fails startup.

**Requirements:** R3, R4, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/removed-names.ts`, `src/lib/config-schema.ts`, `src/lib/config.ts`, `src/lib/config-protected-fields.ts`, `src/lib/capability-snapshot.ts`
- Modify: `docs/public/schemas/v3/systematic-config.schema.json` (regenerated), `docs/src/content/docs/reference/configuration.mdx` (hand-written section replaced with a removed-setting note, generated block regenerated), `docs/src/content/docs/guides/model-profiles.mdx`
- Test: `tests/unit/config.test.ts`, `tests/unit/config-schema.test.ts`, `tests/unit/generate-config-schema.test.ts`, `tests/unit/cli.test.ts`, `tests/unit/capability-snapshot.test.ts`, `tests/unit/config-handler.test.ts`, `tests/unit/pi.test.ts`

**Approach:**
- Add a top-level removed-key list to `removed-names.ts` that holds `workflow_guard`.
- Schema: the guard schema is replaced by a deprecated, unknown, optional stub, and the top-level `.strict()` stays.
- Loader: per-source parsing reports the removed keys present in each file. `loadConfigWithSources` warns once per distinct real file and key through the raw warning sink.
- Remove the guard type, its default, its merge step, and its entries in the protected and authority lists, including the alias-notice eligibility and the alias text.
- Rewrite the tests that used `workflow_guard` as their protected-field example onto another protected field. Keep the alias-notice coverage on `allow_project_profiles`.

**Execution note:** Test-first. Write the config matrix tests before changing the loader.

**Patterns to follow:**
- `warnDroppedNames` and its tests for dedupe and the sink.
- `emitTopLevelProtectedFieldWarning` for sanitized path text.

**Test scenarios:**
- Happy path: user `systematic.json` with `{workflow_guard:{mode:'observe'}}` loads, warns once naming that file, and the loaded config has no guard field.
- Happy path: the same key in a user `.jsonc`, a custom config dir and a project config each load and warn once per file.
- Edge case: `{debug:true}` only, `{mode:'enforced'}`, `true`, `null` and `[]` all load and warn, and none of them throw.
- Edge case: user and custom resolving to the same real file produce one warning.
- Edge case: `.json` and `.jsonc` both present. `.jsonc` wins, and only a key in `.jsonc` warns.
- Error path: `workflow_gaurd` and `agnts` still fail validation.
- Edge case: the warning text contains the sanitized path and the key, and never the value.
- Integration: an aliased project file that sets only `workflow_guard` produces the removed-key warning and no alias notice.
- Integration: `systematic capabilities` stays silent, exits 0, reports the source as present, and lists no guard facts.
- Integration: Pi's config load surfaces the same warning.
- Happy path:
  - The Zod schema accepts `{workflow_guard: anything}`.
  - The published JSON schema accepts it in the AJV parity suite, and AJV rejects a typo.
  - The generated schema marks the key deprecated.
  - Every listed removed key is a property of the schema.

**Verification:**
- Schema drift, the config reference generator and its test, the unit suite and typecheck all pass.
- A local OpenCode start with a guard-carrying user config shows the warning and runs normally.

- [ ] **Unit 4: Drop the tree-sitter dependencies**

**Goal:** Consumer installs no longer pull `web-tree-sitter` or `tree-sitter-bash`, and no longer run their native install script.

**Requirements:** R8

**Dependencies:** Unit 2

**Files:**
- Modify: `package.json`, `bun.lock`, `.github/renovate.json5` (the tree-sitter group)
- Test: `tests/unit/package-exports.test.ts`

**Approach:**
- Remove both packages and their lockfile entries in one change, because CI installs with a frozen lockfile.
- Remove the dead Renovate group.
- Remove the wasm asset assertion in the package-exports test.

**Test expectation:** none. This is a dependency removal, and the package-exports test proves the packed artifact still loads.

**Verification:**
- A frozen-lockfile install, the build and the package-exports test pass.
- `node-gyp-build` is gone from the lock tree.

- [ ] **Unit 5: Record the removal and mark guard history superseded**

**Goal:** One decision doc records the removal. Guard plans and guard solution docs point to it, and no current doc describes the guard as live.

**Requirements:** R9

**Dependencies:** Units 1-3

**Files:**
- Create: a decision doc under `docs/solutions/`, with schema-valid frontmatter, that links #1153
- Modify: the guard-subject plans under `docs/plans/` and the guard-subject solution docs under `docs/solutions/`, per the generated manifest
- Modify: `docs/solutions/integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md` (annotation only)

**Approach:**
- Generate the manifest by searching for guard terms, and give each hit a disposition: supersede, annotate or leave.
- For each superseded doc, add `status: superseded`, a `superseded_by` link to the decision doc and a superseded date, plus a one-line banner, following the version-pinned-evidence precedent.
- Leave docs that only mention the guard, including the two active plans that mention it.
- Mark this plan `completed` at the end.

**Test expectation:** none. These are documentation-only changes.

**Verification:**
- Content-integrity and markdownlint pass.
- Every manifest hit has a recorded disposition.
- No `status: active` plan has all of its units ticked.

## System-Wide Impact

- **Interaction graph:** Removing the before and event hooks leaves the after hook with skill output restore only. Nothing else reads the hooks.
- **API surface parity:** The four tools disappear from OpenCode only. Pi and Claude Code never had them.
- **State lifecycle:** The guard wrote nothing to disk. Old session markers and receipt metadata become inert, and nothing reads them.
- **Integration coverage:** The skill-delivery scenarios, `opencode.test.ts` and the skill-command probe still cover real-host load, delivery and restore.
- **Unchanged invariants:**
  - Bootstrap bytes for default users.
  - Strict rejection of unknown config keys.
  - Skill tool behavior.
  - The Host Contract job shape and its required checks.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A config carrying the key fails startup after the schema change | Unit 3 adds the stub and the warning in the same change as the type removal, and tests every source and value. |
| The test typecheck breaks mid-sequence when a module and its importers are deleted in different commits | Each unit deletes a module together with all of its importers. |
| The Host Contract fails on missing files or stale timings | Suites, expected files and timings change in one unit. |
| A commit body or the PR body leaks internal vocabulary, a breaking-change marker or a closing keyword into the release notes | Before merge, check the branch's commit bodies and the PR body for breaking-change markers, closing keywords and internal labels. |
| Guard history is over-marked, including active plans | Generate a manifest with explicit dispositions, and leave the two active plans that only mention the guard. |

## Documentation / Operational Notes

The PR body is release-note input, so it must cover these points:
- The four removed tools, by name.
- That `workflow_guard` is still accepted, warns and is ignored, including in project config.
- That the guard has been off by default since 3.23.0, so default users see no change.
- That users who enabled `observe` or `protected` lose receipts, the guidance block and the status tools.
- That the tree-sitter packages are no longer installed.

## Sources & References

- Related issues: #1153, #1158, #1147, #1090, #1125, #1081, #740, #854
- Precedent plan: `docs/plans/2026-07-06-001-feat-removed-name-config-safety-plan.md`
- Superseded by this work: `docs/plans/2026-10-18-002-feat-guard-default-off-plan.md`
