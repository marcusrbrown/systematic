---
title: feat: Move Systematic bootstrap and skill catalog into first system message
type: feat
status: completed
date: 2026-05-13
origin: docs/brainstorms/2026-05-13-bootstrap-message0-skill-catalog-requirements.md
shipped: "PR #365"
---

# feat: Move Systematic bootstrap and skill catalog into first system message

## Overview

Systematic should place its default workflow bootstrap at the end of the first OpenCode system message and expose bundled skill availability in the same default bootstrap using a native-style verbose catalog. `systematic_skill` remains the execution tool, but its description becomes a compact fallback rather than the main catalog carrier. This is prompt-shape alignment with OpenCode's native skill presentation, not a measured cache-performance improvement.

## Problem Frame

The origin document frames this as a prompt-ordering and skill-discovery problem: Systematic currently appends bootstrap content to the last system entry, while OpenCode treats the first entry as the stable header for normal chat construction. OpenCode's native skill system also presents verbose skill availability in the system prompt and keeps the tool description compact. Systematic should align with that split without claiming measured cache-performance gains or rewriting its foundational skill policy (see origin: `docs/brainstorms/2026-05-13-bootstrap-message0-skill-catalog-requirements.md`).

## Requirements Trace

- R1. Append new bootstrap content to `output.system[0]` when a system entry exists and no complete bootstrap marker is present.
- R2. Normalize complete existing `<SYSTEMATIC_WORKFLOWS>` blocks to exactly one current block in `output.system[0]`; leave malformed marker fragments untouched.
- R3. Preserve safe empty-system fallback by pushing bootstrap content as the sole entry.
- R4. Preserve disabled bootstrap, custom bootstrap content generation, frontmatter stripping, missing-custom-file fallback, and internal/title-generation skip behavior.
- R5. Add a native-style verbose Systematic skill catalog to default bootstrap content only.
- R6. Build catalog entries from one deterministic static discoverability source: bundled skills sorted by name, excluding disabled skills and `disableModelInvocation === true`.
- R7. Preserve `systematic_skill` execution semantics: prefixed/unprefixed resolution, permission prompt, metadata, and `<skill_content name="systematic:...">` output.
- R8. Slim `systematic_skill` description/parameter hint while retaining a compact available-skills fallback.
- R9. Preserve mandatory skill invocation before response/action when a skill may apply.
- R10. Keep the existing `using-systematic` decision flow semantically unchanged.
- R11. Keep a clear tool distinction in bootstrap/tool prose: `systematic_skill` for bundled Systematic skills; native `skill` for non-Systematic skills.
- R12. Test first-entry insertion, complete-marker normalization, malformed-marker non-normalization, empty fallback, and preserved config/skip behavior.
- R13. Test catalog sorting/filtering, verbose default-bootstrap placement, and compact tool fallback.
- R14. Test the slimmed `systematic_skill` contract without changing load behavior.
- R15. Test duplicate Systematic registration from user and project OpenCode config so bundled skills remain discoverable and `systematic_skill` remains callable in OpenCode's visible tool surface.

## Scope Boundaries

- Do not change OpenCode internals, native `skill`, or native system prompt generation.
- Do not inject the default verbose skill catalog into user-authored custom bootstrap files.
- Do not claim measured cache improvement or add provider-specific cache metrics.
- Do not edit `skills/using-systematic/SKILL.md` in this plan unless a failing test demonstrates a direct contradiction introduced by the catalog/tool split. The default implementation path leaves the skill body unchanged.
- Do not add live reload of skill/config changes; bootstrap and tool descriptions remain snapshot-per-plugin-instance behavior.
- Do not introduce new duplicate-skill-name semantics. Preserve current discovery behavior and sort the resulting discoverable list deterministically.

## Context & Research

### Relevant Code and Patterns

- `src/lib/bootstrap.ts` owns bootstrap content construction, marker lookup, and `applyBootstrapContent` insertion behavior. Existing code uses literal `indexOf`/`slice` operations and should stay linear-time.
- `src/index.ts` snapshots `bootstrapContent` once during plugin initialization, skips internal/title-generation prompts, and calls `applyBootstrapContent` only when content is truthy.
- `src/lib/skill-tool.ts` currently owns discovery/filter/sort for `systematic_skill`, builds the verbose tool description, caches description/hint per tool instance, and preserves prefixed/unprefixed execution.
- `src/lib/skills.ts`, `src/lib/skill-loader.ts`, and related tests provide discovery/frontmatter/body-loading seams.
- `tests/unit/bootstrap.test.ts`, `tests/unit/plugin.test.ts`, and `tests/unit/skill-tool.test.ts` are the primary regression suites to extend.

### Institutional Learnings

