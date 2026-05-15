---
title: Run capability discovery before user-config validation in plugin lifecycle hooks
date: 2026-05-15
category: best-practices
module: agent-overlay-resolution
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Designing a plugin config hook where multiple things must happen (discovery, validation, resolution, emission)
  - A validator may throw before downstream code can attempt graceful degradation
  - A discriminated availability envelope already exists but consumers admit edge cases that should degrade
  - Diagnosing why a feature that "should work" silently produces wrong values when an upstream signal is empty
related_components:
  - tooling
  - authentication
tags: [lifecycle-ordering, discovery-before-validation, graceful-degradation, availability-envelope, empty-set-collapse, plugin-config-hook]
---

# Run capability discovery before user-config validation in plugin lifecycle hooks

## Context

Systematic's `createConfigHandler` is a plugin lifecycle hook that runs at OpenCode startup. It loads Systematic config, builds a bundled-agent inventory, runs two validators, calls `getAvailableModels` to discover connected providers, and then emits the merged agent set.

After v2.13.0 introduced the `ModelAvailability` envelope (with `status: 'api' | 'cache' | 'unknown'` so consumers could distinguish live answers from degraded modes), two correctness gaps surfaced as users adopted the new behavior:

1. **An authoritatively-empty `'api'` response slipped through the downstream gate.** When OpenCode returned `200 OK` with `data.providers = []` (no providers connected), `getAvailableModels` returned `{ status: 'api', models: <empty Set> }`. The consumer gate `status !== 'unknown'` admitted it, source-default resolution iterated over the empty set, found no match, and fell through to a "last-resort: first provider's first model" path. Bundled agents got pinned to a provider the user had no auth for — the exact failure mode the envelope was supposed to prevent.

2. **The validators ran before discovery.** Any user-config typo (e.g., misspelled agent name in an overlay) caused `validateAgentOverlays` to throw, exiting the config hook before `getAvailableModels` was called. The user saw an overlay validation error; OpenCode logs showed a `/config/providers` 200 response — but the 200 came from some other request, not Systematic. The "did Systematic actually reach discovery?" question was unanswerable from logs.

Together: the consumer side was missing one collapse rule, and the lifecycle ordering made the symptom hard to diagnose. PR #372 (v2.14.3) fixed both. Two patterns are worth lifting out of the specific change.

## Guidance

### 1. Empty success is a kind of failure; collapse it at the envelope boundary

A discriminated availability envelope is only as useful as its trigger thresholds. If `'api'` admits empty results (because the API call technically succeeded), every downstream consumer has to remember to combine the status check with a `size > 0` check. Miss that combination at one site, and the failure mode is silent.

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

The downstream consumer is unchanged. The fix lives at the envelope construction site, where the trigger threshold is decided once for every consumer.

### 2. Run capability discovery before user-config validation in plugin lifecycle hooks

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

### 3. Watch for parallel bugs on parallel code paths

When you collapse an edge case at one source of an envelope (e.g., the API success path), check whether the same edge case exists at the other sources (cache, fallback, etc.). Fro Bot's review on PR #372 flagged exactly this: the API-empty case was fixed, but the cache-empty case (`{ status: 'cache', models: <empty Set> }`) still bypasses the same downstream gate. Tracked as issue #373 for a parallel patch.

The lesson isn't "always fix both paths in one PR" — sometimes splitting is correct. The lesson is **after fixing edge case X at source A, ask whether source B has the same edge case.** A 30-second check at PR-review time saves a separate bug-hunt cycle later.

## Why This Matters

The two patterns work together. The collapse in Pattern 1 only matters because the consumer side is gating on a single rule (`status !== 'unknown'`). The reorder in Pattern 2 only matters because the availability envelope already exists and downstream consumers can degrade based on it. Together they make graceful degradation the lazy default — consumers can be terse, validators can fail loudly, and the right thing happens without coordination.

For Systematic specifically, the cost of getting this wrong was concrete: users with no provider auth got bundled agents pinned to `anthropic/claude-opus-4-7`, which then failed at first invocation with a confusing error far from the config hook. After v2.14.3, those users get bundled agents that inherit OpenCode's parent model — which they configured themselves and know is callable.

## When to Apply

- Building a plugin lifecycle hook that combines discovery, validation, and emission
- Designing a discriminated envelope where one variant admits a "successful but useless" edge case (e.g., empty API response, empty cache, schema-valid-but-empty payload)
- Diagnosing a bug where a downstream component "should have degraded" but didn't — the upstream envelope's trigger may admit the case
- Working in any startup hook where the order of fallible operations affects what the user sees in logs after a failure

The patterns are not specific to Systematic or OpenCode. Any plugin or lifecycle handler with comparable shape benefits.

## Examples

### Before/after: the empty-set collapse

The before/after is in the Anti-pattern / Pattern blocks under Guidance #1 above. A regression test guarding the collapse:

```ts
test('returns status: unknown when API providers array is empty', async () => {
  process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent')

  const client = makeMockClient({
    data: { providers: [], default: {} },
    error: undefined,
  })

  const result = await getAvailableModels(client)

  expect(result.status).toBe('unknown')
  expect(result.models.size).toBe(0)
})

test('returns status: unknown when providers list is non-empty but no models discovered', async () => {
  // Catches the edge case where SDK shape produces a non-empty providers
  // array but `buildSetFromProviders` still yields zero models.
  process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent')

  const client = makeMockClient({
    data: {
      providers: [{ id: 'fake', models: {} }],
      default: {},
    },
    error: undefined,
  })

  const result = await getAvailableModels(client)

  expect(result.status).toBe('unknown')
  expect(result.models.size).toBe(0)
})
```

### Before/after: the lifecycle reorder

A regression test that catches a future refactor moving discovery back down:

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

## Related

- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` — the v2.13.0 architectural arc; introduced the `ModelAvailability` envelope this learning sharpens
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — the trust-boundary mechanism that determines which overlay fields project config can set; orthogonal to availability discovery but in the same config-hook lifecycle
- Issue #373 — Cache-empty fallback bypasses source-default pinning gate (the parallel bug surfaced by Fro Bot's review on PR #372)
- PR #358 (v2.13.0) — introduced the `ModelAvailability` envelope
- PR #372 (v2.14.3) — this learning's source PR; empty-discovery collapse + lifecycle reorder
