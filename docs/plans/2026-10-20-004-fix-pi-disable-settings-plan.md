---
title: "fix(pi): honor disabled skills and agents on Pi"
type: fix
status: completed
date: 2026-10-20
---

# fix(pi): honor disabled skills and agents on Pi

## Overview

Pi will honor the same per-user disable settings as OpenCode:
- `disabled_skills` removes a skill from `systematic_skill`.
- `disabled_agents` (bare stem or `category/stem`) and `agents.<key>.disable` remove a persona from the `systematic_delegate` catalog and from the pi-subagents persona export.

When a persona leaves the desired set, `refresh` now removes its manifest-owned file if the file is unchanged since export. A hand-edited file stays in place with a clear warning, and no longer aborts the export.

## Problem Frame

OpenCode skips disabled skills and agents. On Pi:
- `src/pi.ts` hardcodes an empty disabled-skills list.
- The delegate catalog is built from all 37 bundled personas, with no filter.
- The export (`systematic pi-subagents preview|export|refresh|cleanup`) ignores the disable lists entirely.

A user who disables a persona on OpenCode still gets it on Pi. `HARNESSES.md` records the skill gap as a known limitation.

Filtering the export exposes two existing defects in its stale-file path:
- `refresh` rebuilds the manifest from the desired set only. A file that leaves the set stays on disk unowned, so pi-subagents keeps loading it, a later export refuses it, and cleanup can't remove it.
- A hand-edited, manifest-owned stale file makes `findStalePaths` throw, so the whole export aborts with nothing written. Preview still reports the file as a removal.

This plan is a prerequisite for `docs/plans/2026-10-20-003-feat-pi-subagents-package-agents-plan.md` (branch `feat/pi-subagents-package-agents`).

## Requirements Trace

**Pi runtime**
- R1. `systematic_skill` excludes skills in the effective `disabled_skills`. Its description and hint omit them. Loading one returns the same not-found error as an unknown skill.
- R2. The `systematic_delegate` catalog excludes personas disabled by `disabled_agents` (bare stem or `category/stem`) or by an `agents.<key>.disable` overlay. Its description, hint, lookup and unknown-persona error all reflect the filtered set.

**Export**
- R3. Export generation excludes disabled curated personas, using the same rule.
- R4. `refresh` removes manifest-owned stale files whose hash matches, with the lock and rollback that `export` already uses. It reports the removals.
- R5. A manifest-owned stale file whose hash has drifted is left in place and retained in the manifest with its previous entry unchanged. Preview, export and refresh list it in a separate "still active" section that names the file, and the run continues and exits 0.
- R6. Preview's planned removals agree with what export actually does, including the hash check.

**Parity and docs**
- R7. The Pi disable rule matches OpenCode for bare names, qualified names and overlay keys, and a test pins this.
- R8. The docs describe the new behavior, including that Pi's native `pi.skills` discovery still lists disabled skills.

## Scope Boundaries

- Pi's native skill discovery (`package.json` `pi.skills`, `/skill:name`) is not filtered. This is documented.
- Overlays, profiles and the packaged-persona path are unchanged.
- `src/lib/config-handler.ts` and `src/lib/agent-overlays.ts` keep their inline disable logic.
- `buildAgentCatalog` and `generateAll` stay config-neutral. Their duplicate checks and the committed fixtures keep seeing the full inventory.
- A project-level disable does not affect a global-scope export. A global export never reads project config, by design.

### Deferred to Separate Tasks

- `src/cli.ts` `collectAgentFact` counts the full bundled inventory. Whether disabled personas should count is a possible follow-up.
- `skill-resolver.ts` `getAllSkills` ignores `disableModelInvocation` when loading. This predates this change.

## Context & Research

### Relevant Code and Patterns

