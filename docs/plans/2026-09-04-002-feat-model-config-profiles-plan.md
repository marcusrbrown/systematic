---
title: "feat: Named model profiles with per-harness routing blocks"
type: feat
status: completed
date: 2026-09-04
origin: docs/brainstorms/2026-09-04-model-config-profiles-requirements.md
deepened: 2026-09-04
---

# feat: Named model profiles with per-harness routing blocks

## Overview

User config gains a `profiles` map of named routing bundles and a `profile` selector that any config source — including a repository's project config — may set. The existing `agents.<name>` and `categories.<category>` overlays gain optional `opencode` and `pi` blocks so one config routes correctly on both harnesses, with the flat fields staying as the harness-neutral default. Profile selection resolves first by strongest source; overlays then resolve user base → selected profile → project's permitted fields → custom. Pi delegation honours the resolved routing (it inherits the parent model today) and says where the model came from. Every configuration valid before this change stays valid and emits the same OpenCode agent config.

## Problem Frame

Two things the current overlays cannot express have become routine for the maintainer (see origin). A person working across repositories that warrant different routing from the same harness has only `$OPENCODE_CONFIG_DIR`, which switches the entire OpenCode profile and is OpenCode-only; a repository cannot say which of the user's routing sets it should run under. And a person on both OpenCode and Pi finds the overlay vocabulary is OpenCode's — `model` plus `variant` — while Pi's `thinking` lives in a separate `pi_subagents` tree and in-process Pi delegation ignores overlay models entirely.

Magic Context shipped the same two halves (per-harness blocks in v0.39.0, user-owned named profiles with repository selection in v0.40.0). The design transfers; the bones differ. Systematic's routing is already per-agent and per-category, project config is already barred from `model`/`variant` by `SECURITY_OVERLAY_FIELDS`, the Pi export path already resolves overlay models into persona frontmatter, and Claude Code cannot consume runtime config at all.

## Requirements Trace

Carried from the origin document; IDs match it.

- R1–R3c. Per-harness `opencode`/`pi` blocks on agent and category overlays; flat fields as neutral default; block beats flat; agent beats category; `model: null` permitted. OpenCode's `variant` is bound to whichever layer supplies `model` — taken only from that layer or a more specific one, so a less-specific layer's stale `variant` is dropped when a more-specific layer sets or nulls `model`, and `variant` with no `model` anywhere is a post-merge config-load error. Pi's `thinking` is independent of `model`: it applies to whatever model the delegate ends up running, including one inherited from the parent session, so `thinking` with no `model` anywhere is valid and never an error.
- R4, R4a. Pi delegation honours resolved routing, inherits the parent model when nothing resolves, and reports model and source once per session.
- R5. `pi_subagents.<name>.thinking` superseded by `agents.<name>.pi.thinking`; new wins; old applies only when new absent; one deprecation warning.
- R6, R7. `profiles` defined in user config, restricted to routing fields; non-routing fields rejected at validation.
- R8–R11. Any source may select via `profile`; strongest wins; project may not define `profiles`; resolution user base → profile → project permitted → custom; unknown name warns once and falls back to the user's own default, else base.
- R12. `systematic config show` reports the active profile or the fallback that occurred.
- R13, R14. Existing configs stay valid and produce identical OpenCode output; no new vocabulary surfaces unless opted into.

## Scope Boundaries

- Claude Code: the schema rejects a `claude-code` block; nothing in that bundle consumes runtime config (see origin).
- No `fallback_models` chains; one model per harness per target.
- No model-tier indirection; categories remain the tier layer.
- No CLI flag or environment variable for selection; `profile` is a config field so it is visible and never process-global.
- No automatic rewrite of existing config files.
- The OMO registry profile is not shipped as a named Systematic profile; that is a package-policy decision to raise separately once profiles exist.

### Deferred to Separate Tasks

- Deriving `SECURITY_OVERLAY_FIELDS` from the `trustProtected` schema metadata instead of the hand-maintained list: pre-existing duplication this plan extends rather than fixes; separate refactor.
- Per-dispatch config reload in the Pi delegate (so a profile change takes effect without restarting Pi): future iteration if the restart proves annoying in practice.

## Context & Research

### Relevant Code and Patterns

