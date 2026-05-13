---
title: Plugin provider availability discovery and source-default resolution
date: 2026-05-12
category: best-practices
module: agent-overlay-resolution
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Replacing static auth-file heuristics with live capability checks
  - Designing a discovery API whose result must distinguish success from degraded modes
  - Generating user-facing documentation from a runtime constant
  - Planning a refactor that depends on undocumented upstream behavior
  - Handling partial plugin or client stubs in tests
related_components:
  - tooling
  - authentication
tags: [provider-availability, auth-json, source-defaults, generated-docs, defensive-guards, integration-tests, plugin-client, clonedeps]
---

# Plugin provider availability discovery and source-default resolution

## Context

Systematic's first source-default resolution implementation (PR #348) read `$XDG_DATA_HOME/opencode/auth.json` once per config-hook invocation and used the resulting provider-ID set to filter a flat `Record<string, string[]>` of `provider/model` literals — picking the first authenticated entry per category. The approach shipped, worked in the common case, and silently failed in four others: environment-variable providers (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), inline `cfg.provider` config blocks, plugin-registered providers via `auth.loader`, and stale `auth.json` entries for revoked keys.

The same refactor exposed three orthogonal problems that the auth-file approach had been masking:

1. **Discovery had no failure semantics.** `getAvailableModels` returned `Set<string>`. An empty set might mean "API succeeded and reported zero connected providers" or "the entire discovery pipeline failed." Callers couldn't distinguish, so degraded behavior was indistinguishable from success.
2. **Documentation drifted independently.** The Source Category Model Defaults table in `docs/src/content/docs/getting-started/configuration.mdx` was hand-maintained. Every Renovate bump or manual tuning of the source-defaults constant left the docs stale.
3. **Planning had to guess at upstream behavior.** The original plan deferred four technical questions to implementation time: which endpoint to call, what algorithm OpenCode uses for `OPENCODE_MODELS_URL` cache filenames, what "connected" semantically encompasses, and whether `client` is in-process or HTTP.

PR #358's 9-commit refactor produced five patterns worth lifting out of the specific change. They share one shape: **move from implicit assumptions to explicit contracts.**

## Guidance

### 1. Ask the runtime for capability discovery; don't read its caches directly

When a runtime maintains an authoritative list of connected providers, tools, or capabilities, ask the runtime over its own API. Don't reverse-engineer the runtime's state by reading the files it writes.

**Anti-pattern:**

```ts
const auth = readJson(`${xdgDataHome}/opencode/auth.json`)
const providers = new Set(Object.keys(auth.providers ?? {}))
const defaultModel = pickFirstAuthenticated(SOURCE_CATEGORY_MODEL_DEFAULTS, providers)
```

**Pattern:**

```ts
// `client` arrives via the plugin factory `PluginInput`.
const response = await client.config.providers()
const connected = new Set(response.data.providers.map((p) => p.id))
```

OpenCode's `connected` set is built from four signals — `source: "config" | "env" | "api" | "custom"` — not just `auth.json`. Reading `auth.json` directly caught one signal (`api`); the API call catches all four. The auth file was a *cache* of the runtime's connectivity decision; reading the cache directly assumed we understood every writer.

### 2. Return a discriminated availability envelope, not a flat result

When discovery can fail or degrade, the return type must let callers see the failure mode. A flat success-value type collapses orthogonal outcomes.

**Anti-pattern:**

```ts
async function getAvailableModels(client: Client): Promise<Set<string>> {
  // ... API call, cache fallback, empty set on total failure ...
}
```

**Pattern:**

```ts
// src/lib/model-availability.ts:27-50
export type DiscoveryStatus = 'api' | 'cache' | 'unknown'

export interface ModelAvailability {
  status: DiscoveryStatus
  models: Set<string>
}
```

- `api`: live answer; safe to pin source-default models against it
- `cache`: degraded but informed; the cached `provider/model` keys are plausibly still authoritative
- `unknown`: both API and cache failed; callers should fall back to OpenCode's parent-model inheritance rather than pinning a source default the user may not have access to

The downstream consumer becomes correct by construction:

```ts
const availability = await getAvailableModels(client)
const availabilitySet =
  availability.status !== 'unknown' ? availability.models : undefined

// applyAgentOverlays skips source-default pinning when availabilitySet is undefined
```

