---
title: A scripted real-host test must not call a tool that needs a binary the CI runner lacks
date: 2026-11-09
category: test-failures
module: pi-integration-tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "The Host Contract v2 shard that runs the Pi family test was red in CI while the same test passed locally"
  - "The scripted child called Pi's grep tool, which needs ripgrep; the tool's error is: ripgrep (rg) is not available and could not be downloaded"
  - "The run is offline, so the host's attempt to fetch rg could not succeed"
root_cause: missing_tooling
resolution_type: test_fix
severity: medium
tags:
  - pi
  - scripted-model
  - ripgrep
  - host-contract
  - ci-local-divergence
  - offline-runner
---

# A scripted real-host test must not call a tool that needs a binary the CI runner lacks

## Problem

A real-host integration test drives a child agent with a scripted model: the script decides which tool the child calls. The first script for the Pi researcher family called `grep`. Pi's `grep` tool runs `rg`, and Pi's `find` tool runs `fd`. On a developer machine both exist. The CI runner has no `rg`, and it runs offline, so the host's fallback of downloading the binary cannot work. The test passed locally and failed in CI.

## Symptoms

- A red `Host Contract v2 shard N/4` job on the test `a family completes inside the delegate turn cap with read, search and find tools only, and its batch validates` (`tests/integration/pi.test.ts:1344-1394`), green on the author's machine.
- A scripted `grep` call cannot return matches on a machine without `rg`. The exact assertion that failed in CI was not kept; the local reproduction below is what confirmed the cause.
- Reproducible locally by removing `rg` from `PATH` before running the file.

## What Didn't Work

A locally passing test does not reproduce the missing `rg`; take `rg` off `PATH` to reproduce the CI environment. The failure is deterministic on the runner, and the script and assertions were correct. The missing piece was a binary outside the repository.

## Solution

Script the child to use tools that need no host binary. The family script reads files with `read` and still lets the child be *offered* `grep` and `find` (`tests/helpers/connect-family-script.ts:206-249`, `createFamilyScript`, with a comment explaining why). The test then asserts the offer separately, so the claim "the child has read, search and find" stays true without calling the two that need binaries (`tests/integration/pi.test.ts:1366-1373`):

```ts
const offered = script.observation().childToolNames
for (const name of ['read', 'grep', 'find']) {
  expect(offered).toContain(name)
}
```

## Why This Works

What the test proves is that the delegate session was built with the right tool list and that a family finishes inside the 20-turn cap. Neither depends on `grep` matching anything. Asserting the offered tool names covers the first, and `read` calls exercise the turn loop for the second without a dependency on the runner image.

## Prevention

- Before a scripted model calls a tool, check what the tool runs. A tool backed by an external binary (`rg`, `fd`, `git`, a shell) is an environment dependency, and the offline CI job is the environment that will not have it.
- Reproduce CI-only failures of this kind by taking the binary off `PATH` locally: `PATH` without `rg`, then run the one file.
- Prefer built-in tools in a script when the behavior under test is plumbing. If a test needs the external tool, install it in the job explicitly and say so in the test.
- Keep the offered-tools assertion next to the script. Without it, switching the script to `read` could quietly remove `grep` and `find` from the child's list.

## Related Issues

- [A real-host CI job catches what offline gates cannot](../workflow-issues/real-host-ci-catches-what-offline-gates-cannot-2026-09-06.md): the wider class of local-pass, CI-fail, with different causes.
- [Test packaged harness extensions against the real Pi runtime](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md)