- `src/index.ts`: OpenCode passes `config.disabled_skills` into the shared skill resolver. Pi should copy this wiring.
- `src/pi.ts`:
  - `systematicPiExtension` builds `resolverOptions` before `loadConfigWithSources(process.cwd())` runs.
  - It builds the catalog through the injectable `buildAgentCatalog` dep, inside a try/catch.
- `src/lib/skill-resolver.ts` and `src/lib/skill-catalog.ts` already filter `disabledSkills` for the listing, the hint and resolution.
- `src/lib/agent-resolver.ts` `buildAgentCatalog`: each entry carries `key` (file stem), `category`, `id` and frontmatter `name`. It fails closed on duplicate names.
- `src/lib/pi-delegate-tool.ts` `createPiDelegateTool` derives every persona-facing string and the lookup from the catalog it receives.
- `src/lib/config.ts`:
  - `collectRoutingTargets` contains a private disable closure: bare stem or `category/stem` in `disabled_agents`, or an overlay `disable` checked bare first, then qualified.
  - `loadConfigWithSources` merges `disabled_*` lists as a union across sources and drops known-removed names with a warning.
- `src/lib/config-handler.ts` `collectAgents` is the OpenCode reference behavior and the oracle for the parity test.
- `src/lib/pi-subagents-export.ts`:
  - `generateEntries` runs `generateAll` and then applies overlays.
  - `parseSourceCategoryAndKey` and `lookupOverlay` map `sourceRelPath` to a category and key.
  - `planRemoveActions` checks existence but not the hash.
  - `findStalePaths` throws on drift.
  - `refresh` builds its manifest from `toUpdate + toKeep`.
  - `runWithRollback` is the transaction.
- `src/cli.ts`: `runRefresh` prints "All owned persona files are up to date. No changes." whenever nothing was updated.
- `docs/src/content/docs/reference/configuration.mdx` is generated from `config-schema.ts` descriptions by `docs/scripts/generate-config-reference.ts`.

### Institutional Learnings

- `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md`:
  - Filter during export planning.
  - Remove only manifest-owned files, after a hash check.
  - Keep the locks, bounded paths and rollback.
  - Cover remove-only plans.
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`: consume the existing merged disable semantics, and don't change trust rules. Project config may already disable.
- `docs/solutions/best-practices/removing-config-key-strict-schema-2026-10-19.md`: stale names in the disable lists keep the accept-warn-drop path.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md`: the Pi bootstrap inputs must not change. The bootstrap reads no disable settings.
- `docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md`: pin `systematic_skill` behavior at the Pi adapter boundary.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`: use hermetic config with no ambient user config, and include positive controls.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "repo root package: src/, skills/, agents/, scripts/generate-pi-subagents-personas.ts, tests/unit (docs workspace excluded)",
  "freshness": {
    "vcs_reference": "9c9de96f"
  },
  "budget": {
    "max_search_passes": 24,
    "max_candidate_inspections": 40,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/skill-resolver.ts:resolveSkill",
      "description": "Resolves a requested skill after filtering disabledSkills; disabled and unknown names throw the same not-found error listing enabled skills.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/skill-catalog.ts:buildCatalogEntries",
      "description": "Filters bundled skills by disabledSkills for the systematic_skill description and parameter hint.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/pi.ts:systematicPiExtension",
      "description": "Pi extension init; hardcodes disabledSkills to an empty array and builds the delegate catalog unfiltered.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config.ts:loadConfigWithSources",
      "description": "Merges disabled_skills and disabled_agents as a union across sources and drops known-removed names with a warning.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config.ts:collectRoutingTargets",
      "description": "Private isDisabled closure over the disabled_agents set and raw agent overlays; the only harness-neutral persona-disable predicate.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/agent-resolver.ts:buildAgentCatalog",
      "description": "Config-neutral Pi persona catalog with key, category, id and name per entry; fails closed on duplicate names.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/pi-delegate-tool.ts:createPiDelegateTool",
      "description": "Derives the delegate description, hint, lookup and unknown-persona error from the supplied catalog.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config-handler.ts:collectAgents",
      "description": "OpenCode emission filter with an inline disable check over an alias-resolved overlay map.",
      "disposition": "insufficient",
      "insufficiency_reason": "Inline OpenCode adapter logic over a different data shape; used here as the parity oracle, not shared."
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:generateEntries",
      "description": "Generates curated entries, loads config for the chosen scope and applies overlays; applies no persona disable filter.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:parseSourceCategoryAndKey",
      "description": "Maps a curated entry's sourceRelPath to its category and agent key.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:planRemoveActions",
      "description": "Preview removal plan that checks existence but not hash, so it can disagree with export.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:findStalePaths",
      "description": "Collects manifest-owned stale files for deletion and throws on hash drift before any write.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:refresh",
      "description": "Updates desired owned files and rewrites the manifest from desired entries only; never removes stale owned files.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:cleanup",
      "description": "Removes every manifest-owned file with a hash guard; config-neutral.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-personas.ts:generateAll",
      "description": "Config-neutral curated render shared by the export and the committed fixtures.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/removed-names.ts",
      "description": "Known-removed skill and agent names accepted in disabled lists and dropped with a warning.",
      "disposition": "reuse"
    }
  ],
  "excluded_scopes": [
    {
      "scope": "src/lib/opencode-workflow-guard.ts and workflow-guard modules",
      "reason": "Unrelated to skill or persona disable."
    },
    {
      "scope": "registry/registry.jsonc and scripts/generate-registry.ts",
      "reason": "Regenerated only on agent or skill content edits; this work changes neither."
    },
    {
      "scope": "@tintinweb/pi-subagents runtime",
      "reason": "External consumer outside the concern boundary."
    }
  ]
}
```

