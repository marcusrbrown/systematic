---
title: "feat: Auth-aware source model resolution"
type: feat
status: completed
date: 2026-05-09
origin: docs/brainstorms/2026-05-09-auth-aware-source-model-resolution-requirements.md
---

# feat: Auth-aware source model resolution

## Overview

Expand `SOURCE_CATEGORY_MODEL_DEFAULTS` from a single `provider/model` string per agent category to an ordered array, and resolve the chosen model at plugin `config(cfg)` time by selecting the first array entry whose provider is authenticated on the user's machine. Authentication is read directly from OpenCode's on-disk auth file using the same XDG path convention OpenCode itself uses.

User overlays (`agents.<key>.model`, `categories.<id>.model`) remain string-only in this iteration. The resolver only fires for agents that have no stronger user override.

## Problem Frame

Systematic ships zero-config category defaults like `review → anthropic/claude-opus-4-7`. A user authenticated only to OpenAI receives a Systematic agent that names a model their installation cannot reach; OpenCode then surfaces a runtime error per request, or the user has to override every category in `~/.config/opencode/systematic.json` just to get past the default.

The published reference plugins (`@cortexkit/opencode-magic-context`, `oh-my-opencode-slim`, `@kodrunhq/opencode-autopilot`) all considered some form of multi-model defaults; all three settled for `array[0]` selection plus runtime error fallback. None inspect auth state before picking. Brainstorm research established that the OpenCode plugin lifecycle does NOT expose a hook between `config` and `chat.params` where auth-aware mutation is possible — but a synchronous read of OpenCode's `auth.json` at `config(cfg)` time produces correct results for the explicit-credential case (API/OAuth/WellKnown providers), which is the common shape.

## Requirements Trace

- R1. `SOURCE_CATEGORY_MODEL_DEFAULTS` becomes `Record<CategoryId, readonly string[]>`.
- R2. Every bundled category retains a non-empty array; `assertSourceCategoryModelCoverage` invariant holds.
- R3. Each array entry passes `validateModel`; arrays themselves are non-empty.
- R4. The plugin reads `auth.json` once per `config(cfg)` invocation and builds the authenticated-provider set.
- R5. For Systematic-owned bundled agents with no stronger user override, the emitted `agent.<name>.model` is the first array entry whose provider ID (the substring before the first `/`) is in the authenticated set.
- R6. If no array entry's provider is authenticated, the first array entry is emitted unchanged.
- R7. Auth-file path resolves to `path.join(XDG_DATA_HOME || ~/.local/share, 'opencode', 'auth.json')` using `process.env.XDG_DATA_HOME`-then-`os.homedir()` convention, treating empty/blank or non-absolute XDG values as unset.
- R8. A missing auth file is silently treated as "no providers authenticated"; an unreadable or malformed file is also treated that way AND emits a single user-visible diagnostic naming the path and failure category, with no file contents leaked.
- R9. Top-level keys of the auth file (and only top-level keys) are taken as authenticated provider IDs.
- R9a. Systematic reads only `Object.keys(...)`; nested values are never inspected, copied, persisted, transmitted, or logged. The derived authenticated-provider list is consumed in-process and discarded.
- R9b. Systematic never writes to `auth.json` and never repairs/normalizes/migrates the file.
- R10. User overlay `model` fields stay scalar (`string` only).
- R11. User-supplied `model` strings continue to bypass auth checks (structural validation only).
- R12. Documentation states autoload-true providers (e.g., AWS Bedrock per `packages/opencode/src/provider/provider.ts`) load from environment variables and may not appear in `auth.json`, so they may be skipped by the resolver; the mitigation is a category or exact overlay.
- R13. Documentation notes the tiny race window with `opencode auth login` and the OpenCode-restart fix.

## Scope Boundaries

- Not implementing runtime error-driven fallback (the omo-slim `ForegroundFallbackManager` pattern). If the chosen model fails at runtime, OpenCode surfaces the error.
- Not validating auth entry expiry, OAuth refresh validity, or token freshness. OpenCode owns real validation.
- Not accepting user-overlay `model` arrays in this iteration.
- Not handling environment-variable-only providers (Bedrock with `autoload: true`).
- Not detecting auth changes mid-session — resolver runs once per `config(cfg)`.
- Not changing the existing rejection of `fallback_models` in user overlays.
- Not changing user-overlay `model` validation (still requires `provider/model` shape).
- Not inspecting, logging, persisting, or transmitting auth file contents.
- Not writing to or modifying `auth.json`.
- Not extending `SECURITY_OVERLAY_FIELDS` — no new protected fields are introduced.

