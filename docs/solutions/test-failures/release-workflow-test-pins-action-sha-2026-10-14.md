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
tags: [renovate, github-actions, sha-pinning, workflow-tests, test-fix, regex-manager, host-support-table]
last_updated: 2026-11-12
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
- Tests check behavior at the current version, never the version itself. A test that compares a restated version with a pin adds a hand step to every bump and proves nothing the real-host jobs do not. When one fails on a Renovate PR, delete it.
- A value in source that must track a pinned version gets a `// renovate:` annotation and a regex manager whose package name falls in the pin's group, so Renovate moves both together and `postUpgradeTasks` regenerates whatever depends on it.

## The same failure with a version restated in source

`HOST_SUPPORT_TABLE` in `src/lib/connect-config.ts` lists the OpenCode v1, OpenCode v2 and Pi versions the ce:connect researcher was proven on. A unit test required each row to equal the pin in `scripts/opencode-host-pins.json` or `package.json`. Renovate bumped the v2 pin, the Host Contract v2 jobs proved the researcher at the new version in the same PR, and the Test check still failed on that one assertion. Satisfying it by hand meant editing the row, regenerating `skills/ce-connect/scripts/connect.mjs` and recording a new evaluation digest, on every bump.

The fix had two parts:

- Delete the assertion (#1369). Behavior at the new version is what the real-host jobs prove; a test that a restated version equals the pin proves nothing more.
- Connect the row to the bump (#1371). Each row carries an annotation, and one regex manager in `.github/renovate.json5` reads it, so the row bumps in the same group PR as its pin:

```ts
  {
    host: 'opencode-v2',
    // renovate: datasource=npm depName=@opencode/cli
    version: '2.2.6',
```

```json5
{
  customType: 'regex',
  managerFilePatterns: ['/^src/lib/connect-config\\.ts$/'],
  matchStrings: [
    '//\\s*renovate:\\s*datasource=(?<datasource>\\S+)\\s+depName=(?<depName>\\S+)\\s*\\n\\s*version:\\s*\'(?<currentValue>\\d+\\.\\d+\\.\\d+)\'',
  ],
}
```

The existing `groupName` rules for `opencode-ai`, `@opencode/**` and `@earendil-works/**` put each row in its pin's PR. `postUpgradeTasks` already runs `bun run postupgrade`, which regenerates every surface, so the helper bundle that embeds the table is rebuilt in the same PR. The next v2 bump changed the row and the bundle with no hand edit. The Claude Code row has no package to track and keeps its manual evidence.

The tests for the wiring run the manager's own regex over the real file (`tests/unit/renovate-workflow.test.ts`). They check that it finds exactly the annotated rows, that each captured version equals its table row, and that each package lands in its pin's group. Neither side is a literal, so a bump never breaks them; removing or misnaming an annotation does.

## Related Issues

- #1102, #1121
- #1359, #1369, #1371