Bundled agents now inherit OpenCode's parent model when discovery fails entirely, instead of getting pinned to providers the user may not have access to.

### 3. Generate documentation from the source constant

If a documentation table or guide mirrors a runtime constant, make the constant the source of truth and generate the table from it. Hand-maintained mirrors of code constants drift; they always drift.

**Anti-pattern:** A `## Source Category Model Defaults` section in MDX with a manually-edited table. Every time the constant changes, someone is supposed to update the table. Nobody does.

**Pattern:** Extend the source constant with metadata sufficient for docs generation (`rationale: string`, `whenToOverride: string`, per-model `variant`), then generate the table inside MDX-comment delimiters that the generator owns:

```mdx
{/* SYSTEMATIC:SOURCE-DEFAULTS:START */}
| Category | Provider Chain | Default Model | Variant | Rationale | When to override |
| -------- | -------------- | ------------- | ------- | --------- | ---------------- |
| ... generated rows ...
{/* SYSTEMATIC:SOURCE-DEFAULTS:END */}
```

The generator imports the constant directly. CI enforces idempotence via `docs:build`: two runs of the generator must produce a byte-identical file. Use MDX-comment syntax `{/* */}` instead of HTML comments `<!-- -->` — MDX parses `!` as a JSX tag-start and a hand-rolled HTML comment can crash the docs build.

### 4. Inspect upstream source when planning depends on upstream behavior

If a plan has deferred-to-implementation technical questions about how an upstream behaves, shallow-clone the upstream **before** implementation begins. Direct source inspection turns guesses into evidence and shrinks the implementation-time decision surface.

PR #358's plan had four deferred questions about OpenCode's plugin API and server semantics. The `clonedeps` skill cloned `anomalyco/opencode@v1.14.41` to `.slim/clonedeps/repos/anomalyco__opencode/` and resolved all four:

| Question | Resolution from source |
|---|---|
| Which endpoint to use? | `client.config.providers()` — lighter than `client.provider.list()` |
| `OPENCODE_MODELS_URL` cache filename? | `Hash.fast(url)` is SHA-1 hex (verified at `packages/core/src/util/hash.ts`) |
| What does "connected" mean? | ≥1 of 4 signals: config / env / api / custom |
| Is `client` in-process or HTTP? | HTTP — `createOpencodeClient` returns a `fetch`-based client |

The findings landed in a gitignored `docs/brainstorms/` doc and were folded into the plan's Code & Patterns refs. Plan units shipped with empirical anchors at specific upstream line numbers, not vague "TBD at impl time."

### 5. Defensive client guards encode the integration-test contract

When integration tests inject partial client stubs, the production code should tolerate partial clients too. A defensive shape check is not "extra coverage" — it is the implicit contract telling future callers what shape the function actually needs.

**Anti-pattern:** Production code that calls `client.config.providers()` assumes the full client shape. Integration tests pass a stub `{ app: { log: async () => {} } }`. Production crashes with `client.config is undefined`. The fix gets applied to the test fixture, expanding it to provide every method production happens to call today, and the next caller hits the same wall.

**Pattern:** Production code states its actual contract through a defensive guard. Partial clients gracefully degrade to the documented fallback path.

```ts
// src/lib/model-availability.ts:213-220
export async function getAvailableModels(
  client: OpencodeClientLike,
  options: AvailabilityOptions = {},
): Promise<ModelAvailability> {
  // Defensive against partial/test client shapes: if config.providers isn't a
  // callable function, skip the API entirely and go straight to the cache.
  if (typeof client.config?.providers !== 'function') {
    return readFallbackCache()
  }
  // ... real API call ...
}
```

Two regression tests assert the behavior: one with a cache present (expects `status: 'cache'`), one without (expects `status: 'unknown'`). Future plugin-input variations and third-party callers degrade safely instead of crashing.

## Why This Matters

The structural win across all five patterns is the same: **explicit contracts over implicit assumptions.**

- Live API discovery is more complete than file-based inference because the runtime sees signals the file never captures.
- Discriminated envelopes prevent callers from pretending failure is success by making degraded paths show up in the type system.
- Generated docs eliminate drift between code and documentation because there is only one place that can change.
- Upstream source inspection reduces planning risk because empirical evidence beats inferred behavior every time.
- Defensive guards make partial inputs survivable because the production code itself documents what shape it actually requires.

