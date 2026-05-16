---
title: 'feat: Client-API source-model resolution'
type: feat
status: completed
date: 2026-05-12
origin: docs/brainstorms/2026-05-12-client-api-source-model-resolution-requirements.md
deepened: 2026-05-12
shipped: "PR #358 (v2.13.0)"
---

# feat: Client-API source-model resolution

## Overview

Replace `auth.json` provider-presence detection with real availability checks via OpenCode's plugin `client` API (with `~/.cache/opencode/models.json` as fallback). Restructure `SOURCE_CATEGORY_MODEL_DEFAULTS` from a flat `string[]` to a provider-grouped object that carries per-model variant, per-category rationale, and per-category "when-to-override" metadata. Expand the provider catalog from 3 IDs (anthropic, openai, github-copilot) to 7 IDs (adds google, opencode, opencode-go, vercel). Generate the docs Rationale table from source. Replace duplicated model-string literals in tests with imports plus one snapshot test of the source defaults.

The work ships as one PR targeting v2.13.0 minor.

## Problem Frame

`getAuthenticatedProviders()` reads `~/.local/share/opencode/auth.json` and uses **the presence of a top-level key** as a proxy for "this provider is connected." The signal is wrong (key presence ≠ runtime connectivity), the file is wrong (secrets we are obligated to never inspect), and the resolution shape is brittle (a flat `string[]` cannot express variant-tuned defaults like "Opus with `variant: max` then Sonnet without").

PR #357 (merged 2026-05-12) tuned the source defaults but kept the shape, the file-reading approach, and the docs duplication. Continuing to layer fixes on the same architecture is unproductive. OpenCode's server already exposes a `/config/providers` endpoint (and a heavier `/provider` endpoint) reachable via the plugin's `client`. Either endpoint returns the canonical "connected" set assembled from FOUR independent signals — config-block, env-var match, `auth.json:type=api`, and plugin `auth.loader` — empirically verified against `anomalyco/opencode@v1.14.41` source at `.slim/clonedeps/repos/anomalyco__opencode`. Reading `auth.json` ourselves catches only signal 4; the SDK call catches all four. The current implementation is strictly inferior, not merely redundant.

The test suite has parallel rot: `tests/unit/agent-overlays.test.ts:903` asserts against an invented constant unrelated to the real `SOURCE_CATEGORY_MODEL_DEFAULTS`, sixteen test-file string literals duplicate source-of-truth values, and the docs Rationale table in `configuration.mdx:89-95` is hand-maintained.

## Requirements Trace

- R1. Excise `getAuthenticatedProviders()` and every `auth.json` read (see origin: R1). The SDK call subsumes auth.json (signal 4 of 4); reading it ourselves is strictly inferior, not merely redundant.
- R2. New availability module backed by `client.config.providers()` (see origin: R2). Empirically: this endpoint returns only connected providers (`GET /config/providers` → `{ providers, default }`); the heavier `/provider` endpoint returns the full models.dev catalog plus a `connected: string[]` filter and is not needed for the availability check.
- R3. Fallback to `~/.cache/opencode/models.json` with strict cache-miss semantics (see origin: R3)
- R4. Availability computed once per config-hook invocation (see origin: R4)
- R5. Provider-grouped source-default shape with per-model variant + per-category rationale + when-to-override (see origin: R5)
- R6. Provider catalog covers 7 IDs with empirical OMO usage-frequency justification (see origin: R6)
- R7. Resolution: provider-availability outer loop, model-availability inner loop, last-resort = first listed entry (see origin: R7)
- R8. Variant flows through existing overlay layer; no provider-specific reasoning-surface translation (see origin: R8)
- R9. Zod schema mirrors the new shape; assertion verifies category coverage + provider catalog membership (see origin: R9)
- R10. Docs Rationale table generated from source under fixed-heading boundary (see origin: R10)
- R11. Delete invented-constant tests (see origin: R11)
- R12. Replace test-file string literals with imports from source-defaults module (see origin: R12)
- R13. Snapshot test against `SOURCE_CATEGORY_MODEL_DEFAULTS` as golden file (see origin: R13)

## Scope Boundaries

- No retry, backoff, or TTL caching for availability lookup. One API call + at most one disk read per config-hook invocation.
- No mapping of `variant` strings to provider-specific reasoning surfaces (Anthropic `thinking`, OpenAI `reasoningEffort`, Gemini `thinkingBudget`). Variant is forwarded as a string; OpenCode owns the semantics downstream.
- No expansion beyond the 7 provider IDs in R6. Adding a new provider is a follow-up brainstorm.
- No restructuring of behavior tests beyond R11–R13. Structurally-sound tests stay untouched.
- No changes to `bootstrap`, `disabled_*`, `agents.*`, or `categories.*` config keys.
- No changes to how OpenCode discovers or invokes Systematic skills, agents, or commands.

## Context & Research

### Relevant Code and Patterns