## Context & Research

### Relevant Code and Patterns

- `src/lib/agent-overlays.ts:52-59` — current `SOURCE_CATEGORY_MODEL_DEFAULTS` constant (single string per category)
- `src/lib/agent-overlays.ts:181-188` — `getSourceCategoryModel(category)` — the single integration point this plan extends
- `src/lib/agent-overlays.ts:190-202` — `assertSourceCategoryModelCoverage` — invariant that must keep holding
- `src/lib/agent-overlays.ts:204-214` — `validateSourceCategoryModelDefaults` — must learn to iterate arrays
- `src/lib/agent-overlays.ts:1-3` — `node:fs`, `node:path` imports already present; only `node:os` is new
- `src/lib/config-handler.ts:215-220` — call site that consumes the resolver result and writes `result.model`
- `src/lib/config.ts:67` — `SECURITY_OVERLAY_FIELDS` (NOT extended; this plan does not touch trust boundaries)
- `tests/unit/agent-overlays.test.ts` — existing patterns for testing `validateModel`, source coverage, overlay validation
- `tests/unit/config-handler.test.ts` — existing patterns for testing emitted-config shape with temp dirs
- `tests/integration/opencode.test.ts` — existing patterns for testing the full plugin config-hook flow with `os.homedir` mocking and `homeDir` temp directories

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md` — "treat plugin output as schema-validated"; the auth file is upstream-owned with stable top-level keys keyed by provider ID, but nested values use Effect Schema unions. This plan reads only the keys, so schema drift on nested values is a non-issue.
- `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — `plugInOnce` returns cached real hooks, so the `config(cfg)` body runs once per process even with duplicate plugin sources. Auth-file read inside the hook is naturally per-process and per-config-load.
- `docs/solutions/developer-experience/git-auto-merge-silent-identifier-duplication-2026-05-09.md` — when adding test scaffolding to `tests/integration/opencode.test.ts` (which already mocks `os.homedir`), do not duplicate the existing `originalHomedir` declaration or hook.

### External References

Brainstorm research (resumable session `ses_1f0d5df3affeBe3hI7XeoqnrIS`) established:
- OpenCode auth path resolution: `packages/core/src/global.ts:10` (xdg-basedir → `${XDG_DATA_HOME ?? ~/.local/share}/opencode/`) + `packages/opencode/src/auth/index.ts:10` (`auth.json` filename).
- Auth file shape: top-level keys are provider IDs; nested values are tagged unions of `Oauth | Api | WellKnown`.
- Auth file write is NOT atomic (`packages/core/src/filesystem.ts` writeJson) — race window exists during `opencode auth login`.
- Plugin lifecycle: no hook between `config` and `chat.params` can mutate agent config; `chat.params` fires after model selection.
- `provider/provider.ts` declares `autoload: false` for `github-copilot` and `openrouter` (these DO write to auth.json when authenticated). Bedrock and similar use `autoload: true` and load from environment variables — invisible to the resolver.

## Key Technical Decisions