- `src/lib/config-schema.ts` — `AgentOverlaySchema` / `CategoryOverlaySchema` (`.strict()`, `enforceVariantHasExplicitModel` refinement), `modelSchema` (nullable provider/model), `variantSchema`, `PiSubagentsAgentOverlaySchema` (`thinking`, no model), `trustProtected` / `trustAny` metadata, `SECURITY_OVERLAY_FIELDS` (hand-listed), `createSystematicConfigSchema`.
- `src/lib/config.ts` — `loadConfigWithSources` (user → project → custom; validate; strip protected paths; `mergeOverlaySources`; returns `{ config, metadata, overlays }`), `PROJECT_PROTECTED_FIELDS`, `warningSink` (defaults to `console.warn`), removed-name accept-warn-drop handling.
- `src/lib/agent-overlays.ts` — `validateAgentOverlays` / `validateExactAgentOverlays` (bare and `category/name` alias keys, hard errors on unknown names), `resolveAgentOverlaySet` (index into maps).
- `src/lib/config-handler.ts` — applies resolved overlays to emitted OpenCode agents.
- `src/lib/agent-resolver.ts` — `AgentCatalogEntry` and `buildAgentCatalog`; today the entry drops the agent's file stem and category, keeping only frontmatter `name`.
- `src/lib/pi-delegate-tool.ts` / `src/lib/pi-delegate-session.ts` — `validateDelegateRequest` fails closed without `ctx.model` and threads it unchanged into `CreateAgentSessionOptions`; `src/pi.ts` registers the tool with only `catalog` and `createDelegateSession`.
- `src/lib/pi-subagents-export.ts` — already resolves `agents.<name>.model` and `pi_subagents.thinking` into exported persona frontmatter and strips project-sourced values; never translates `variant`.
- `src/cli.ts` — `configShow` prints raw user/project files; `capabilities` computes a resolved view to mirror for R12.
- `scripts/generate-config-schema.ts` + `bun run schema:drift`; `docs/scripts/generate-config-reference.ts` (renders descriptions/types/defaults/enums/examples, fails on a field missing `examples` meta, walks one level into records via `checkAdditionalProperties`, `TOP_LEVEL_KEYS` list).
- `tests/unit/config-schema.test.ts`, `tests/unit/config.test.ts`, `tests/unit/agent-overlays.test.ts`, `tests/unit/pi-delegate-tool.test.ts`, `tests/unit/pi-subagents-export.test.ts` — fixture styles to mirror.

### Institutional Learnings

- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — trust-sensitive fields need an explicit allowlist; project config must never trump user denials. Governs `profiles` (protected) vs `profile` (selectable).
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` — schema, generated JSON Schema, and drift gate move together.
- `docs/solutions/best-practices/zod-json-schema-ref-dedup-postprocessors-2026-05-17.md` — the same overlay sub-schema appearing in base and inside `profiles` needs ref-aware post-processing.
- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` — inheritance is the fallback; never pin a provider the user may not have.
- `docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md` — the model-inheritance eval watches `model` and `variant`; new blocks must not reintroduce source-owned pinning under either.
- `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md` — Pi export is a constrained projection; strip project-sourced Pi capabilities; never translate `variant` into Pi fields.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` — generated surfaces drift silently; regenerate every one a change reaches.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/lib",
  "freshness": {
    "vcs_reference": "324a87ed213111204fbe299c34121ad58ade081c"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/lib/config.ts:loadConfigWithSources",
      "description": "Loads user/project/custom config sources, merges overlay maps, strips protected fields, and returns the effective config plus source metadata.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/lib/config-schema.ts:AgentOverlaySchema",
      "description": "Defines trust tags, strict overlay schemas, and the hand-listed protected-field set.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/agent-overlays.ts:validateAgentOverlays",
      "description": "Validates overlay keys against bundled agent/category inventories and indexes validated overlays for runtime lookup.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/config-handler.ts:createConfigHandler",
      "description": "Consumes loaded config and resolved overlays to emit OpenCode agent/command config.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-subagents-export.ts:resolvePersonaFrontmatter",
      "description": "Resolves Pi persona frontmatter fields from config overlays, including current Pi-native thinking export.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/pi-delegate-tool.ts:validateDelegateRequest",
      "description": "Validates delegate requests and passes the parent model into child session creation, currently fail-closed when no model exists.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/cli.ts:configShow",
      "description": "Current config-show command only prints raw file contents and paths.",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **One routing resolver, three consumers.** A single function computes, for one target on one harness, the effective `{ model, qualifier, source }` from the merged overlays under R3a (agent block > agent flat > category block > category flat). The OpenCode config hook, the Pi delegate tool, the Pi persona export, and `config show` all call it. Rationale: the precedence is the contract; four hand-rolled copies would drift, and the resolver is where "source" (for R4a and R12) is known.
- **Profile selection is a load-time step between stripping and merging.** After each source is parsed and project's protected fields are stripped, the selector is resolved (custom > project > user); the named bundle is looked up across both custom's and user's `profiles` maps, custom checked first, then user; and the overlay chain becomes four entries: user base, selected profile, project, custom. `mergeOverlaySources` gains no new semantics — it merges a longer chain. The profile-bundle layer itself merges field-by-field, not wholesale-replace, unlike an ordinary same-key user/custom override (see R7/R10). Rationale: R10's order falls out of chain position; nothing else in the loader changes.
- **`profile` is not protected; `profiles` is.** The selector chooses among bundles the user authored, so a repository setting it is the feature. `profiles` joins `PROJECT_PROTECTED_FIELDS` and both `trustProtected` metadata and `SECURITY_OVERLAY_FIELDS` gain the new block paths. Rationale: the trust boundary in `layered-trust-boundaries-overlay-config` is exactly "select, never define."
- **Qualifier-requires-model moves from parse time to a post-merge pass — OpenCode only.** The per-overlay `superRefine` is relaxed to allow a qualifier without a model in a written fragment; the check runs once on each target's effective overlay and throws a config error naming the target and harness, but only for OpenCode's `variant`. Pi's `thinking` is never subject to this check: a `thinking` value with no `model` anywhere is a normal, valid configuration. Rationale: R3b requires a profile to set `pi.thinking` alone with no model at any layer, which is legitimate on Pi but not on OpenCode, and a parse-time check cannot see the lower layer, so the OpenCode-only check moves post-merge.
- **The Pi delegate resolves routing from config loaded once at extension start.** `src/pi.ts` does not load config today (it builds the catalog and registers tools); it gains one `loadConfigWithSources` call at init and passes the merged overlays and the resolver into `createPiDelegateTool`. `AgentCatalogEntry` gains the agent's file stem, category, and qualified id so the tool can key into the overlays (today it keeps only the frontmatter `name`). Rationale: no per-dispatch re-parse; the cost is that a profile change needs a Pi restart.
- **The in-process Pi delegate applies both `model` and `thinking`.** The pinned Pi SDK (`@earendil-works/pi-coding-agent` 0.83.0) exposes `thinkingLevel` on `CreateAgentSessionOptions`, and its value set is identical to Systematic's `thinking` enum, so the delegate passes the resolved qualifier straight through (absent when none resolves, so the child inherits Pi's default). Planning had assumed no such option existed; implementation checked the SDK and found it. Persona export applies the same values through the resolver.
- **`profile` is tri-state.** `undefined` means "no opinion" (lower sources decide); `null` means "explicitly none" and is a selection that wins like any other; a string names a bundle. Rationale: without `null`, a stronger source has no way to force base config when a weaker one sets a default — the fallback would depend on omission rather than intent.
- **Provenance is not needed after merge.** Protected fields (`model`, `variant`, `thinking`, `permission`, `skills`) are stripped from the project source before the chain is merged, so the merged overlays cannot carry a project-sourced value for them and the resolver needs no layer tags to be safe; `temperature`/`top_p` are project-settable today and stay so. Rationale: the boundary is enforced once, at load, as `layered-trust-boundaries-overlay-config` prescribes.
- **"Once per session" for R4a is a set keyed by delegated agent in the tool's closure.** The first dispatch of each agent whose model came from config appends one line to the tool's result naming model and source. Rationale: the tool has no session object to hang state on; closure state lives for the extension's life, which is the session.
- **Pi export honours the `pi` block with the same resolver.** `pi-subagents-export.ts` replaces its own `model` + `pi_subagents.thinking` lookup with a resolver call for the `pi` harness and keeps stripping project-sourced values. Rationale: one precedence, one place; the committed persona fixtures are generated from bundled markdown with no user config, so the fixture drift gate is unaffected.
- **Docs reference generator learns to recurse one more level and treats `profiles` entries as "same shape as `agents`/`categories`".** Rationale: the generator walks records one level deep and fails the build on any field without `examples`; the nested `opencode`/`pi` blocks and the `profiles` record both need explicit meta and a rendering rule, or `bun run docs:generate` breaks.

## Open Questions

### Resolved During Planning

- Is the `profile` selector a protected field? No — selecting among user-authored bundles is the feature; only `profiles` is protected.
- Where does the post-merge qualifier check live? In the loader, immediately after the merged overlays exist, via the shared resolver — not in `agent-overlays.ts`, whose job is key validation.
- Does the Pi persona fixture drift gate see local profiles? No — `generateAll` reads bundled markdown only.
- Can the eval `model-inheritance` case be reused as the back-compat gate? Partly: it proves bundled agents stay model-free under the config hook. R13 additionally needs a snapshot of emitted OpenCode agent config for a corpus of pre-change user configs; Unit 6 builds that corpus from the existing config fixtures.
- Selection state table (custom C, project P, user default U; "defined" means present in custom's OR user's `profiles`, both maps eligible lookup sources with custom preferred on a name collision): strongest-set selector S wins, where `null` counts as set and means base; if S is a name not defined → warn naming S → use U if defined → else base with a second clause noting U also missing; S = U = undefined name → single warning, base. Eleven cases enumerated in Unit 2's test scenarios.
- Does the Pi delegate session accept a reasoning-effort option? Yes — `thinkingLevel` on `CreateAgentSessionOptions` (found during implementation); the delegate applies model and thinking, and persona export applies the same.
- Does `capabilities` already compute a resolved routing view to reuse for `config show`? No — it builds a capability snapshot without per-agent routing. `config show` sources its resolved section from the new loader metadata instead.

### Deferred to Implementation

- Exact names of the resolver and its result type; whether `source` is an enum or a small struct.
- Whether the four-entry overlay chain is built as an array or as a named struct; either is fine for `mergeOverlaySources`.
- The one-line format of the Pi delegate's routing notice.
- Whether `config show` prints the per-agent routing table by default or behind a flag; the active profile line is unconditional.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
load:
  user, project, custom  ← parse each (strict schema; harness blocks and profiles now valid)
  project               ← strip PROJECT_PROTECTED_FIELDS (+ profiles) with warnings
  S                     ← custom.profile ?? project.profile ?? user.profile
  bundle                ← user.profiles[S]  |  if missing: warn(S) → user.profiles[user.profile] | base
  overlays              ← merge([user.base, bundle, project, custom])
  for each target × harness: assertQualifierHasModel(resolve(target, harness))

resolve(target, harness) → { model, qualifier, source }:
  agent block > agent flat > category block > category flat
  qualifier = variant (opencode) | thinking (pi, then legacy pi_subagents.thinking with deprecation warning)

consumers:
  config-handler (opencode)   pi-delegate-tool (pi)   pi-subagents-export (pi)   cli config show (both)
```