- `src/lib/agent-overlays.ts:62-77` — current `SOURCE_CATEGORY_MODEL_DEFAULTS` constant
- `src/lib/agent-overlays.ts:205-241` — `getAuthenticatedProviders()` to excise
- `src/lib/agent-overlays.ts:243-267` — `getSourceCategoryModel()` resolution to rewrite
- `src/lib/agent-overlays.ts:269-287` — assertion helpers to migrate to Zod
- `src/lib/config-handler.ts:430-470` — call site that consumes `getAuthenticatedProviders` and threads `authedProviders` into agent emission; this is the integration seam
- `src/lib/config-schema.ts` — Zod schema source for the published JSON Schema
- `docs/scripts/generate-config-reference.ts` — existing config-reference generator; it imports the schema and renders sections from it. There is no `getDocsReference()`-style helper in `src/` today.
- `docs/src/content/docs/getting-started/configuration.mdx:89-95` — hand-maintained Rationale table
- `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts` — `Config.providers()` (`/config/providers`) and `Provider.list()` (`/provider`) method signatures
- `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` — `ConfigProvidersResponses` returns `{ providers: Provider[], default: Record<string, string> }`; `ProviderListResponses` returns `{ all, default, connected: string[] }`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:36-51` — `PluginInput.client` is available at plugin-factory time
- `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/client.ts` — empirical: `createOpencodeClient` is an HTTP client over `fetch()`. Every method call is a localhost HTTP round-trip to the OpenCode server.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts` — empirical: `/config/providers` handler returns `Object.values(providerSvc.list())`; every entry IS connected by construction.
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1075-1330` — empirical: `Provider.Service.list()` builds the connected map by merging four signals (config block, env var, auth.json `type:api`, plugin `auth.loader`).
- `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/models.ts:80-150` — empirical: `models.json` cache lives at `$XDG_CACHE_HOME/opencode/models.json` with a 5-min TTL; `OPENCODE_MODELS_URL` env var changes the cache filename to `models-<hash>.json`.
- `docs/brainstorms/2026-05-12-opencode-source-findings-for-unit-2.md` — empirical findings doc consolidating the four sources above; recommended pre-read for the Unit 2 implementer.

### Institutional Learnings

- Memory `#2734` (conventional-commit prefix → semantic-release map): this PR ships as `feat:` for the minor bump.
- Memory `#2685` (pre-PR gate must include `bun run docs:build`): the docs-generation unit means full docs:build is non-negotiable.
- Memory `#2762` (plugin entry MUST export only `default`): new modules live under `src/lib/`, not `src/index.ts`.
- Memory `#2687` (multi-load plugin registration model): the new availability module runs per-config-hook-invocation, which matches the post-PR-#352 model.
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — trust-boundary precedent for overlay validation.

### External References

OMO empirical references (read during brainstorm, no need to re-fetch during planning):
- `src/shared/model-availability.ts` (OMO commit `75825eb9a6`) — `fetchAvailableModels()` reference implementation pattern.
- `src/shared/model-requirements.ts` (OMO commit `75825eb9a6`) — per-category provider chains with usage frequencies used to justify R6.

## Key Technical Decisions

- **Provider-grouped data shape with per-model variant** (origin: Key Decisions, locked) — exactly matches the stated resolution algorithm.
- **Two-layer availability lookup: API primary + models.json fallback** (origin: Key Decisions, locked) — captures real-time connect/disconnect plus disk-cached state. The primary API is `client.config.providers()` (`/config/providers`), not `client.provider.list()` (`/provider`) — both return identical "connected" info, but the former is a lighter payload. Empirically verified at `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`.
- **7-provider catalog with empirical OMO usage frequency justification** (origin: Key Decisions, locked) — vercel=80, opencode=55, github-copilot=39, opencode-go=26, openai=20, anthropic=18, google=10.
- **Single PR targeting v2.13.0 minor** (origin: Key Decisions, locked) — tests are rewritten alongside the feature; the rewritten suite IS the regression check.
- **New source-defaults module at `src/lib/source-model-defaults.ts`** (resolved in planning) — `agent-overlays.ts` is already 13.9KB / ~480 lines; adding metadata-rich shape doubles it. Clean separation: source-defaults owns shape + Zod schema fragment + docs-export helper; overlays owns merge/resolve.
- **`formatForDocs()` lives on the source-defaults module** (resolved in planning) — the docs generator already follows the pattern of importing source and rendering. One more import keeps the generator thin.
- **Bun's built-in `.snap` file (Jest-style)** (resolved in planning) — zero new tooling, native Bun support, snapshot lives at `tests/unit/__snapshots__/source-model-defaults.test.ts.snap`.
- **No dual resolver transition state** (adversarial deepening) — Unit 1 introduces the new source-defaults module without rewiring `config-handler.ts`; Unit 3 performs the single switch from old auth/provider path to new availability/model path for all categories; Unit 4 deletes the old auth reader only after Unit 3 is green. There is never a supported state where some categories resolve via `getSourceCategoryModel(authedProviders)` and others via `resolveSourceModel(availabilitySet)`.
- **Partial model overrides clear source variants** (adversarial deepening) — if a user sets `categories.<id>.model` or `agents.<key>.model` and omits `variant`, the emitted config must not retain the source-default variant from the previously resolved model. Combining a user-selected model with a source-selected variant would create a nonsensical hybrid. Users who want a variant with their override must set both fields.

## Open Questions

### Resolved During Planning

