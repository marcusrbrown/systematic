---
title: "feat: Pi coding-agent harness support"
type: feat
status: active
date: 2026-07-06
origin: docs/brainstorms/2026-07-06-pi-harness-support-requirements.md
target_branch: v3
---

# feat: Pi Coding-Agent Harness Support

## Overview

Add **Pi** (`earendil-works/pi`) as a second supported harness, shipped from the **same single `@fro.bot/systematic` npm package** at full parity with the OpenCode experience: Pi users get the bundled skills, the agents as real in-process subagents, the `systematic_skill` tool, and the `using-systematic` bootstrap. The OpenCode plugin (`src/index.ts`) is unchanged in behavior; a new second entry `src/pi.ts` is a thin adapter over the existing `src/lib/*` core, built to `dist/pi.js` and wired via a `pi` manifest key in `package.json`.

This rides the long-lived `v3` branch alongside the v3 cleanup plan (`docs/plans/2026-07-06-002-feat-v3-cleanup-release-plan.md`) but is an independent set of PRs. The two coordinate only on `src/cli.ts` (cleanup removes the `convert` command; this plan adds `setup --harness`).

## Problem Frame

Systematic is currently OpenCode-only. Pi implements the same Agent Skills standard, so the `skills/` bundle is already consumable by Pi — but Pi has no plugin to discover Systematic's bundle, no `systematic_skill` tool, no bootstrap injection, and (in core) no agent concept. Without a Systematic Pi extension, Pi users would get raw skills with none of the enforcement or delegation that make Systematic a discipline layer. The runtime contracts differ (OpenCode: declarative hook object; Pi: imperative `(pi: ExtensionAPI) => {…}` factory, jiti-loaded), so Pi support is a second thin adapter over the shared core, not a shared plugin — but it lives in the same package (oracle-validated).

## Requirements Trace

Carried from the origin brainstorm (see origin: `docs/brainstorms/2026-07-06-pi-harness-support-requirements.md`):

- R1. Single package; `src/pi.ts` second entry; build `dist/index.js` + `dist/pi.js` from shared `src/lib/*`.
- R2. `package.json` carries `"pi": { "extensions": ["./dist/pi.js"], "skills": ["./skills"] }`; keep `skills/`+`agents/` in `files`.
- R3. `dist/index.js` stays export `['default']`; `src/index.ts` never re-exports `src/pi.ts`; neither entry imports the other harness's runtime values.
- R4. Both harness SDKs + `typebox` are optional peer dependencies (`peerDependenciesMeta.optional`).
- R5. Existing `skills/` loads in Pi unchanged via `pi.skills`.
- R6. Systematic's own Pi extension provides subagents from `agents/` via in-process `createAgentSession()` (model-free inherits parent model).
- R7. **Resolved during implementation (Unit 5), superseding the original text below:** Pi core has no agent-discovery surface or manifest key of any kind — the original "adapt to flat Pi agent files" premise assumed a Pi-side discovery mechanism that does not exist. Adapt categorized `agents/<category>/<name>.md` into a runtime, in-memory catalog built by Systematic itself (the sole consumer); preserve the model-free invariant; category is dropped from the lookup key (no consumer, Pi or otherwise). No physical/generated flat file tree is produced.
- R8. Delegation exposed via a registered tool with a Systematic-owned depth/turn guard.
- R9. Pi `systematic_skill` tool backed by the same `src/lib` skill-loader as OpenCode.
- R10. Inject `using-systematic` bootstrap via `before_agent_start`.
- R11. `src/cli.ts` grows `setup --harness opencode|pi`.
- R12. Committed docs cover Pi install + harness parity/differences.
- R13. Pi-subprocess test harness asserts skills load, tool resolves, bootstrap injects, and a subagent runs to completion.
- R14. No OpenCode regression detectable by the suites/packaging checks/ESM smoke test (verifiable target, not absolute guarantee).
- R15. No skill/agent content-semantics changes beyond R7's discovery adaptation.
- R16. Independent of cleanup plan `002`; coordinate only on `src/cli.ts`.
- R17. Extension re-entry safety: child sessions spawned without rebinding Systematic's extension; `configCwd` constrained to the trusted project root (foreign cwd rejected/gated).
- R18. Bounded delegation: mandatory fail-closed max-depth + max-turns cap.
- R19. Least-privilege subagent tools: explicit allowlist, not the full parent surface.
- R20. `setup --harness` config writes are atomic, backed-up, idempotent, path-validated, and touch only the target harness's config.

## Scope Boundaries

- No monorepo split (single package; F1 oracle-validated).
- No third-party Pi subagent-extension dependency (Systematic owns its subagents — R6).
- No skill/agent content redesign (R15); agent adaptation is discovery-shape only (R7).
- No change to the OpenCode plugin's behavior or its users' install path.
- Not gated on Pi's abandoned in-core `src/core/subagents/` (design against `createAgentSession()` only).

### Deferred to Separate Tasks

- A shared harness-agnostic tool-definition format generating both zod and typebox schemas: nice-to-have; two hand-written declarations over one handler is the baseline (F5).
- Publishing a separate `@fro.bot/systematic-pi` package: only the fallback if the tarball-load gate (Unit 1) fails.
- Pi-specific skills/prompts beyond the shared bundle: none planned.

## Context & Research

### Relevant Code and Patterns

