---
title: Test packaged harness extensions against the real Pi runtime
date: 2026-07-16
category: best-practices
module: pi
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - building integration tests against the real Pi runtime
  - mocking Pi model responses without a built-in test provider
  - validating packaged Pi extensions from the shipped npm artifact
  - deciding between silent skip guards and hard failures for exact devDependencies
tags: [pi, integration-testing, real-runtime, rpc, mock-server, env-isolation, fail-fast]
related_components:
  - tooling
  - development_workflow
---

# Test packaged harness extensions against the real Pi runtime

## Context

Unit-level adapter parity tests only prove the shared core and adapter envelope agree. They do
**not** prove the real harness can install, load, and wire the packaged extension in-process.

`tests/integration/pi.test.ts` proves what fake-SDK tests miss:

- real CLI boot (`node .../dist/cli.js --mode rpc`) with the **exact devDependency**; a missing CLI
  is a hard failure, not a skip (`pi.test.ts:70-79`)
- real packaged plugin loading from an **`npm pack` tarball**, not source (`pi.test.ts:234-298`)
- real manifest-driven wiring of `pi.extensions` / `pi.skills`
- real RPC/JSONL plumbing between subprocess and test harness (`pi.test.ts:485-657`)
- real model-driven tool execution over SSE, so bootstrap and tool results are observed through the
  same path the agent uses (`pi.test.ts:341-483`, `:692-930`)

That is the boundary where packaged-runtime regressions actually live.

## Guidance

### 1) Isolate the fixture hard

Mirror the OpenCode discipline: temp `HOME` + temp XDG roots + narrow env allowlist + agent/session
dirs overridden. The Pi dir env names were verified against the installed source
(`dist/config.js:397-398`, `ENV_AGENT_DIR` / `ENV_SESSION_DIR`).

```ts
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', ...])

return {
  HOME: fixture.homeDir,
  XDG_CONFIG_HOME: fixture.xdgConfigHome,
  XDG_DATA_HOME: fixture.xdgDataHome,
  XDG_CACHE_HOME: fixture.xdgCacheHome,
  XDG_STATE_HOME: fixture.xdgStateHome,
  PI_CODING_AGENT_DIR: fixture.agentDir,
  PI_CODING_AGENT_SESSION_DIR: fixture.sessionDir,
  PI_OFFLINE: '1',
}
```

Refs: `pi.test.ts:103-193`, `:676-704`; shared OpenCode pattern: `opencode.test.ts:142-212`.

### 2) Install packaged code offline

Pack once, extract the tarball into the fixture, then point `.pi/settings.json` at it via a
**relative local path** (Pi's package manager accepts local directory sources):

```ts
fs.writeFileSync(
  path.join(piDir, 'settings.json'),
  JSON.stringify({ packages: [relativePackagePath] }, null, 2),
)
```

The key is an offline local source, not npm spec resolution. That exercises real manifest loading
without network. Use Pi's `--approve` flag for non-interactive project trust. See
`pi.test.ts:234-298`.

### 3) Put mock model config in the agent dir

Pi 0.80.6 has no built-in mock or test provider. The working mechanism is an in-test
OpenAI-completions SSE server (`Bun.serve` on port 0) plus a `models.json` provider override — and
that file must live in the agent dir (`PI_CODING_AGENT_DIR`), not the project:

```ts
fs.writeFileSync(path.join(fixture.agentDir, 'models.json'), JSON.stringify(...))
```

A project-local `.pi/models.json` is silently ignored (verified empirically — it is not a Pi config
scope). Scripted multi-turn responses, including `tool_calls` chunks, drive real tool execution.
Refs: `pi.test.ts:300-338`, `:371-483`.

### 4) Drive RPC by id, and keep tails for failures

The client writes JSONL requests, correlates responses by `id`, and waits with a timeout:

```ts
const responsePromise = waitFor((msg) => msg.type === 'response' && msg.id === id)
stdin.write(`${JSON.stringify(withId)}\n`)
```

Timeout errors include stdout/stderr tails for diagnosis. Refs: `pi.test.ts:486-657`.

### 5) Ground observability in what the runtime actually exposes

Do not rely on a command that does not exist.

- The system prompt is **not** exposed by RPC; assert the bootstrap marker in the mock model's
  captured request payload instead (`pi.test.ts:792-820`).
- Extension load is proven by **absence of `extension_error`** plus behavioral markers, not by
  slash commands (`pi.test.ts:692-735`).
- Tool success is proven via `tool_execution_end` frames (`pi.test.ts:855-869`).
- Pi registers tools, not commands, so `get_commands` is the wrong load signal
  (`pi.test.ts:697-704`).

### 6) Hard-fail exact devDependencies

If the CLI is missing, throw immediately:

```ts
if (!fs.existsSync(PI_CLI)) {
  throw new Error(`Pi coding-agent CLI not found...`)
}
```

Rule of thumb: **skip guards are for genuinely optional external deps**. If the repo declares an
exact devDependency, a silent skip creates false-green CI.
Ref: `pi.test.ts:70-79`.

## Why This Matters

This closes the false-green gap:

- fake-SDK tests can drift from the real runtime
- subprocess tests catch packaging, manifest resolution, bootstrap injection, and RPC wiring
- the right contract is three-layered: shared-core unit tests, adapter contract tests, and
  subprocess/package integration (see the layer table in
  [cross-harness adapter parity contract tests](cross-harness-adapter-parity-contract-tests-2026-07-14.md))

## When to Apply

- Adding a harness/runtime integration suite.
- A dependency becomes exact or vendored, and existing skip guards need revisiting.
- Asserting on prompts or tooling the runtime does not expose directly through its API.

## Examples

**Don't**

```ts
if (!PI_AVAILABLE) test.skip(...)
```

**Do**

```ts
if (!fs.existsSync(PI_CLI)) throw new Error('...missing exact devDependency...')
```

**Don't**

```ts
fs.writeFileSync(path.join(projectDir, '.pi/models.json'), ...)
```

**Do**

```ts
fs.writeFileSync(path.join(fixture.agentDir, 'models.json'), ...)
```

## Related

- [Isolate OpenCode subprocess fixtures from the real installation](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md)
  — the OpenCode sibling of this recipe (server+SDK spawn; this doc covers Pi's RPC/JSONL spawn
  with a mocked model)
- [Pin cross-harness adapter contracts at the boundary](cross-harness-adapter-parity-contract-tests-2026-07-14.md)
  — the layer contract this harness completes at the subprocess tier
- [Preserve foreign content when composing a chained bootstrap prompt](../logic-errors/pi-chained-bootstrap-composition-2026-07-14.md)
  — the bootstrap composition rules whose runtime proof lives in this harness
- [Pi harness support plan](../../plans/2026-07-06-003-feat-pi-harness-support-plan.md)
