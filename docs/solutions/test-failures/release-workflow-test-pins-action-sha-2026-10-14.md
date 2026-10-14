---
title: A workflow test asserted an exact action SHA, so every Renovate bump failed the Test check
date: 2026-10-14
category: test-failures
module: release-workflow
problem_type: test_failure
component: testing_framework
symptoms:
  - "Renovate PR #1102 failed the required Test check: publish job > mints the App token from the release secrets expected @bcd2ba49 and received @64ab729a"
root_cause: logic_error
resolution_type: test_fix
severity: medium
tags: [renovate, github-actions, sha-pinning, workflow-tests, test-fix]
---

# A workflow test asserted an exact action SHA, so every Renovate bump failed the Test check

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

## Related Issues

- #1102, #1121
