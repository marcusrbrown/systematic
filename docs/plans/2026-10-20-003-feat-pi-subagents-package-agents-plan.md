---
title: "feat(pi): ship Systematic personas as pi-subagents package agents"
type: feat
status: active
date: 2026-10-20
---

# feat(pi): ship Systematic personas as pi-subagents package agents

## Overview

When Systematic is installed as a Pi package, pi-subagents 0.20+ should discover Systematic's curated personas with no export step. The npm package will carry a build-generated directory of default persona files and declare it under `pi.subagents.agents`. It will also add the `pi-package` gallery keyword. The pi-subagents interop contract in the docs and the Pi capability profile moves from pi-subagents 0.14.3 to 0.22.0 on Pi 1.3.0.

## Problem Frame

Today, a Pi user who wants Systematic's personas in pi-subagents must run `systematic pi-subagents export`. That command writes `systematic-*.md` files into `.pi/agents/` or the global agents directory. pi-subagents 0.20.0 added package-shipped agents: a package declares `pi.subagents.agents` in its `package.json`, and pi-subagents loads those files from every installed Pi package at the lowest precedence. Systematic already ships as a Pi package (`pi.extensions`, `pi.skills`), so it can offer its personas the same way. User-owned directories get no writes, and a user's own or exported files still win.

