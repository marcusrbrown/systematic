---
title: 'fix(overlay): memoize getAvailableModels per OpencodeClient instance'
type: fix
status: completed
shipped: PR #383 → v2.14.5
date: 2026-05-16
origin: docs/brainstorms/2026-05-14-provider-availability-dx-hardening-requirements.md
---

# fix(overlay): memoize getAvailableModels per OpencodeClient instance

## Overview

Add module-scope memoization to `getAvailableModels` keyed on `OpencodeClientLike` identity via `WeakMap`. Within one OpenCode process lifecycle, repeated calls with the same `client` reuse the result. Multi-source Systematic plugin loads collapse N HTTP round-trips to one for **successful discovery outcomes**; `'unknown'` results are not cached so transient failures can retry.

Two distinct caches exist in this code path. To avoid ambiguity, this plan uses precise terminology throughout:
- **WeakMap memoization cache** — the new module-scope per-process cache added by this plan
- **`models.json` disk cache** — the existing on-disk fallback at `~/.cache/opencode/models.json` (unchanged)

Ships as v2.14.5 (`fix:` patch).

## Problem Frame

PR #370 made dual-Systematic loads a real and supported contributor configuration. Each plugin source invokes its own config hook, and each config hook calls `getAvailableModels` afresh — N HTTP round-trips with N independent 1500ms timeout budgets. The empty-`'api'` collapse fix shipped in v2.14.3 made second-source calls cheap-to-fail (returns `unknown` quickly when discovery is empty), but the duplicate work itself is still wasteful when discovery succeeds.

Empirical inspection of `anomalyco/opencode@v1.15.1` plugin loader at `packages/opencode/src/plugin/index.ts:128-150` proves that `PluginInput.client` is built once per OpenCode process and passed by reference to every plugin factory. That shared `client` identity is the natural memoization key.

## Requirements Trace

- R1. `getAvailableModels` MUST be memoized at module scope using `WeakMap<OpencodeClientLike, ModelAvailability>` for **successful discovery outcomes** (`'api'` and `'cache'` status). The WeakMap auto-invalidates when `client` is collected. `'unknown'` outcomes MUST NOT be cached so transient failures can retry on the next call (origin: brainstorm R1, refined by document review).
- R2. The `docs/src/content/docs/getting-started/configuration.mdx` "Availability-Aware Resolution" subsection MUST be updated to describe: (a) process-scoped memoization for successful results only, (b) the explicit restart contract for provider-state changes, and (c) the no-mutation contract for callers (the cached envelope is returned by reference). All three clauses verified in Unit 2's acceptance.

## Scope Boundaries

- No TTL on memoization — process lifetime is the contract for cached entries
- No promise-dedupe for concurrent in-flight calls — not needed under today's FIFO loader topology
- No subprocess/MCP isolation — module scope only covers the main OpenCode process
- No auth-event hook integration — OpenCode side change required

### Deferred to Separate Tasks