## Key Technical Decisions

- **One exported predicate, extracted from `config.ts`.** The private disable closure in `collectRoutingTargets` becomes an exported pure function over the disabled set, the raw agent overlays, a category and a key. Its current caller, Pi and the export all use it.
  - The OpenCode runtime copies in `config-handler.ts` and `agent-overlays.ts` run on different data shapes, and this fix leaves them alone.
  - A parity test against `collectAgents` guards against drift.
  - No new `src/lib` module is created, so no codemap or module-table rows are needed.
- **Filter after building, not inside the builders.** Pi filters the catalog right after `buildAgentCatalog`. The export filters inside `generateEntries`, after `generateAll`.
  - Both builders stay config-neutral, so duplicate-name checks and the committed fixtures still cover the full inventory.
  - One catalog filter covers the delegate's description, hint, lookup and error.
- **A conflicting bare and qualified overlay disables.** OpenCode rejects a config that holds both a bare and a qualified overlay for one persona, as a duplicate overlay target. Pi's predicate treats the persona as disabled when either key disables it. That is the fail-safe direction for a config OpenCode won't load anyway.
- **Match on stem and category, never on the frontmatter name.** `disabled_agents` keys on the file stem. Catalog entries carry `key` and `category`, and export entries carry `sourceRelPath`.
  - The frontmatter name equals the stem for every bundled persona today. A test pins that equality.
- **Config loads before the skill resolver is built.** Pi already loads config at init and fails hard on invalid names. Only the order changes, and the bootstrap inputs stay the same.
- **`refresh` removes stale owned files, matching `export`.** It reuses `findStalePaths` inside its existing transaction. The new manifest keeps desired entries plus retained drifted entries.
  - Without this, disabling a persona and running `refresh` leaves a live, unowned file that nothing can remove.