The docs and the Pi profile, which is inlined into every Pi session, still state "tested against pi-subagents v0.14.3". Main now pins pi-subagents 0.22.0 and Pi 1.3.0 (#1184, #1166). Since 0.18.0, pi-subagents runs an `Agent` call in the background unless the call passes `run_in_background: false`.

## Requirements Trace

- R1. Installing Systematic as a Pi package makes the curated `systematic-<name>` personas available to pi-subagents' `Agent` tool, with no export. Pi must have the package in `settings.json` `packages[]`, and pi-subagents ≥0.20 must be installed.
- R2. The packaged personas are the default render of the curated set, byte-identical to what the export writes with no config overlays.
- R3. Local persona files, whether exported or hand-written, keep outranking packaged ones. The export CLI does not change.
- R4. The packaged files are produced by `bun run build` under `dist/`, so the release build artifact and its digest carry them.
- R5. A real Pi host proves discovery and use from the packed tarball. A negative control shows the behavior depends on the package manifest.
- R6. The docs, HARNESSES and the Pi profile describe the 0.22.0 / Pi 1.3.0 contract:
  - packaged versus exported personas and their precedence;
  - the background default;
  - project trust;
  - unsupported install paths;
  - Pi's Node floor, which goes in the docs but not the profile.
- R7. The package lists the `pi-package` keyword.

## Scope Boundaries

- The `systematic pi-subagents preview|export|refresh|cleanup` behavior and output do not change.
- `systematic_delegate`, the bootstrap composition and the OpenCode and Claude Code surfaces do not change.
- `engines.node` stays `>=18`. Pi enforces its own `>=22.19.0`.
- No persona pins `run_in_background`, and no persona gains `name:`, `display_name` or `color`.
- No auto-detection of pi-subagents and no writes to user directories.
- No new CI step. The existing unit suite and Host Contract carry the gates.

### Deferred to Separate Tasks

- A ce:review reviewer fan-out shipped as a pi-subagents saved workflow (`pi.subagents.workflows`): its own plan, after this ships.
- `preview` and `export` noting that an exported file shadows a packaged persona, or is stale against it: a later follow-up.

## Context & Research

### Relevant Code and Patterns

- `src/lib/pi-subagents-personas.ts`:
  - `generateAll(repoRoot)` is the pure default render of `CURATED_PERSONAS`. It has 29 entries: 28 exported and 1 exported-with-warning.
  - It throws on a filename collision or on critical coupling.
  - Each entry is `{fileName: systematic-<sanitized>.md, content, hash}`, and its frontmatter is only `description:`.
- `src/lib/pi-subagents-export.ts`: `generateEntries(root)` with no options returns `generateAll(root)` unchanged. That shared default is what makes R2's byte-equality hold.
- `scripts/generate-pi-subagents-personas.ts`: it writes the committed fixtures `tests/fixtures/pi-subagents-personas/`, which are 29 `.md` files plus a timestamped manifest. It has a `--check` mode that `tests/unit/generate-pi-subagents-personas.test.ts` exercises.
- `package.json`:
  - The `build` chain is `rimraf dist`, then `bun build` for index/cli, then `bun build` for `src/pi.ts`, then `tsc --emitDeclarationOnly`.
  - `pi` is `{extensions: ["./dist/pi.js"], skills: ["./skills"]}`.
  - `files` includes `dist`.
- `.github/workflows/release.yaml`:
  - The build job runs `bun run build` and uploads `dist/` with a digest.
  - The publish job downloads `dist/` and installs with `--ignore-scripts`.
  - `prepublishOnly` therefore never runs in CI, and generated assets must come from `build` itself.
- `tests/unit/package-exports.test.ts`: it builds, runs `npm pack` and asserts paths inside the tarball. It exact-matches `pi.extensions` and `pi.skills` only.
- `tests/integration/pi.test.ts`:
  - The combined-path describe extracts the packed tarball into a project `packages[]` entry next to pi-subagents' package directory.
  - It drives the real `Agent` tool over Pi RPC with a mock model.
  - The export-based test asserts that the persona body reaches the child system prompt.
- `scripts/build-claude-code-plugin.ts`: precedent for an ephemeral bundle generated from `agents/` and `skills/`.
- pi-subagents 0.22.0:
  - `dist/package-resources.js` reads `pi.subagents` only from packages in Pi's `settings.json` `packages[]`, via `listConfiguredPackages()`. That rules out `node_modules` and `pi -e`. Project-scope packages are read only after the project is trusted.
  - `dist/custom-agents.js` loads package directories first, then global, `.agents/agents` and `.pi/agents`. Each later `Map.set` overwrites silently.
  - The type comes from `name:`, and falls back to the filename stem.
  - Package files over 1 MB, or malformed ones, are warned about and skipped.
  - Directories are scanned non-recursively for `*.md`.
  - The `packageAgents` setting gates the whole mechanism.

### Institutional Learnings

- `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md`: personas are generated projections, and nothing writes into user directories without a command. Packaging keeps that rule. It does supersede the doc's export-only activation path.
- `docs/solutions/best-practices/pi-real-runtime-integration-harness-2026-07-16.md` and `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`: prove discovery on the real host, from the shipped artifact.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`:
  - Build before `npm pack` and test the actual tarball.
  - A Pi local tarball install needs `npm:<name>@file:<abs.tgz>`.
  - Isolate HOME, XDG and npm state.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`: agent edits regenerate the Pi persona fixtures. This plan adds a second consumer of the same render.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md`: Pi profile edits go through the profile seam and refresh the bootstrap snapshot.
- `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`: new real-host tests count only inside the CI-required suite.

### External References

- pi-subagents `docs/packages.md` at v0.22.0: <https://github.com/tintinweb/pi-subagents/blob/v0.22.0/docs/packages.md>
- pi-subagents CHANGELOG at v0.22.0, for 0.18.0 background-by-default and 0.20.0 package agents: <https://github.com/tintinweb/pi-subagents/blob/v0.22.0/CHANGELOG.md>
- Pi `docs/packages.md` at v1.3.0, for the manifest keys Pi reads and the `pi-package` gallery keyword: <https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md>

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "package.json, scripts/, src/lib/pi-subagents-{personas,export}.ts, tests/fixtures/pi-subagents-personas, tests/{unit/package-exports,integration/pi}.test.ts, pi-subagents 0.22.0 loader",
  "freshness": {
    "vcs_reference": "b291bf56"
  },
  "budget": {
    "max_search_passes": 10,
    "max_candidate_inspections": 14,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "package.json (pi)",
      "description": "Pi package manifest: pi.extensions and pi.skills. pi-subagents reads a sibling pi.subagents key from the same object.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "package.json (scripts.build)",
      "description": "Build chain run by the release build job and by the pack-based tests. It must host the generation step because prepublishOnly does not run in the CI publish.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-personas.ts generateAll",
      "description": "Default, config-free render of the curated personas into systematic-<name>.md entries, with no writes.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-personas.ts CURATED_PERSONAS",
      "description": "Curated include list (29) shared by the export and the committed fixtures.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "scripts/generate-pi-subagents-personas.ts writeFixtures",
      "description": "Writes the committed fixtures plus a timestamped manifest into tests/fixtures/pi-subagents-personas.",
      "disposition": "insufficient",
      "insufficiency_reason": "Its write target is the unshipped fixture directory and it adds a timestamped manifest; generateAll is the reusable part."
    },
    {
      "path_or_symbol": "tests/fixtures/pi-subagents-personas",
      "description": "Committed default persona files, used as the byte-equality oracle.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts exportPersonas",
      "description": "Writes systematic-*.md into user agent directories with a manifest, a lock and rollback.",
      "disposition": "insufficient",
      "insufficiency_reason": "Writes into user directories on command; the concern is discovery from the installed package with no command."
    },
    {
      "path_or_symbol": "agents/ source tree",
      "description": "Source personas already shipped in the tarball, in category subdirectories.",
      "disposition": "insufficient",
      "insufficiency_reason": "Uncurated, unprefixed and nested; the loader scans one directory level and the curated screen excludes critical-coupled personas."
    },
    {
      "path_or_symbol": "scripts/build-claude-code-plugin.ts",
      "description": "Ephemeral generated bundle for the Claude Code plugin.",
      "disposition": "insufficient",
      "insufficiency_reason": "Targets claude-code/ with Claude Code identifiers and is not part of the package build; precedent only."
    },
    {
      "path_or_symbol": "pi-subagents 0.22.0 package-resources.js",
      "description": "Upstream loader for pi.subagents.agents from packages listed in Pi settings packages[].",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "tests/integration/pi.test.ts combined-path setup",
      "description": "Real Pi RPC harness that loads the packed Systematic tarball and pi-subagents as packages.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "tests/unit/package-exports.test.ts",
      "description": "Build plus npm pack assertions on tarball contents and pi manifest paths.",
      "disposition": "extend"
    }
  ],
  "excluded_scopes": [
    {
      "scope": "docs/ workspace",
      "reason": "Documentation is updated by this plan, not searched for a discovery seam."
    }
  ]
}
```

## Key Technical Decisions

- **The packaged directory is `dist/pi-subagents/agents/`, written by a new `scripts/build-pi-package-agents.ts` appended to `build`.**
  - The publish job only ships the built `dist/` artifact, with `--ignore-scripts`, so `prepublishOnly` is not an option.
  - The script removes and recreates its target. It writes only the `.md` entries from `generateAll`, with no manifest and no timestamp, so the output is deterministic.
  - `tsc`'s `rootDir` is `src`, which has no `pi-subagents` directory, so declaration emit cannot collide with it.
- **One render, two consumers.** The build reuses `generateAll`, so the packaged files are byte-identical to the committed fixtures and to a config-free export. The fixtures stay the oracle.
  - We don't commit a second copy. Marcus chose build-time generation for a single source of truth.
- **The files carry no `name:` frontmatter.** pi-subagents falls back to the filename stem, which gives `systematic-<name>`, the same type an export produces.
  - Adding `name:` only to the packaged copies would break byte-equality and make the export and package diverge.
  - The real-host test pins the fallback.
- **Packaged personas never get overlays.** `systematic.json` overlays (model, thinking, `max_turns`, tools, skills) apply only to exported files. An exported file shadows the packaged one silently, as the loader does.
  - This supersedes the earlier "export is the only activation path" contract. Nothing is ever written to user-owned directories without a command, so that rule still holds.
- **No `run_in_background` pin.** Personas stay identical across the fixtures, the export and the package. The docs explain the 0.18 background default and `run_in_background: false`.
- **The Pi profile stays under its 4000-character cap.** The cap exists because the profile is inlined into every Pi session.
  - The export lock and manifest detail and the overlay-precedence detail, already in HARNESSES and the guide, shrink to a one-line pointer.
  - The freed space covers packaged discovery, export for overlays, and the background default.
  - The Node floor goes in the docs, not in the profile.
- **`engines.node` stays `>=18`.** The field is advisory and the package serves several harnesses. Pi enforces its own floor, and a bump here would warn Node 20 CLI users on a minor release.
- **The release type is `feat(pi)`, a minor release.** User-visible behavior changes: personas appear for every Pi package install with pi-subagents present.

## Open Questions

### Resolved During Planning

- Does a project-scope install (`systematic setup --harness pi`) expose personas? Only after the project is trusted. Systematic's own extension has the same gate. Documented.
- Do `pi -e`, git installs or `node_modules` expose them? No.
  - pi-subagents reads only Pi's `settings.json` `packages[]`.
  - `dist/` is gitignored, so a git install has no build output.
  - Documented as unsupported.
- Does pi-subagents warn when a local file shadows a packaged one, or on a package-vs-package collision? No. In 0.22.0 the last load wins silently, despite its docs. Our docs describe the silent behavior.
- Does `--approve` cover project-package trust in the RPC harness? Yes. It sets the settings manager's trust, and pi-subagents reads it at `session_start`. The existing combined tests already load project-scope packages under `--approve`.

### Deferred to Implementation

- Where pi-subagents reads `packageAgents` (`subagents.json` versus Pi settings), and so how the negative control sets it. Confirm from `dist/index.js` when writing the test.
- Whether a project-scope first session advertises package types in the `Agent` tool description before trust is saved. Record whichever behavior is observed. The project-scope test asserts dispatch only.
- The final Host Contract timings value for `pi.test.ts`. Take it from the measured run.

## Implementation Units

- [ ] **Unit 1: Generate packaged personas at build time and declare them in the package manifest**

**Goal:** `bun run build` writes the curated default personas to `dist/pi-subagents/agents/`. `package.json` declares the directory to pi-subagents and adds the gallery keyword.

**Requirements:** R1, R2, R4, R7

**Dependencies:** None

**Files:**
- Create: `scripts/build-pi-package-agents.ts`
- Modify: `package.json` (`build`, `pi.subagents.agents`, `keywords`)
- Modify: `AGENTS.md` (the "Generated surfaces" paragraph names the packaged directory as a second consumer of the persona render)
- Modify: `STRUCTURE.md` (the `dist/` layout)
- Test: `tests/unit/build-pi-package-agents.test.ts`
- Test: `tests/unit/package-exports.test.ts`

**Approach:**
- The script imports `generateAll` and resolves the repo root the way the existing generator does. It removes and recreates the target and writes each entry's content as-is.
- It fails the build if `generateAll` throws, or if any name contains `:`.
- The `build` chain gets the script as its last step, after `tsc`.
- The manifest key is `pi.subagents.agents: ["./dist/pi-subagents/agents"]`. Use the object form, not the shorthand, so `workflows` can be added later.

**Execution note:** Implement test-first.

**Patterns to follow:**
- `scripts/generate-pi-subagents-personas.ts`: root resolution and the `import.meta.main` guard.
- `scripts/build-claude-code-plugin.ts`: a generated bundle from `agents/`.

**Test scenarios:**
- Happy path: running the script against the repo yields exactly the 29 `generateAll` file names and nothing else in the target. Every file is byte-equal to its counterpart in `tests/fixtures/pi-subagents-personas/`.
- Happy path: the packed tarball contains exactly those 29 `.md` files under `package/dist/pi-subagents/agents/`, byte-equal to the fixtures. Each `pi.subagents.agents` path resolves inside the extracted tarball.
- Happy path: `package.json` `keywords` contains `pi-package`. `pi.extensions` and `pi.skills` are unchanged.
- Edge case: a stale extra `.md` file planted in the target before the script runs is gone afterwards.
- Edge case: every generated file starts with frontmatter containing `description:`, is under 1 MB, and has a name without `:`.
- Error path: a `generateAll` that throws, injected through the script's seam, makes the script exit non-zero and leaves no partial directory claiming success.

**Verification:**
- `bun run build` produces the directory.
- The unit suite passes.
- `bun scripts/generate-pi-subagents-personas.ts --check` stays clean.
- `bun run registry:drift` stays clean.

- [ ] **Unit 2: Prove packaged discovery on a real Pi host**

**Goal:** Real Pi RPC sessions show that a packaged persona is discovered and used with no export, that turning the gate off removes it, and that a local file outranks it.

**Requirements:** R1, R3, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/integration/pi.test.ts`
- Modify: `tests/integration/host-contract-timings.json`

**Approach:**
- Add the tests inside the combined-path describe so its setup and its `afterEach` process cleanup apply.
- None of these tests calls `exportPersonas`. Each asserts that the project `.pi/agents`, `.agents/agents` and the global agents directories are absent or empty, except the precedence test.
- Each `Agent` call passes `run_in_background: false`.
- The global-scope variant lists both packages in `$PI_CODING_AGENT_DIR/settings.json` `packages[]` instead of the project settings.
- Fix the stale "v0.14.3" comments in this file.

**Execution note:** Write the positive test first and watch it fail on a tarball built without Unit 1's manifest key. That proves the test exercises the key.

**Patterns to follow:**
- The existing export-based combined-path test: assertions on the persona body in the child system prompt, and the bounded request count.

**Test scenarios:**
- Integration, project scope: an `Agent` call for `systematic-repo-research-analyst` completes without error. `details.subagentType` names that type. The nested request's system text contains the packaged persona body. The request count is bounded.
- Integration, global scope: the same dispatch succeeds with the packages declared only in global settings. The `Agent` tool description offered to the model lists `systematic-repo-research-analyst`.
- Integration, negative control: with `packageAgents` off and everything else identical, no request's system text contains the persona body, and the call does not resolve to the packaged persona. Do not settle for asserting only an error result.
- Integration, precedence: a local `.pi/agents/systematic-repo-research-analyst.md` whose body differs wins. The nested system text has the local body and not the packaged one.

**Verification:**
- `bun test tests/integration/pi.test.ts` passes with `SYSTEMATIC_REQUIRE_OPENCODE=1`.
- No spawned processes are left behind (PID diff empty).
- The Host Contract guard still meets its floor.
- Removing the `pi.subagents` key from `package.json` and rebuilding fails the positive tests.

- [ ] **Unit 3: Update the Pi capability profile**

**Goal:** The profile every Pi session receives describes packaged discovery, export for overlays, precedence and the background default, under its 4000-character cap.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `skills/using-systematic/references/pi-profile.md`
- Modify: `tests/unit/__snapshots__/bootstrap.test.ts.snap` (only if a snapshot includes the Pi profile; regenerate rather than hand-edit)
- Test: `tests/unit/bootstrap.test.ts` (the existing budget assertion; no change to the cap)

**Approach:**
- Replace the lock, manifest and symlink paragraph and the overlay-precedence paragraph with one pointer to HARNESSES and the guide.
- Update the capability-table row and the tested-version line to pi-subagents 0.22.0 on Pi 1.3.0.
- Add three facts:
  - installing the package exposes `systematic-<name>` types to pi-subagents ≥0.20 as plain defaults;
  - export is needed only for overlays, and local files win;
  - `Agent` runs in the background by default, and `run_in_background: false` waits for the result.

**Test scenarios:**
- Happy path: the profile-size assertion in `tests/unit/bootstrap.test.ts` passes, with every profile under 4000 characters.
- Happy path: the Pi bootstrap still carries the `# Pi Capability Profile` marker (existing unit and integration checks), and its text no longer mentions 0.14.3.

**Verification:**
- The unit suite passes with the snapshot refreshed.
- `bun scripts/content-integrity.ts` is clean.

- [ ] **Unit 4: Update the interop docs, HARNESSES and stale comments**

**Goal:** Every user-facing and contributor-facing statement of the pi-subagents contract matches 0.22.0 on Pi 1.3.0 and the packaged path.

**Requirements:** R3, R6

**Dependencies:** Units 1-3

**Files:**
- Modify: `HARNESSES.md` (the Pi capability row, the pi-subagents paragraphs, PI-7 evidence references to the manifest key, the build script and the real-host tests)
- Modify: `docs/src/content/docs/guides/pi-subagents.mdx`
- Modify: `docs/src/content/docs/getting-started/installation.mdx`
- Modify: `ARCHITECTURE.md` (the Pi module and discovery sections, where they describe export as the only path)
- Modify: `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md` (a one-line "partly superseded by" pointer to this plan's behavior)
- Modify: `src/lib/pi-subagents-export.ts` (stale version comment)
- Modify: `scripts/generate-pi-subagents-personas.ts` (stale contract header)

**Approach:**
- Re-verify every interop claim against 0.22.0 before restating it, including the absence of `temperature`, `top_p` and `variant` frontmatter equivalents. Don't only bump the version string.
- Guide and installation docs:
  - A two-path table: packaged defaults versus export for customization, with the precedence order.
  - pi-subagents is a separate install.
  - Pi needs Node ≥22.19.
  - Project trust gates project-scope installs.
  - `pi -e` and git installs do not expose personas.
  - After upgrading, run `refresh`, or run `cleanup` to fall back to packaged defaults.
  - A global export shadows in every project.
  - Collisions are silent.
  - The `/agents` source badges.
  - The `packageAgents` off switch.
  - The background default.
- Retitle the installation export section so export reads as customization, not activation.

**Test scenarios:**
- Test expectation: none. This unit changes documentation and comments only. `docs:build` and content-integrity are its checks.

**Verification:**
- `bun run docs:build` succeeds.
- `bun scripts/content-integrity.ts` is clean, including solution-doc citations.
- markdownlint passes on the changed Markdown.
- A search for `0.14.3` outside dated plans and records finds nothing.

## System-Wide Impact

- **Interaction graph:**
  - pi-subagents, when installed, now loads 29 extra agent types from any Pi install of Systematic.
  - Pi itself ignores the `pi.subagents` key.
  - OpenCode, Claude Code and the npm consumers of `dist/` are unaffected, apart from 29 extra files in the tarball.
- **State lifecycle risks:**
  - A prior export silently shadows packaged defaults and can go stale after an upgrade. This is documented, and the export CLI change is deferred.
  - The build removes and recreates only its own subdirectory.
- **API surface parity:** the export and the package share one render, so they cannot diverge without the byte-equality test failing.
- **Integration coverage:** only the real-host tests prove the manifest key, the stem-name fallback and precedence. Unit tests prove the build and pack contents.
- **Unchanged invariants:**
  - Nothing writes to user-owned directories without an explicit command.
  - `systematic_delegate` stays bounded.
  - The combined pi-subagents path stays outside its guarantees.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A future pi-subagents requires `name:`, as its docs already claim | The real-host test pins the stem fallback at the exact pin. A Renovate bump that breaks it fails CI before merge. |
| The persona count or names change in `agents/` | Unit tests derive the expected set from `generateAll` and the fixtures, not a literal, and the fixture `--check` already gates agent edits. |
| Profile text pressure pushes past the cap | Detail moves to HARNESSES and the guide, and the cap test enforces the limit. |
| Users with old exports see stale personas | The guide and installation docs carry the refresh and cleanup guidance. |
| Packaged personas appear for users who never asked for them | They only appear when pi-subagents is installed. They rank below every local file, and `packageAgents` turns them off. Documented. |

## Documentation / Operational Notes

- The PR title is `feat(pi): ship Systematic personas as pi-subagents package agents`, which releases as a minor version. Write commit bodies as public prose, because the release notes read them.
- After release, a `ce:compound` pass can record the package-agent pattern.

## Sources & References

- Upstream: pi-subagents `docs/packages.md` v0.22.0; Pi `docs/packages.md` v1.3.0
- Related PRs: #1166, #1184, #1185, #1189
- Related code: `src/lib/pi-subagents-personas.ts`, `src/lib/pi-subagents-export.ts`, `tests/integration/pi.test.ts`