- New source-defaults type's module location: **`src/lib/source-model-defaults.ts`** (Q1, see Key Decisions).
- Docs generator boundary: **source-defaults module exposes `formatForDocs()` helper** consumed by `docs/scripts/generate-config-reference.ts` (Q2, see Key Decisions).
- Snapshot format: **Bun built-in `.snap` file** (Q3, see Key Decisions).
- Provider ID stability in `models.json`: **All 7 R6 IDs PRESENT in current cache** (anthropic=23 models, openai=52, google=38, github-copilot=27, opencode=60, opencode-go=14, vercel=248). No upstream rename risk (Q4).
- Primary endpoint choice: **`client.config.providers()` (`/config/providers`)** — both `/config/providers` and `/provider` expose the same "connected" set; the simpler endpoint returns `{ providers: Provider[], default }` where every entry IS connected. The heavier `/provider` endpoint returns the full models.dev catalog plus a `connected: string[]` filter that we don't need for availability checking. Empirically verified at `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`.

### Deferred to Implementation

- Exact category-by-category provider-chain assignments for the new shape — done as part of Unit 1 with the actual `SOURCE_CATEGORY_MODEL_DEFAULTS` constant rewrite. Rationale text and when-to-override notes also authored at that point.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
src/lib/source-model-defaults.ts (new)
├── const SOURCE_CATEGORY_MODEL_DEFAULTS: SourceCategoryDefaults  ← provider-grouped shape
├── type SourceCategoryDefaults = Record<categoryId, CategoryDefault>
├── type CategoryDefault = { rationale, whenToOverride?, providers: ProviderEntry[] }
├── type ProviderEntry = { provider, models: ModelEntry[] }
├── type ModelEntry = { model, variant? }
├── function resolveSourceModel(category, availability) → { model, variant? }
├── function formatForDocs() → MarkdownTable
└── export Zod schema fragment for config-schema.ts to compose

src/lib/model-availability.ts (new)
├── async function getAvailableModels(client) → Set<"provider/model">
│   ├── primary: client.config.providers() → { providers, default }; every entry IS connected
│   └── fallback: read $XDG_CACHE_HOME/opencode/models.json (or models-<hash>.json if OPENCODE_MODELS_URL set) + structural-validate
└── per-hook-invocation, no caching across invocations (HTTP round-trip per invocation is acceptable)

src/lib/agent-overlays.ts (modified)
├── Unit 1: keep old auth-backed resolver exports wired while the new module lands
├── Unit 3: replace getSourceCategoryModel call sites with resolveSourceModel for all categories at once
└── Unit 4: remove getAuthenticatedProviders, getSourceCategoryModel, and old coverage helpers after the new path is green

src/lib/config-handler.ts (modified)
├── REMOVE: ConfigHandlerDeps.getAuthenticatedProviders injection seam
├── REPLACE: readAuthProviders() call with getAvailableModels(client)
└── THREAD: availability Set through to resolveSourceModel call sites