- **Hand-edited stale files are skipped, not fatal.** A drifted, manifest-owned stale file stays on disk and stays in the manifest, and the run continues. Marcus chose this over keeping the abort.
  - pi-subagents keeps loading that persona until the file is gone. The CLI therefore prints it under its own heading, "Still active in pi-subagents (edited since export, left in place)". Each line names the file and says to revert or delete it to finish. The exit code stays 0, a choice Marcus made over a non-zero exit.
  - The reason text depends on the case. One case is a persona the user disabled. The other is a persona dropped from the curated set on upgrade.
  - The retained file's previous manifest entry (filename, hash, status) carries over to the new manifest unchanged. It is never rehashed from disk. Rehashing would make the user's edited file look owned and unchanged, and the next run would delete it.
  - Ownership stays truthful, and the file is removed on the first run after the user reverts or deletes it.
  - The same tolerance applies when a package upgrade drops a persona from the curated set.
  - Re-enabling the persona overwrites the owned file, as export already does for any enabled drifted file.
- **Preview checks hashes.** `planRemoveActions` reports a drifted stale file as refused, not as a removal, so preview matches export.
- **The release is a `fix(pi)` patch with a behavior-change note.** It makes documented settings work on Pi. Users who set them and saw no effect will now see personas and skills disappear, and the release notes say so.

## Open Questions

### Resolved During Planning

- Does a project-level disable affect a global export? No. Global export loads config with `includeProject: false`, so project config never changes global files. This is documented and tested.
- Can profiles disable personas? No. The strict profile bundle schema rejects both `disabled_agents` and `disable`.
- Does the Pi bootstrap need filtering? No. It lists no skills.
- What does an invalid disable name do? It fails config load, as it does today. That fails Pi init and export generation, by design.
- What does the refresh result carry? `removed` and `retained` arrays of `{filename, reason}`, mirroring `ExportResult.refused`. Summary counts derive from them, and the CLI prints filenames from them.
- Do the config reference docs need new wording? No. The `disabled_skills` and `disabled_agents` schema descriptions already say the settings apply globally, so the generated reference stays as it is.

### Deferred to Implementation

- The exact name and argument shape of the exported predicate. Settle these against `collectRoutingTargets` and `lookupOverlay` when extracting.

## Implementation Units

- [x] **Unit 1: Shared disable predicate and Pi runtime wiring**

**Goal:** `systematic_skill` and `systematic_delegate` on Pi exclude disabled skills and personas.

**Requirements:** R1, R2, R7

**Dependencies:** None

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/pi.ts`
- Test: `tests/unit/pi.test.ts`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/disable-parity.test.ts`

**Approach:**
- Extract the disable closure into an exported function in `config.ts`, and have `collectRoutingTargets` call it.
- In `systematicPiExtension`, load config before building `resolverOptions`. Pass `config.disabled_skills`, and filter the built catalog with the predicate. The filter applies to the catalog `buildAgentCatalog` returns, including any injected via deps.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `src/index.ts` disabled-skills wiring.
- The hermetic config-file tests in `tests/unit/pi.test.ts`.

**Test scenarios:**
- Happy path: with `disabled_skills: [<skill>]`, the `systematic_skill` description and parameter hint omit the skill, and loading it returns not-found. An enabled skill still loads.
- Happy path: a bare `disabled_agents` entry, a `category/name` entry, a bare-key `agents.<key>.disable` overlay and a qualified-key overlay each remove that persona from the delegate description, hint and lookup. Each unknown-persona error lists only enabled personas. An enabled persona still resolves.
- Edge case: disabling every persona registers the tool with an empty catalog and does not throw.
- Edge case: a known-removed name in `disabled_agents` or `disabled_skills` warns and has no other effect.
- Edge case: every bundled persona's frontmatter name equals its file stem.
- Integration (parity): build a fixture matrix with rows for bare names, qualified names, overlay-bare, overlay-qualified and non-matching names. For each row, assert:
  - the predicate's disabled set equals a literal expected list;
  - the personas OpenCode's exported `createConfigHandler` omits equal the same list;
  - every disabling row yields a non-empty set.

  `collectAgents` is private, so the test goes through the handler.
