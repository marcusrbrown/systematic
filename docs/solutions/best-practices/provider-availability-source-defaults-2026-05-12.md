---
title: Plugin provider availability discovery and source-default resolution
date: 2026-05-12
last_refreshed: 2026-05-16
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
  - Designing a discriminated envelope where one variant admits a "successful but useless" edge case
  - Building a plugin lifecycle hook that combines discovery, validation, and emission
related_components:
  - tooling
  - authentication
tags: [provider-availability, auth-json, source-defaults, generated-docs, defensive-guards, integration-tests, plugin-client, clonedeps, lifecycle-ordering, empty-set-collapse]
---

# Plugin provider availability discovery and source-default resolution

## Context

Systematic's first source-default resolution implementation (PR #348) read `$XDG_DATA_HOME/opencode/auth.json` once per config-hook invocation and used the resulting provider-ID set to filter a flat `Record<string, string[]>` of `provider/model` literals — picking the first authenticated entry per category. The approach shipped, worked in the common case, and silently failed in four others: environment-variable providers (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), inline `cfg.provider` config blocks, plugin-registered providers via `auth.loader`, and stale `auth.json` entries for revoked keys.

The same refactor exposed three orthogonal problems that the auth-file approach had been masking:

1. **Discovery had no failure semantics.** `getAvailableModels` returned `Set<string>`. An empty set might mean "API succeeded and reported zero connected providers" or "the entire discovery pipeline failed." Callers couldn't distinguish, so degraded behavior was indistinguishable from success.
2. **Documentation drifted independently.** The Source Category Model Defaults table in `docs/src/content/docs/getting-started/configuration.mdx` was hand-maintained. Every Renovate bump or manual tuning of the source-defaults constant left the docs stale.
3. **Planning had to guess at upstream behavior.** The original plan deferred four technical questions to implementation time: which endpoint to call, what algorithm OpenCode uses for `OPENCODE_MODELS_URL` cache filenames, what "connected" semantically encompasses, and whether `client` is in-process or HTTP.

PR #358's 10-commit refactor (including review-fix follow-up) produced six patterns worth lifting out of the specific change. They share one shape: **move from implicit assumptions to explicit contracts.**

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

- `api`: live answer with at least one connected model; safe to pin source-default models against it
- `cache`: degraded but informed; the cached `provider/model` keys are plausibly still authoritative
- `unknown`: discovery produced no usable signal (both API and cache failed, OR a path technically succeeded but returned an empty set); callers should fall back to OpenCode's parent-model inheritance rather than pinning a source default the user may not have access to

**Refinement (v2.14.3/v2.14.4): collapse empty success into `unknown`.** PR #372 and #378 tightened the envelope so that an API or cache path that returns zero usable models gets reshaped to `'unknown'` at the envelope construction site — not at every downstream consumer. See Pattern 7 below for the full rationale; the gate stays a single rule.

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

### 6. Bounded-read file handles eliminate TOCTOU races and unsafe shared state

Two adjacent failure modes surface together when a plugin reads a local cache file and returns the parsed result to multiple callers:

1. **Time-of-Check to Time-of-Use (TOCTOU)** — `fs.statSync(path)` + `fs.readFileSync(path)` checks the file size, then reopens the path to read. Between the two calls the file at `path` can be replaced (symlink swap), grown (concurrent writer extends past the size cap), or shrunk (writer truncates and rewrites). CodeQL flags this pattern as `js/file-system-race-condition` because the check and use are decoupled.
2. **Shared mutable singleton** — a module-level constant returned by reference from multiple early-exit paths lets any caller corrupt every future caller's view. The bug is latent until a caller mutates the returned set; then the next caller sees the mutation.

The fixes are independent in scope but share the same shape: **make the returned thing impossible to share or to read inconsistently.**

**Anti-pattern (TOCTOU):**

```ts
const stat = fs.statSync(filePath)
if (stat.size > MAX_BYTES) return null     // check
const raw = fs.readFileSync(filePath, 'utf8')  // use — different fs.open() under the hood
```

**Pattern (single-descriptor bounded read):**