src/lib/config-schema.ts (modified)
└── EXTEND: SystematicConfigSchema with source-default validation derived from source module
```

## Implementation Units

- [ ] **Unit 1: Source-defaults module with provider-grouped shape**

**Goal:** Introduce `src/lib/source-model-defaults.ts` with the new provider-grouped data shape, the Zod schema fragment, and the actual `SOURCE_CATEGORY_MODEL_DEFAULTS` constant rewritten for the 7-provider catalog. This prepares the replacement for the current `agent-overlays.ts:62-77` flat-string-array constant; the old path stays wired until Unit 3.

**Requirements:** R5, R6, R9

**Dependencies:** None (greenfield module)

**Files:**
- Create: `src/lib/source-model-defaults.ts`
- Modify: `src/lib/config-schema.ts` (compose new Zod fragment)
- Test: `tests/unit/source-model-defaults.test.ts` (new)
- Do **not** modify `src/lib/agent-overlays.ts` in this unit except for import-only type reuse if unavoidable. The old constant, `getSourceCategoryModel`, and old coverage helpers stay wired until Unit 3/Unit 4 to avoid a half-migrated build.

**Approach:**
- Define `SourceCategoryDefaults` type with `Record<categoryId, CategoryDefault>` where `CategoryDefault` carries `{ rationale: string, whenToOverride?: string, providers: ProviderEntry[] }`.
- Define `ProviderEntry` as `{ provider: ProviderID, models: ModelEntry[] }` and `ModelEntry` as `{ model: string, variant?: string }`.
- Define `ProviderID` as a Zod literal union of the 7 R6 catalog values, exported for downstream use. Availability may contain providers outside this catalog (for example, future `mistral` entries from OpenCode), but resolution is intentionally constrained to providers explicitly listed in `SOURCE_CATEGORY_MODEL_DEFAULTS` and validated by this union.
- Author the actual constant with the 6 Systematic categories (`design`, `docs`, `document-review`, `research`, `review`, `workflow`). Each category gets a `rationale` (one-line user-facing explanation, drawn from existing `configuration.mdx:89-95` and refined where the new shape allows finer expression) and an optional `whenToOverride` note for the categories where one is clearly useful (review, design). Provider chains are picked from the R6 catalog using OMO's category-fit reasoning as the empirical baseline.
- Introduce new assertion logic in the new module, backed by a Zod schema. Do not delete the old `agent-overlays.ts:269-287` helpers yet; Unit 3/Unit 4 handle the wiring/removal. The schema enforces: shape correctness; every key in the constant maps to an existing bundled-agent category directory under `agents/`; every `provider` ID is in the R6 catalog; provider lists non-empty; model lists non-empty; `(model, variant)` pairs unique within a provider entry; provider IDs unique within a category; `variant` is non-empty, whitespace-free, and bounded to a conservative maximum length (128 chars).
- Apply the same `variant` length bound to the user-facing `variantSchema` in `src/lib/config-schema.ts` so `categories.<id>.variant` and `agents.<key>.variant` cannot accept pathological payload-sized strings either. Keep semantic validation open-ended; the bound is only a payload sanity limit.
- Export `SourceCategoryDefaultsSchema` for `config-schema.ts` to compose into the broader `SystematicConfigSchema`.

**Patterns to follow:**
- `src/lib/config-schema.ts` — Zod schema composition style (strict mode, branded types, `.meta()` tagging)
- `src/lib/agent-overlays.ts:269-287` — assertion error message style ("missing intentional coverage for: …")

**Test scenarios:**
- Happy path: `SourceCategoryDefaultsSchema.parse(SOURCE_CATEGORY_MODEL_DEFAULTS)` succeeds and returns the typed constant.
- Edge case: a category with `providers: []` fails schema validation with a clear "providers must be non-empty" error.
- Edge case: a provider entry with `models: []` fails schema validation with a clear "models must be non-empty" error.
- Edge case: a duplicate provider ID within a category fails validation.
- Edge case: a duplicate `(model, variant)` pair within a provider entry fails validation.
- Error path: an unknown provider ID (not in the 7-catalog) fails validation with a "provider not in catalog" error.
- Error path: source or user override `variant` with whitespace, empty string, or >128 chars fails validation with a clear error.
- Error path: a category key not matching `agents/<category>/` directories fails validation with a "category missing in bundled agents" error.
- Integration: round-trip `JSON.stringify(SOURCE_CATEGORY_MODEL_DEFAULTS)` → schema parse → deep-equal original.

**Verification:**
- The new provider-grouped `SOURCE_CATEGORY_MODEL_DEFAULTS` constant exists in the new module and validates. The old flat constant may still exist in `agent-overlays.ts` only as a temporary compatibility path until Unit 3 switches all call sites.
- `bun run schema:drift` passes after the schema update.
- `bun run content-integrity` passes.

---

- [ ] **Unit 2: Availability module — client API primary, models.json fallback**

**Goal:** Introduce `src/lib/model-availability.ts` exporting an async `getAvailableModels(client)` that returns a `Set<"provider/model">`. Primary signal is `client.config.providers()` (`/config/providers`); fallback is `~/.cache/opencode/models.json` (or `models-<hash>.json` if `OPENCODE_MODELS_URL` is set).

**Requirements:** R2, R3, R4

**Dependencies:** None (greenfield module)

**Files:**
- Create: `src/lib/model-availability.ts`
- Test: `tests/unit/model-availability.test.ts` (new)

**Approach:**
- Primary path: call `await client.config.providers()`. Wrap in `try/catch`. The response shape is `{ providers: Provider[], default }` where every entry in `providers[]` is already connected by construction (the server-side handler is `Object.values(providerSvc.list())`). Iterate `result.providers`, then iterate each provider's nested `.models` map, building `provider/model` keys into a `Set<string>`. Empirically verified against `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`.
- A successful response with `providers: []` is **valid empty** — return the empty set without consulting disk. Only thrown errors (network, non-2xx, malformed return) trigger fallback. The `client` is an HTTP client over `fetch()` (verified at `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/client.ts`), so every invocation is a localhost round-trip; catch ECONNREFUSED, timeout, and non-2xx alike.
- Fallback path: resolve cache file path. Default is `$XDG_CACHE_HOME/opencode/models.json` (with `$HOME/.cache` default for unset XDG). When `OPENCODE_MODELS_URL` is set in the environment, the cache filename changes to `models-<hash>.json` where `<hash>` is a fast hash of the URL (empirically: `Hash.fast(source)` at `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/models.ts:108`). Unit 2 should mirror this: read `OPENCODE_MODELS_URL` env var, compute the hashed filename if set, fall back to `models.json` otherwise. The hash algorithm choice is OpenCode-internal — we don't need byte-equivalence; we only need to read OpenCode's own cache file, so we read both `models.json` AND `models-<hash>.json` (preferring the URL-derived filename if `OPENCODE_MODELS_URL` is set) and accept the first one that parses.
- `fs.readFileSync` + `JSON.parse` + structural validation (`Record<string, { models: Record<string, unknown> }>`). Field-level model metadata is read as opaque keys; future upstream additions to per-model metadata do not invalidate the parse. Build `provider/model` keys from top-level provider keys and `.models` sub-object keys.
- Missing file, zero-byte, unreadable, corrupted JSON, or schema-mismatched cache → return empty set. Schema-mismatched cache is a **warn-and-miss**, not a thrown error: do not break config generation because a fallback cache changed shape, but emit a scoped warning so upstream shape drift is visible during local runs and CI logs.
- If a future OpenCode writes a wrapped cache like `{ "providers": { ... } }`, the current implementation treats it as schema-mismatched cache, warns once for that read, and returns empty availability. Supporting that shape is a follow-up once verified against upstream; do not guess nested shapes silently.
- The module is stateless — no module-level caching. R4's "once per config-hook invocation" is enforced by the call site (config-handler), not by the module.

**Patterns to follow:**
- `src/lib/agent-overlays.ts:205-241` — old `getAuthenticatedProviders` error-handling style (try/catch + `console.warn`)
- OMO's `src/shared/model-availability.ts` `fetchAvailableModels` (reference only, not a literal port)

**Test scenarios:**
- Happy path (API): client returns `providers: [{ id: 'anthropic', models: {...} }, { id: 'openai', models: {...} }]` with nested model maps → result is the `Set` of all `provider/model` strings.
- Happy path (fallback): client throws; `models.json` exists with valid shape → result reflects models.json content.
- Edge case (valid empty providers): client returns `providers: []` → result is empty `Set`, fallback NOT consulted.
- Edge case (default cache path): with `XDG_CACHE_HOME` set and unset, the module resolves the expected cache path (`$XDG_CACHE_HOME/opencode/models.json` or `$HOME/.cache/opencode/models.json`).
- Edge case (OPENCODE_MODELS_URL): with `OPENCODE_MODELS_URL` set, the module attempts `models-<hash>.json` and falls back to `models.json` if the URL-derived file is absent.
- Error path (API failure): `client.config.providers()` throws or returns malformed data → fallback is consulted.
- Error path (cache miss bucket): missing, zero-byte, unreadable, corrupt, or schema-mismatched `models.json` all return empty `Set`; schema-mismatched files also emit the scoped warning.
- Error path (wrapped future cache): file exists with `{ "providers": { "anthropic": { "models": {} } } }` → returns empty `Set` and emits the schema-mismatch warning rather than silently interpreting a guessed format.

**Verification:**
- New module exports `getAvailableModels(client): Promise<Set<string>>`.
- All test scenarios pass.

---

- [ ] **Unit 3: Resolution + variant emission via overlay flow**

**Goal:** Rewrite the resolver to walk the new provider-grouped shape, return the first available `provider/model` (with optional `variant`), and emit `variant` through the existing overlay flow alongside `model`.

**Requirements:** R7, R8

**Dependencies:** Unit 1 (data shape + resolveSourceModel signature), Unit 2 (availability signature)

**Files:**
- Modify: `src/lib/source-model-defaults.ts` (add `resolveSourceModel` function)
- Modify: `src/lib/agent-overlays.ts` (update emission to thread variant)
- Modify: `src/lib/config-handler.ts` (call new availability + resolver)
- Test: `tests/unit/source-model-defaults.test.ts` (extend with resolution scenarios)
- Test: `tests/unit/agent-overlays.test.ts` (variant emission scenarios)

**Approach:**
- `resolveSourceModel(category, availabilitySet)`: walk the category's `providers` list in order. For each provider entry, test whether its ID has at least one matching `provider/model` key in `availabilitySet` (a provider with no available models is treated as not-connected). For the first matching provider entry, walk its `models` list in order and return the first `(model, variant?)` whose `${provider}/${model}` is in `availabilitySet`.
- If no provider has any available model, return exactly `category.providers[0].provider` + `category.providers[0].models[0]` — the first model entry of the first provider entry, including that model entry's `variant` if present. Do not sort providers, flatten all models, or pick a later model from the first provider.
- Empty `providers: []` or `models: []` would be a runtime impossibility because Unit 1's schema rejects them. Don't add defensive empty-list handling; the schema is the gate.
- In `agent-overlays.ts`, where the emitter today writes `model: <resolved>` to the agent config, also write `variant: <resolved.variant>` when present. Absence of variant must preserve absence in emitted config (do not default to empty string).
- Rewire `config-handler.ts` in one pass: compute `availabilitySet` once, pass it into `collectAgents`/`applyAgentOverlays`, and remove use of `authedProviders` for every category. Do not leave a split path where some categories use the old provider-presence resolver and others use the new model-availability resolver.
- User overrides in `systematic.json` (`categories.<id>.variant`, `agents.<key>.variant`) win over source variant. Partial model overrides require explicit handling: when a category or exact overlay provides `model` but does **not** provide `variant`, delete any source-applied `variant` before/while applying that overlay so the user-selected model is not paired with the old source variant. If the user wants a variant for an overridden model, they must set both `model` and `variant` in the same override scope (or a higher-precedence exact override).

**Patterns to follow:**
- `src/lib/agent-overlays.ts:243-267` — old `getSourceCategoryModel` signature and last-resort fallback pattern
- Existing per-agent / per-category overlay merge precedence in `agent-overlays.ts:128-156`

**Test scenarios:**
- Happy path: availability matches the first provider entry (`anthropic/claude-opus-4-7` with `variant: 'max'`) or falls through to the next provider (`openai/gpt-5.5` with `variant: 'high'`) and returns the first available model/variant pair in order.
- Edge case (provider connected but no model match): user has `anthropic` listed in `availability` but availability lacks `anthropic/claude-opus-4-7`. Per the resolution algorithm, treat as not-connected for this category and walk to the next provider. Verify the per-provider check uses model-key membership, not provider-ID membership.
- Edge case (last-resort fallback): availability set is empty → returns the first listed `(provider, model, variant?)` from the category's first provider entry. No error thrown.
- Edge case (last-resort with multi-model first provider): availability set is empty and `providers[0].models` has `[opus+max, sonnet]` → returns `providers[0].models[0]` (`opus+max`), not the first model after flattening/sorting and not the first model without a variant.
- Edge case (resolved entry has no variant): an entry like `{ model: 'claude-sonnet-4-6' }` (no variant) resolves to `{ model, variant: undefined }`. Emitted overlay has NO `variant` field.
- Integration (variant override): source resolves to `variant: 'max'`; user `systematic.json` sets `categories.review.variant = 'high'` → emitted overlay has `variant: 'high'`. User override wins.
- Integration (partial model override clears source variant): source resolves to `{ model: 'anthropic/claude-opus-4-7', variant: 'max' }`; user `systematic.json` sets only `categories.review.model = 'openai/gpt-5.5'` → emitted overlay has `model: 'openai/gpt-5.5'` and no `variant` field.
- Integration (exact model override clears lower-precedence variant): source/category resolves or sets a variant; user `agents.security-sentinel.model` sets a different model with no `variant` → emitted exact-agent config has no inherited stale variant.
- Integration (variant absence preserved): source resolves with no variant; user `systematic.json` has no override → emitted overlay has no `variant` field.

**Verification:**
- All categories resolve correctly under simulated availability sets matching the new shape.
- Variant is emitted alongside `model` when present, absent when not.
- `bun test tests/unit/source-model-defaults.test.ts` and `bun test tests/unit/agent-overlays.test.ts` both pass.

---

- [ ] **Unit 4: Excise auth.json reading**

**Goal:** Remove `getAuthenticatedProviders`, the `ConfigHandlerDeps.getAuthenticatedProviders` injection seam, and all auth.json-related code. After this unit, no source under `src/` opens `auth.json`.

**Requirements:** R1

**Dependencies:** Unit 3 (resolution via the new path must work end-to-end before the old path is deleted). This dependency is hard: Unit 4 may not begin while `config-handler.ts` still imports or calls the old auth-backed resolver.

**Files:**
- Modify: `src/lib/agent-overlays.ts` (delete `getAuthenticatedProviders` and any private helpers it uses)
- Modify: `src/lib/config-handler.ts` (delete `getAuthenticatedProviders` import, delete the optional `getAuthenticatedProviders` field on `ConfigHandlerDeps`, delete the `readAuthProviders` resolution and call)
- Modify: `tests/unit/config-handler.test.ts` (delete tests that inject mock `getAuthenticatedProviders`)
- Modify: `tests/unit/agent-overlays.test.ts` (delete tests that exercise `getAuthenticatedProviders` directly)

**Approach:**
- `git grep -nE "getAuthenticatedProviders|auth\.json|XDG_DATA_HOME|getSourceCategoryModel|authedProviders" src/ tests/` to find every old-path reference before deleting. The expected hit list from feasibility-reviewer's verification: `getAuthenticatedProviders` is used only from `src/lib/config-handler.ts`; `auth.json` is read only in `src/lib/agent-overlays.ts:205-241`.
- Delete the function, its imports (`fs`, `os`, `path` if newly orphaned), and its types.
- Update `ConfigHandlerDeps` to remove the optional `getAuthenticatedProviders` field — this is a type-level breaking change, but `ConfigHandlerDeps` is consumed only internally by `src/index.ts` so no external compatibility shim is needed.
- Audit `src/lib/AGENTS.md` if it documents the removed function, and trim accordingly.

**Patterns to follow:**
- Removal pattern: delete function + import + injection seam + tests in one atomic commit (matches U2/U3/U4 removal commits in PR #352).

**Test scenarios:**
- Test expectation: none for this unit — Unit 3 already covered the replacement behavior, and Unit 4's deletion is verified by the absence of references in the post-deletion grep.

**Verification:**
- `git grep -nE "getAuthenticatedProviders|auth\.json|XDG_DATA_HOME|getSourceCategoryModel|authedProviders" src/` returns zero matches.
- All existing tests still pass (no test was relying on auth.json behavior except the ones deleted in this unit).
- `bun test` exits clean.

---

- [ ] **Unit 5: Docs generator — Rationale + when-to-override table from source**

**Goal:** Generate the Source Category Model Defaults table in `configuration.mdx` from `SOURCE_CATEGORY_MODEL_DEFAULTS`. The generator owns only the table under the `### Source Category Model Defaults` heading; surrounding prose remains hand-authored.