- `docs/solutions/security-issues/redos-after-plugin-trust-boundary-inversion-2026-05-11.md`: keep bootstrap delimiter handling literal and linear-time; avoid regex-based delimiter parsing.
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md`: keep helpers out of `src/index.ts`; plugin entry exports only `default`.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`: duplicate plugin registration can happen; marker idempotency must preserve most-recent hook output.
- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md`: generated/catalog-style content needs deterministic verification, not manual review.

### External References

- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/session/llm.ts`: OpenCode builds `system: string[]`, invokes `experimental.chat.system.transform`, and maps each system entry to model system messages.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/session/system.ts`: native skills are presented verbosely in the system prompt.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/skill.ts` and `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/registry.ts`: native `skill` keeps execution output compatible with `<skill_content>` and uses a compact tool description.

## Key Technical Decisions

- **Shared catalog helper:** Create one small pure helper for discoverable Systematic skill catalog data and render modes. This avoids bootstrap/tool drift without introducing a broad catalog framework.
- **Catalog source:** Use raw skill discovery/frontmatter metadata for catalog entries. Do not use `loadSkill()`'s formatted description path for catalog text, because that path adds Systematic formatting intended for loaded skill content rather than native-style availability lists.
- **Complete-block normalization:** Treat complete `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>` blocks as Systematic-owned marker blocks, remove all such complete blocks across all system entries, then append the current block once to `output.system[0]`. This makes duplicate registration and prior last-entry placement converge to the new canonical location.
- **Malformed marker stance:** Treat partial/malformed markers as ordinary text. Do not attempt cleanup that could delete user or plugin content incorrectly.
- **Default-bootstrap-only verbose catalog:** Default bootstrap gets verbose XML. Custom bootstrap content remains verbatim and relies on `systematic_skill`'s compact fallback for discoverability.
- **Snapshot contract:** Skill/config changes require a fresh plugin instance/OpenCode restart to refresh bootstrap/tool descriptions. No live refresh in this change.
- **Later hook wins:** Under duplicate registration, later Systematic hooks win because each invocation removes complete prior blocks and appends its own current content.
- **First-entry ownership:** Systematic does not own `output.system[0]`. The selected contract is still to append to the first entry OpenCode/earlier plugins provide, because prompt priority is the goal. This may keep later system entries split; do not present it as a cache optimization.

## Open Questions

### Resolved During Planning

- Should complete marker blocks be normalized across all system entries? Yes. Remove every complete block and write exactly one current block to `output.system[0]`.
- Should first-entry insertion be treated as a prompt-ordering change rather than a cache benchmark? Yes. Do not claim measured cache benefit.
- Should custom bootstrap files receive an injected default skill catalog? No. Custom bootstrap files remain verbatim.
- Should tool descriptions refresh live after config/skill-file changes? No. Preserve snapshot-per-plugin-instance behavior.

### Deferred to Implementation

- Exact helper names and export boundaries: decide while editing `src/lib/*`, keeping helpers out of `src/index.ts`.
- Exact compact fallback rendering: keep it short enough to reduce tool-description weight while still listing discoverable skill names.
- Whether `using-systematic` needs any prose edit at all after the catalog/tool split: change only if the final bootstrap would otherwise duplicate or contradict existing wording.

## Implementation Units

- [ ] **Unit 1: Shared Systematic skill catalog data and renderers**

**Goal:** Establish one deterministic source for discoverable bundled-skill catalog entries and both verbose/compact renderings.

**Requirements:** R5, R6, R8, R13

**Dependencies:** None

**Files:**
- Create: `src/lib/skill-catalog.ts`
- Test: `tests/unit/skill-catalog.test.ts`
- Modify: `src/lib/skill-tool.ts` only if needed to consume the helper without changing execution behavior

**Approach:**
- Derive discoverable entries from `findSkillsInDir()`/frontmatter metadata rather than `loadSkill()`'s loaded-content formatting path.
- Preserve current static filters: configured disabled skills and `disableModelInvocation === true`.
- Sort by skill name before rendering.
- Provide verbose native-style XML for bootstrap and compact fallback output for tool descriptions.
- Pin the compact fallback shape to:
  - heading: `## Available Systematic Skills`
  - one bullet per skill: `- <prefixed-name>: <description>`
  - empty-state text: `No Systematic skills are currently available.`
- Do not add new duplicate-name policy beyond sorting the existing discoverable entries.

**Execution note:** Implement behavior test-first; start with helper tests that fail before adding production helper code.