```ts
function readModelsFromCache(filePath: string): Set<string> | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd)              // check on the descriptor
    if (!stat.isFile()) return null
    if (stat.size === 0) return null
    if (stat.size > MAX_BYTES) return null
    const buffer = Buffer.alloc(stat.size)
    const bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0)  // use the same descriptor
    if (bytesRead !== stat.size) return null   // mid-read truncation guard
    return parse(buffer.toString('utf8'))
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // best-effort close
    }
  }
}
```

The descriptor binds check and use to the same inode. A replaced or rewritten file at `path` is invisible — the fd still points at the original file. A shrunk file shows up as `bytesRead < statSize` and is rejected.

**Anti-pattern (shared singleton):**

```ts
const EMPTY_AVAILABILITY: ModelAvailability = {
  status: 'unknown',
  models: new Set<string>(),  // shared mutable Set
}
function readFallbackCache(): ModelAvailability {
  // ...
  return EMPTY_AVAILABILITY  // every "unknown" caller gets the same Set reference
}
```

**Pattern (factory + `ReadonlySet`):**

```ts
function emptyAvailability(): ModelAvailability {
  return { status: 'unknown', models: new Set<string>() }
}

export interface ModelAvailability {
  status: DiscoveryStatus
  /**
   * Set of `${providerId}/${modelId}` strings. Typed `ReadonlySet` because
   * callers must not mutate the returned collection — mutation would corrupt
   * future calls in the same process.
   */
  models: ReadonlySet<string>
}
```

`ReadonlySet<string>` is a TypeScript-level guard: honest callers cannot call `.add()` or `.delete()`. It is not a runtime guarantee (a cast through `as Set<string>` defeats it), but the factory pattern handles the runtime side: every caller gets an independent set, so even a forced cast-and-mutate cannot leak across calls.

The combined `ReadonlySet` + factory pattern outperforms `Object.freeze` on Set values. `Object.freeze` on a Set freezes only the container, not the contents — you would need to reassign `Set.prototype.add` or similar tricks. The factory is simpler and clearer.

**Why apply both together:** the singleton fix without the TOCTOU fix means callers get independent sets that may still be parsed from inconsistent file contents. The TOCTOU fix without the singleton fix means safely-read data still ends up shared. Both fixes target "make the returned thing impossible to share or to read inconsistently."

A regression test for the singleton fix forces mutation through a cast and asserts the next call sees an empty set:

```ts
const first = await getAvailableModels(client)
const firstMutable = first.models as Set<string>
firstMutable.add('attacker/poisoned-model')

const second = await getAvailableModels(client)
expect(second.models.has('attacker/poisoned-model')).toBe(false)
```

### 7. Empty success is a kind of failure; collapse it at the envelope boundary

A discriminated availability envelope (Pattern 2) is only as useful as its trigger thresholds. If `'api'` admits empty results (because the API call technically succeeded), every downstream consumer has to remember to combine the status check with a `size > 0` check. Miss that combination at one site, and the failure mode is silent.

The fix is to push the collapse into the envelope construction itself: when the success path produces an empty set, return the `'unknown'` shape instead. Callers get one rule ("`status !== 'unknown'` is safe to use"), and adding new consumers is mechanical rather than thoughtful.

**Anti-pattern (admits the edge case):**

```ts
if (response.error !== undefined || response.data === undefined) {
  return readFallbackCache()
}
return {
  status: 'api',
  models: buildSetFromProviders(response.data.providers),
}
```

```ts
// Downstream consumer
const availabilitySet =
  availability.status !== 'unknown' ? availability.models : undefined
// BUG: an empty `'api'` set produces an empty `availabilitySet`,
// which is admitted by the gate. Source-default pinning then
// falls through to a wrong-model last-resort.
```

**Pattern (collapse at the boundary):**

```ts
if (response.error !== undefined || response.data === undefined) {
  return readFallbackCache()
}

const models = buildSetFromProviders(response.data.providers)

// An authoritatively-empty response is operationally identical to total
// discovery failure — we cannot point bundled agents at any model the user
// can call. Funneling the empty case through the same `'unknown'` path the
// real failures take keeps the gate a single rule.
if (models.size === 0) {
  return emptyAvailability()
}

return { status: 'api', models }
```