## Implementation Units

- [x] **Unit 1: Schema — harness blocks, profiles, relaxed parse-time refinement**

**Goal:** The strict schema accepts the new shapes and rejects the forbidden ones; generated JSON Schema and docs reference regenerate clean.

**Requirements:** R1, R2, R3c, R6, R7, R14

**Dependencies:** None

**Files:**
- Modify: `src/lib/config-schema.ts` (harness block schemas; `opencode`/`pi` on both overlay schemas; `profiles` record of a routing-only overlay bundle; `profile` selector; relaxed `enforceVariantHasExplicitModel`; `trustProtected` on block `model`/`variant`/`thinking`; `SECURITY_OVERLAY_FIELDS` additions), `docs/scripts/generate-config-reference.ts` (`TOP_LEVEL_KEYS`, one more recursion level, rendering rule for `profiles`)
- Regenerate: `docs/public/schemas/v3/systematic-config.schema.json`, `docs/src/content/docs/reference/configuration.mdx` generated region
- Test: `tests/unit/config-schema.test.ts`, `tests/unit/generate-config-reference.test.ts`

**Approach:**
- The `opencode` block is a strict object of `model` + `variant`; the `pi` block of `model` + `thinking`. Each carries `description` and `examples` meta. A `claude-code` key is rejected by strictness with no special casing.
- The profile bundle schema is a strict object of optional `agents` and `categories` records whose values are the routing-only projection of the overlay schemas (`model`, `variant`, `temperature`, `top_p`, `opencode`, `pi`); any other overlay field fails with the offending path.
- `enforceVariantHasExplicitModel` no longer fails a written fragment that has a qualifier but no model; the invariant moves to Unit 3.
- Every new field has `examples` meta, or the docs build fails.