- Typed config validation (build-time agent/skill name enumeration + Zod enums + IDE autocomplete): separate brainstorm at `docs/brainstorms/2026-05-16-typed-config-validation-requirements.md` (status `draft`)
- Solution-doc cross-reference edits: separate `docs(solutions):` PR after this PR ships (matches PR #376 pattern)
- 1500ms timeout symptom on first call: smart note `#95` (this plan reduces N timeouts to 1, doesn't eliminate the first call's latency)
- Mid-process invalidation on auth changes: explicit non-goal; restart contract documented in R2

## Context & Research

### Relevant Code and Patterns

- `src/lib/model-availability.ts:266-340` — current `getAvailableModels(client, options?)` implementation; **6 return paths** to handle (enumerated in Unit 1)
- `src/lib/model-availability.ts:51-61` — `ModelAvailability` interface with `ReadonlySet` `models` contract (memory `#2963`)
- `src/lib/model-availability.ts:69-71` — `emptyAvailability()` factory (each caller gets a fresh Set, not a shared singleton)
- `src/lib/config-handler.ts:557` — single call site for `getAvailableModels`; verified to consume the return value only with no signature dependency
- `tests/unit/model-availability.test.ts` — existing 857-line test file; the empty-discovery test block is the structural template for new memoization tests

### Institutional Learnings

- Memory `#2963` (factory + ReadonlySet pattern): `ReadonlySet` is a type-level trust contract, not a runtime immutability guarantee. The cached envelope is safe to return by reference because the existing codebase honors the contract; downstream code that casts and mutates would corrupt the cache, but no such code exists today.
- Memory `#3005` (contributor DX invariant): local checkout wins over npm-installed Systematic. Multi-source plugin loads are a supported configuration.
- Memory `#2065` (scope-discipline split signal): typed-validation work was split into its own brainstorm. This plan honors the split.
- Memory `#2767` (TDD): RED-GREEN cycle, failing test first.
- Memory `#2685` (`docs:build` in pre-PR gate): Unit 2's docs change must be verified.
- Memory `#2734` (`fix:` triggers patch): `fix(overlay):` → v2.14.5.

### External References

- `anomalyco/opencode@v1.15.1` plugin loader source: `PluginInput.client` is built once at `packages/opencode/src/plugin/index.ts:128-150` and shared across all plugin factories. (Single sentence: this is the empirical anchor for keying the cache on `client` identity; full inspection notes are in the origin brainstorm.)

## Key Technical Decisions

- **WeakMap<OpencodeClientLike, ModelAvailability> at module scope**: The shared `client` reference is the only stable cross-source identity (module-scope state is per-source, not shared).
- **Cache only successful discovery (`'api'` and `'cache'`); skip caching `'unknown'`**: A transient failure on the first call (network blip, 1500ms timeout exceeded) should not pin every subsequent call into `'unknown'` for the rest of the process lifetime. The cost of one extra HTTP call on retry is acceptable; sticky-failure UX is not.
- **No TTL**: `WeakMap` auto-invalidates on `client` collection (OpenCode restart). TTL adds UX contract surface without providing better invalidation than the natural process boundary.
- **Cached envelope returned by reference, not clone**: Cloning every cache hit defeats the win. The existing `ReadonlySet` type contract (memory `#2963`) is a trust-level guarantee; this plan extends the same contract to cached returns. **This is type-level, not runtime: callers that cast and mutate would corrupt the cache.** No such code exists today and the contract is documented.
- **Single canonical statement of reference-identity contract**: The cached envelope is the same `ModelAvailability` reference as the originally-computed result. All test scenarios and acceptance assertions trace to this one contract.
- **No promise-dedupe**: The empirical FIFO finding means concurrent calls do not happen in today's topology. The multi-source test scenario is **sequential** — Source B's call happens after Source A's completes.

## Open Questions

### Resolved During Planning

- Cache shape: `WeakMap<OpencodeClientLike, ModelAvailability>`
- TTL: none
- Cached value type: `ModelAvailability` envelope by reference
- What gets cached: `'api'` and `'cache'` results only; `'unknown'` is skipped (refined by document review)
- Whether to expose a public reset/invalidation API: NO — process restart is the contract

### Deferred to Implementation

- (None — test isolation strategy is now explicit in Unit 1.)

## Implementation Units

- [ ] **Unit 1: Add WeakMap memoization to getAvailableModels (successful results only)**

**Goal:** Memoize successful `getAvailableModels` results (`'api'` and `'cache'` status) at module scope using `WeakMap<OpencodeClientLike, ModelAvailability>`. Sequential calls with the same `client` reuse the cached envelope. `'unknown'` results are not cached so transient failures can retry on the next call.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/lib/model-availability.ts`
- Test: `tests/unit/model-availability.test.ts`

**Approach:**
- Declare a module-scope `WeakMap<OpencodeClientLike, ModelAvailability>` (suggested name: `availabilityCache`)
- At the top of `getAvailableModels`, check the WeakMap for a cached envelope keyed on `client`. On hit, return the cached envelope by reference.
- The current function has **6 distinct return paths**. Cache-population happens at the two successful paths only:
  1. Defensive guard (no `client.config.providers`) → returns `readFallbackCache()` → cache if status is `'cache'`, skip if `'unknown'`
  2. Timeout branch → returns `readFallbackCache()` → cache if `'cache'`, skip if `'unknown'`
  3. Thrown error branch → returns `readFallbackCache()` → cache if `'cache'`, skip if `'unknown'`
  4. Error-envelope / undefined-data branch → returns `readFallbackCache()` → cache if `'cache'`, skip if `'unknown'`
  5. Empty-discovery branch (`models.size === 0`) → returns `emptyAvailability()` (`'unknown'`) → **skip cache**
  6. Successful API return → returns `{ status: 'api', models }` → **cache**
- Implementation pattern: wrap the existing function body in a cache-check prelude + a single `cacheAndReturn(envelope)` helper that only populates the WeakMap when `envelope.status !== 'unknown'`. This makes the cache rule visible at every return path without scattering the conditional throughout.
- All cached values are full `ModelAvailability` envelopes, not promises. The FIFO loader topology means we never have concurrent in-flight calls on the same client; promise-dedupe is not needed.

**Execution note:** Write failing tests for the memoization behavior first (RED), then add the cache structure (GREEN). Memory `#2767` discipline.

**Patterns to follow:**
- The existing factory-based `emptyAvailability()` pattern — `'unknown'` results still construct via the factory; they just don't enter the cache
- The single call site at `src/lib/config-handler.ts:557` should continue to work with zero changes (verified)

**Test scenarios:**

The scope-guardian noted that 7 scenarios was padded for a 5-15 line change. Trimmed to 4 high-signal scenarios that cover the contract:

- **Happy path — same-client cache hit (the core invariant):** Two consecutive `getAvailableModels(client)` calls with the same client where the first returns `status: 'api'` produce exactly one provider-API HTTP call. The second call returns the cached envelope by reference (`===`-equal). Spy on `client.config.providers` to count invocations.
- **Happy path — different-client miss:** `getAvailableModels(clientA)` followed by `getAvailableModels(clientB)` (distinct `OpencodeClientLike` instances) each produce their own provider-API call. No false sharing — the WeakMap correctly distinguishes by reference identity.
- **Edge case — `'unknown'` does not cache (the retry contract):** A first call that returns `status: 'unknown'` (either via empty-discovery collapse or via failed-cache fallthrough) is followed by a second call with the same client. The second call MUST re-invoke the underlying provider-API path (or cache-fallback path) — proving the failure is not sticky. This is the refinement that emerged from document review.
- **Edge case — `'cache'` status caches too (sequential multi-source integration scenario):** Simulate the multi-source contributor scenario sequentially: configure `client.config.providers` to throw, but pre-write a valid `models.json` to a temp `XDG_CACHE_HOME`. The first call returns `status: 'cache'`. The second call (still sequential, same shared `client`) hits the WeakMap, skipping both the failing API call AND the `fs.readFileSync` of `models.json`. Spy on `fs.readFileSync` to assert it fires exactly once.

**Test isolation strategy:**
- Tests MUST construct a fresh `OpencodeClientLike` per test case. Module-scope `WeakMap` state cannot leak between tests because each fresh client is its own key, and the test-scoped client goes out of scope when the test ends (no shared module state visible across tests).
- Tests that assert on cache behavior across multiple calls within ONE test use the same `client` reference deliberately and document the intent. No test should share a `client` across `it()` blocks.
- This is **not** relying on garbage-collection timing — the WeakMap auto-invalidation is a production property; in tests, the isolation comes from never sharing the key (client) across test cases.

**Verification:**
- All new tests pass; existing 857 lines of `tests/unit/model-availability.test.ts` continue to pass unchanged
- The provider-availability timeout warning at `src/lib/model-availability.ts:299-301` fires at most once per `(client, process)` pair on successful paths, and continues to fire on retries when discovery returns `'unknown'`
- `bun typecheck` passes; the `ReadonlySet` contract holds at the type level
- `bun run lint` passes; no new Biome warnings
- `bun run build` produces a clean dist; no dead code

- [ ] **Unit 2: Document memoization semantics**

**Goal:** Update the user-facing configuration docs to describe (a) process-scoped memoization for successful results, (b) the restart contract, and (c) the no-mutation contract for callers.

**Requirements:** R2

**Dependencies:** Unit 1 (the behavior must exist before the doc describes it)

**Files:**
- Modify: `docs/src/content/docs/getting-started/configuration.mdx`

**Approach:**
- In the existing "Availability-Aware Resolution" subsection, add a sub-paragraph describing the WeakMap memoization cache (per-process, no TTL, auto-invalidates on restart)
- Make the cache scope explicit: successful results (`'api'` and `'cache'`) are cached; `'unknown'` results are not cached (next call retries)
- Add explicit "Restart Contract" framing: provider-state changes (auth login/logout, env var changes) require OpenCode restart to be reflected in cached availability
- Add a brief note that callers receive the same envelope reference and MUST NOT mutate the returned `models` Set — referencing the existing `ReadonlySet` type contract
- Keep prose tight; this is a docs delta, not a redesign

**Patterns to follow:**
- The existing "Availability-Aware Resolution" subsection style — tight, plain prose, no embedded code examples
- Other docs sections that describe runtime contracts (search for "restart" or "process lifetime" mentions in the same MDX file)

**Test scenarios:**
- Test expectation: none — pure documentation, no behavioral change. Verified via `bun run docs:build` per memory `#2685`.

**Verification:**
- `bun run docs:build` produces 110+ pages without MDX errors
- The rendered page contains paragraphs covering ALL THREE R2 clauses: (a) memoization scope (successful results only), (b) restart contract, (c) no-mutation contract on cached envelope
- The doc reads cleanly to a senior engineer who hasn't followed the v2.14.x arc

## System-Wide Impact

- **Interaction graph:** `getAvailableModels` is called from a single site (`src/lib/config-handler.ts:557`). The memoization is transparent to that caller — no signature change. Multi-source plugin loads now hit the WeakMap memoization cache for successful discovery; single-source loads are unchanged.
- **Error propagation:** Existing "never rejects, always returns a `ModelAvailability` envelope" contract is preserved. Transient `'unknown'` outcomes are not cached, so a flaky first call doesn't poison subsequent calls within the same process.
- **State lifecycle risks:** WeakMap state is per-OpenCode-process. No partial-write or cross-process concerns. Tests that construct fresh clients per case see fresh state; tests that share a client within one `it()` block see the shared cached state, which is intended for multi-source coherency assertions.
- **API surface parity:** `getAvailableModels` is internal to `src/lib/`. Not exported from the package entry. No public API change.
- **Integration coverage:** Existing 857-line `tests/unit/model-availability.test.ts` covers empty-discovery, cache fallback, timeout behavior, and defensive client guards. The 4 new memoization tests add coverage for the WeakMap behavior without disturbing existing scenarios.
- **Unchanged invariants:** The `ReadonlySet<string>` contract for `models` (memory `#2963`); the `emptyAvailability()` factory pattern; the 1500ms `apiTimeoutMs` default; the empty-discovery collapse to `'unknown'` (v2.14.3); the cache-empty collapse to `'unknown'` (v2.14.4); the defensive guard for partial client shapes; the "never rejects" contract.

## Risks & Dependencies

Scope-guardian rightly noted the original risk table padded decision echoes. Trimmed to genuine open risks that could materially affect implementation:

| Risk | Mitigation |
|------|------------|
| If OpenCode ever parallelizes config-hook execution, concurrent calls would race on the WeakMap and could trigger duplicate HTTP work. | Explicit non-goal documented in plan + brainstorm. The FIFO empirical finding from v1.15.1 loader source is the anchor. If OpenCode ships parallelism in a future version, this plan must be revisited (promise-dedupe in the cache becomes necessary). |
| If OpenCode reuses a `client` reference after a transport teardown (hypothetical future behavior), the WeakMap returns stale data. | Empirical loader source shows `client` is built once per process and not torn down mid-process. If a future OpenCode version adds live-reload, the cache contract still holds because a new `client` is a new WeakMap key. |

## Documentation / Operational Notes

- No release notes beyond the standard `fix:` commit message — semantic-release picks up `fix(overlay):` and bumps to v2.14.5 patch automatically.
- The PR body should note that this is an internal optimization with no observable behavior change beyond N→1 HTTP calls on multi-source loads. Per memory `#2632`, no agent/session/memory refs in PR body.
- Post-merge: smart note `#95` updates to reflect the memoization-shipped status (typed-validation work remains the next surface).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-14-provider-availability-dx-hardening-requirements.md](../brainstorms/2026-05-14-provider-availability-dx-hardening-requirements.md)
- **Companion (deferred):** docs/brainstorms/2026-05-16-typed-config-validation-requirements.md (status `draft`)
- Related code: `src/lib/model-availability.ts:266-340`, `src/lib/config-handler.ts:557`
- Related PRs (parent arc): #372 (v2.14.3), #378 (v2.14.4), #380 (compound docs)
- External docs: `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/plugin/index.ts:128-150` at v1.15.1
- Memories: `#2065`, `#2627`, `#2685`, `#2734`, `#2762`, `#2767`, `#2963`, `#3005`, `#3043`, `#3061`
- Smart notes: `#95` (active, updates post-merge)