The same collapse rule applies symmetrically to the cache path — see PR #378 for the parallel fix (Pattern 9 below covers the meta-lesson). The downstream consumer stays a single rule. The fix lives at the envelope construction site, where the trigger threshold is decided once for every consumer.

### 8. Run capability discovery before user-config validation in plugin lifecycle hooks

When a plugin lifecycle hook needs to both discover runtime capabilities and validate user config, run discovery first. Two reasons:

**Diagnostic clarity.** A validator throw leaves the question "did discovery happen?" unanswerable from external logs. Running discovery first guarantees an answer regardless of validation outcome: either discovery succeeded (the result is in scope when validation runs), or it fell back gracefully (the envelope's degraded shape is in scope). The user sees the right error class — overlay validation, not "we don't know if discovery worked."

**Forward-compatible lifecycle seam.** Future validators that need to consult availability — "reject this overlay because its target model isn't in the connected set" — can assume the availability result is computed by the time validation runs. If discovery happens after validation, that future work either needs a refactor or has to repeat the discovery call. The reorder costs almost nothing today and prevents a refactor later.

**Anti-pattern:**

```ts
const inventory = buildBundledAgentInventory(...)

// Validate first — risks throwing before discovery has a chance to run
assertSourceCategoryModelCoverage(inventory.categories)  // can throw
const validatedOverlays = validateAgentOverlays({...})    // can throw
const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)

// Discovery only runs if validators didn't throw
const availability = await getAvailableModels(deps.client)
```

**Pattern:**

```ts
const inventory = buildBundledAgentInventory(...)

// Discovery runs BEFORE validation. Two reasons:
//
// 1. Diagnostic clarity. If validation throws, the user sees the
//    validation error — and we know discovery already attempted (and
//    succeeded or fell back gracefully). Without this ordering, a
//    validator throw obscures whether discovery ever ran.
//
// 2. Forward-compatible lifecycle seam. Future validators that consult
//    availability (e.g., rejecting an overlay whose target model is not
//    in the connected set) can assume `availabilitySet` is already
//    computed by the time validation runs. Do not move discovery back
//    down on the grounds that current validators don't consume it; that
//    would reintroduce the same ordering bug class.
const availability = deps.client
  ? await getAvailableModels(deps.client)
  : undefined
const availabilitySet = computeAvailabilitySet(availability)

// Validators come after — they can throw safely now
assertSourceCategoryModelCoverage(inventory.categories)
const validatedOverlays = validateAgentOverlays({...})
const resolvedOverlays = resolveAgentOverlaySet(validatedOverlays)
```

The reorder is small. The inline rationale is non-negotiable — future maintainers must not "tidy up" by moving discovery back down on the grounds that current validators don't consume the result.

A regression test for the lifecycle ordering:

```ts
test('discovery completes before user-overlay validation throws', async () => {
  // When `validateAgentOverlays` rejects a user overlay, the config hook
  // must have already invoked `client.config.providers()`. Protects the
  // lifecycle ordering: discover first, validate second.
  createCategorizedAgent('review', 'correctness-reviewer', { ... })
  writeCustomSystematicConfig({
    agents: { 'correctness-reviewer': { skills: ['missing-skill'] } },
  })

  const providersCalls: number[] = []
  const trackingClient = {
    config: {
      providers: async () => {
        providersCalls.push(Date.now())
        return { data: { providers: [], default: {} }, error: undefined }
      },
    },
  }

  const handler = createConfigHandler({
    directory: projectDir,
    bundledSkillsDir, bundledAgentsDir, bundledCommandsDir,
    client: trackingClient,
  })

  // The handler should still throw — but discovery must have happened first
  await expect(handler({})).rejects.toThrow(/missing-skill/)

  // Spy fired before the throw — proves discovery is no longer gated
  // behind user-overlay validation.
  expect(providersCalls.length).toBe(1)
})
```

The spy doesn't just verify "called once eventually" — it asserts the call happened **before** the validator throw. A future refactor that defers discovery behind any validator-throw path would break this assertion.

### 9. Watch for parallel bugs on parallel code paths

When you collapse an edge case at one source of an envelope (e.g., the API success path in Pattern 7), check whether the same edge case exists at the other sources (cache, fallback, etc.). Fro Bot's review on PR #372 flagged exactly this: the API-empty case was fixed, but the cache-empty case (`{ status: 'cache', models: <empty Set> }`) still bypassed the same downstream gate. It was tracked as issue #373 and fixed in PR #378 (v2.14.4) — symmetrically collapsing empty cache results into `'unknown'`.

The lesson isn't "always fix both paths in one PR" — sometimes splitting is correct. The lesson is **after fixing edge case X at source A, ask whether source B has the same edge case.** A 30-second check at PR-review time saves a separate bug-hunt cycle later.

## Why This Matters

The structural win across all nine patterns is the same: **explicit contracts over implicit assumptions.**

- Live API discovery is more complete than file-based inference because the runtime sees signals the file never captures.
- Discriminated envelopes prevent callers from pretending failure is success by making degraded paths show up in the type system.
- Generated docs eliminate drift between code and documentation because there is only one place that can change.
- Upstream source inspection reduces planning risk because empirical evidence beats inferred behavior every time.
- Defensive guards make partial inputs survivable because the production code itself documents what shape it actually requires.
- Single-descriptor reads and factory-allocated returns close the windows where unrelated code paths can corrupt each other through shared file handles or shared state.
- Collapsing empty-success at the envelope boundary keeps the downstream gate a single rule, so adding new consumers is mechanical rather than thoughtful.
- Running discovery before validation makes graceful degradation the default — consumers can be terse, validators can fail loudly, and the right thing happens without coordination.
- Asking "does the parallel path have the same edge case?" at review time saves a separate bug-hunt cycle later.

These patterns matter most in plugin and integration-heavy systems where current truth is distributed across config, environment, runtime state, and external APIs. Reading any single store as ground truth is a bet that you understand every other writer. The bet rarely holds.

For Systematic specifically, the cost of getting the envelope-collapse and lifecycle-ordering wrong was concrete: users with no provider auth got bundled agents pinned to `anthropic/claude-opus-4-7`, which then failed at first invocation with a confusing error far from the config hook. After v2.14.3 and v2.14.4, those users get bundled agents that inherit OpenCode's parent model — which they configured themselves and know is callable.

## When to Apply

Use these patterns when:

- A cache file is being treated as the authoritative source for runtime state
- A fallback decision depends on whether discovery truly succeeded or merely returned empty
- A documentation table or guide mirrors a code constant that can change
- Upstream behavior is unclear during planning and the plan currently defers it to implementation
- Integration tests inject partial objects or stubs into production code
- Multiple provider, model, or capability sources can coexist simultaneously
- A module-level constant is returned by reference from multiple early-exit paths
- A function performs `stat` followed by `read` on the same path and the path could change between the two calls
- Designing a discriminated envelope where one variant admits a "successful but useless" edge case (empty API response, empty cache, schema-valid-but-empty payload)
- Diagnosing a bug where a downstream component "should have degraded" but didn't — the upstream envelope's trigger may admit the case
- Building a plugin lifecycle hook that combines discovery, validation, and emission
- Working in any startup hook where the order of fallible operations affects what the user sees in logs after a failure
- Reviewing a PR that fixes an edge case on one of several parallel code paths

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
- PR #358 (v2.13.0) — the architectural arc that established Patterns 1–6
- PR #372 (v2.14.3) — empty-discovery collapse + lifecycle reorder (added Patterns 7 and 8)
- PR #378 (v2.14.4) — parallel cache-empty collapse, closing the symmetry gap (added Pattern 9)
- PR #348 (squash 05affb9) — original `auth.json`-reading implementation, now removed
- `src/lib/model-availability.ts` — discriminated envelope + defensive client guard + `OPENCODE_MODELS_URL` SHA-1 resolution + empty-set collapse
- `src/lib/source-model-defaults.ts` — provider-grouped shape with `rationale`, `whenToOverride`, per-model `variant` metadata
- `src/lib/config-handler.ts` — lifecycle ordering: discover before validate
- `docs/scripts/generate-config-reference.ts` — docs generator with idempotent MDX-comment delimiters
- `.slim/clonedeps/repos/anomalyco__opencode/` — cloned upstream for `Hash.fast` and `Provider.Service.list` source inspection
