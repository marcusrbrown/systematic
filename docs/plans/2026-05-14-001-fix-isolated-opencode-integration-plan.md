---
title: fix: Isolate OpenCode integration tests
type: fix
status: active
date: 2026-05-14
---

# fix: Isolate OpenCode integration tests

## Overview

Systematic's live OpenCode integration tests should stop creating sessions and state in the real project/user OpenCode environment. The default integration path should exercise the local checkout under test, while mixed installed-version behavior should be covered by explicit scenarios rather than accidental user-config bleed-through.

## Problem Frame

`tests/integration/opencode.test.ts` currently runs `opencode run` from a temporary project and injects `OPENCODE_CONFIG_CONTENT`, but the spawned OpenCode process still inherits the developer's OpenCode environment and does not receive an isolated `OPENCODE_CONFIG_DIR`, XDG directories, or disabled first-boot side-effect flags. That allows test sessions to appear in the real OpenCode TUI session list and can let global user plugins/config affect test results.

The sibling `opencode-copilot-delegate` integration tests use a cleaner fixture shape: per-test temp project, isolated config directory, `OPENCODE_CONFIG_CONTENT` for the plugin under test, and `OPENCODE_DISABLE_*` flags for irrelevant first-boot paths. Systematic should adopt that pattern while preserving coverage for its own plugin-specific config behavior.

## Requirements Trace

- R1. Live OpenCode integration tests must not write sessions, config, cache, or state into the real project/user OpenCode environment.
- R2. Default integration tests must load the local checkout under test. Source-local coverage means `file://src/index.ts`; dist-local coverage means `file://dist/index.js`. Both paths should be explicit, with source-local always available and dist-local guarded by a clear build prerequisite.
- R3. Mixed installed-version behavior, such as npm/global `@fro.bot/systematic` plus local `file://src/index.ts`, must be tested explicitly and separately.
- R4. Existing `systematic_skill` prefix/no-prefix smoke coverage must keep proving the tool can load `setup` through OpenCode.
- R5. Existing config-hook integration tests must keep covering config overlays, validation, command/skills-path registration, color schema safety, and JSONC project config loading.
- R6. Fixture cleanup must be deterministic and restore process globals/environment variables after each test.
- R7. Tests should fail with enough subprocess stderr/context to diagnose OpenCode startup or plugin-loading failures.

## Scope Boundaries

- Do not change Systematic runtime behavior.
- Do not change bundled skill, agent, or registry output.
- Do not depend on Marcus's user-level OpenCode config for ordinary integration tests.
- Do not require globally installed `@fro.bot/systematic` for the default integration suite.
- Do not make mixed-version coverage run accidentally through inherited config; it must opt in explicitly.

### Deferred to Separate Tasks

- Broader OpenCode session-storage cleanup tooling: not needed if tests are hermetic.
- Replacing LLM-driven OpenCode tests with lower-level OpenCode API probes: not part of this isolation migration.

## Context & Research

### Relevant Code and Patterns