These patterns matter most in plugin and integration-heavy systems where current truth is distributed across config, environment, runtime state, and external APIs. Reading any single store as ground truth is a bet that you understand every other writer. The bet rarely holds.

## When to Apply

Use these patterns when:

- A cache file is being treated as the authoritative source for runtime state
- A fallback decision depends on whether discovery truly succeeded or merely returned empty
- A documentation table or guide mirrors a code constant that can change
- Upstream behavior is unclear during planning and the plan currently defers it to implementation
- Integration tests inject partial objects or stubs into production code
- Multiple provider, model, or capability sources can coexist simultaneously

Do **not** apply these as ceremony to trivial local code. Use them when the system has more than one writer, more than one discovery path, or more than one failure mode.

## Examples

### A. Live runtime truth replaces auth-file shortcuts

```ts
// Before: trust auth.json as the full provider list
const auth = await readJson(authPath)
const providers = new Set(Object.keys(auth.providers ?? {}))

// After: ask the runtime
const response = await client.config.providers()
const providers = new Set(response.data.providers.map((p) => p.id))
```

### B. Availability envelope prevents unsafe pinning

```ts
const availability = await getAvailableModels(client)

if (availability.status === 'unknown') {
  return skipSourceDefaults()  // OpenCode parent inheritance
}

return pinSourceDefaults(availability.models)
```

### C. Generated docs stay in sync with the constant

```ts
// docs/scripts/generate-config-reference.ts
import { SOURCE_CATEGORY_MODEL_DEFAULTS, formatForDocs } from '../../src/lib/source-model-defaults.js'

const table = formatForDocs(SOURCE_CATEGORY_MODEL_DEFAULTS)
const updated = replaceBetweenDelimiters(
  current,
  '{/* SYSTEMATIC:SOURCE-DEFAULTS:START */}',
  '{/* SYSTEMATIC:SOURCE-DEFAULTS:END */}',
  table,
)
```

A second run produces byte-identical output; CI's `docs:build` step catches any non-idempotence.

### D. Upstream inspection clears planning unknowns

```bash
# Via the clonedeps skill — shallow clone at the pinned tag
# Lands at .slim/clonedeps/repos/anomalyco__opencode/
```

Then read the actual source for the four questions: which endpoint, what hash, what "connected" means, in-process or HTTP. Each answer becomes a Code & Patterns ref in the plan with a specific line number, not a guess.

### E. Defensive guards turn partial clients into supported inputs

```ts
// Production code's defensive guard IS the contract
if (typeof client.config?.providers !== 'function') {
  return readFallbackCache()
}

// Test 1: partial client + cache present → status: 'cache'
const partialClient = { app: { log: async () => {} } } as unknown as Client
const result = await getAvailableModels(partialClient)
expect(result.status).toBe('cache')

// Test 2: partial client + no cache → status: 'unknown'
process.env.XDG_CACHE_HOME = '/nonexistent'
const result2 = await getAvailableModels({} as unknown as Client)
expect(result2.status).toBe('unknown')
```

When the next caller arrives with a different partial shape, the contract is already documented in the production code and the regression tests.

## Related

- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — *Trust* boundaries (which sources may set which fields); this doc covers *discovery* contracts (how to know what's available). Adjacent in the config-load layer but orthogonal in concern.
- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` — Defensive contract at the plugin export-shape boundary; same family of "make implicit assumptions explicit" thinking applied to module shape rather than client shape.
- `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md` — Schema-validated emitted config; complementary surface where the runtime rejects unknown values at the boundary.
- PR #358 (squash pending) — the architectural arc captured in this doc
- PR #348 (squash 05affb9) — original `auth.json`-reading implementation, now removed
- `src/lib/model-availability.ts` — discriminated envelope + defensive client guard + `OPENCODE_MODELS_URL` SHA-1 resolution
- `src/lib/source-model-defaults.ts` — provider-grouped shape with `rationale`, `whenToOverride`, per-model `variant` metadata
- `docs/scripts/generate-config-reference.ts` — docs generator with idempotent MDX-comment delimiters
- `.slim/clonedeps/repos/anomalyco__opencode/` — cloned upstream for `Hash.fast` and `Provider.Service.list` source inspection