**Requirements:** R10

**Dependencies:** Unit 1 (source-defaults module with `formatForDocs()` helper)

**Files:**
- Modify: `src/lib/source-model-defaults.ts` (add `formatForDocs(): string` helper)
- Modify: `docs/scripts/generate-config-reference.ts` (call `formatForDocs()` and inject under the fixed heading)
- Modify: `docs/src/content/docs/getting-started/configuration.mdx` (replace hand-maintained table at lines 89-95 with generated content; add `### Source Category Model Defaults` heading and clear delimiters if not already present)
- Test: `tests/unit/source-model-defaults.test.ts` (extend with `formatForDocs` scenarios)

**Approach:**
- `formatForDocs()` walks `SOURCE_CATEGORY_MODEL_DEFAULTS` in stable insertion order. For each category, renders a row: `| <category> | <chain> | <rationale> | <when-to-override or '—'> |`. The chain is a compact rendering: comma-separated `provider/model[+variant]` for the first 2-3 entries followed by `, …` if the chain is longer.
- The generator script reads the existing `configuration.mdx`, locates the `### Source Category Model Defaults` heading, and replaces only the generated block between MDX delimiters under that heading. Surrounding prose and all unrelated manual edits elsewhere in the file are preserved byte-for-byte.
- If the heading is absent, the generator may create a new heading only under the known configuration reference parent section. If the parent anchor is also absent, if multiple matching headings exist, or if delimiters are malformed/ambiguous, fail loudly with a clear error instead of guessing and rewriting a broad range of the file.
- The MDX file uses MDX comment syntax `{/* */}` for delimiters (per memory `#2685` discovery — HTML comments `<!-- -->` break MDX parse). Boundary ownership is delimiter-first, heading-scoped second; this prevents accidental deletion of prose between the generated table and the next heading.
- Verify two idempotency dimensions: (1) running the generator twice with no intervening edits produces a byte-identical file; (2) manually editing text outside the generated block, then running the generator, preserves the manual edit while updating only the generated block.

