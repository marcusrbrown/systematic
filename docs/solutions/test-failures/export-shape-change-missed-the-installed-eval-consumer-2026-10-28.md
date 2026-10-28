---
title: A default-export shape change missed the installed-mode eval consumer
date: 2026-10-28
category: test-failures
module: systematic-plugin
problem_type: test_failure
component: testing_framework
symptoms:
  - Installed-mode eval cases return `artifact_resolution` after the plugin entry becomes an object
  - Unit and package-export tests pass while the installed-mode evals fail
  - The failures were first written off as "fail on macOS (also on HEAD)", with HEAD meaning the branch tip
root_cause: missing_workflow_step
resolution_type: code_fix
severity: medium
tags:
  - default-export
  - plugin-object
  - installed-mode-evals
  - artifact-resolution
  - consumer-search
  - baseline-on-main
  - opencode
---

# A default-export shape change missed the installed-mode eval consumer

## Problem

PR #1239 changed the plugin's default export from a function to an object `{id, setup, server}` so one package serves both OpenCode lines. The list of consumers to update was built from the places that obviously inspect the export. One consumer was not on it: the installed-mode eval runner, which loads the packed artifact and checked that the default was a function. Every installed-mode case failed with `artifact_resolution`.

## Symptoms

- Installed-mode eval cases ended in `artifact_resolution` before any model call.
- The unit suite and the package-export tests passed.
- The failures were reported as pre-existing on macOS. The comparison was against the branch tip, not against main.

## What Didn't Work

- **A consumer list built from gates.** The list covered `tests/unit/package-exports.test.ts`, the `plugin.test.ts` call sites and the packaged smoke script in `.github/workflows/main.yaml`. `scripts/run-evals.ts` loads the packed artifact for a different purpose, so nobody thought of it as an entry-shape consumer.
- **"Pre-existing on macOS".** The baseline was the branch tip, which already carried the change, and the macOS explanation was never tested against the base. The old check, `typeof installedModule.default !== 'function'`, cannot accept an object default, so every installed-mode case fails on any platform.
- **Blaming the environment in a guard comment.** The comment stayed until Linux CI passed and disproved it.

## Solution

`executeInstalledArtifactCase` (`scripts/run-evals.ts:3159`) loads the packed entry. Its check on `installedModule.default`, at `scripts/run-evals.ts:3182-3197`, now accepts the object and requires its `server` member to be a function. The old check was `typeof installedModule.default !== 'function'`.

```ts
const entry = installedModule.default
if (
  typeof entry !== 'object' ||
  entry === null ||
  !('server' in entry) ||
  typeof entry.server !== 'function'
) {
  return { runtime, execution: failedExecution('artifact_resolution') }
}
```

The shipped entry is `systematicPlugin` in `src/index.ts:23-50`. `entryShapeProblems` in `tests/unit/package-exports.test.ts:42-65` holds the full shape predicate, and the comment that blamed macOS was replaced.

## Why This Works

The runner imports the built entry and checks it before it starts a host. A check written for the old shape rejects the new one at that step, which is why every installed-mode case failed identically and early. Accepting the object with a callable `server` matches what a v1 host calls, so the eval exercises the same contract the host does.

## Prevention

- **Search every consumer of the default before changing its shape.** Look for `.default`, `typeof .*default` and dynamic `import(` of the built entry across `scripts/`, `.github/workflows/` and `tests/`. Include anything that loads the packed or installed artifact. A file named for evals or smoke checks is still a consumer.
- **Run a failing suite on the base commit before accepting "pre-existing".** A failure that also appears on the branch tip says nothing about main. Check out main, run the same command, and record the commit.
- **Keep one shape predicate.** `entryShapeProblems` in `tests/unit/package-exports.test.ts:42-65` already encodes the rule. A second hand-written check, like the one in the eval runner, drifts the next time the shape moves.
- **Fix comments that blame the environment once evidence disproves them.** A stale excuse in a guard comment trains the next reader to skip the failure.

## Related Issues

- [OpenCode plugin named exports break the loader](../integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md). The other half of the entry contract: only `default` may be exported.
- [Verify installed artifacts, not just build gates](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md). Why the packed artifact needs its own check.
- [Verify a no-change claim against the consumer](../best-practices/verify-a-no-change-claim-against-the-consumer-2026-09-08.md). The same habit applied to a claimed no-op.
- [Clean-checkout baselines before quoting metrics](../workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md). Take the baseline from main, not from the working branch.
- [A duplicated literal is a registration point nobody documented](./duplicated-cli-help-fixture-is-a-hidden-registration-point-2026-08-16.md). The same shape: a consumer outside the documented list.
- PR #1239.