- Edge case: a bare plus a qualified overlay for one persona, where only one sets `disable`, leaves the persona disabled on Pi.
- Isolation: Pi tests mock `os.homedir` (the existing `pi.test.ts` pattern) and unset `OPENCODE_CONFIG_DIR`. Project-scope cases `process.chdir` to a temp dir and restore it in `finally`. There is no ambient user config.

**Verification:**
- The unit suite passes.
- Each of these mutations fails a named test: reverting `disabledSkills` to an empty list, skipping the catalog filter, dropping the qualified-name branch, and dropping the overlay branch.

- [x] **Unit 2: Filter the export and align preview with export**

**Goal:** `preview` and `export` exclude disabled curated personas. A hand-edited stale file is reported and left in place, not fatal.

**Requirements:** R3, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/pi-subagents-export.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/pi-subagents-export.test.ts`
- Test: `tests/unit/cli.test.ts`

**Approach:**
- In `generateEntries`, drop entries whose category and key the predicate disables, after config loads for the chosen scope.
- `findStalePaths` separates hash-matching stale files, which it removes, from drifted ones, which it retains.
- The export manifest carries each retained file's previous entry over unchanged.
- `runExport` prints retained files under the "still active" heading. The existing refused heading is reserved for unowned files.
- `planRemoveActions` applies the same hash check, and preview shows drifted files in the same "still active" form.

**Execution note:** Implement test-first.

**Patterns to follow:**
- The existing hash-gated deletion tests and the `{scope, cwd}` config tests in `tests/unit/pi-subagents-export.test.ts`.

**Test scenarios:**
- Happy path: after an export, disabling an exported persona and exporting again removes its owned, unchanged file and drops it from the manifest. Other files are untouched.
- Happy path: preview for the same state lists that file as a removal.
- Edge case: a hand-edited owned file for a disabled persona remains on disk, and its manifest entry is byte-identical to the previous one. Export returns ok, the CLI prints the file under "still active" and exits 0, and the other personas are still updated. Preview shows it the same way.
- Edge case: a second export or refresh after that does not delete the hand-edited file.
- Edge case: once the user reverts the file to its exported content, the next export removes it.
- Edge case: an unowned file with a disabled persona's name is untouched.
- Edge case: a manifest entry whose file is already gone is dropped without error.
- Edge case: a disabled persona outside the curated set changes nothing.
- Edge case: re-enabling a removed persona and exporting re-creates its file.
- Integration: a project-only disable leaves global-scope export output unchanged, and a project-scope export honors it.
- Integration: `cleanup` behaves the same with and without disable settings.

**Verification:**
- The unit suite passes.
- Each of these mutations fails a named test: removing the `generateEntries` filter, flipping `includeProject`, and dropping the preview hash check.

- [x] **Unit 3: Remove stale owned files on refresh**

**Goal:** `refresh` removes manifest-owned stale files under the same rules as `export`, and the CLI reports the removals.

**Requirements:** R4, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/pi-subagents-export.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/pi-subagents-export.test.ts`
- Test: `tests/unit/cli.test.ts`

**Approach:**
- `refresh` collects stale paths with the Unit 2 split. It unlinks the hash-matching ones inside its existing `runWithRollback` transaction, rechecking the hash before each unlink. It builds the manifest from updated and kept entries plus the retained entries carried over unchanged.
- If a file drifts between planning and unlink, the hash recheck throws. The whole refresh then rolls back and returns an error. This is deliberately fail-closed.
- `RefreshResult` gains `removed` and `retained` arrays.
- `runRefresh` prints removals and "still active" files. It prints "No changes" only when nothing changed.
- CLI tests pass a temp `HOME` and `OPENCODE_CONFIG_DIR` through `runCli`'s `extraEnv`, as the config-show tests do.

**Execution note:** Implement test-first.

