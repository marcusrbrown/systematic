---
title: Availability guards must check executability, not PATH presence
date: 2026-08-16
category: integration-issues
module: integration-test-harness
problem_type: integration_issue
component: testing_framework
severity: high
symptoms:
  - "`which opencode` succeeds while `opencode --version` fails"
  - "Real-host integration tests execute instead of skipping"
  - "`bun test` hangs with no error explaining why"
root_cause: missing_validation
resolution_type: test_fix
related_components:
  - mise
  - opencode
tags:
  - integration-tests
  - skip-guard
  - shims
  - mise
  - availability-check
---

# Availability guards must check executability, not PATH presence

## Problem

The OpenCode integration-test guard checks only that the command exists on `PATH`. A version manager can place a shim there that fails on every invocation, so the guard passes and the tests run against a runtime that cannot start.

## Symptoms

```console
$ which opencode
/Users/<user>/.local/share/mise/shims/opencode

$ opencode --version
mise ERROR No version is set for shim: opencode
```

The guard sees success from the first command and never runs the second:

```ts
export const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()
```

`tests/integration/fixtures/receipt-workflow-host.ts:7-10`

Result: `bun test` starts the real-host receipt and eval-runner suites, which wait on a host that will never come up. There is no failure message — the run simply stops making progress, and the whole suite becomes unusable locally.

## What Didn't Work

**Reading the hang as a test bug.** The natural first assumption is that a recently changed test introduced the stall. It had not; the environment had.

**Assuming a skip guard implies a skip.** The guard's existence made "these tests skip when OpenCode is absent" feel guaranteed. The guard was real, its check was just too shallow to fire.

**Grouping suites by name.** `eval-runner.test.ts` reads like a unit-adjacent suite but spawns hosts the same way the receipt suites do. Splitting "host-independent" tests by intuition still included it, and the run hung again.

## Solution

Probe the executable rather than the path:

```ts
export const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['opencode', '--version'])
  return result.exitCode === 0
})()
```

Retaining the failure reason makes the skip self-explanatory:

```ts
export const OPENCODE_AVAILABILITY = (() => {
  const result = Bun.spawnSync(['opencode', '--version'])
  return {
    available: result.exitCode === 0,
    detail: result.stderr.toString().trim(),
  }
})()
```

Gate on `available`, and put `detail` in the skip message so the next person sees `No version is set for shim: opencode` instead of an unexplained skip.

## Why This Works

`which` answers "does a file exist at this name." It says nothing about whether the file runs. A shim is a file that exists precisely so it can decide later whether it works.

`--version` exercises path lookup, shim resolution, runtime selection, and process startup, while staying cheap and side-effect-free. Do not use a real workload such as `opencode run` as the probe — that reintroduces the hang the guard exists to prevent.

## Prevention

- Guard optional real-host suites on a successful trivial invocation, never on `which` or `command -v` alone.
- Include captured stderr in the skip message. A silent skip and a silent hang look identical from the outside.
- Suspect the environment when a suite hangs without output, especially after installing or switching a version manager. Verify with `<tool> --version` before investigating test code.
- Do not classify suites as host-independent by filename. Check what they actually spawn.

## Related

- [`docs/solutions/best-practices/pi-real-runtime-integration-harness-2026-07-16.md`](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md) — skip-guard discipline for optional runtimes, and when a missing dependency should hard-fail instead.
- [`docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md`](isolated-opencode-subprocess-fixtures-2026-05-14.md) — isolating real-host subprocess fixtures.
