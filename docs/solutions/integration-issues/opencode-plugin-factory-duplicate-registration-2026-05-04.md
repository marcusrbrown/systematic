---
title: OpenCode plugin factory invoked once per opencode.json source — duplicate tool registration
date: 2026-05-04
category: integration-issues
module: systematic-plugin
problem_type: integration_issue
component: tooling
symptoms:
  - systematic_skill appeared twice in the LLM-visible tool catalog (opencode-doctor returned 2)
  - plugin factory ran twice in the same process when listed in both user-level and project-level opencode.json
  - heavy initialization (loadConfig, getBootstrapContent, createConfigHandler, createSkillTool) ran twice
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags:
  - opencode
  - plugin-registration
  - singleton
  - duplicate-tools
  - globalthis
  - config-sources
---

# OpenCode plugin factory invoked once per opencode.json source — duplicate tool registration

## Problem

OpenCode invokes a plugin's exported factory function **once per `opencode.json` source that lists the plugin**. When a user has the same plugin listed in both their user-level config (`~/.config/opencode/opencode.json`) and a project-level config (`<repo>/opencode.json`), the factory runs twice in the same process. The host then registers each returned hooks object independently, so the LLM sees the plugin's tools listed twice in its catalog.

For Systematic specifically: `systematic_skill` showed up twice in the doctor's tool listing, `experimental.chat.system.transform` ran twice on every prompt, and the configuration merge ran twice. Without a guard, the plugin had no way to know it was being asked to register itself a second time.

## Symptoms

Run the OpenCode doctor against a dual-source config:

```bash
mise run opencode:doctor --only tools --full --format json \
  | jq '.[] | select(.label == "Tools").data | map(.id) \
        | map(select(. == "systematic_skill")) | length'
```

Before the fix: `2`.

In the OpenCode log (`~/.local/share/opencode/log/<timestamp>.log`):

- `service=tool.registry status=started systematic_skill` appears twice per session
- `service=tool.registry status=completed ... systematic_skill` appears twice per session
- `Skipping bootstrap prompt injection` (or whatever the bootstrap-injection branch logs) appears twice
- Two distinct heavy-init runs visible in any `console.warn` instrumentation added to the factory

## What Didn't Work

**Assuming this was a single-source bug fixable by config dedup.** Wrong — OpenCode's plugin host calls the factory once per source by design. Whether two sources point at the same path or two different paths, the host invokes the factory twice.

**Whole-hooks reuse (the natural first instinct).** Cache the first call's `hooks` object, return the same reference to duplicate callers. This is what `opencode-copilot-delegate`'s `src/runtime/plugin-singleton.ts` does — the precedent that initially looked transferable. **Empirically insufficient**: the OpenCode host iterates each config source's returned hooks and calls `register(hooks.tool.<name>)` per-source regardless of reference identity. Two register calls = two catalog entries, even when the references match. After applying whole-hooks reuse, the doctor still reported `2`.

**Treating source-string equality as the dedup key.** Wrong. Different paths like `/abs/path/dist/index.js` and `./src/index.ts` produce different module instances even when they resolve to functionally-equivalent code. The OpenCode loader doesn't reconcile them. (When *both* sources point at the *same* path string, the loader does dedup at the path-string level — but that's a happy coincidence, not the typical setup.)

## Solution

Per-process register-once guard in `src/lib/plugin-singleton.ts`. The cache key is a `Symbol.for('@fro.bot/systematic/plugin-singleton')` slot on `globalThis` (PID-stamped to prevent cross-process cache poisoning when modules are shared via worker threads or process forks).

The exported plugin factory is wrapped through `plugInOnce`. **The first invocation runs init and returns the real hooks. Duplicate invocations skip init and return an empty hooks object `{}`** so the host has nothing to register a second time.

### Helper API

```typescript
// src/lib/plugin-singleton.ts
export interface PlugInOnceResult<T> {
  isFirst: boolean
  hooks: T
}

export interface PlugInOnceOptions<T> {
  doInit: () => Promise<T>
  onDuplicate?: (pid: number) => void
  /** Test override for the PID guard; production callers omit this. */
  pid?: number
}

export async function plugInOnce<T>(
  options: PlugInOnceOptions<T>,
): Promise<PlugInOnceResult<T>>
```

- **First call**: `{ isFirst: true, hooks }` — `hooks` contains real `tool`, `config`, and `experimental.chat.system.transform` registrations.
- **Duplicate call** (same process): `{ isFirst: false, hooks: {} as T }` — empty hooks object. The host iterates over its keys, finds none, registers nothing.
- **Sticky failure**: if `doInit` rejects, the rejection is cached and replayed to all subsequent callers in the same PID. No retry-on-failure.
- **Concurrent safety**: simultaneous first calls share a single in-flight init promise.

### Factory wiring

```typescript
// src/index.ts
const SystematicPlugin: Plugin = async (input) => {
  const { hooks } = await plugInOnce({
    doInit: () => initializePlugin(input),
    onDuplicate: (pid) => {
      const message = `[systematic] duplicate factory invocation in same process (pid=${pid}); skipping duplicate registration. Multiple opencode.json sources may list this plugin.`
      console.warn(message)
      // Fire-and-forget; never block plugin init on the structured-log call.
      input.client.app
        .log({
          body: { service: 'systematic', level: 'warn', message },
        })
        .catch(() => {})
    },
  })
  return hooks
}
```