- **Hand-rolled XDG path resolution.** Use `(process.env.XDG_DATA_HOME?.trim() && path.isAbsolute(process.env.XDG_DATA_HOME.trim()) ? process.env.XDG_DATA_HOME.trim() : path.join(os.homedir(), '.local/share'))` followed by `path.join(..., 'opencode', 'auth.json')`. Avoids adding `xdg-basedir` as a dependency. Matches OpenCode's behavior (verified against `core/src/global.ts:10`).
- **Extend `getSourceCategoryModel` rather than add a new module.** The existing function is the single call site and already knows about categories. Add an optional second parameter `authedProviders?: ReadonlySet<string>`. Backward compat: callers that don't pass the set get the array's first element (matches today's single-string behavior in spirit).
- **Auth-file read happens once per `config(cfg)` invocation, in the hook outer scope.** Pass the resulting `ReadonlySet<string>` through to the per-agent loop in `config-handler.ts`. No module-level cache (would persist across invocations and break test isolation).
- **The auth-file reader is exported from `agent-overlays.ts` as `getAuthenticatedProviders(rootDirOverride?: string): ReadonlySet<string>`.** The optional override exists for tests; in production the function uses the XDG-resolved path.
- **First-match wins, no scoring.** The array is an ordered preference list. Iterate, return on first authenticated entry, fall back to `array[0]` if none match.
- **Provider ID extraction is the substring before the first `/`.** Handles both `openai/gpt-5.5` and the nested form `openrouter/anthropic/claude-sonnet-4` correctly.
- **R8 diagnostic uses `console.warn` to stderr with a fixed message shape.** No file contents, no auth-derived data. Single emission per `config(cfg)` invocation. Plugin stderr is local-only in OpenCode (TUI surface or local log file); the diagnostic's path leak is bounded to the user's own machine and is not forwarded to telemetry. If a future OpenCode version pipes plugin stderr off-machine, revisit this choice.
- **`XDG_DATA_HOME` is trusted as user-controlled.** The plan does not validate that the resolved path is owned by the current user, contained within `os.homedir()`, or otherwise sandboxed. Threat model: the user already controls their own environment; pointing `XDG_DATA_HOME` elsewhere is the user's choice. Read access is read-only and the file is treated as malformed if it is not Record-shaped, so an unexpected target file collapses to the empty-set fallback.
- **No symlink hardening.** The auth file is in the user's own data dir; symlink attacks are out of threat model for this read.
- **No content-integrity gate change.** This plan adds runtime behavior, not bundled-asset surface area.
- **`getAuthenticatedProviders` is exported but documented as call-once-per-hook.** Its JSDoc must mark it as intended for a single invocation per `config(cfg)` cycle. Future callers that violate this contract risk repeated file reads and repeated stderr emissions; the contract is a comment, not enforced state.

## Open Questions

### Resolved During Planning

- **Q1: `xdg-basedir` package or hand-rolled?** Hand-rolled. Behavior is two lines (`(process.env.XDG_DATA_HOME?.trim() && path.isAbsolute(process.env.XDG_DATA_HOME.trim()) ? process.env.XDG_DATA_HOME.trim() : path.join(os.homedir(), '.local/share'))`); a dependency is overkill.
- **Q2: Where does the resolver live?** Extend `getSourceCategoryModel(category, authedProviders?)` in `src/lib/agent-overlays.ts`. The auth-file read is a sibling exported helper `getAuthenticatedProviders` in the same module.
- **Q3: How is the auth-file read cached within a single `config(cfg)` invocation?** Read once at the top of the hook, pass `ReadonlySet<string>` through. No module-level state.
- **Q4: Definitive autoload-true list?** AWS Bedrock is the example to cite in docs; planning grep against `anomalyco/opencode` `packages/opencode/src/provider/provider.ts` will confirm the full list during implementation. Doc copy can read "providers like AWS Bedrock that load from environment variables" and remain accurate even if the list grows.

### Deferred to Implementation

- Exact stderr message format for the R8 diagnostic (one line, includes path + failure category, prose to be polished during implementation).
- Whether to expose the read-once auth set on the public API of `getSourceCategoryModel` or keep it internal-only by accepting/returning it through an internal type. Production callers do not need this — only the integration test does, and it can use `getAuthenticatedProviders` directly.
- Whether the regression test in `tests/integration/opencode.test.ts` should write a synthetic `auth.json` into the existing `homeDir` fixture or use a separate fixture. The existing fixture already isolates `~/.config/opencode/`; adding `~/.local/share/opencode/auth.json` to the same fixture is the natural extension.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
config(cfg) hook fires
  ├── getAuthenticatedProviders()           // read auth.json once
  │     ├── resolve XDG path
  │     ├── fs.readFileSync (sync)
  │     ├── JSON.parse → Object.keys → Set
  │     ├── on missing: return empty Set silently
  │     └── on unreadable/malformed: emit one diagnostic, return empty Set
  │
  ├── for each Systematic-owned bundled agent:
  │     ├── if user override → skip auth-aware path (user wins)
  │     └── else:
  │           ├── getSourceCategoryModel(category, authedProvidersSet)
  │           │     ├── lookup array for category
  │           │     ├── find first entry whose substring-before-first-slash ∈ authedProvidersSet
  │           │     └── if none match → return array[0]
  │           └── result.model = chosen
  │
  └── emit config.agent map
```

The auth set is built once and threaded through the existing per-agent loop. No state escapes the hook scope.

## Implementation Units

- [x] **Unit 1: Expand source-default shape and update validators**

**Goal:** Change `SOURCE_CATEGORY_MODEL_DEFAULTS` from `Record<CategoryId, string>` to `Record<CategoryId, readonly string[]>`, ensure all existing source coverage validators handle the array shape, and prove no regressions in current behavior.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Test: `tests/unit/agent-overlays.test.ts`

**Approach:**
- Change the constant to `Record<CategoryId, readonly string[]>`. Each existing single-string value becomes a one-element array as the starting point. New entries can be added in this unit or a follow-up — the shape change is the unit's primary deliverable.
- Recommended starting arrays (subject to current-catalog verification during implementation):
  - `design`: `['openai/gpt-5.5', 'anthropic/claude-opus-4-7']`
  - `docs`: `['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5']`
  - `document-review`: `['anthropic/claude-opus-4-7', 'openai/gpt-5.5']`
  - `research`: `['openai/gpt-5.5', 'anthropic/claude-opus-4-7']`
  - `review`: `['anthropic/claude-opus-4-7', 'openai/gpt-5.5']`
  - `workflow`: `['openai/gpt-5.4-mini', 'anthropic/claude-haiku-4-5']`
- Update `validateSourceCategoryModelDefaults` to iterate each category's array and call `validateModel` per entry with an indexed key path like `source category model defaults.${category}[${index}]`. Reject empty arrays explicitly.
- `assertSourceCategoryModelCoverage` keeps its key-coverage shape; the value-shape check delegates to `validateSourceCategoryModelDefaults` as today.
- `getSourceCategoryModel(category)` keeps its current signature in this unit and returns `array[0]` for now. Auth-aware behavior comes in Unit 2.

**Patterns to follow:**
- `validateModel` invocation pattern from current `validateSourceCategoryModelDefaults` (`src/lib/agent-overlays.ts:204-214`).
- `Record<CategoryId, ...>` typing already used by the constant.

**Test scenarios:**
- Happy path: Each currently-shipped category still resolves to a model when `getSourceCategoryModel(category)` is called (returns `array[0]`).
- Edge case: An array with multiple entries returns the first entry from `getSourceCategoryModel(category)` until Unit 2 lands.
- Error path: `validateSourceCategoryModelDefaults` throws when fed a fixture with `category: []` (empty array).
- Error path: `validateSourceCategoryModelDefaults` throws when fed a fixture with `category: ['malformed-no-slash']` (each entry is structurally validated).
- Error path: `assertSourceCategoryModelCoverage` still throws when fed a category not present in the constant.
- Edge case: `validateSourceCategoryModelDefaults` accepts a fixture with `category: ['openai/gpt-5.5', 'anthropic/claude-opus-4-7']` (multi-entry valid array).

**Verification:**
- All existing `tests/unit/agent-overlays.test.ts` source-default tests continue to pass with no behavior change at the integration boundary (because Unit 1 still returns `array[0]`).
- `bun run typecheck` passes — the type signature change for `SOURCE_CATEGORY_MODEL_DEFAULTS` propagates cleanly.
- `bun scripts/content-integrity.ts` passes — no bundled-asset surface area is touched.

- [x] **Unit 2: Add auth-file reader and auth-aware resolver**

**Goal:** Add `getAuthenticatedProviders(rootDirOverride?)` that reads `auth.json` synchronously and returns the top-level-key set, and extend `getSourceCategoryModel` to accept an optional authenticated-provider set and return the first array entry whose provider ID matches.

**Requirements:** R4, R5, R6, R7, R8, R9, R9a, R9b

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/agent-overlays.ts`
- Test: `tests/unit/agent-overlays.test.ts`

**Approach:**
- Add `import os from 'node:os'` (the only new import; `fs` and `path` are already present).
- Add an exported function `getAuthenticatedProviders(rootDirOverride?: string): ReadonlySet<string>`. Mark it in JSDoc as intended for one invocation per plugin `config(cfg)` cycle; document that repeated calls trigger repeated file reads and (on malformed input) repeated stderr diagnostics. The contract is documentation, not enforced state.
  - Resolve the auth path: `path.join(rootDirOverride || (process.env.XDG_DATA_HOME?.trim() && path.isAbsolute(process.env.XDG_DATA_HOME.trim()) ? process.env.XDG_DATA_HOME.trim() : path.join(os.homedir(), '.local/share')), 'opencode', 'auth.json')`. The override exists only for tests; production callers omit it.
  - Read synchronously with `fs.readFileSync(path, 'utf8')`.
  - On `ENOENT` (missing): return empty `Set`, no diagnostic.
  - On any other read error or `JSON.parse` failure: return empty `Set` AND emit one `console.warn` to stderr naming the path and failure category (`unreadable` or `malformed`). Do NOT include file contents, partial JSON, or any auth-derived data in the diagnostic.
  - On successful parse: validate the parsed value is a plain object (Record-shaped), then return `new Set(Object.keys(parsed))`. If not Record-shaped, treat as malformed.
  - Never call `Object.values(...)` or otherwise read nested values. R9a is a hard contract.
- Extend `getSourceCategoryModel(category, authedProviders?: ReadonlySet<string>)`:
  - If `category` is undefined, return `undefined` (current behavior).
  - Look up the array. If undefined, return `undefined`.
  - If `authedProviders` is not provided OR is empty: return `array[0]` (R6 fallback also covers this case).
  - Iterate the array; for each entry, extract the provider ID (`entry.split('/', 1)[0]` or equivalent — substring before the first `/`); if `authedProviders.has(providerId)`, return `entry`.
  - If no entry matched, return `array[0]`.

**Patterns to follow:**
- Existing `fs.readFileSync` usage in `agent-overlays.ts` for category-directory reads (or in `src/lib/walk-dir.ts` for similar synchronous patterns).
- `node:os` usage from `tests/integration/opencode.test.ts:lines 105-127` (the `homeDir` fixture pattern).
- `console.warn` diagnostics are not currently widespread in the codebase; emit one stderr line in the simple format: `[systematic] auth.json <unreadable|malformed> at <path>; ignoring`.

**Test scenarios:**
- Happy path: `getAuthenticatedProviders(rootDir)` returns `Set(['openai'])` when fixture writes `{"openai":{"type":"api","key":"x"}}`.
- Happy path: Returns `Set(['github-copilot','anthropic'])` when fixture has both keys.
- Edge case: Returns empty `Set` and emits no diagnostic when the file is absent (`ENOENT`).
- Edge case: Returns empty `Set` and emits one stderr diagnostic when the file is unreadable (mode `0o000`).
- Edge case: Returns empty `Set` and emits one stderr diagnostic when the file contains malformed JSON (`{not valid`).
- Edge case: Returns empty `Set` when the file parses to a non-object (`null`, array, scalar) — treated as malformed.
- Edge case: Returns `Set(['openai'])` when the value at the key is anything (R9a — values are not inspected).
- Happy path: `getSourceCategoryModel('review', new Set(['openai']))` returns `'openai/gpt-5.5'` for the array `['anthropic/claude-opus-4-7', 'openai/gpt-5.5']`.
- Happy path: `getSourceCategoryModel('review', new Set(['anthropic','openai']))` returns `'anthropic/claude-opus-4-7'` (first match wins).
- Edge case: `getSourceCategoryModel('review', new Set())` returns `array[0]` (R6 fallback).
- Edge case: `getSourceCategoryModel('review')` (no second arg) returns `array[0]` (backward compat).
- Edge case: `getSourceCategoryModel('review', new Set(['openrouter']))` returns `array[0]` when no entry matches the authed set.
- Edge case: A nested-form entry like `'openrouter/anthropic/claude-sonnet-4'` is correctly recognized as `provider=openrouter` (substring before first `/`).
- Integration: `getAuthenticatedProviders` does NOT log, persist, or expose the nested values from `auth.json`. Test fixture writes a known secret-like token (e.g., `{"openai":{"type":"api","key":"sk-test-do-not-leak-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"}}`) — capture stderr and stdout for the entire test and assert (a) the literal `sk-test-do-not-leak-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` substring does NOT appear, AND (b) no string of `[A-Za-z0-9_-]{30,}` shape appears (the regex catches future drift if a different token shape is introduced).
- Integration: `getAuthenticatedProviders` does NOT modify the `auth.json` file (R9b). Read the file's mtime + sha256 before and after; assert unchanged.

**Verification:**
- All Unit 2 tests pass with `bun test tests/unit/agent-overlays.test.ts`.
- The diagnostic-on-malformed test asserts exactly one stderr line and that it contains the path + failure-category words.
- No leak: a regex like `/[A-Za-z0-9-_]{30,}/` (token-shape) does not appear in captured stderr/stdout for any happy-path test.

- [x] **Unit 3: Wire the auth-aware resolver into the config hook**

**Goal:** Read auth state once at the top of the `config(cfg)` hook in `config-handler.ts`, pass the resulting set through to per-agent processing, and use it when calling `getSourceCategoryModel`.

**Requirements:** R4, R5, R6, R10, R11

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Import `getAuthenticatedProviders` alongside the existing `getSourceCategoryModel` import.
- The per-agent loop lives in `collectAgents` (`src/lib/config-handler.ts:155`), called from `createConfigHandler` at line 452. Two equivalent insertion points:
  - Read auth state in `createConfigHandler` and pass `authedProviders` as a new argument to `collectAgents` (preferred: keeps the auth surface visible at the hook entry point and keeps `collectAgents` testable with explicit auth state).
  - Read auth state inside `collectAgents` before its per-agent loop. Discouraged: makes test injection harder.
- The existing call at `src/lib/config-handler.ts:216` becomes `getSourceCategoryModel(agentInfo.category, authedProviders)`.
- User-overlay precedence is unchanged: the existing flow already runs the source-default lookup BEFORE applying category overlay (`src/lib/config-handler.ts:215-220`) and exact overlay (later in the same function). Auth-aware resolution only affects the source-default value; user overlays still win as today.
- Bundled-agent markdown remains model-free — no change to agent file frontmatter.

**Patterns to follow:**
- Existing import block at the top of `src/lib/config-handler.ts` (`import { ..., getSourceCategoryModel, ... } from './agent-overlays.js'`).
- Existing source-default application at lines 215-220.

**Test scenarios:**
- Happy path: With no `auth.json` present in the test home dir, an emitted `review`-category agent gets the array's first entry (current zero-config behavior, no regression).
- Happy path: With `auth.json` containing `{"openai":{...}}` and a `review` category whose array starts `['anthropic/claude-opus-4-7', 'openai/gpt-5.5']`, the emitted model is `'openai/gpt-5.5'`.
- Happy path: With `auth.json` containing `{"github-copilot":{...},"anthropic":{...}}` for the same array, the emitted model is `'anthropic/claude-opus-4-7'` (first match wins).
- Happy path: `getAuthenticatedProviders` is invoked exactly once per `config(cfg)` invocation, regardless of how many bundled agents exist. Assert by either (a) `mock.module('./agent-overlays.js', ...)` before importing `config-handler.ts` and counting calls on the mocked function, or (b) injecting the reader through `ConfigHandlerDeps` for test purposes and counting through the injected version. The contract being tested is the helper-invocation count from `config-handler`, not the underlying `fs.readFileSync` call count.
- Edge case: A user-supplied `categories.review.model` overrides the auth-aware source default; the overlay still wins regardless of auth state.
- Edge case: A user-supplied `agents.<name>.model` exact overlay overrides both category overlay and source defaults; auth-aware resolution does not run for that agent.
- Edge case: A bundled agent in a category whose array contains zero entries authenticated emits `array[0]` and OpenCode owns the runtime failure.
- Integration: An existing `tests/integration/opencode.test.ts` `config hook integration` describe block adds a fixture writing `auth.json` to the temp `homeDir` and asserts the emitted models match per-category expectations for two auth-state scenarios (single-provider and multi-provider).

**Verification:**
- All `tests/unit/config-handler.test.ts` tests pass.
- The new integration scenarios in `tests/integration/opencode.test.ts` pass.
- `bun run typecheck`, `bun run lint`, and `bun run registry:drift` all pass.

- [x] **Unit 4: Document the new behavior**

**Goal:** Update user-facing documentation to describe the array shape, the auth-aware resolution behavior, the documented limitations (autoload providers, race window), and confirm that user overlays remain scalar.

**Requirements:** R12, R13

**Dependencies:** Unit 3

**Files:**
- Modify: `README.md`
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`

**Approach:**
- README: add a paragraph under the existing source-default discussion describing that defaults can now be ordered arrays, that the resolver picks the first authenticated provider, and that it falls back to the first array entry when no match exists. Reference the doc page.
- Configuration docs page: add a new subsection under the agent-overlay docs describing the source-default array shape, the auth-file path, the precedence (user > category > source-default-resolver > inheritance), and the two documented limitations:
  - Autoload-true providers (e.g., AWS Bedrock, which loads from environment variables) may not appear in `auth.json` and may be skipped by the resolver — pin via category or exact overlay.
  - A tiny race window exists with `opencode auth login`; restart OpenCode to refresh the resolved model.
- README's existing "Systematic does not support `fallback_models`" sentence stays unchanged — this plan does not introduce fallback chains.

**Patterns to follow:**
- Existing source-default copy in `README.md` and `docs/src/content/docs/getting-started/configuration.mdx`.

**Test scenarios:**
- Test expectation: none — documentation-only changes. `bun run docs:build` validates Starlight syntax and link integrity.

**Verification:**
- Docs build succeeds.
- README and configuration docs both describe the array shape, the resolver behavior, and the two limitations.

## System-Wide Impact

- **Interaction graph:** Touches the plugin `config(cfg)` hook entry point. No effect on tool execution, skill loading, or agent dispatch.
- **Error propagation:** A missing/malformed auth file does not throw — the config hook continues with an empty authenticated-provider set and emits source defaults' first entry. OpenCode owns runtime model-availability errors.
- **State lifecycle risks:** The authenticated-provider set is built once per hook invocation, lives in hook-scope only, and is discarded when the hook returns. No persistence, no caching across invocations.
- **API surface parity:** No new external API. `SOURCE_CATEGORY_MODEL_DEFAULTS` is module-private and unexported. `getSourceCategoryModel`'s signature gains an optional second parameter (backward-compatible). `getAuthenticatedProviders` is a new export.
- **Integration coverage:** The auth-aware resolution path requires an integration scenario in `tests/integration/opencode.test.ts` because unit tests of `getAuthenticatedProviders` alone do not prove the read-once-and-thread-through behavior in the actual hook.
- **Unchanged invariants:** Bundled agent markdown still omits `model:` (content-integrity gate enforces). User-overlay `model` validation is unchanged. `SECURITY_OVERLAY_FIELDS` is unchanged. The plugin-singleton contract from PR #335 is preserved (auth read happens inside `config()`, which is itself guarded by `plugInOnce`). Existing user overlays continue to win over source defaults.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Reading `auth.json` synchronously inside the `config(cfg)` hook adds startup latency | The file is small (typically <1 KB) and read once per hook invocation. No measurable impact. |
| The `auth.json` schema upstream might evolve to no longer have provider IDs as top-level keys | Read-only and key-only access tolerates additive schema changes. If keys move into a nested object in a future OpenCode version, the resolver gracefully degrades to "no providers authenticated" and emits `array[0]` — same behavior as today's missing-file case. |
| Race window during `opencode auth login` | Documented in R13 with the OpenCode-restart workaround. Probability low (single user manually invoking auth login in a different shell while the plugin is loading). |
| A future contributor expands the resolver to inspect nested values in `auth.json` | R9a is documented in the brainstorm and reflected in the unit tests asserting no token-shaped strings appear in stderr/stdout. The contract is captured in the test suite, not just prose. |
| `process.env.XDG_DATA_HOME` is set to a non-existent directory in some users' shells | The reader treats an absent file as "no providers authenticated" silently. Behavior matches the no-auth case — defaults to `array[0]`. |
| Adding a new bundled agent category without an entry in `SOURCE_CATEGORY_MODEL_DEFAULTS` | `assertSourceCategoryModelCoverage` already throws in this case; behavior is unchanged. |

## Documentation / Operational Notes

- This is a developer-facing config feature with no operational impact (no production service, no telemetry, no migration).
- Release notes should highlight that zero-config Systematic now adapts to a user's authenticated providers automatically — with a one-line note for users on Bedrock/env-var providers that they may need to pin a model explicitly.
- No data migration. Existing user configs continue to work unchanged.
- Suggested release: minor version bump (`v2.11.0`) — additive feature, backward compatible.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-09-auth-aware-source-model-resolution-requirements.md](../brainstorms/2026-05-09-auth-aware-source-model-resolution-requirements.md)
- Related code: `src/lib/agent-overlays.ts`, `src/lib/config-handler.ts`
- Related tests: `tests/unit/agent-overlays.test.ts`, `tests/unit/config-handler.test.ts`, `tests/integration/opencode.test.ts`
- Related solution doc: `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md`
- Related solution doc: `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md`
- Predecessor PRs: #343 (overlay foundation), #344 (security-field guard), #345 (source defaults v1, single-string), #346 (color schema fix), #347 (compound docs)
- OpenCode source: `packages/opencode/src/auth/index.ts`, `packages/core/src/global.ts`, `packages/opencode/src/provider/provider.ts`, `packages/plugin/src/index.ts`