**Patterns to follow:**
- Existing `AgentOverlaySchema` / `PiSubagentsAgentOverlaySchema` for strictness and meta style.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` for the regenerate-together discipline.

**Test scenarios:**
- Happy path: an overlay with `opencode: { model, variant }` and `pi: { model, thinking }` parses.
- Happy path: a `profiles` map with two bundles and a top-level `profile` parses.
- Happy path: a config with no new fields parses to the same value as before (assert deep equality with the pre-change parse of every existing config fixture).
- Error path: `pi: { variant }` and `opencode: { thinking }` each fail naming the path.
- Error path: `claude-code: {}` on an overlay fails.
- Error path: `profiles.x.agents.fixer.permission` fails naming the path.
- Edge case: `pi: { thinking: "high" }` with no model anywhere in the written overlay parses (invariant deferred to post-merge).
- Edge case: `model: null` inside a harness block and inside a profile parses.
- Integration: `bun run schema:drift` and `bun run docs:generate` are clean after regeneration; the generated reference renders both blocks and the `profiles` shape.

**Verification:**
- Schema and docs drift gates clean; content-integrity clean.

- [x] **Unit 2: Loader — profile selection and the four-entry merge chain**

**Goal:** `loadConfigWithSources` resolves the selector, looks up the bundle, strips project `profiles`, and merges base → profile → project → custom.

**Requirements:** R8, R9, R10, R11, R13

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config.ts` (`PROJECT_PROTECTED_FIELDS` + `profiles`; selection step; overlay chain; warnings for missing selector and project `profiles`; `ConfigObservationMetadata` gains `activeProfile`, `profileSelectorSource`, and `profileFallback`, populated by `buildConfigObservationMetadata` right after selection — today it carries only `authorities`, `protectedFields`, `sources`)
- Test: `tests/unit/config.test.ts`

**Approach:**
- Selection happens after per-source validation and project stripping, before `mergeOverlaySources`. The returned metadata records which source supplied the selector, the resolved name, and whether a fallback occurred, so `config show` and tests can read it.
- Missing-name handling emits exactly one warning per load through `warningSink`; the message names the missing profile and, when applicable, that the user default was used or was also missing. "Once" is per `loadConfigWithSources` call, which is once per OpenCode plugin init, once per Pi extension init, and once per CLI invocation.

**Patterns to follow:**
- Removed-name accept-warn-drop handling in the same file for warning shape.
- Existing protected-field stripping for the `profiles` warning.

**Test scenarios:**
- Happy path (selection table cases 1–4): no selector → base; user default only → that profile; project selector over user default → project's; custom over both → custom's.
- Happy path (case 11): user default `personal`, project `profile: null` → base, no warning; custom `profile: null` over a project name → base.
- Error path (cases 5–10): project selects an undefined name with a defined user default → user default active, one warning naming the missing name; undefined name and undefined user default → base, one warning noting both; custom selects undefined name → same rules; user default itself undefined → base, one warning, no loop.
- Error path: project config contains `profiles` → stripped, one warning, none of its names selectable even if the project also selects one.
- Happy path (merge order): base sets `agents.fixer.model: A`, profile sets `agents.fixer.model: B`, project sets `agents.fixer.temperature: 0.2`, custom sets `agents.fixer.model: C` → effective model C, temperature 0.2; with custom absent → model B.
- Integration: every existing config fixture in `tests/` loads with identical `config` and `overlays` to the pre-change loader (snapshot corpus, see Unit 6).

**Verification:**
- The ten selection cases pass; metadata exposes the active profile; existing loader tests unchanged.

- [x] **Unit 3: Routing resolver and post-merge qualifier check**

**Goal:** One function answers "what model and qualifier does target T get on harness H, and from where"; the loader asserts the qualifier invariant on its output.

**Requirements:** R3, R3a, R3b, R5

**Dependencies:** Unit 2

**Files:**
- Create: `src/lib/routing-resolver.ts`
- Modify: `src/lib/config.ts` (call the post-merge check after merging), `ARCHITECTURE.md` (codemap entry), `src/lib/AGENTS.md` (module-table row)
- Test: `tests/unit/routing-resolver.test.ts`