`initializePlugin` is the heavy work — `loadConfig`, `getBootstrapContent`, `createConfigHandler`, `createSkillTool`. It runs once per process even when the host invokes the factory N times.

### Diagnostics

`onDuplicate` fires once per duplicate caller and emits both a synchronous `console.warn` (for terminal visibility during dev) and a best-effort structured `client.app.log` (for parity with the rest of OpenCode's structured logging). Failures of `client.app.log` are swallowed so they can't break startup.

## Why This Works

**Root cause.** OpenCode's plugin host iterates each `opencode.json` source's plugin list and registers tools, transforms, and config from each returned hooks object independently. Reference equality is not part of its dedup logic — the host doesn't compare the second call's hooks to the first's. So whatever the second factory call returns will be registered as if it were a separate plugin's hooks.

**Why empty-hooks fixes it.** When the duplicate caller returns `{}`, there is literally no `tool` field, no `experimental.chat.system.transform` field, no `config` field for the host to enumerate. The first caller's registrations stand. The second caller's "registrations" are no-ops because there is nothing to register.

**Why whole-hooks reuse doesn't fix it.** Even with reference equality, the host calls `register(hooks.tool.systematic_skill)` once per source. Two register calls produce two catalog entries regardless of whether the handler function is the same reference both times.

## Prevention

- **Verify singleton fixes against the LLM-visible tool catalog, not just diagnostic logs.** The `mise run opencode:doctor --only tools --full --format json | jq '...'` command is the canonical verification — it queries `client.tool.list({ provider, model })` which is exactly what the LLM sees. Fingerprint-matching probes only tell you the singleton helper fired; they don't tell you the host stopped registering twice.
- **Don't transfer plugin singleton patterns from precedent without dual-source verification.** A pattern that works for a plugin listed only in user-level config will pass its own internal tests yet fail under dual-source listing. Always set up the dual-source case explicitly when verifying a register-once guard.
- **For register-once guards in OpenCode plugins, return empty hooks/handlers to duplicate callers.** Not cached real handlers. Empty `{}` is what makes the host stop registering.
- **Run a Phase 0 empirical probe before designing the singleton.** Before any code, instrument the factory with a module-scope counter, sync `console.warn`, and best-effort structured log. Reproduce the bug in a dual-source config to confirm: same PID, count=1 in both invocations (independent module instances), all caller-scoped fingerprints match. Probe artifacts: `tests/manual/companion-aware-probe.ts` is a usable scaffold.
- **Test the helper's behavior branches:** first-call init, duplicate-call skip, `onDuplicate` callback wiring, concurrent first calls (shared in-flight promise), sticky failure, PID-change recovery (use the test-only `pid?` override), and a reset hook for test isolation.
- **Add a factory-level regression test** that calls the plugin factory three times in the same process and asserts only the first invocation returns real hooks; calls 2+ return empty `{}`. This is the host-visible contract the fix targets — separate from the helper's unit tests, and the one that catches future drift.
- **Operational gotcha when verifying empirically:**
  - `opencode-doctor` reuses any existing `opencode serve` already listening on port 4096 instead of spawning fresh — it cannot pick up a rebuilt plugin while a stale serve is alive. Run `pkill -KILL -f '\.opencode serve'` first; SIGTERM is often ignored.
  - The OpenCode TUI session you are inside caches its plugin module instances at session start. Rebuilding the plugin and re-running tools via the same TUI will not pick up changes — verification must happen from a fresh shell after killing orphaned serves, or after exiting and restarting the TUI.

## Related Issues

- Systematic PR #335 — the fix as shipped: <https://github.com/marcusrbrown/systematic/pull/335>
- Plan document: `docs/plans/2026-05-01-001-fix-idempotent-plugin-registration-plan.md`
- Adjacent upstream pattern (idempotence under cache-busting hook injection): <https://github.com/alvinunreal/oh-my-opencode-slim/issues/415>
- Precedent that initially appeared transferable but used the insufficient whole-hooks pattern: `opencode-copilot-delegate/src/runtime/plugin-singleton.ts`

## 2026-05-10 follow-up: singleton removed

The `plugInOnce` singleton introduced in PR #335 was reverted in a later PR. The duplicate-tool-entry concern that motivated the singleton turned out to be a non-issue — OpenCode registers tools per-source regardless of whether the hooks reference is shared, so the singleton's deduplication of the init work had no visible effect on the TUI tool catalog. What it DID do in dev setups with multiple plugin sources was collapse all loads onto whichever ran first, silently shadowing later sources.

The real correctness contract is now marker-based idempotency in `applyBootstrapContent`: each registration applies its bootstrap content by walking `output.system` for any prior `<SYSTEMATIC_WORKFLOWS>...</SYSTEMATIC_WORKFLOWS>` block and replacing it in-place. Under OpenCode's FIFO hook iteration, the last transform to run owns the final block — most-recently-registered plugin wins. The architectural rationale is captured in `docs/brainstorms/2026-05-10-multi-load-plugin-registration-requirements.md` and the implementation plan at `docs/plans/2026-05-10-002-refactor-multi-load-plugin-registration-plan.md`.