**Patterns to follow:**
- `docs/scripts/generate-config-reference.ts` — existing source-import + table-render style. Mirror the table-emit code path.
- `src/lib/config-schema.ts` `getDocsReference()` if such a helper exists; otherwise the new `formatForDocs()` becomes the precedent.

**Test scenarios:**
- Happy path: `formatForDocs()` returns a markdown string with one row per `SOURCE_CATEGORY_MODEL_DEFAULTS` key.
- Happy path: each row's chain field reflects the first 2-3 entries' `provider/model[+variant]` format.
- Edge case: a category with no `whenToOverride` renders the column as `—` (or empty cell, depending on table-rendering convention — pick one and commit).
- Edge case: a category whose first provider entry has only one model renders the chain without trailing `, …`.
- Integration: running `bun docs/scripts/generate-config-reference.ts` once, then a second time, produces byte-identical `configuration.mdx` (idempotency).
- Integration: manual edit outside the generated block survives a generator run byte-for-byte.
- Error path: missing heading plus missing parent anchor, duplicate headings, or malformed delimiters causes a clear generator failure and no partial rewrite.
- Integration: `bun run docs:build` succeeds after the generator runs (catches MDX parse issues per memory `#2685`).

**Verification:**
- `configuration.mdx` Source Category Model Defaults table content equals `formatForDocs()` output exactly.
- `bun run docs:build` exits clean (110 pages built, no MDX errors).
- `bun docs/scripts/generate-config-reference.ts` is idempotent.

