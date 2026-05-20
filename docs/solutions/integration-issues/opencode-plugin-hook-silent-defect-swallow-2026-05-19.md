---
title: OpenCode plugin hooks silently swallow synchronous throws as Effect defects
module: tests/manual (observability hooks)
date: 2026-05-19
problem_type: integration_issue
component: tooling
category: integration-issues
severity: medium
tags:
  - opencode-plugin
  - effect-ts
  - silent-failure
  - manual-probes
  - observability
  - hook-side-effects
symptoms:
  - Plugin hook produces no observable side effect (file write, log, network call) despite the hook being registered and the surrounding event firing
  - JSONL or other side-channel log stays empty for an entire probe run with no error in stderr
  - opencode serve process keeps running normally; no traceback, no warning, no degraded mode
  - The same hook works in isolation (different fixture, different invocation) but fails silently in the real fixture
root_cause: unhandled_effect_defect
resolution_type: code_fix
related_components:
  - manual-probes
  - plugin-runtime
---

# OpenCode plugin hooks silently swallow synchronous throws as Effect defects

## Problem

OpenCode's plugin runtime invokes registered hooks via `Effect.promise(async () => fn(input, output))` inside `Plugin.trigger`. `Effect.promise` is the Effect-TS combinator for promises that are **expected to never fail** — when the wrapped async function throws, the error becomes a **defect** in Effect terminology, not a recoverable failure. The defect propagates through the surrounding `Effect.fn` chain, but how it surfaces (or doesn't) depends entirely on the call site that invoked `Plugin.trigger`.

For the `tool.execute.before` and `tool.execute.after` hooks, the call site at `packages/opencode/src/session/prompt.ts:582-601` invokes them with bare `yield* plugin.trigger(...)` — no `Effect.catch`, no `Effect.either`, no try/catch boundary. In practice this means a synchronous throw inside a plugin's hook implementation can produce an empty side-effect log with zero diagnostic signal to the operator. The opencode serve process keeps running and the user-visible session flow continues, but the hook's observable side effect (writing JSONL, emitting a metric, ringing a webhook) silently never happens for that invocation.

## Symptoms

A manual probe that wrote `tool.execute.before` events to a JSONL file produced empty logs across multiple full runs:

```text
=== JSONL log dump ===
(no log written)
```

Both `opencode/big-pickle` (90-minute run, no signal) and `opencode-go/deepseek-v4-flash` (8-minute run, no signal) exhibited the same shape. The opencode serve process was alive at 0% CPU — running normally, just not producing the expected side effect.

## What Didn't Work

1. **Switching the model.** First instinct was inference latency: maybe big-pickle was slow enough that the prompt never returned. Switching to deepseek-v4-flash produced the same empty-JSONL result in less wall time, ruling out model speed.

2. **Verifying plugin loading.** Ran `opencode serve` with the Systematic plugin alone (no counter plugin) — server started cleanly in ~12s and bound to a port. Plugin loading was not the issue.

3. **Verifying provider auth.** `opencode auth list` confirmed credentials for the OpenCode Zen API. Auth was not the issue.

4. **Verifying hook signature.** Checked `.slim/clonedeps/repos/anomalyco__opencode/packages/plugin/src/index.ts` and confirmed the canonical `Plugin` type matches what the probe used — `tool.execute.before: (input: { tool, sessionID, callID }, output: { args }) => Promise<void>`. Signature was correct.

All four false-trail diagnostics burned time without surfacing the actual mechanism.

## Solution