**Patterns to follow:**
- `src/lib/skill-tool.ts` discovery/filter/sort behavior
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/skill/index.ts` native verbose/compact shape
- `tests/unit/skill-tool.test.ts` temp skill fixtures

**Test scenarios:**
- Happy path: enabled bundled skills render in sorted order for verbose and compact modes.
- Edge case: configured disabled skills are absent from both render modes.
- Edge case: `disable-model-invocation: true` skills are absent from both render modes.
- Edge case: zero discoverable skills renders an explicit no-skills message rather than malformed XML/markdown.

**Verification:**
- Bootstrap and tool code can consume one catalog source without duplicating filtering logic.

- [ ] **Unit 2: First-entry bootstrap insertion and marker normalization**

**Goal:** Make `applyBootstrapContent` place one canonical bootstrap block at the end of `output.system[0]`, preserving existing skip/configuration behavior.

**Requirements:** R1, R2, R3, R4, R12

**Dependencies:** None

**Files:**
- Modify: `src/lib/bootstrap.ts`
- Test: `tests/unit/bootstrap.test.ts`
- Test: `tests/unit/plugin.test.ts`

**Approach:**
- Replace the current first-match replacement behavior with complete-block collection/removal across all system entries.
- Append the latest bootstrap content to `output.system[0]` when system entries exist; push when empty.
- Leave malformed or partial marker fragments untouched.
- Preserve the current `src/index.ts` truthy-content guard and internal-agent skip behavior.
- Rewrite existing tests that currently assert last-entry insertion or in-place later-entry replacement; those assertions encode the old contract and should fail under the new one.

**Execution note:** Characterization-first: add tests for current empty/custom/skip behavior before changing insertion behavior where coverage is missing, then add failing tests for first-entry insertion and multi-block normalization.

**Patterns to follow:**
- Existing literal delimiter logic in `src/lib/bootstrap.ts`
- Existing bootstrap and plugin tests in `tests/unit/bootstrap.test.ts` and `tests/unit/plugin.test.ts`
- ReDoS learning in `docs/solutions/security-issues/redos-after-plugin-trust-boundary-inversion-2026-05-11.md`

**Test scenarios:**
- Happy path: two system entries with no marker result in bootstrap appended to `system[0]`, leaving `system[1]` unchanged.
- Edge case: empty `system` pushes bootstrap as the sole entry.
- Edge case: complete markers in multiple entries and multiple complete blocks in one entry are removed, then one current block is appended to `system[0]`.
- Edge case: malformed/open-only marker fragments remain untouched while one current complete block is appended to `system[0]`.
- Integration: duplicate Systematic transform invocations converge to one block, with the later invocation's content winning.
- Integration: complete marker blocks in a later entry and in `system[0]` are both removed before one current block is appended to `system[0]`.
- Regression: disabled bootstrap, custom bootstrap, missing custom fallback, frontmatter stripping, and internal/title-generation skip behavior remain unchanged.

**Verification:**
- The bootstrap marker appears exactly once after repeated transforms when complete prior blocks exist.
- No regex-based delimiter parsing is introduced.

- [ ] **Unit 3: Default bootstrap verbose catalog**

**Goal:** Include verbose Systematic skill availability in default bootstrap content while preserving custom bootstrap content generation semantics.

**Requirements:** R5, R6, R8, R13

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/bootstrap.ts`
- Modify: `src/index.ts` only if wiring needs to pass catalog dependencies explicitly
- Test: `tests/unit/bootstrap.test.ts`

**Approach:**
- Insert the verbose catalog inside the default `<SYSTEMATIC_WORKFLOWS>` block with native-style XML structure.
- Generate the catalog from the shared helper's static discoverability set.
- Do not add the verbose catalog to custom bootstrap file content.
- Preserve current fallback when a configured custom file path does not exist: default bundled bootstrap content is still used and therefore includes the catalog.

**Execution note:** Test-first for default/custom contrast; write a failing custom-bootstrap test before adding catalog insertion.

**Patterns to follow:**
- `getBootstrapContent()` default/custom branching in `src/lib/bootstrap.ts`
- Native verbose skill catalog in `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/skill/index.ts`

**Test scenarios:**
- Happy path: default bootstrap contains `<available_skills>` with skill name, description, and file URL/location entries.
- Edge case: disabled and non-invocable skills are absent from the default bootstrap catalog.
- Edge case: custom bootstrap file content is returned verbatim and does not get a forced verbose catalog.
- Edge case: missing custom bootstrap path still falls through to default bootstrap with catalog.

**Verification:**
- Default bootstrap has workflow guidance plus verbose catalog; custom bootstrap behavior remains verbatim.

- [ ] **Unit 4: Compact `systematic_skill` fallback and behavior guards**

**Goal:** Slim the `systematic_skill` tool description while preserving load behavior and guarding the unchanged `using-systematic` workflow discipline.

**Requirements:** R7, R8, R9, R10, R11, R14, R15

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `src/lib/skill-tool.ts`
- Test: `tests/unit/skill-tool.test.ts`
- Test: `tests/unit/bootstrap.test.ts` if bootstrap/tool wording consistency changes
- Test: `tests/unit/plugin.test.ts`
- Test: `tests/integration/opencode.test.ts` if OpenCode exposes enough tool-surface state to assert host-visible duplicate registration behavior