---

- [ ] **Unit 6: Test cleanup + golden snapshot**

**Goal:** Delete the `:903` invented-constant test and any siblings asserting invented constants. Replace duplicated model-string literals across the three test files with imports from `src/lib/source-model-defaults.ts`. Add one snapshot test against `SOURCE_CATEGORY_MODEL_DEFAULTS` as a golden file.

**Requirements:** R11, R12, R13

**Dependencies:** Unit 1 (source-defaults module must export the constant), Unit 2 (availability module exists), Unit 3 (resolution call sites updated)

**Files:**
- Modify: `tests/unit/agent-overlays.test.ts` (delete `:903` invented-constant test; replace ~7 model-string literals with imports)
- Modify: `tests/unit/config-handler.test.ts` (audit for any additional literals after Units 3–4; currently no live grep hits)
- Modify: `tests/unit/config-schema.test.ts` (replace ~6 model-string literals with imports)
- Modify: `tests/unit/source-model-defaults.test.ts` (add snapshot test against the constant)
- Create: `tests/unit/__snapshots__/source-model-defaults.test.ts.snap` (new, generated)

**Approach:**
- Grep `tests/unit/agent-overlays.test.ts` and `tests/unit/config-schema.test.ts` for `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex` (13 live hits today; `config-handler.test.ts` currently has none). Categorize each hit:
  - **Mirror of source default** → replace with import like `import { SOURCE_CATEGORY_MODEL_DEFAULTS } from '../../src/lib/source-model-defaults'` and `SOURCE_CATEGORY_MODEL_DEFAULTS.review.providers[0].models[0].model`.
  - **Intentional fixture value differing from source** → keep as literal. These exist (the invented-constant test was one; real fixtures that test resolution against arbitrary models also count).
  - **Test prose / test names** → still in scope. If the prose names a current source default merely to describe the scenario, make the description generic or derive the displayed value from the imported source constant. Keep a literal in prose only when the literal is part of the intentional fixture being tested, and add a short inline comment explaining why it is intentionally not source-derived.