**Approach:**
- Input: merged overlays, a target (agent key with its category), a harness. Output: `{ model, qualifier, source }` where `source` names the layer (agent/category, block/flat, and for Pi whether `thinking` came from the legacy `pi_subagents` location).
- Precedence per R3a; `model: null` is a value meaning "inherit" and beats a lower layer's explicit model.
- Legacy `pi_subagents.<name>.thinking` is consulted only when no `pi.thinking` resolves; using it emits one deprecation warning per target naming the new location, whether or not the legacy value actually wins (it also fires when a `pi.thinking` block overrides it — the user still has stale config to migrate away from).
- **Qualifier binding differs by harness.** OpenCode's `variant` is coupled to whichever layer supplies `model`: let L be the most specific layer (agent block > agent flat > category block > category flat) that sets `model` as an own property; `variant` is taken only from L or a more specific layer, dropped from anything less specific, and dropped entirely when the model at L is `null` (inherit). If no layer sets a model at all, `variant` still resolves via its own precedence, so a variant-with-no-model-anywhere remains detectable and is a config-load error. Pi's `thinking` resolves fully independently of `model` — it applies to whatever model the delegate ends up running, including one inherited from the parent session, so `thinking` with no model anywhere is valid and never an error.
- The post-merge check walks every agent key present in the merged overlays, plus every bundled agent whose category has an overlay, resolving each on both harnesses; it throws a config error only for OpenCode when a `variant` resolves without a model at any layer (Pi's `thinking` never triggers this). Categories are not checked in isolation: a category `variant` with no category model is fine when every agent in that category resolves a model from its own overlay, and is an error only for an agent that does not.
- `model: null` obeys the same precedence as any value: a block's `null` beats a flat explicit model at the same level, and a flat `null` at the agent level beats a category's block model. A profile that sets `agents.x.model: null` over a base `agents.x.opencode.model` does not restore inheritance on OpenCode, because the block is more specific; to inherit on OpenCode it must set `agents.x.opencode.model: null`. This is stated in the config reference.

**Patterns to follow:**
- `resolveAgentOverlaySet` for how targets are keyed (bare name and `category/name` aliases).
- `docs/solutions/integration-issues/pi-subagents-export-config-security-lifecycle-2026-07-30.md`: `variant` never reaches Pi.

**Test scenarios:**
- Happy path: agent flat model + category `opencode.model` → agent's (R3a, AE5a).
- Happy path: base agent model + profile-only `pi.thinking` → base model with that thinking on Pi (AE5).
- Happy path: profile `categories.review.pi.model` + base `agents.oracle.model` → oracle's own model on Pi (agent level wins).
- Edge case: `agents.x.model: null` in a block over a category's explicit model → inherit.
- Edge case: base `agents.x.opencode.model: M` and profile `agents.x.model: null` → OpenCode still `M` (block beats flat); Pi inherits.
- Edge case: `categories.review.variant: high` with no category model, agent `oracle` in review with a flat model → valid; a second review agent with no model anywhere → error naming that agent.
- Edge case: `opencode.variant` set, `pi` block absent → Pi qualifier undefined, never `variant`.
- Error path: `agents.x.variant: "high"` with no model at any layer → config error naming `x` and `opencode`.
- Non-error: `agents.x.pi.thinking` with no model at any layer → loads fine; `thinking` is model-independent, unlike OpenCode's `variant`.
- Qualifier-layer-clearing: `categories.review = {model, variant}` + agent overrides `model` only → agent's model wins, category's `variant` is dropped (not inherited); same with the agent setting `model: null` → neither model nor variant resolve.
- Edge case (R5): legacy `pi_subagents.agents.x.thinking: low` and no `pi` block → `low` plus one deprecation warning; both set and disagreeing → `pi` block wins, same warning.
- Integration: registration gates (`bun scripts/content-integrity.ts`) pass with the new module listed in both surfaces.

**Verification:**
- Resolver tests pass; content-integrity clean with the codemap and module-table entries.

- [x] **Unit 4: OpenCode config hook uses the resolver**

**Goal:** The OpenCode hook emits per-agent `model`/`variant` from the resolver's `opencode` answer; output for every pre-change config is byte-identical.

**Requirements:** R3, R13

**Dependencies:** Unit 3

**Files:**
- Modify: `src/lib/config-handler.ts`
- Test: `tests/unit/config-handler.test.ts`

**Approach:**
- Replace the direct overlay field reads for `model`/`variant` with a resolver call for the `opencode` harness; `temperature`/`top_p` and non-routing fields keep their existing path.
- No new fields are emitted; a config without blocks or profiles must produce the same object as before.

**Patterns to follow:**
- Existing overlay application in the same file.

**Test scenarios:**
- Happy path: `agents.x.opencode.model` is emitted as the agent's model; flat `model` is emitted when no block.
- Happy path: with a selected profile overriding a category model, emitted agents in that category carry it unless an agent-level model exists.
- Integration: snapshot corpus (Unit 6) — emitted config for every pre-change fixture equals the stored snapshot.
- Integration: the `model-inheritance` eval case still passes (bundled agents stay model-free without user overlays).

**Verification:**
- Snapshot corpus identical; eval assertions unchanged.

- [x] **Unit 5: Pi — catalog identity, delegate routing, export parity**

**Goal:** `systematic_delegate` honours resolved Pi routing and reports its source once per agent; persona export uses the same resolver.

**Requirements:** R4, R4a, R5

**Dependencies:** Unit 3

**Files:**
- Modify: `src/lib/agent-resolver.ts` (`AgentCatalogEntry` gains file stem, category, qualified id), `src/pi.ts` (load config once at init; pass merged overlays and resolver into the tool), `src/lib/pi-delegate-tool.ts` (resolve model for the dispatched agent; fall back to `ctx.model`; once-per-agent notice), `src/lib/pi-subagents-export.ts` (resolver for the `pi` harness for both model and thinking; keep its raw-source stripping as defence in depth)
- Test: `tests/unit/agent-resolver.test.ts`, `tests/unit/pi-delegate-tool.test.ts`, `tests/unit/pi-subagents-export.test.ts`

**Approach:**
- The tool keys the resolver by the catalog entry's file stem and category, not the display name.
- When the resolver returns a model, the child session uses it; when it returns `null` or nothing, the child inherits `ctx.model`, and the fail-closed rule when `ctx.model` is undefined is unchanged. The delegate applies `thinking` as `thinkingLevel` on the session options; export applies the same resolved value.
- Everyone who constructs or matches `AgentCatalogEntry` (tests, `pi-subagents-personas.ts`) is updated; persona file naming (`systematic-<sanitized-name>.md`) keys on the frontmatter `name` and is unchanged.
- The routing notice is appended to the tool's result text the first time each agent dispatches with a config-sourced model; it names model and source.
- Export resolves `model` and `thinking` for the `pi` harness through the resolver and continues to drop project-sourced values; `variant` is never emitted.

**Patterns to follow:**
- Existing fail-closed check in `validateDelegateRequest`.
- `pi-subagents-export.ts`'s current project-source stripping.

**Test scenarios:**
- Happy path: `agents.fixer.pi.model` set → child session created with that model; flat `agents.fixer.model` set and no block → same (AE4).
- Happy path: nothing resolves → child inherits `ctx.model`.
- Error path: nothing resolves and `ctx.model` undefined → the existing fail-closed error.
- Edge case: `model: null` resolves → inherit `ctx.model` even though a category pinned a model.
- Happy path (R4a): first dispatch of `fixer` with a config-sourced model → result text contains one notice naming model and source; second dispatch → no notice; a different agent → its own notice (AE9).
- Happy path: catalog entries carry stem/category/id for every bundled agent and resolve overlay keys by both bare and `category/name` form.
- Happy path (export): `agents.x.pi.thinking` reaches the persona frontmatter; legacy `pi_subagents.x.thinking` still does when the block is absent (AE8); project-sourced values are dropped.
- Integration: persona fixture drift gate unchanged (fixtures are config-free).

**Verification:**
- Delegate and export tests pass; `bun scripts/generate-pi-subagents-personas.ts --check` clean.

- [x] **Unit 6: `config show`, back-compat corpus, and documentation**

**Goal:** Resolved profile state is visible; a stored corpus proves R13; the config reference and release notes describe the feature and the Pi behaviour change.

**Requirements:** R12, R13, R14

**Dependencies:** Units 2–5

**Files:**
- Modify: `src/cli.ts` (`configShow` loads config, prints active profile / fallback and, per agent and harness, the resolved model, qualifier, and source), `docs/src/content/docs/reference/configuration.mdx` (prose section on profiles and harness blocks, outside the generated region), `AGENTS.md` (one line on the Pi behaviour change for overlay models)
- Create: `tests/fixtures/config-corpus/` (pre-change user configs and the canonical JSON serialization of their emitted OpenCode agent config), `tests/unit/config-corpus.test.ts`
- Test: `tests/unit/cli.test.ts`

**Approach:**
- `configShow` keeps printing the file paths and adds a resolved section; it prints routing values only — never file contents beyond what it prints today, never env values.
- The corpus is built once, before Unit 4 lands, from the config fixtures already under `tests/` (no copies of any real user config); each entry stores the input and a canonical serialization (sorted keys, `undefined` omitted) of the emitted OpenCode agent config. The test asserts byte-identity of the canonical serialization, not deep equality, so key-order and undefined-versus-absent drift fails it. There is no existing corpus analogue in the repo; this is the first.
- The config reference gains one prose section: what a profile is, how a repository selects one, what happens on an unknown name, and the sentence that a flat `model` now routes Pi delegates too.

**Patterns to follow:**
- `configShow` reads the new `ConfigObservationMetadata` fields and calls the resolver per overlaid agent; it does not reuse `capabilities`, which has no routing view.
- `docs/scripts/generate-config-reference.ts`'s non-generated prose regions.

**Test scenarios:**
- Happy path: `config show` with a selected profile prints its name and source; with a missing name prints the fallback that occurred.
- Happy path: the resolved routing table lists each overlaid agent with model, qualifier, and source per harness.
- Edge case: no profiles defined → the section says so and prints nothing else new.
- Integration: every corpus entry round-trips identically.
- Test expectation for docs prose: none — reviewed by reading; the generated region is covered by Unit 1's drift gate.

**Verification:**
- Corpus test green; `bun run docs:generate` clean; release note text present in the PR description.

## System-Wide Impact

- **Interaction graph:** config loader → resolver → OpenCode hook, Pi delegate, Pi export, CLI. The bootstrap injection and skill discovery are untouched.
- **Error propagation:** schema violations remain parse errors; post-merge qualifier violations are load-time config errors; selector and `profiles` problems are warnings through `warningSink`. On OpenCode a config error surfaces the way it does today (hook logs, plugin continues with defaults per the existing `debug config` behaviour); on Pi it surfaces at extension start.
- **State lifecycle risks:** none persisted. Pi reads config once per extension start (a profile change needs a restart). The once-per-agent notice set lives in the tool closure.
- **API surface parity:** the JSON Schema, the generated config reference, and the CLI's `config show` all change together; `capabilities` output is unchanged.
- **Integration coverage:** the back-compat corpus (Unit 6) is the cross-layer proof for R13; the `model-inheritance` eval proves bundled agents stay model-free.
- **Unchanged invariants:** bundled agent markdown stays model-free (content-integrity gate); project config still cannot set `model`/`variant`/`permission`/`skills`; Pi delegation still fails closed with no parent model; the Claude Code bundle is untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Relaxing the parse-time refinement lets a qualifier-only overlay through if the post-merge check is skipped by a consumer | The check runs in the loader, not in consumers; every consumer receives already-checked overlays. |
| A flat `model` set today silently starts routing Pi delegates (AE4) | R4a's notice in the tool result plus the config reference sentence and release note; `config show` lists the source. |
| Docs generator breaks on nested records | Unit 1 extends the generator and gates on `docs:generate`; every new field carries `examples`. |
| JSON Schema ref-dedup collapses the routing-only bundle schema into the full overlay schema or vice versa | Ref-aware post-processing per the 2026-05-17 learning; the drift gate catches a wrong shape. |
| The persona catalog change alters export output | Catalog gains fields; export output is generated from bundled markdown only, so the fixture gate proves no change. |
| Existing configs change behaviour on OpenCode | The corpus test compares canonical serializations byte for byte; any difference, including key order, fails it. |

## Documentation / Operational Notes

- Release note must state: flat `agents.<name>.model` now applies to Pi delegates; the new `pi` block and `profiles`; `pi_subagents.thinking` deprecation.
- The config reference's generated region regenerates from the schema; one hand-written section describes profiles and selection.
- `config show` becomes the diagnostic for "why did this agent get that model".

## Sources & References

- **Origin document:** `docs/brainstorms/2026-09-04-model-config-profiles-requirements.md` — untracked in this repository (`docs/brainstorms/` is gitignored); the decisions it records are carried into this plan's Requirements Trace and Key Technical Decisions.
- Related code: `src/lib/config-schema.ts`, `src/lib/config.ts`, `src/lib/agent-overlays.ts`, `src/lib/config-handler.ts`, `src/lib/agent-resolver.ts`, `src/lib/pi-delegate-tool.ts`, `src/lib/pi-subagents-export.ts`, `src/cli.ts`, `docs/scripts/generate-config-reference.ts`
- Related plans: `docs/plans/2026-08-16-001-refactor-retire-source-model-defaults-plan.md`, `docs/plans/2026-05-09-002-feat-provider-model-mcp-overlays-plan.md`
- Related issues: #854 (Claude Code runtime delivery)
- External: Magic Context issue cortexkit/magic-context#354; releases v0.39.0 (per-harness blocks) and v0.40.0 (named profiles)