- `tests/integration/opencode.test.ts` currently contains both in-process config-hook integration tests and live `opencode run` smoke tests.
- `tests/integration/opencode.test.ts` already uses temp dirs and `OPENCODE_CONFIG_CONTENT`, but the child process inherits most environment variables and lacks child-side OpenCode config/state isolation.
- `tests/unit/plugin.test.ts`, `tests/unit/config-handler.test.ts`, and `tests/unit/model-availability.test.ts` demonstrate temp home/config isolation and restoration patterns.
- `tests/manual/session-compacting-probe.ts` and `tests/manual/companion-aware-probe.ts` demonstrate temp project plus `OPENCODE_CONFIG_CONTENT` probe patterns.
- `package.json` defines `bun run build`, `bun test tests/integration`, and `dist/index.js` as the package entrypoint.
- Sibling `opencode-copilot-delegate` integration tests provide the target shape: temp project, temp config dir, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_MODELS_FETCH`, and `OPENCODE_DISABLE_PRUNE`.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`: OpenCode may invoke plugin factories once per config source; tests must use fresh OpenCode processes when validating plugin-registration changes.
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`: config source trust boundaries matter; tests must distinguish user/config-dir/project config instead of allowing accidental source mixing.
- `docs/solutions/developer-experience/git-auto-merge-silent-identifier-duplication-2026-05-09.md`: avoid duplicated isolation scaffolding when extending integration tests; centralize fixtures.

### External References

- No web research needed. The relevant external pattern is the local sibling repository's OpenCode integration fixture design.

## Key Technical Decisions

- Centralize live OpenCode spawning behind an isolated fixture helper: avoids repeating partial isolation across tests.
- Isolate more than `OPENCODE_CONFIG_DIR`: set temp `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` so OpenCode and Systematic cannot read/write real user state through alternate path helpers.
- Keep ordinary integration coverage local-only: source-local smoke always loads `file://src/index.ts`; dist-local smoke loads `file://dist/index.js` only when the built artifact exists or after an explicit build prerequisite.
- Add one explicit mixed-version scenario: load a pinned package spec such as `@fro.bot/systematic@2.14.1` plus local `file://src/index.ts` in the same isolated OpenCode config, with package resolution rooted in temp OpenCode/npm cache directories so it cannot silently use the developer's user config.
- Keep config-hook tests in-process: they are faster, deterministic, and already test Systematic config mutation without needing a live OpenCode subprocess.
- Build the child process environment from a narrow allowlist. Preserve only the variables OpenCode needs to run the selected test model and package resolution; explicitly override OpenCode config/path variables and redact token-bearing values from captured diagnostics.

## Open Questions

### Resolved During Planning

- Should default tests use the global installed package? No. They should load local Systematic so CI and local runs test the checkout.
- Should source or dist be the default local target? Source-local should remain the always-available live smoke target because `bun test tests/integration` does not build first. Dist-local coverage should be explicit and guarded by `dist/index.js` existence or a build prerequisite.
- Should mixed installed-version behavior be covered? Yes, but only in an explicit isolated scenario.
- Is `OPENCODE_CONFIG_DIR` alone enough? No. Sandbox HOME/XDG directories too because OpenCode and plugins can read/write config, cache, data, and state through multiple roots.

### Deferred to Implementation

- Whether dist-local coverage should be part of `bun test tests/integration` when `dist/index.js` is present or split into a separate script: decide during implementation based on clean CI behavior.
- Whether mixed-version coverage should be enabled by default or gated behind package-resolution availability: decide after confirming OpenCode's behavior with an isolated temp npm cache and pinned package spec.

## Implementation Units

- [x] **Unit 1: Introduce isolated OpenCode fixture**

**Goal:** Centralize live OpenCode subprocess setup so every integration run uses temp project/config/state roots and a diagnostic result wrapper.

**Requirements:** R1, R6, R7

**Dependencies:** None

**Files:**
- Modify: `tests/integration/opencode.test.ts`

