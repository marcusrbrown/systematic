---
title: An unlistable external search root reported "empty" on Linux while the macOS test passed
date: 2026-11-03
category: logic-errors
module: search-core
problem_type: logic_error
component: tooling
symptoms:
  - "Linux CI: runSearch kind external > prints an unreadable root as a quiet state got 'empty: no readable records.' instead of 'unreadable: root could not be read.'"
  - "Linux CI: the parity test counted 'config unreadable' twice where it expected one; macOS counted one"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [search, external-sources, platform-divergence, chmod, realpath, ci, bun, test-stubbing]
---

# An unlistable external search root reported "empty" on Linux while the macOS test passed

## Problem
An external search source whose root exists but cannot be listed was reported as `empty` on Linux, not `unreadable`. The test for it passed on macOS only because `realpathSync` failed there first. A second test passed on macOS only because a long temp path changed where a warning was cut.

## Symptoms
- On `ubuntu-24.04`, `tests/unit/search-core.test.ts:1423` ("prints an unreadable root as a quiet state") saw `empty`. It passed on macOS.
- On the same runner, the parity test expected one `config unreadable` match and got two. It passed on macOS.

## What Didn't Work
- Running the suite on macOS. Both tests were green there.
- Reproducing as root. `tests/unit/search-core.test.ts:1424` returns early for uid 0, so the repro needs a non-root user and a Node binary.

## Solution
The walk sets `found.rootUnreadable` when the walked directory itself cannot be listed, and discovery returns `unreadable` for it (`src/lib/search-corpus.ts:690-695`). A test that stubs `readdirSync` to throw EACCES runs that branch on every platform (`tests/unit/search-corpus.test.ts:383-413`). The parity test counts `Notes:` lines, not the raw phrase (`tests/unit/search-adapters-parity.test.ts:120-122`).

## Why This Works
Under Bun on macOS, `realpathSync` on a mode-0 directory fails with EACCES; under Node, and under Bun on Linux, it succeeds. The tests run under Bun. On macOS the early `realpath` failure gave `unreadable`. Before the fix, the Linux walk reached the failing root listing and emitted `could not read directory <label>`, but discovery still returned `found`, so the source looked empty. Now the state comes from the listing (`src/lib/search-corpus.ts:459-461`, `found.rootUnreadable`), which fails the same way everywhere.

A warning can also contain `config unreadable`, and warnings are capped at 200 characters. It embeds a temp path whose length differs by platform, so a raw substring count can change between platforms. The `Notes:` line is fixed text; see the test comment (`tests/unit/search-adapters-parity.test.ts:1208-1209`).

## Prevention
- If the platform decides which branch a test reaches, stub the failing call so the branch runs everywhere.
- Don't count substrings of text that embeds a path and has a length cap. Assert on a structural unit such as a line prefix.
- When CI fails and local passes, reproduce on the CI platform as a non-root user.

## Related Issues
- [Match filesystem safety evidence to the operation being guarded](../best-practices/match-filesystem-safety-evidence-to-the-operation-2026-09-10.md)
