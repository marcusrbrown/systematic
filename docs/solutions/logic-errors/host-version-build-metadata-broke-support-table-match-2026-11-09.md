---
title: A host-printed version can carry build metadata, so normalize it before comparing to a support table
date: 2026-11-09
category: logic-errors
module: host-support-table
problem_type: logic_error
component: tooling
symptoms:
  - "A host that printed 1.19.5+harness.bf7f7dfe was reported as an unlisted version, although the support table lists 1.19.5"
  - "In headless mode begin answered unsupported-host with hostSupport unlisted; in interactive mode it asked for consent"
  - "The headless run only passed because the live model happened to drop the +harness suffix before sending the version"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - semver
  - build-metadata
  - version-gate
  - support-table
  - host-version
---

# A host-printed version can carry build metadata, so normalize it before comparing to a support table

## Problem

`ce:connect` asks the host for its version, sends the printed token to the helper, and the helper looks the pair up in `HOST_SUPPORT_TABLE`. The lookup compared the raw string to the table. A fork build of OpenCode prints `1.19.5+harness.bf7f7dfe`. Under SemVer everything after `+` is build metadata and does not change which release a build is, but a strict string match saw a different version and refused the host.

## Symptoms

- `checkHostSupport('opencode-v1', '1.19.5+harness.bf7f7dfe')` returned `{ supported: false, reason: 'unlisted' }` against a table listing `1.19.5`.
- Headless `begin` replied `unsupported-host` with `hostSupport: "unlisted"` (`src/ce-connect-helper.ts:888-904`, `gateHost`). Interactive mode returned `consent-required` and a warning that the tool limits "have not been verified".
- A headless run on the real host passed anyway, because the model stripped the suffix on its own. The check was passing by luck, not by design.

## What Didn't Work

Two traps to avoid, not recorded attempts:

- **Relying on the model to trim the version.** The skill already says to send the printed token exactly. Letting the model decide what to strip makes the gate depend on model behavior, which is what the table exists to avoid.
- **Stripping every suffix.** Keep prerelease tags such as `-rc.1`: they change the release, and cutting at the first `-` would let `1.19.5-rc.1` match `1.19.5`, which was never observed.

## Solution

Normalize in the helper, on both sides of the comparison. `normalizeVersion` trims, drops one leading `v`, cuts everything from the first `+`, and returns `undefined` when nothing is left (`src/lib/connect-config.ts:613-625`). `checkHostSupport` normalizes the observed version and each table row's version before comparing (`src/lib/connect-config.ts:632-649`).

```ts
// Before (strict match on the printed string):
//   candidate.version === version
// After:
const observed = normalizeVersion(version)
// ...
normalizeVersion(candidate.version) === observed
```

The skill keeps its rule to send the first digit-leading token exactly as printed, with any `-` prerelease tag or `+` build suffix, and not to trim or round anything (`skills/ce-connect/SKILL.md:65`).

## Why This Works

SemVer says build metadata is ignored for precedence, so `1.19.5+harness.bf7f7dfe` and `1.19.5` are the same release. A prerelease tag is part of the version and stays, so `1.19.5-rc.1` remains unlisted. Doing the cut in the helper means the answer no longer depends on what the model chooses to send.

## Prevention

- Pin both directions in tests. `tests/unit/connect-config.test.ts:797-846` (the `build metadata` block) asserts that `9999.19.5+harness.bf7f7dfe`, a leading `v` and surrounding whitespace match; that `9999.19.5-rc.1`, `9999.19.5-rc.1+build.7` and `9999.19.6+build.1` do not; that `+`, `+abc` and ` +harness ` have no version and are `unobserved`; and that the shipped v1 row matches its own pinned version with the fork suffix.
- When a gate compares a host-printed string, decide what counts as the same release before writing the comparison, and test the real printed form (`claude --version` prints `2.1.319 (Claude Code)`, so the skill sends only `2.1.319`).
- Known residual: because build metadata is ignored, any fork build of a pinned core version counts as supported. The support row records an observation on one build; a fork that changes the permission code under the same core version is not distinguished.

## Related Issues

- [Support a host only after an observed deny](../best-practices/support-a-host-only-after-an-observed-deny-2026-11-09.md): the table this comparison feeds.