- `package.json` — current single-`.`-export shape: `main`/`exports` → `dist/index.js`; build `bun build src/index.ts src/cli.ts --outdir dist --target bun --splitting --external @opencode-ai/plugin --external js-yaml && tsc --emitDeclarationOnly`; `peerDependencies` only `@opencode-ai/plugin`; `files` already includes `skills`, `agents`. `prepublishOnly` runs build + schema:generate.
- `src/index.ts` — OpenCode plugin, single `default` export (the invariant the ESM smoke test in `.github/workflows/main.yaml` guards).
- `src/lib/skill-loader.ts` (`loadSkill`) and `src/lib/skills.ts` (`findSkillsInDir`, `extractFrontmatter`) — the skill-resolution core the Pi `systematic_skill` tool reuses.
- `src/lib/bootstrap.ts` (`getBootstrapContent`, `INTERNAL_AGENT_SIGNATURES`) — bootstrap content the Pi `before_agent_start` handler reuses; already harness-agnostic (returns a string).
- `src/lib/agents.ts` (`findAgentsInDir`, category from subdirectory) — source discovery reused by `src/lib/agent-resolver.ts`'s runtime catalog builder (Unit 5); no flat-file generation step exists.
- `src/cli.ts` — current `list`/`convert`/`config` commands; the `setup --harness` addition lands here (coordinate with cleanup `002` removing `convert`).
- `tests/integration/opencode.test.ts` — `IsolatedFixture` (temp HOME + all XDG roots + `OPENCODE_CONFIG_CONTENT`), `runOpencode`, source/dist load paths, `OPENCODE_AVAILABLE` skip guard — the shape to mirror for a Pi-subprocess harness.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` — the loader treats every named export of the entry as a plugin factory; adding a second entry must not leak exports into `dist/index.js`. The ESM smoke test is the guard (R3).
- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — a synchronous throw inside a hook is swallowed as an Effect defect. The Pi analog: the `before_agent_start` and tool handlers must not throw uncaught; warnings go to a sync channel.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — the isolated-subprocess fixture pattern (override HOME + every XDG root + config-content last); basis for the Pi-subprocess harness (R13).
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — plugins load per-source, factories can run N times; the Pi extension's registration must be idempotent (relevant to R17 re-entry).
- Prior art (this session's research, not in `docs/solutions/`): cortexkit **Magic Context** shares one core via tsconfig path alias + bundle-at-build; cortexkit **AFT** `tests/pi-rpc` spawns the Pi extension over JSONL/RPC with a mocked model — the testing model for R13.

### External References

- Pi SDK: `createAgentSession()`, `DefaultResourceLoader`, `SessionManager.inMemory()`, exported `parseFrontmatter`/`getAgentDir` (`@earendil-works/pi-coding-agent`, verified `v0.80.3`/`main`).
- Pi extension API: `pi.registerTool` (typebox params), `pi.on('before_agent_start', …)` returning `{ systemPrompt }`, `pi.registerCommand`.
- oracle packaging review (this session): GO-WITH-CONSTRAINTS against OpenCode loader source (`.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/plugin/{shared,loader}.ts`) and Pi `v0.80.3` loader.

## Key Technical Decisions

- **Single package, two build outputs.** Add `src/pi.ts` to the build entry list; keep `src/index.ts` and `src/pi.ts` as independent adapters over `src/lib/*`. `main`/`exports` stay pointed at `dist/index.js` (OpenCode); Pi reads the `pi.extensions` manifest and ignores `main` (no collision). Do NOT add a `./pi` export.
- **`--splitting` verification is load-bearing.** The current build uses `bun build --splitting`, which emits shared chunks. Adding `src/pi.ts` sharing `src/lib/*` chunks must not alter `dist/index.js`'s export surface. The ESM smoke test (`['default']`) is extended to run against BOTH entries and is the gate.
- **In-process subagents via `createAgentSession()`.** No `ExtensionAPI` spawn primitive exists; the extension calls `createAgentSession({ model: ctx.model, tools: allowlist, resourceLoader: DefaultResourceLoader with systemPromptOverride, sessionManager: SessionManager.inMemory() })` inside a registered delegation tool's `execute`, then `await session.prompt(task)`. Model-free personas inherit the parent model here (they do not on the subprocess path).
- **Re-entry + recursion safety are firm requirements, not deferrals.** Spawn children with Systematic's own extension NOT rebound (`bindExtensions()` re-runs factories in children → infinite recursion of the delegation tool otherwise); keep `configCwd` = parent trusted root (foreign cwd executes that dir's `.pi` extensions in-process); enforce a fail-closed max-depth + max-turns cap (Pi core caps nothing).
- **Runtime catalog, category dropped (resolved Unit 5, supersedes the original "generate flat Pi agent files" text).** Pi has no agent-discovery surface to generate files for. Build an in-memory catalog from the categorized tree at extension-init time (`src/lib/agent-resolver.ts`); category has no consumer, so it is dropped from the lookup key. No build-time file generation step exists.
- **Optional peer deps.** `@opencode-ai/plugin`, `@earendil-works/pi-coding-agent`, `typebox` all optional peers so single-harness installs get no unmet-peer warnings; `typebox` stays a devDependency for build/typecheck unless `dist/pi.js` imports it at runtime.
- **Tarball-load is a gating prerequisite.** Before committing to the single-package model, smoke-test Pi's managed-install + manifest load from a `npm pack` tarball; if it fails, fall back to a separate `-pi` package (the only structural pivot).

## Open Questions

### Resolved During Planning

- Can one package carry both contracts? Yes — OpenCode resolves `exports["./server"]`→`main`; Pi reads `pi.extensions` (oracle, against loader source).
- Can an extension spawn persona subagents with return values? Yes, in-process via `createAgentSession()` inside a registered tool (verified against Pi source + two real implementations).
- Do model-free personas inherit the parent model? Yes, in the in-process path.
- Is category preservation needed for Pi agents? No — dropped (no consumer).

### Deferred to Implementation

- **Build target for `dist/pi.js`.** Current build is `--target bun`; Pi jiti-loads TS/JS and cortexkit builds Pi entries `--target node`. Determine whether the Pi output needs a different target/externalization than the OpenCode output (may require splitting the single `bun build` invocation into two).
- **Exact flat-agent generation mechanism — resolved (Unit 5):** none of the three deferred options. Pi has no agent-discovery surface at all, so there is nothing for a flat tree to satisfy. Resolved to a runtime in-memory catalog (`src/lib/agent-resolver.ts`) built from the existing categorized `agents/<category>/<name>.md` tree at extension-init time — no generated flat tree, no drift surface to check.
- **typebox-vs-zod drift control** for the `systematic_skill` schema — whether a small shared descriptor generates both, or a parity test pins the two hand-written declarations.
- **Exact `before_agent_start` composition** with other extensions' system-prompt contributions (chained return).
- **`setup --harness` Pi mechanics — resolved (Unit 6):** direct `settings.json` edit (`<cwd>/.pi/settings.json`'s `packages` array), never `pi install`. No `src/cli.ts` conflict with cleanup `002` materialized.
- **Depth/turn cap defaults — resolved (Unit 5):** structural max depth = 1 (enforced via `DefaultResourceLoader({ noExtensions: true, ... })` in the child, not a counted depth parameter — the child cannot register further extensions or discover further delegation tools at all), max turns = 20 (`MAX_DELEGATE_TURNS`, enforced via `AgentSession.subscribe()` + `abort()`), concurrency = 1 (`ToolDefinition.executionMode: 'sequential'`). None of the three are configurable via tool parameters.

## High-Level Technical Design

> *This illustrates the intended dependency shape and is directional guidance for review, not implementation specification.*

```
Phase 1 — Foundation (gates everything)
  Unit 1: build two outputs + pi manifest + optional peers + dual ESM smoke test
          + GATING tarball-load smoke test (fallback: separate -pi package)
                    │
        ┌───────────┼───────────────┬───────────────┐
        ▼           ▼               ▼               ▼
Phase 2 — Parity surfaces (parallel-ish over the shared core)
  Unit 2:     Unit 3:            Unit 4:          Unit 5:
  skills      systematic_skill   bootstrap        runtime agent catalog
  via pi.skills  tool mirror     via before_      + bounded systematic_delegate
                                 agent_start      tool (depth 1, 20-turn cap,
                                                   serial, least-privilege)
        └───────────┴───────────────┴───────────────┘
                    │
                    ▼
Phase 3 — Install, docs, assurance
  Unit 6: setup --harness (coordinate w/ cleanup 002 on src/cli.ts)
  Unit 7: Pi-subprocess test harness (skills+tool+bootstrap+subagent)
  Unit 8: committed Pi install + parity docs
```

## Implementation Units

- [x] **Unit 1: Two-output build, Pi manifest, optional peers, dual export-shape guard**

**Goal:** Make the single package emit `dist/pi.js` alongside `dist/index.js`, declare the Pi manifest and optional peer deps, and prove neither entry pollutes the other's export surface. Includes the GATING tarball-load smoke test.

**Requirements:** R1, R2, R3, R4, R14 (partial)

**Dependencies:** None (foundation)

**Files:**
- Create: `src/pi.ts` (minimal `export default async (pi: ExtensionAPI) => {}` skeleton; real behavior in later units)
- Modify: `package.json` — add `src/pi.ts` to the build entry list; add `"pi": { "extensions": ["./dist/pi.js"], "skills": ["./skills"] }`; add `@earendil-works/pi-coding-agent` + `typebox` to `peerDependencies` with `peerDependenciesMeta.optional`; keep `main`/`exports` unchanged (no `./pi` export); keep `skills`/`agents` in `files`
- Modify: `.github/workflows/main.yaml` — extend the ESM export-shape smoke test to assert `dist/pi.js` loads and `dist/index.js` still exports exactly `['default']`
- Test: `tests/unit/package-exports.test.ts` (or extend an existing packaging test), a packed-tarball manifest test

**Approach:**
- Add `src/pi.ts` to the `bun build` entry list; if `--target bun --splitting` alters `dist/index.js`'s exports or the Pi output needs a different target, split into two `bun build` invocations (see Deferred: build target).
- Optional peers so OpenCode-only and Pi-only installs emit no unmet-peer warnings.
- GATING: `npm pack`, then load the tarball into a temp project and confirm Pi resolves the `pi.extensions` manifest and loads `dist/pi.js`. If this fails, STOP and pivot to the separate-`-pi`-package fallback before proceeding.

**Execution note:** Test-first on the export-shape guard — assert the dual-entry invariant before wiring the second build output.

**Patterns to follow:** cortexkit Magic Context single-core/second-entry shape; existing `main.yaml` ESM smoke test.

**Test scenarios:**
- Happy path: after build, `dist/index.js` and `dist/pi.js` both exist; `import('./dist/index.js')` exports exactly `['default']`.
- Edge case: `dist/pi.js` default export is a function; importing it does not pull OpenCode runtime values.
- Packaging: `npm pack` output contains `dist/index.js`, `dist/pi.js`, `skills/**`, `agents/**`; the `pi.extensions`/`pi.skills` manifest paths resolve inside the tarball.
- Install matrix: OpenCode-only install → no Pi-SDK peer warning; Pi-only install → no OpenCode peer warning.
- Gating (integration): Pi loads `dist/pi.js` from the packed tarball via its manifest.

**Verification:** both outputs build; dual ESM smoke test green; tarball contains and Pi loads the Pi entry; peer-warning matrix clean.

- [x] **Unit 2: Skills parity via `pi.skills`**

**Goal:** The existing `skills/` bundle loads in Pi with no per-skill edits.

**Requirements:** R5, R15

**Dependencies:** Unit 1 (manifest + tarball gate)

**Files:**
- Modify: `package.json` `pi.skills` (already added in Unit 1 — this unit verifies discovery)
- Test: extend the Pi-subprocess harness (Unit 7) or a focused packaging test asserting skill discovery

**Approach:**
- Confirm Pi's recursive `SKILL.md` discovery finds the bundled skills from the installed package `skills/` dir (name-matches-dir relaxation applies).
- No skill content changes; any OpenCode-specific wording is out of scope (R15).

**Test scenarios:**
- Happy path: a representative bundled skill (e.g. `ce-plan`) is discoverable in Pi and its `SKILL.md` body loads.
- Edge case: a skill with sub-files (`references/`) resolves those paths from the installed location.

**Verification:** Pi exposes the bundled skills; no per-skill edits required.

- [x] **Unit 3: `systematic_skill` tool mirror in Pi**

**Goal:** Register a Pi `systematic_skill` tool backed by the same `src/lib` skill-loader as the OpenCode tool, so skill-load behavior is identical across harnesses.

**Requirements:** R9

**Dependencies:** Unit 1

**Files:**
- Modify: `src/pi.ts` — `pi.registerTool({ name: 'systematic_skill', parameters: <typebox>, execute })` calling the shared loader
- Possibly create: `src/lib/skill-resolve.ts` if a harness-agnostic seam must be extracted from the current OpenCode tool (keep the loader itself harness-free)
- Test: unit test of the shared handler; Pi-harness assertion in Unit 7

**Approach:**
- Reuse `loadSkill`/`findSkillsInDir` from `src/lib`; the Pi tool is a thin typebox-param wrapper over the same handler the OpenCode `tool` hook uses.
- Keep the handler harness-agnostic (no `@opencode-ai/plugin` or Pi types in `src/lib`).

**Test scenarios:**
- Happy path: `systematic_skill` in Pi loads the byte-identical body the OpenCode tool loads for the same skill name.
- Error path: an unknown skill name returns the same not-found behavior in both harnesses.
- Edge case: a deprecated skill (if any remain post-cleanup) behaves identically across harnesses.

**Verification:** shared handler covered by unit tests; Pi tool resolves a real skill in the subprocess harness (Unit 7).

- [x] **Unit 4: Bootstrap injection via `before_agent_start`**

**Goal:** Inject the `using-systematic` bootstrap into Pi sessions so they get the same workflow enforcement as OpenCode sessions.

**Requirements:** R10

**Dependencies:** Unit 1

**Files:**
- Modify: `src/pi.ts` — `pi.on('before_agent_start', …)` returning `{ systemPrompt }` composed from `getBootstrapContent()`
- Test: unit test asserting the injected content; Pi-harness assertion in Unit 7

**Approach:**
- Reuse `src/lib/bootstrap.ts` `getBootstrapContent()` (already returns a harness-agnostic string).
- Compose (append) with any existing system prompt / other extensions' contributions rather than replacing (chained return).
- The handler must not throw uncaught (hook-defect-swallow learning).

**Test scenarios:**
- Happy path: a fresh Pi session's system context contains the `using-systematic` bootstrap.
- Edge case: when another extension also contributes to `before_agent_start`, Systematic's content is appended, not clobbering theirs.
- Error path: a failure computing bootstrap content degrades gracefully (no uncaught throw aborting the session).

**Verification:** bootstrap present in a fresh Pi session (Unit 7 assertion); composition preserves other contributions.

- [x] **Unit 5: Runtime agent catalog + bounded in-process subagent delegation**

**Goal:** Provide Systematic's agents to Pi as real in-process subagents via a runtime, in-memory catalog built from packaged `agents/<category>/<name>.md` (no physical flat tree), and register a single `systematic_delegate` tool that spawns a persona subagent with a structural depth-1 guard, a fixed 20-turn cap, serial execution, and least-privilege tool allowlisting.

**Requirements:** R6, R7 (resolved: runtime catalog, not Pi-side discovery — Pi has no agent-discovery surface of its own), R8, R17, R18, R19

**Dependencies:** Unit 1

**Resolved architecture (supersedes the original "flat Pi agent files" premise and all Deferred depth/turn-cap decisions below):**
- **No physical/generated flat agent tree.** Pi core has no agents discovery/manifest key; Systematic is the only consumer. `src/lib/agent-resolver.ts` builds an in-memory catalog from packaged `agents/<category>/<name>.md` at extension-init time, flattening category out of the lookup key. Duplicate persona names across categories fail closed (throw) at catalog-build time.
- **One registered tool, `systematic_delegate`,** with only `{ agent: string, task: string }` parameters — no chain, parallel, cwd, model, or policy parameters. Its description/parameter hint includes the bounded, deterministic persona list from the catalog.
- **Structural max depth = 1.** The child loader (`src/lib/pi-delegate-session.ts`) uses `DefaultResourceLoader` with `noExtensions: true` (no extension paths/factories of any kind), plus `noSkills`/`noPromptTemplates`/`noThemes`/`noContextFiles` all `true` so no unrelated child resources leak in. The persona body replaces the system prompt via `systemPromptOverride`; `appendSystemPromptOverride` is cleared to `[]`. `reload()` is called before session creation. The child's tool allowlist is asserted (fail-closed) to never include `systematic_delegate` at two points: allowlist resolution in `pi-delegate-tool.ts` and again defensively in `pi-delegate-session.ts` immediately before session construction.
- **Fixed max turns = 20** (`MAX_DELEGATE_TURNS`), not configurable. Enforced via `AgentSession.subscribe()` counting real `turn_start` events; on exceeding the cap the tool calls `session.abort()` before a 21st turn can start, then throws a plain `Error` whose message preserves persona/turn-count observability rather than returning an `isError` result.
- **Fixed concurrency = 1 per parent session** via the real `ToolDefinition.executionMode: 'sequential'` — no custom semaphore or future parallel-mode surface. This does not impose a process-global limit across independent Pi sessions.
- **Model inheritance is fail-closed, not fallback.** The tool passes `ctx.model` straight through; if `ctx.model` is `undefined`, the tool throws a plain `Error` before any child session is created rather than letting Pi select a default model. `cwd` is pinned to `ctx.cwd` with no cwd input exposed. (Note: `noExtensions` prevents project-extension re-entry; it does not confine an explicitly allowed `bash` tool to that `cwd` — that is a real, separate blast-radius property of the `bash` tool itself, not claimed here.)
- **Ephemeral lifecycle:** `SessionManager.inMemory()`; the tool's own `AbortSignal` is raced against `createDelegateSession()` so a parent abort can preempt a never-settling construction, and if the child resolves after abort the tool makes a best-effort `abort()` + `dispose()` cleanup. The `subscribe()` listener is unsubscribed and `session.dispose()` is always called in `finally` — covering prompt failures and the abort/turn-limit paths, and creation failures where a session exists (there is nothing to dispose if construction itself never returned a session). `abort()` is called at most once per run, its promise is awaited before the outcome is finalized, and a rejecting `abort()` is wrapped into a plain `Error` with the real turn count rather than a false clean `aborted`. A `prompt()` rejection caused by the tool's own abort request is treated as expected and does not override the authoritative `turn_limit`/`aborted` outcome; a `prompt()` rejection with no abort in flight is reported as `failed` with the actual turn count.
- **Least privilege via parsed frontmatter, Pi-only field.** `src/lib/agent-resolver.ts` reads each persona's `tools:` frontmatter value through `parseFrontmatter`'s parsed YAML data (not a body-wide regex), so a persona body containing a line that merely begins with `tools:` can never be misread as a declaration. This is a Pi-only reading of that field and does not change `extractAgentFrontmatter`'s existing `isToolsMap` (boolean-map) parsing used elsewhere. Every catalog entry is additionally validated fail-closed at build time: YAML parse success, and non-empty `name`/`description`/prompt-body, each throwing a contextual error naming the source file — there is no filename fallback for a missing/empty `name`. Known OpenCode tool names map deliberately to Pi built-ins (`Read`→`read`, `Grep`→`grep`, `Glob`→`find`, `Bash`→`bash`, and defensively `Edit`→`edit`/`Write`→`write`). Any unknown declared name fails closed (throws `UnknownDeclaredToolError`) rather than defaulting silently. `Task` (or any delegation-shaped declaration) is explicitly denylisted and never maps into the child. No `tools:` declaration at all defaults to the read-only allowlist `read, grep, find, ls`. The bundled-markdown model-free invariant is preserved: persona `model`/`variant` frontmatter is never read or forwarded by this path.
- **Result contract.** The tool returns the final assistant text (`session.getLastAssistantText()`) in `content`; `details` is a small discriminated object `{ persona, turnCount, outcome }` where `outcome` is `'completed' | 'turn_limit' | 'aborted' | 'failed'`. Failures surface as thrown `Error`s through Pi's supported channel, with messages carrying persona and turn-count context where relevant. No usage/cost/UI-renderer fields are in scope.

**Files (actual):**
- Created: `src/lib/agent-resolver.ts` — harness-neutral in-memory catalog build/validation/tool-allowlist resolution, reusing `findAgentsInDir`/`extractAgentFrontmatter` from `src/lib/agents.ts`
- Created: `src/lib/pi-delegate-tool.ts` — Pi-specific `systematic_delegate` tool factory; depends on Pi session construction only through an injectable `CreateDelegateSession` seam (no live Pi SDK import), so it is unit-testable without a real provider/session
- Created: `src/lib/pi-delegate-session.ts` — the real `CreateDelegateSession` implementation using `DefaultResourceLoader`/`createAgentSession`/`SessionManager.inMemory()`
- Modified: `src/pi.ts` — builds the packaged agent catalog once per extension-factory invocation and registers `systematic_delegate` (fails closed to skipping registration, with a stderr diagnostic, if catalog build fails — e.g. a duplicate-name collision — matching the existing bootstrap-failure pattern)
- Modified: `src/lib/AGENTS.md` — module map entries for the three new modules
- Test: `tests/unit/agent-resolver.test.ts` (new), `tests/unit/pi-delegate-tool.test.ts` (new, including the raw failure/late-abort contract and bounded catalog description), `tests/unit/pi-delegate-session.test.ts` (new — pins the live adapter's exact option/order contract without a provider), `tests/unit/pi.test.ts` (extended for `systematic_delegate` registration shape/description)

**Execution note:** Test-first — RED tests were written for catalog flattening/duplicate detection, tool-allowlist mapping/denylist, and the full delegate-tool contract (validation-before-session-creation, turn-cap abort, signal propagation, dispose-in-every-path) before the implementation existed.

**Patterns to follow:** `src/lib/skill-resolver.ts` + `src/lib/skill-catalog.ts` (harness-neutral catalog/description-builder split reused here for agents); `src/pi.ts`'s existing `computeBootstrapContentSafe`/stderr-diagnostic fail-open-but-report pattern, mirrored for catalog-build failure.

**Test scenarios (implemented):**
- Catalog flattening, deterministic sorted listing, duplicate-name fail-closed throw.
- Catalog fails closed on malformed YAML frontmatter, and on missing/empty `name`/`description`/prompt-body — each error names the source file.
- Regression: a persona body line beginning `tools:` is never mistaken for a frontmatter `tools:` declaration (parsed via `parseFrontmatter`'s YAML data, not a body-wide regex).
- Declared-tools mapping (`Read, Grep, Glob, Bash` → `read, grep, find, bash`; `Edit`/`Write` supported), unknown-tool fail-closed, undeclared-tools safe default (`read, grep, find, ls`), `Task` denylist.
- Registered tool schema is exactly `{ agent, task }`, bounded deterministic description, `executionMode: 'sequential'`.
- Unknown persona and undefined parent model throw before `createDelegateSession` is ever called (asserted via a spy flag in tests).
- 20-turn bound: a fake session emitting >20 `turn_start` events is aborted before the 21st turn, then throws a plain `Error` whose text includes the persona and turn count; `abort()` is called at most once.
- A signal already aborted before execution throws before constructing a child session.
- A signal that aborts while `createDelegateSession()` is still pending preempts promptly; if the child resolves later, the tool performs best-effort cleanup and the rejection identifies the aborted start.
- A `prompt()` rejection caused by the turn-limit (or external) abort request still reports the authoritative `turn_limit`/`aborted` outcome in the thrown message, not a generic `failed`.
- A rejecting `abort()` (after either a turn-limit or an external abort request) is wrapped into a plain `Error` with the real turn count, not a false clean abort.
- `prompt()` failing after several turns already ran preserves the actual `turnCount` in the thrown `failed` message instead of reporting 0.
- Parent/tool `AbortSignal` abort propagates to `session.abort()` and throws `aborted`.
- `unsubscribe()`/`dispose()` are called on the success path and on every failure path (creation throw, unknown persona, undefined model, unknown tool, turn-limit, abort, abort-during-construction, rejecting abort).
- The delegated persona catalog description is bounded under 6,000 characters, keeps every persona name, and includes `promptSnippet` routing guidance.
- Live adapter contract pinned without a provider (`tests/unit/pi-delegate-session.test.ts`): parent cwd/model, all five `no*` resource-loader flags, authoritative override system prompt with emptied append prompt, `reload()` called before `createAgentSession`, exact mapped `tools`, `customTools: []`, `SessionManager.inMemory()` output passed through untouched, and the delegate-tool denylist re-asserted at this exact boundary (construction short-circuits before even calling `getAgentDir()`).
- Built `dist/pi.js` is plain-Node importable, exports exactly `['default']`, and registers both `systematic_skill` and `systematic_delegate`; no static OpenCode SDK import (verified by direct `node -e` import and by `tests/unit/package-exports.test.ts`).

**Verification:** `bun test tests/unit/agent-resolver.test.ts tests/unit/pi-delegate-tool.test.ts tests/unit/pi-delegate-session.test.ts tests/unit/pi.test.ts` green (86/86); full `bun test tests/unit` green (1075/1075); `bun run typecheck`, `bun run lint`, docs build, content-integrity, and registry drift checks clean; `bun run build` succeeds and a plain-Node `import('./dist/pi.js')` registers both tools.

- [x] **Unit 6: `setup --harness` CLI**

**Goal:** Extend `src/cli.ts` with `setup --harness opencode|pi` that wires each harness's registration safely.

**Requirements:** R11, R20

**Dependencies:** Unit 1; coordinate with cleanup plan `002` (which removes `convert` from `src/cli.ts`)

**Resolved architecture:**
- **OpenCode target resolution** is project-local-only, checked in this exact precedence order against the trusted `cwd`: `.opencode/opencode.jsonc`, `.opencode/opencode.json`, `opencode.jsonc`, `opencode.json`. If none exist, a new root `opencode.jsonc` is created. No ancestor-directory walk and no `OPENCODE_CONFIG_DIR` honored.
- **OpenCode schema is singular-only, matching OpenCode v1.17.6.** Only a top-level `plugin: string[]` is supported; any `plugins` (plural) key present at all — alone or alongside `plugin` — fails closed with zero writes, as does a literal duplicate top-level `plugin` or `plugins` key (detected via `jsonc-parser`'s `parseTree`, before `modify`). `plugin` entries must be strings; no object/tuple entry shapes are accepted. JSONC is parsed via `jsonc-parser`'s authoritative `parse` (`allowTrailingComma: true`, real parse-error collection — never a regex-based comment-strip) for validation, and `modify`/`applyEdits` for comment-preserving mutation. Creates singular `plugin` when missing.
- **Pi target** is always `<cwd>/.pi/settings.json`, written directly (never via `pi install`). The document is validated with strict `JSON.parse` (Pi does not preserve JSONC comments), but mutation uses `jsonc-parser`'s structural `modify`/`applyEdits` against the original raw text so unrelated formatting and numeric lexemes beyond `Number` precision (e.g. `9007199254740993`) survive byte-for-byte except the structural edit. An absent `packages` array is created; an existing one must be an array of strings or `{source: string}`-tagged objects, else the write fails closed.
- **Pi tagged-entry matching is filter-aware.** A matching `{source}` object counts as already-configured only when it does not disable or filter out what Systematic needs: `autoload: false`, or a declared `extensions`/`skills` filter list, each fail closed with an actionable message (remove/adjust the flag) rather than silently duplicating an entry. Other filters (`prompts`, `themes`) don't affect Systematic and are left alone.
- **Identity check is a literal comparison** against the one known package (`@fro.bot/systematic` / Pi's `npm:@fro.bot/systematic`), including a bare-or-`@version` suffix match — not a general dependency-resolution mechanism (R8-style scoping, deliberately narrow).
- **Trusted single-read via `openTrustedExisting`:** an existing target is opened exactly once with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` on POSIX, `fstat`'d to reject any non-regular file (directory/FIFO/socket/device) before any blocking read, read once from the descriptor, and closed in `finally`. There is no separate path re-stat/re-read after the trust check; the same bytes and mode feed both parsing and the backup. Windows has no `O_NOFOLLOW`, so a best-effort `lstat` pre-check runs there instead (residual below). The parent directory is independently validated (must be a real, non-symlink directory; realpath stays under `cwd`) before this open.
- **Atomic, no-clobber backup.** On mutation of an existing target, `<target>.bak` is written via a same-directory temp file + atomic rename (never truncated in place), refusing to clobber ANY pre-existing backup path — regular file, hardlink, symlink (live or dangling), or directory — with a concise fail-closed error. Both the backup temp and target temp are created with `writeFileSync(..., { flag: 'wx', mode })` so an existing/symlinked temp path can't be followed; on mutation of an existing file the temp is then `chmod`'d to the exact original mode before rename (since `writeFileSync`'s `mode` is umask-masked and can't reproduce e.g. `0o666`). Cleaned up on write/rename/chmod failure. If the backup succeeds but the subsequent target rename fails, the backup is deliberately left in place as manual recovery evidence (not rolled back). New targets get no backup and respect umask.
- **No custom error class.** Per the repo's zero-class-for-errors convention, fail-closed errors are plain `Error` instances carrying a `name` marker, checked via the exported `isSetupError()` type guard rather than `instanceof`.
- **Result is a discriminated union**, `{status: 'configured' | 'already-configured', targetPath}`, not a boolean pair.
- **Identity matching excludes a trailing bare `@`** — only the bare package name or `@<nonempty version/tag>` counts as already-configured, for both harnesses.
- **Residual (accepted, not closable with portable Node/Bun):** Windows has no `O_NOFOLLOW`, so target-level symlink/non-regular-file rejection there relies on a best-effort `lstat` immediately before `openSync` — a real race remains between that check and the open on Windows only; POSIX stays descriptor-authoritative via `fstat`. A parent-directory swap between `assertParentTrusted`'s check and the later open/write calls (TOCTOU) also cannot be fully closed on any platform without a platform-specific `O_DIRECTORY`+`openat`-style primitive, which portable `node:fs` does not expose.

**Files (actual):**
- Created: `src/lib/setup.ts` — `setupHarness`, `isSetupError`, `Harness`, `SetupResult`, `SetupFsOps` (injectable write/rename/unlink/chmod seam for failure-path tests), `PI_PACKAGE_IDENTIFIER`, `SYSTEMATIC_PACKAGE_NAME`
- Modified: `src/cli.ts` — added the `setup` command + `--harness` flag parsing/validation, help text/examples for both harness values; invalid-harness usage goes to stderr
- Modified: `src/lib/AGENTS.md`, `STRUCTURE.md` — module map entry for `setup.ts`
- Modified: `tests/unit/package-exports.test.ts` — added a built `dist/cli.js setup --harness pi` smoke assertion inside the existing build/pack fixture (no second build)
- Test: `tests/unit/setup.test.ts` (pure mutation fixtures, trusted-read/atomic-backup safety), `tests/unit/cli.test.ts` (subprocess-level happy/invalid/idempotent/isolation/coexistence cases against real temp dirs)

**Approach:**
- `--harness opencode` resolves the target per the precedence order above and mutates singular `plugin` only (creating it if missing, rejecting `plugins` and duplicate keys); `--harness pi` mutates `.pi/settings.json`'s `packages` array via structural JSONC edit.
- **R20 safety:** atomic no-clobber backup with `wx`-staged temps and exact mode preservation, single trusted read (no re-stat/re-read), idempotency (identity + filter-aware Pi tagged-entry check short-circuits to zero writes), symlink/non-regular-file/non-directory-parent rejection before any read, and each harness's setup function only ever touches its own target file.
- No conflict materialized with cleanup `002`'s `convert`-command removal in `src/cli.ts`.

**Test scenarios (implemented):**
- Pure mutation fixtures: JSONC comment preservation, comment-like substrings inside string values surviving parse, a valid trailing-comma document mutating successfully, singular-`plugin`-only creation/mutation, `plugins` (plural) rejected alone and alongside `plugin`, literal duplicate top-level `plugin`/`plugins` key rejected, non-string `plugin` entries rejected, version-preserving no-op, a trailing bare `@` not treated as a match (both harnesses), `.opencode/opencode.jsonc` precedence over a coexisting root `opencode.json`.
- Pi: creation, append to existing valid `packages`, `packages` added to a settings file that has none, large-integer lexeme preserved byte-for-byte, matching tagged object with no filters (bare `{source}` and an unrelated `prompts` filter) is already-configured, matching tagged object with `autoload: false`/`extensions`/`skills` fails closed, malformed JSON / non-array `packages` / invalid entry shape all fail closed.
- Atomic writer/trust safety: exact-bytes backup on mutation, no backup for new targets, both temp writes staged with `flag: 'wx'`, an umask-sensitive exact mode (`0o666`) preserved via pre-rename `chmod`, POSIX-gated symlinked parent/target/backup rejection (symlink and hardlink backup variants, each verified against an untouched external sentinel), POSIX-gated dangling-symlink parent/target rejection, a regular-file `.pi` parent rejected, non-regular (directory) target rejected before any blocking read, rename-failure cleanup (target and backup paths independently), backup-succeeds-but-target-rename-fails leaves the backup as recovery evidence, zero-write no-op verified via injected write/rename call counters.
- CLI: happy path (`opencode` and `pi`), invalid args (missing/unknown/extra, no `--global`) with unknown-harness usage on stderr not stdout, idempotent rerun, harness-isolation, and `.opencode/opencode.jsonc`-wins-over-root coexistence, all against real temp directories.
- Built-artifact smoke: `dist/cli.js setup --harness pi` inside the existing `package-exports.test.ts` build/pack fixture.

**Verification:** `bun test tests/unit/setup.test.ts tests/unit/cli.test.ts` green (67/67); `bun test tests/unit/package-exports.test.ts` green (15/15); full `bun test tests/unit` green (1144/1144); `bun run typecheck` clean; `bunx biome check` clean on all touched files; `bun run build` succeeds (all three dist entries); `bun run docs:build` green; `bun run registry:drift` reports up to date; `content-integrity` clean.

- [x] **Unit 7: Pi-subprocess test harness**

**Goal:** An integration harness that spawns the built Pi extension and asserts the four parity capabilities, skipping cleanly where Pi is unavailable.

**Requirements:** R13, R14

**Dependencies:** Units 2–5

**Files:**
- Create: `tests/integration/pi.test.ts` (and helpers mirroring `tests/pi-rpc` shape — spawn, JSONL/RPC, mocked model, isolated env)
- Test: this unit IS the test

**Approach:**
- Mirror AFT's `tests/pi-rpc` and the existing `IsolatedFixture` discipline (temp HOME + XDG roots + config-content last); mock the model.
- Skip guard analogous to `OPENCODE_AVAILABLE` (e.g. `PI_AVAILABLE`) so CI without Pi skips cleanly.

**Execution note:** Integration-first — these assertions only prove value against a real spawned runtime.

**Test scenarios:**
- Integration: the packaged Pi extension loads; skills are discoverable.
- Integration: `systematic_skill` resolves a real skill body.
- Integration: the `using-systematic` bootstrap is injected into the session.
- Integration: a persona subagent runs to completion and returns a result.
- Integration (R14): running the Pi suite does not require or perturb the OpenCode suite; both green independently.

**Verification:** Pi harness asserts all four capabilities; skips cleanly without Pi; OpenCode suites unaffected.

**Verification (implemented):** `tests/integration/pi.test.ts` (931 lines, self-contained): real Pi 0.80.6 spawned via `dist/cli.js --mode rpc` against an in-test OpenAI-completions SSE mock (`Bun.serve`, port 0), packaged extension loaded from the `npm pack` tarball through a project-local `.pi/settings.json` relative-path package source (real `pi.extensions`/`pi.skills` manifest resolution, fully offline, `--approve` for non-interactive project trust). Model wiring via `models.json` in the agent dir (`PI_CODING_AGENT_DIR`; project-local `.pi/models.json` is not a Pi scope). All five scenarios green: extension load (no `extension_error` + bootstrap marker in the captured model payload), skill commands (`get_commands` `source: "skill"`), `systematic_skill` resolution (`tool_execution_end` carries `<skill_content>`), bootstrap injection incl. Pi-native usage text (asserted from the mock-model request payload — v0.80.6 RPC exposes no system-prompt command), and `systematic_delegate` child-session completion (`outcome === 'completed'`). Deliberate deviation from the planned skip guard: Pi is an exact devDependency, so the suite hard-fails with an actionable message when the CLI is missing instead of silently skipping (a `PI_AVAILABLE`-style guard could false-green CI). 5/5 integration, 1144/1144 unit, typecheck/lint/content-integrity clean.

- [ ] **Unit 8: Committed Pi install + parity docs**

**Goal:** Ship committed docs covering Pi installation and harness parity/differences, without changing the OpenCode path docs.

**Requirements:** R12

**Dependencies:** Units 1–6

**Files:**
- Create/Modify: a Pi install/parity page under `docs/src/content/docs/`, linked from active nav
- Modify: any active install guide to add the Pi path (leave the OpenCode path unchanged)

**Approach:**
- Document `setup --harness pi`, the manifest/skills registration, and the four parity capabilities.
- Note harness differences honestly (e.g. Pi trust-gating of project-local resources; the subagent depth cap).

**Test scenarios:**
- Test expectation: none (docs content) — verified by `bun run docs:build` (MDX parses, links resolve).

**Verification:** `bun run docs:build` green; Pi page reachable from active nav; OpenCode docs unchanged.

## System-Wide Impact

- **Interaction graph:** `src/lib/*` becomes shared by two entries; the shared skill-loader + bootstrap now serve OpenCode hooks AND Pi handlers/tools. `src/cli.ts` is touched by both this plan and cleanup `002`.
- **Error propagation:** Pi handlers/tools must not throw uncaught (hook-defect-swallow analog); delegation fails closed on depth (R18); config writes fail without corruption (R20).
- **State lifecycle risks:** subagent sessions are ephemeral (`SessionManager.inMemory()`); the re-entry guard prevents recursive extension binding; `configCwd` confinement prevents foreign code execution.
- **API surface parity:** `main`/`exports` unchanged for OpenCode; the `pi` manifest is additive; no `./pi` export.
- **Unchanged invariants:** `dist/index.js` exports only `['default']`; bundled agent markdown stays model-free; the OpenCode plugin's behavior and install path are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pi cannot load `dist/pi.js` from a published tarball | GATING smoke test in Unit 1; fallback = separate `-pi` package (the only structural pivot) |
| `--splitting` leaks exports into `dist/index.js`, breaking the OpenCode loader | Dual ESM export-shape smoke test (Unit 1); split the build into two invocations if needed |
| Delegation recurses infinitely (extension rebinds in child) | R17 re-entry guard: child spawned without rebinding Systematic's extension; unit-tested |
| Runaway/nested delegation exhausts resources (Pi caps nothing) | R18 fail-closed max-depth + max-turns; unit-tested |
| Subagent inherits full tool surface, widening injection blast radius | R19 explicit least-privilege allowlist from persona `tools` |
| `setup --harness` corrupts or cross-writes user config | R20 atomic + backup + idempotent + path-validated + harness-isolated writes |
| `src/cli.ts` conflict with cleanup plan 002 | Coordinate rebase order on `v3`; both changes are additive/removal in different regions |
| Optional-peer behavior differs across Pi installer vs npm | Install-matrix test (Unit 1); documented |
| Build target mismatch (bun vs node) for the Pi entry | Deferred build-target decision; split `bun build` if the Pi output needs a different target |

## Documentation / Operational Notes

- Pi support is additive to v3; it ships on the `v3` branch and cuts live with the rest of v3 (`--no-ff` merge to `main`).
- The committed Pi docs (Unit 8) are the parity source of truth; release notes for v3 should mention the second harness.
- Coordinate `src/cli.ts` edits with cleanup plan `002` to avoid merge friction.

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-06-pi-harness-support-requirements.md
- Related plan (shared v3 branch): docs/plans/2026-07-06-002-feat-v3-cleanup-release-plan.md
- Packaging targets: package.json, src/index.ts, src/pi.ts (new), src/cli.ts, .github/workflows/main.yaml
- Shared core: src/lib/skill-loader.ts, src/lib/skills.ts, src/lib/bootstrap.ts, src/lib/agents.ts
- Test model: tests/integration/opencode.test.ts; cortexkit AFT tests/pi-rpc
- Pi SDK: `createAgentSession`, `DefaultResourceLoader`, `SessionManager.inMemory`, `parseFrontmatter`, `getAgentDir` (`@earendil-works/pi-coding-agent` v0.80.3)
- oracle packaging review + Pi capability probe (this session)
