---
title: A workflow test asserted an exact action SHA, so every Renovate bump failed the Test check
date: 2026-10-14
category: test-failures
module: release-workflow
problem_type: test_failure
component: testing_framework
symptoms:
  - "Renovate PR #1102 failed the required Test check: publish job > mints the App token from the release secrets expected @bcd2ba49 and received @64ab729a"
  - "Renovate PR #1359 (OpenCode v2 2.2.5 to 2.2.6) failed the Test check: the ce:connect host-support table test expected opencode-v2 2.2.6 and received 2.2.5"
root_cause: logic_error
resolution_type: test_fix
severity: medium
tags: [renovate, github-actions, sha-pinning, workflow-tests, test-fix, regex-manager, host-floor]
last_updated: 2026-11-16
---

# A workflow test asserted an exact action SHA, so every Renovate bump failed the Test check

> **Superseded in part:** The `SYSTEMATIC_VERSION` pin example, its Renovate regex manager and the `renovate-workflow.test.ts` block that tracked it no longer exist. The version now comes from the callee commit's own changelog (`docs/plans/2026-11-24-001-fix-connect-version-from-callee-changelog-plan.md`). The lesson about pinning wiring, not literals, still holds.

## Problem

Renovate PR #1102 bumped `actions/create-github-app-token` from v3.2.0 to v3.3.0 and failed the required Test check. Nothing was wrong with the action: one test asserted the exact commit SHA that Renovate had just rotated. Fixed in #1121.

## Symptoms

- `tests/unit/release-workflow.test.ts`, "publish job > mints the App token from the release secrets", expected `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1` and received `@64ab729a6294000f5aa4a4bc0b73d1f32bc45510`.
- The same failure would recur on every bump of that action.

## What Didn't Work

- **Replacing the exact value with a SHA-shape regex.** That fixed the failure, but it duplicated the file-wide `action pins` tests, which already require every `uses:` to be pinned to a 40-character SHA with a version comment.

## Solution

Before:

```ts
expect(step.uses).toBe(
  'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
)
```

After, the step test checks only which action the step uses:

```ts
expect(String(step.uses)).toStartWith('actions/create-github-app-token@')
```

Pinning is left to the existing file-wide tests:

```ts
test('every uses: reference is pinned to a 40-hex commit SHA', () => {
  // ...for every step in every job:
  expect(String(step.uses)).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
})
```

With the change, the suite passes on `main` and with the #1102 bump applied. Changing the step to the tag `@v3` still fails, through both `action pins` tests.

## Why This Works

The workflows pin every action to a full commit SHA, and Renovate owns which SHA. A test that copies the current SHA restates Renovate's decision and breaks each time Renovate changes it. The invariants worth pinning are that the step uses the expected action and that every action is SHA-pinned with a version comment. The file-wide tests already cover the second.

## Prevention

- Workflow tests pin invariants: which action a step uses, step ids, inputs, secret wiring, and that actions are SHA-pinned. They never pin a value a dependency bot rotates.
- Before adding a per-step assertion, check whether a file-wide test already covers the invariant.
- Before merging a workflow test, apply a dependency bump to the workflow and re-run it. The test should still pass.
- Tests check behavior at the current version, never the version itself. A test that compares a restated version with a pin adds a hand step to every bump and proves nothing the real-host jobs do not. When one fails on a Renovate PR, delete it.
- Decide first what a version in source means. If it must equal a pin, it gets a `renovate:` annotation and a regex manager, so Renovate moves both together and `postUpgradeTasks` regenerates whatever depends on it. `env.SYSTEMATIC_VERSION` in `.github/workflows/connect.yaml` is that case. If it records the lowest version where something was observed, it is a floor: it follows no pin, and it gets no annotation.

## The same failure with a version restated in source

`HOST_SUPPORT_TABLE` in `src/lib/connect-config.ts` listed the host versions the ce:connect researcher was proven on, and a unit test required each row to equal a host pin. Renovate PR #1359 bumped the v2 pin, the Host Contract v2 jobs proved the researcher at the new version in the same PR, and the Test check still failed on that one assertion. #1369 deleted the test and #1371 added a `// renovate:` annotation to each row. Both kept the wrong reading: the row is not the version in use. It is the lowest version where the researcher's tool limits were observed.

The fix in #1407 made each row a floor, so a newer release in the same major version is supported without a Systematic release, and a release seen to fail the proof goes on `KNOWN_BAD_HOST_VERSIONS` (`src/lib/connect-config.ts:862`, `HostSupportRow`; `src/lib/connect-config.ts:921-927`, `KNOWN_BAD_HOST_VERSIONS`). A floor follows no pin. The v2 pin is `2.2.7` (`scripts/opencode-host-pins.json:2`, `v2`) while the v2 row stays at `2.2.5`, and nothing fails. The annotation and its regex manager are gone, and a test pins their absence (`tests/unit/renovate-workflow.test.ts:197-207`, `no regex manager targets the connect config file`). The host-version evidence is in [`support-a-host-only-after-an-observed-deny-2026-11-09.md`](../best-practices/support-a-host-only-after-an-observed-deny-2026-11-09.md).

The risk is that a newer host release is supported without its own observation. What catches a release that breaks the limits is the researcher deny proofs in the Host Contract jobs, which run on every host pin bump ([`host-contract-evidence-is-ci-owned-2026-09-04.md`](../workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md)). #1407 did not run a real host above a floor.

An exact pin still follows Renovate. `env.SYSTEMATIC_VERSION` in `.github/workflows/connect.yaml` must be the one published release the scheduled run installs, so it keeps its annotation and regex manager (`.github/workflows/connect.yaml:73`, `SYSTEMATIC_VERSION`; `.github/renovate.json5:37-49`, `SYSTEMATIC_VERSION`; pinned by `tests/unit/renovate-workflow.test.ts:224`, `renovate Systematic pin tracking`).

## Related Issues

- #1102, #1121
- #1359, #1369, #1371, #1407 (host rows become floors), #1397 (`SYSTEMATIC_VERSION` tracked)