**Approach:**
- Replace the verbose XML catalog in the tool description with compact fallback availability derived from the shared helper.
- Keep the tool purpose, argument hint, permission ask, metadata, error suggestions, prefixed/unprefixed resolution, sampled file list, and `<skill_content>` output unchanged.
- Do not edit `skills/using-systematic/SKILL.md` unless a new failing test proves the bootstrap/tool split introduced contradictory tool-access guidance.
- Preserve the current multi-registration contract: repeated Systematic plugin factories expose usable hooks/tools rather than returning empty hooks. Add a host-visible guard where feasible so user-level plus project-level plugin registration does not make `systematic_skill` unavailable or ambiguous.

**Execution note:** Behavior test-first; existing load tests should stay green while new description-weight/fallback tests fail before the description change.

**Patterns to follow:**
- `src/lib/skill-tool.ts` native-compatible output shape
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/skill.ts` execution output
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/registry.ts` compact native skill tool description

**Test scenarios:**
- Happy path: prefixed and unprefixed `systematic_skill` invocations still load the same skill output.
- Edge case: unknown skill errors still list discoverable Systematic skill names.
- Edge case: compact description contains discoverable skill names but not the full verbose XML catalog.
- Edge case: disabled/non-invocable skills are excluded from compact fallback.
- Regression: the rendered default bootstrap still includes `using-systematic` instructions that require skill invocation before response/action and preserve process-skill priority.
- Integration: existing OpenCode integration coverage for loading `systematic:setup` through `systematic_skill` remains green after moving catalog placement.
- Integration: duplicate plugin registration through representative user/project config still leaves `systematic_skill` callable and bundled skills discoverable; if OpenCode's public surface exposes tool IDs, assert there is no ambiguous duplicate visible entry.

**Verification:**
- Tool execution output remains stable while description weight and catalog location change.

## System-Wide Impact

- **Interaction graph:** `src/index.ts` initializes config, bootstrap content, and tool definitions; `experimental.chat.system.transform` applies bootstrap per conversation; `systematic_skill` uses the same discoverable skill set for fallback descriptions and execution-time loading.
- **Error propagation:** Missing bundled skill files and unreadable directories should continue to degrade as today; the catalog helper should not turn optional skill discovery failures into plugin-load crashes.
- **State lifecycle risks:** Bootstrap and tool descriptions remain cached per plugin instance. Users must restart OpenCode to pick up skill/config changes.
- **API surface parity:** `systematic_skill` remains the public tool surface for bundled skills. Native `skill` remains separate for non-Systematic skills.
- **Integration coverage:** Duplicate plugin registration and repeated transform invocation must be covered because user/project OpenCode configs can register Systematic more than once. Coverage should include both bootstrap idempotency and `systematic_skill` availability.
- **Unchanged invariants:** `src/index.ts` exports only default; custom bootstrap content generation remains verbatim; malformed marker fragments are not deleted; `using-systematic`'s mandatory workflow discipline remains intact.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Moving bootstrap into `system[0]` changes OpenCode's split-system-message shape when other plugins append later entries. | Treat this as an intentional prompt-ordering change; test structural `output.system` behavior and avoid cache-performance claims. |
| Shared catalog helper becomes unnecessary abstraction. | Keep it small and pure: one producer, two render modes, no framework or runtime registry. |
| Catalog/tool descriptions drift. | Derive both verbose and compact renderings from the same helper and assert sorting/filtering in tests. |
| Custom bootstrap users do not get the verbose default catalog. | Preserve custom content generation semantics and rely on compact `systematic_skill` fallback for discoverability. |
| Marker cleanup accidentally deletes unrelated prompt content. | Only remove complete literal marker blocks; leave malformed fragments untouched. |
| Duplicate plugin registration leaves users without bundled skills after preset/config changes. | Add a plugin/tool-surface guard that keeps `systematic_skill` callable under repeated registration. |

## Documentation / Operational Notes

- Update docs only if existing public configuration or README text describes bootstrap or `systematic_skill` catalog placement.
- No release migration note is required for config shape; behavior changes are prompt/tool-description semantics only.
- PR description should explicitly avoid claiming measured cache improvements.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-13-bootstrap-message0-skill-catalog-requirements.md](../brainstorms/2026-05-13-bootstrap-message0-skill-catalog-requirements.md)
- `src/lib/bootstrap.ts`
- `src/lib/skill-tool.ts`
- `tests/unit/bootstrap.test.ts`
- `tests/unit/plugin.test.ts`
- `tests/unit/skill-tool.test.ts`
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/session/llm.ts`
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/session/system.ts`
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/skill.ts`
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/registry.ts`