Wrap every side-effecting call inside a plugin hook in `try/catch` and write the caught error to a synchronous, observable channel (stderr in this case, since file logging is exactly what's failing). The fix is small but mandatory:

```ts
// Before — silent failure if appendFileSync throws
function appendLine(obj) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n')
}

// After — defects surface on stderr instead of vanishing into the Effect runtime
function appendLine(obj: Record<string, unknown>) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n')
  } catch (err) {
    process.stderr.write('[counter] appendLine error: ' + String(err) + '\n')
  }
}
```

For probes that depend on hook side effects to validate behavior, also add a **RED-gate sanity test** that runs in under a minute against a real provider and asserts the side effect was observed. This is the canonical SUBAGENT-STOP probe's `subagent-stop-sanity.ts` pattern — single session, single tool call, single JSONL line within 60 seconds, fail loudly if the line never lands. Run the sanity gate before any longer probe run. The sanity probe authored for the SUBAGENT-STOP work passes in under 8 seconds against `opencode/big-pickle` and surfaces infrastructure failure immediately.

## Why This Works

`Effect.promise` does not provide error handling; it documents an expectation that the wrapped promise never rejects. When a synchronous throw inside the async hook becomes a defect, Effect's runtime treats it as an unrecoverable bug in the producer (the plugin), not a recoverable error in the consumer (the opencode session). The `Effect.fn("Plugin.trigger")` wrapper at line 261 of `packages/opencode/src/plugin/index.ts` propagates defects upward, and the bare `yield* plugin.trigger(...)` at the session.ts call site neither catches nor reports them in a way the operator sees.

Adding `try/catch` inside the hook converts the defect-emitter (synchronous throw) into a side-effect-emitter (stderr write). Effect's runtime now sees a clean async function that does not throw, and the operator gets a diagnostic on stderr the moment the failure occurs. The hook's intended JSONL write may still fail, but at least the failure is no longer invisible.

For OpenCode plugin authors: treat every side-effecting call inside a hook as a potential silent-failure surface. Filesystem writes, network calls, IPC pipes, and external-process invocations all need defensive error handling at the hook boundary. The plugin runtime will not surface them for you.

## Prevention

- **Wrap every side effect inside an OpenCode plugin hook in `try/catch`** with a synchronous diagnostic channel (stderr write, console.error, or an in-process counter that the test driver reads after teardown). Do not rely on Effect's runtime to surface failures from a plugin hook.
- **Add a RED-gate sanity probe for any longer behavioral probe that depends on hook side effects.** The sanity gate should run in under a minute, assert the expected side effect within a deadline, and fail loudly with a JSONL dump on miss. Pay back the 5-minute authoring cost the first time infrastructure fails.
- **Type generated plugin source.** When emitting plugin code as a string (the `counterPluginSource` pattern in manual probes), give the inner functions explicit `Record<string, unknown>` or domain-specific types instead of leaving parameters implicitly typed. Bun's embedded runtime compiles these strings as TypeScript; tighter types catch mismatched shapes at load time instead of at the silent-failure boundary.
- **Reference the Plugin type from the cloned upstream** (`.slim/clonedeps/repos/anomalyco__opencode/packages/plugin/src/index.ts`) when authoring hooks. The canonical signatures are the source of truth and surface mismatches before runtime.

### Concrete probe artifact

The PR #408 commit `f8c22b0` ships the `subagent-stop-sanity.ts` artifact as a reusable RED-gate template. It demonstrates:

- spawning an isolated `opencode serve` with dual plugin config (production plugin + per-run counter plugin) via `OPENCODE_CONFIG_CONTENT`
- firing a single `session.prompt` via the SDK's `client.session.prompt` fetch
- polling a JSONL log concurrently with the prompt rather than waiting for the response body (avoids hanging-HTTP-connection lockups on slow models)
- killing the server with SIGTERM-then-SIGKILL-after-grace to avoid stuck shutdowns
- failing loudly with a JSONL contents dump when the expected entry doesn't land within the deadline

Future probes that depend on hook side effects can copy this scaffold and replace only the assertion (which JSONL entry to wait for) and the prompt (what tool call to force).

## Related

- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md` — different mechanism (zsh `for x in $VAR` not word-splitting unquoted variables in zsh), same shape (instrumentation silently misreports its own state). Both are cases where the operator gets zero diagnostic signal from a failure that would be loud in a less-clever runtime.
- `docs/solutions/workflow-issues/risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md` — plan-writing analog of the same trap: a mitigation identified in the Risks table silently dropped from the Unit spec produces a code change that looks correct but lacks the intended defensive check.
- `docs/solutions/developer-experience/gh-statuscheckrollup-conclusion-empty-for-in-progress-2026-05-18.md` — CI polling analog: `gh pr view --json statusCheckRollup` emits empty-string `conclusion` for in-progress jobs, so the same empty-string check used in hook errors that silently look like success.
- OpenCode source for the trigger mechanism: [`packages/opencode/src/plugin/index.ts` lines 261–273](https://github.com/anomalyco/opencode/blob/v1.15.1/packages/opencode/src/plugin/index.ts#L261-L273) (the `Effect.promise` wrap) and [`packages/opencode/src/session/prompt.ts` lines 582–601](https://github.com/anomalyco/opencode/blob/v1.15.1/packages/opencode/src/session/prompt.ts#L582-L601) (the bare `yield* plugin.trigger` call site). Pinned to v1.15.1 — the clonedep at `.slim/clonedeps/repos/anomalyco__opencode/` is a runtime-local checkout.