- Delete `tests/unit/agent-overlays.test.ts:903` (`assertSourceCategoryModelDefaults passes for actual constants` — asserts invented constants). Delete adjacent invented-constant tests if present (Unit 6's grep audit will reveal them).
- Add the snapshot test: `test('SOURCE_CATEGORY_MODEL_DEFAULTS golden snapshot', () => { expect(SOURCE_CATEGORY_MODEL_DEFAULTS).toMatchSnapshot() })`. First run generates the snapshot file. Subsequent runs assert equality. The snapshot captures only the exported constant from `src/lib/source-model-defaults.ts`; it must not call `resolveSourceModel`, `formatForDocs`, `getAvailableModels`, or any OpenCode/client-derived path, so Renovate/plugin updates cannot change the snapshot unless the source constant changes.

**Patterns to follow:**
- Bun's snapshot output convention: `tests/unit/__snapshots__/<test-file-basename>.snap` — a Jest-format snapshot file alongside the test.

**Test scenarios:**
- Happy path (snapshot exists): `bun test tests/unit/source-model-defaults.test.ts` passes; snapshot matches the constant exactly.
- Edge case (snapshot diff signals intentional change): when `SOURCE_CATEGORY_MODEL_DEFAULTS` changes in the same PR as a snapshot update, the diff is reviewer-visible and reviewable as one atomic change.
- Edge case (snapshot drift): if someone updates the snapshot without changing the constant, the diff is visible in PR review as a red-flag (no corresponding source change).
- Edge case (dependency bump no source change): bumping `@opencode-ai/plugin` or OpenCode model metadata without changing `SOURCE_CATEGORY_MODEL_DEFAULTS` produces no snapshot diff because the snapshot is constant-only, not derived from availability or docs formatting.
- Integration: `grep -rn "claude-opus-4-7\|gpt-5\.\|claude-sonnet\|claude-haiku" tests/unit/` returns only intentional-fixture lines (or zero, if no test legitimately needs a literal model name).

**Verification:**
- `bun test` exits clean (no test references undefined constants).
- `tests/unit/__snapshots__/source-model-defaults.test.ts.snap` exists and is committed.
- `grep -rn "claude-opus-4-7\|claude-sonnet-4-6\|claude-haiku-4-5\|gpt-5\.5\|gpt-5\.4-mini\|gpt-5\.3-codex" tests/unit/ | grep -v 'SOURCE_CATEGORY_MODEL_DEFAULTS\|__snapshots__'` returns only intentional-fixture lines.

## System-Wide Impact

- **Interaction graph:** the config-hook fires once per plugin source per OpenCode startup. Each invocation calls `getAvailableModels(client)` once and threads the result through resolution for every bundled-agent emit. No re-entrancy concerns.
- **Transition sequencing:** Unit 1 is additive and leaves the old auth-backed path wired; Unit 3 is the single cutover for all categorized bundled agents; Unit 4 is deletion-only after the cutover. This avoids a half-migrated state where categories split across old provider-presence and new model-availability semantics.
- **Error propagation:** API errors trigger fallback silently; fallback errors return empty availability set; empty availability set triggers last-resort behavior (first listed entry). No errors propagate to the user — this is intentional and preserves the no-throw resolution contract from R7.
- **Unchanged invariants:** the precedence chain (project config > user config > Systematic source defaults > bundled markdown > OpenCode inheritance) is preserved. The `agents.<key>.model` and `categories.<id>.model` user-override fields work exactly as today. The runtime `model: null` inheritance opt-out is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `client.config.providers()` shape changes upstream in a future `@opencode-ai/plugin` minor | The fallback to `models.json` is the same shape OpenCode already writes; structural validation in Unit 2 catches schema drift. The peerDep range `>=1.0.0` in `package.json` already gives us version flexibility. |
| `models.json` shape changes upstream | Unit 2's structural validation (top-level must be `Record<string, { models: Record<string, unknown> }>`) treats schema-mismatched cache as a warn-and-miss, not a crash. We never read field-level model metadata so per-model upstream additions are opaque. A wrapped shape like `{ providers: ... }` is not guessed silently. |
| 7-provider catalog drift (new providers, renamed IDs) | Unit 1's schema enforces the catalog literal union for source defaults; availability may include unknown providers, but resolution ignores anything not explicitly present in the source chains. Adding a new provider requires an explicit Systematic release. `models.json` empirical check at planning time confirmed all 7 IDs PRESENT today. |
| Variant validation too permissive (user sets `variant: 'banana'` or a huge value) | Unit 1 schema validates variant as non-empty, whitespace-free, and max 128 chars. Semantic interpretation is OpenCode's downstream concern per R8 — Systematic doesn't gate on a closed enum because the variant space is provider-defined and evolves. |
| Stale source variant combines with user model override | Unit 3 explicitly clears source/lower-precedence `variant` when an overlay sets `model` without `variant`, and adds category + exact-agent tests for that partial override path. |
| Snapshot churn on dependency/model metadata bumps | R13's snapshot captures only the exported `SOURCE_CATEGORY_MODEL_DEFAULTS` constant, not OpenCode availability, docs formatting, or generated derived state. A snapshot diff is intentional only when source changes in the same PR. PR reviewers assert the connection. |

## Documentation / Operational Notes

- `docs/src/content/docs/getting-started/configuration.mdx` Source Category Model Defaults table is now generator-owned. Hand-edits inside the MDX-delimited generated block under `### Source Category Model Defaults` are reverted by `bun run docs:generate`; hand-edits outside that block are preserved. Editors should change source for table content.
- `src/lib/AGENTS.md` may need updates if it documents `getAuthenticatedProviders`. Verified during Unit 4 audit.
- No telemetry, monitoring, or rollout concerns. The change is entirely deterministic config-time resolution.
- Memory `#2685` reminder: pre-PR gate must include `bun run docs:build` (Unit 5 makes this non-negotiable).
- Memory `#2734` reminder: ship as `feat:` for v2.13.0 minor.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-12-client-api-source-model-resolution-requirements.md](../brainstorms/2026-05-12-client-api-source-model-resolution-requirements.md)
- Related PRs: #348 (auth-aware source resolution, v2.11.0), #351 (Zod-backed config schema, v2.12.0), #357 (recent source-default tuning)
- External references (OMO): `src/shared/model-availability.ts` and `src/shared/model-requirements.ts` at commit `75825eb9a6`
- OpenCode SDK: `node_modules/@opencode-ai/plugin/dist/index.d.ts:36-51`, `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts`, `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
- OpenCode source (read-only inspection at `v1.14.41`): `.slim/clonedeps/repos/anomalyco__opencode/`
- Empirical findings doc: `docs/brainstorms/2026-05-12-opencode-source-findings-for-unit-2.md`