**Approach:**
- Add a fixture type that owns a temp root, temp project dir, temp config dir, temp home, and temp XDG config/data/cache/state dirs.
- Create a minimal `package.json` in the temp project so OpenCode treats it as an isolated project root instead of walking into the real repo.
- Update the live `runOpencode` helper to set isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_CONFIG_DIR`, and first-boot disable flags.
- Build the child environment from an allowlist. Include `PATH`, model/provider auth needed for the selected `opencode/*` test model, npm resolution variables only when required for pinned package tests, and explicit test overrides. Do not forward host `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, or OpenCode path/config variables.
- Redact token-bearing values (`TOKEN`, `KEY`, `SECRET`, `PAT`, `AUTH`) from failure diagnostics before including stdout/stderr in assertion errors.
- Add an `assertOk`-style helper that includes bounded stderr/stdout context on failure.

**Execution note:** Characterization-first: before changing live tests, identify what files/directories the current fixture creates in temp dirs and preserve the successful `systematic_skill` smoke behavior.

**Patterns to follow:**
- `tests/integration/opencode.test.ts` existing temp fixture and `runOpencode` helper.
- `tests/unit/config-handler.test.ts` temp home restoration pattern.
- `tests/manual/session-compacting-probe.ts` env-injected OpenCode probe pattern.

**Test scenarios:**
- Happy path: live OpenCode smoke runs with isolated env and still loads `systematic:setup` through `systematic_skill`.
- Edge case: temp fixture cleanup removes project/config/state roots after each test.
- Edge case: parent process OpenCode config variables are ignored or overwritten by the fixture.
- Error path: a failing `opencode run` reports exit code and stderr tail instead of only a numeric assertion failure.
- Integration: after a run, OpenCode-created session/state files exist only under the temp fixture roots, not under the repo working tree.

**Verification:**
- Live integration tests pass when `opencode` is available.
- A local run no longer adds sessions to the real project TUI session list.

- [x] **Unit 2: Make local source and dist targets explicit**

**Goal:** Ensure ordinary integration tests load local Systematic through named source-local and dist-local targets rather than an implicit global package.

**Requirements:** R2, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/integration/opencode.test.ts`
- Possibly Modify: `package.json`

**Approach:**
- Replace the current generic `buildOpencodeConfig()` with target-specific helpers: source-local (`file://src/index.ts`) and dist-local (`file://dist/index.js`).
- Keep source-local as the always-available default for `bun test tests/integration` because the integration script does not build first.
- Add dist-local smoke coverage behind an explicit `dist/index.js` existence guard or a clearly named build-required test path. The failure/skip message must say to run `bun run build`.
- Keep the existing prefix and no-prefix `systematic_skill` cases on the source-local target; add a minimal dist-local smoke that proves the built plugin registers `systematic_skill` and can load one stable skill.

**Patterns to follow:**
- `package.json` build entrypoint and exports.
- Sibling isolated integration fixture's “dist must exist” guard.

**Test scenarios:**
- Happy path: source-local plugin loads `systematic:setup` with `systematic:setup` input.
- Happy path: source-local plugin loads `setup` without prefix.
- Happy path: dist-local plugin registers `systematic_skill` and loads `setup` when `dist/index.js` exists.
- Edge case: missing dist artifact produces an actionable failure if dist is part of the selected target.
- Integration: local plugin target does not depend on global `@fro.bot/systematic` being installed.

**Verification:**
- `bun test tests/integration` exercises source-local checkout behavior even without a prior build, and dist-local coverage is explicit when the built artifact exists.

- [x] **Unit 3: Add explicit mixed-version coverage**

**Goal:** Cover global/npm plus local plugin interaction intentionally, without inheriting Marcus's user config.

**Requirements:** R1, R3, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/integration/opencode.test.ts`

**Approach:**
- Add a dedicated test or describe block that builds `OPENCODE_CONFIG_CONTENT` with three fixture-owned entries: pinned package Systematic, an optional probe plugin, and local source Systematic.
- Resolve the package side through an exact package spec (for example `@fro.bot/systematic@2.14.1`) with npm/OpenCode cache directories rooted under the temp fixture. Do not rely on the developer's globally configured plugin list.
- If package resolution cannot be made hermetic enough for ordinary CI, gate the mixed-version test behind an explicit environment variable and document that it is an intentional compatibility probe.
- Use a probe plugin when needed to capture host-visible system/tool surfaces without requiring changes to runtime code. If the probe runs between package and local entries, it can snapshot package-only state before the local plugin rewrites the marker block; a second probe or final capture can verify the converged final state.
- Assert the observable compatibility contract: `systematic_skill` remains callable under pinned-package plus local-source registration, and duplicate bootstrap blocks converge to one marker block in the final system prompt.
- Keep this test separate from ordinary local smoke coverage so failures point to mixed-version behavior, not normal plugin functionality.

**Patterns to follow:**
- `tests/unit/plugin.test.ts` duplicate-registration expectations.
- The ad hoc isolated probe from this session: package plugin plus local file plugin plus probe plugin capturing system/tool surfaces.

**Test scenarios:**
- Happy path: mixed package/local config can load a Systematic skill through `systematic_skill`.
- Integration: probe/captured evidence shows the mixed package/local config still exposes deterministic host-visible `systematic_skill` tool definitions.
- Integration: final system prompt contains exactly one complete `<SYSTEMATIC_WORKFLOWS>` marker block after both plugins run.
- Integration: if tool definitions are captured, duplicate `systematic_skill` definitions are identical or otherwise deterministically safe.
- Error path: package resolution failure reports which plugin spec failed without leaking token-bearing environment values.

**Verification:**
- Mixed-version test passes in isolation and does not require global user OpenCode config.

- [x] **Unit 4: Consolidate leakage assertions and fixture documentation**

**Goal:** Keep isolation guarantees understandable and regression-tested without duplicating the fixture setup from Unit 1.

**Requirements:** R1, R6, R7

**Dependencies:** Units 1-3

**Files:**
- Modify: `tests/integration/opencode.test.ts`

**Approach:**
- Add helper-level comments documenting why `OPENCODE_CONFIG_DIR`, HOME, XDG dirs, and `OPENCODE_DISABLE_*` flags are all set.
- Keep env scrubbing and path overrides in the Unit 1 helper; this unit only consolidates comments and regression assertions after all target modes exist.
- Add containment assertions around fixture-owned roots and avoid exact session filename assumptions.
- Add one regression case proving parent `OPENCODE_CONFIG_CONTENT`/`OPENCODE_CONFIG_DIR` values do not override the fixture's test-specific config.

**Patterns to follow:**
- Sibling integration test comments around OpenCode isolation.
- `tests/unit/config-handler.test.ts` restore/cleanup style.

**Test scenarios:**
- Edge case: parent process has `OPENCODE_CONFIG_DIR` set, but the fixture overrides it for the child.
- Edge case: parent process has `OPENCODE_CONFIG_CONTENT` set, but test-specific config wins.
- Integration: test-created OpenCode state is rooted under fixture paths at the directory-boundary level.

**Verification:**
- Repeated integration runs do not create new sessions in the real project TUI list.
- The test file has one shared isolation path rather than duplicated env scaffolding.

## System-Wide Impact

- **Interaction graph:** Only tests change. Runtime plugin hooks remain unchanged.
- **Error propagation:** Subprocess failures should surface bounded stdout/stderr context through test errors.
- **State lifecycle risks:** Main risk is OpenCode writing sessions/cache/state outside temp dirs; fixture isolation and leakage assertions mitigate it.
- **API surface parity:** Local source/dist and mixed-version plugin specs are distinct test targets and should be named accordingly.
- **Integration coverage:** Live OpenCode smoke continues to prove `systematic_skill` works through the actual CLI, while mixed-version coverage proves duplicate registration remains safe.
- **Unchanged invariants:** Config-hook integration tests keep running in-process and should not require live OpenCode unless they explicitly test CLI behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Live OpenCode tests become slower or flakier. | Keep smoke cases minimal, preserve skip when `opencode` is unavailable, and use bounded timeouts. |
| Dist-based tests fail before build. | Keep source-local as the default and guard dist-local coverage with `dist/index.js` existence or an explicit build prerequisite. |
| Mixed-version test depends on network/package resolution. | Pin the package spec, root npm/OpenCode caches under the fixture, and gate the test if hermetic package resolution is not available. |
| Environment scrubbing removes auth/model variables needed by OpenCode. | Define an allowlist for required model/package-resolution variables and redact token-bearing diagnostics. |
| Environment forwarding leaks credentials into logs or session artifacts. | Do not forward broad `process.env`; redact captured subprocess output before assertion errors. |
| Leakage assertion overfits OpenCode's internal storage layout. | Assert high-level roots and fixture containment rather than exact session filenames. |

## Documentation / Operational Notes

- Add comments in the integration fixture explaining why it must not use the real user OpenCode config.
- If `bun test tests/integration` requires `bun run build` for dist coverage, document that in the test failure message and consider updating `package.json` scripts in a separate small follow-up if needed.

## Sources & References

- Current integration tests: `tests/integration/opencode.test.ts`
- Plugin duplicate-registration tests: `tests/unit/plugin.test.ts`
- Config isolation patterns: `tests/unit/config-handler.test.ts`, `tests/unit/model-availability.test.ts`
- Manual OpenCode probes: `tests/manual/session-compacting-probe.ts`, `tests/manual/companion-aware-probe.ts`
- Prior learning: `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`
- Prior learning: `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`