**Test scenarios:**
- Happy path: disabling an exported persona and then running `refresh` removes its owned, unchanged file, drops it from the manifest and reports one removal. A follow-up `export` raises no unowned-file refusal.
- Edge case: a hand-edited owned file for a disabled persona is retained in the manifest and reported. Refresh succeeds.
- Edge case: when the only changes are removals, refresh does not print "No changes".
- Error path: if an unlink fails partway, rollback restores the removed files and the previous manifest.
- Error path: a file edited after planning but before unlink makes refresh roll back and report an error, and the file is untouched.

**Verification:**
- The unit suite passes.
- Each of these mutations fails a named test: removing refresh's stale removal, and removing its hash guard (which would delete a hand-edited file).

- [x] **Unit 4: Document the new Pi behavior**

**Goal:** Docs state that Pi honors the disable settings and where it doesn't.

**Requirements:** R8

**Dependencies:** Units 1-3

**Files:**
- Modify: `HARNESSES.md` (the "Pi does not consume `disabled_skills`" paragraph and the stale PI-6 evidence citation)
- Modify: `docs/src/content/docs/guides/pi-subagents.mdx`

**Approach:**
- `HARNESSES.md` and the guide cover:
  - what Pi now honors and that a Pi restart applies it;
  - that native `pi.skills` and `/skill:name` still list disabled skills;
  - export and refresh removal of owned, unchanged files;
  - hand-edited files that are left in place;
  - that project disables don't affect a global export, so hiding a persona everywhere needs a user-config disable;
  - that a disabled persona outside the curated set is still removed from the Pi delegate catalog, and that export ignores it;
  - that re-enabling a persona overwrites a hand-edited exported file.

**Test scenarios:**
- Test expectation: none. This is documentation, and the gates below check it.

**Verification:**
- `bun run docs:build` succeeds.
- `bun scripts/content-integrity.ts` is clean, including solution-doc citations.
- markdownlint passes on the changed Markdown.

## System-Wide Impact

- **Interaction graph:**
  - Pi init now reads the disable lists.
  - The export lifecycle (preview, export, refresh) changes how it treats stale files.
  - OpenCode behavior is unchanged. The predicate extraction keeps `collectRoutingTargets` behavior, which the existing routing tests cover.
- **State lifecycle risks:**
  - `refresh` now deletes files. It deletes only manifest-owned, hash-matching files, inside a lock and rollback.
  - Drifted files are never deleted.
- **API surface parity:**
  - The parity test ties Pi to OpenCode's disable semantics.
  - Packaged personas (the follow-up plan) can't see config. That plan documents `/agents → Disable` as their per-persona off switch.
- **Unchanged invariants:**
  - Trust rules are unchanged.
  - Profiles still can't disable.
  - Invalid names still fail init.
  - `cleanup` stays config-neutral.
  - The committed fixtures stay config-neutral.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Users who set disable fields long ago are surprised when personas or skills vanish on Pi | A behavior-change note in the PR, commit bodies and docs. |
| `refresh` deleting a file the user still wants | It deletes only manifest-owned, hash-matching files for personas that left the desired set, under rollback. Drifted files are kept. |
| The skip-on-drift tolerance hides a persona dropped from the curated set on upgrade | It is reported as refused on every run until resolved, and the PR notes it. |
| The predicate drifts from OpenCode | Parity matrix test with literal expected sets. |
| A project disable leaves a globally exported persona live in that project's pi-subagents | Documented. A user-config disable hides it everywhere. |
| A disabled persona with a hand-edited file stays live in pi-subagents | A separate "still active" CLI section names the file and the fix on every run. |

## Documentation / Operational Notes

- PR title: `fix(pi): honor disabled skills and agents on Pi`. Patch release. Commit bodies are public prose, because the release notes read them.

## Sources & References

- Follow-up plan: `docs/plans/2026-10-20-003-feat-pi-subagents-package-agents-plan.md` (branch `feat/pi-subagents-package-agents`)
- Related code: `src/pi.ts`, `src/lib/config.ts`, `src/lib/pi-subagents-export.ts`, `src/lib/config-handler.ts`
