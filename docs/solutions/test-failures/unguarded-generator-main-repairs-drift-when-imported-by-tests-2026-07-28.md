---
title: Unguarded generator main() silently repairs drift when imported by its own test
date: 2026-07-28
category: test-failures
module: scripts/generate-agent-browser-skill.ts
problem_type: test_failure
component: testing_framework
severity: high
symptoms:
  - Importing the generator from its unit test executes the write path
  - A `bun test` run silently repairs real drift instead of exposing it
  - The `--check` drift gate passes even though the committed artifact was out of sync
root_cause: test_isolation
resolution_type: code_fix
tags:
  - import-meta-main
  - generator-script
  - test-isolation
  - side-effects
  - drift-masking
  - module-guard
---

# Unguarded generator main() silently repairs drift when imported by its own test

## Problem

A generator script that calls `main()` at module top level (outside any guard) runs its write path whenever the module is imported — including when a test file imports the module's exported helpers. If real drift exists between the committed generated file and the pinned source, importing the generator makes `bun test` silently repair the drift as an import side effect, and the drift check then passes — masking the drift completely.

## Symptoms

- A drift check (`bun run agent-browser:drift`) reports the committed file is out of date.
- Running `bun test` appears to "fix" it — immediately afterward the drift check passes.
- No test asserts a file was written; the mutation is invisible in test output.
- Intermittent by nature: if the generated file already matches, nothing is written and the suite looks clean. Drift is masked _only when it actually exists_ — i.e. exactly when the check matters most.

## What Didn't Work

Adding the generator unit test without an entrypoint guard. The test imports named exports:

```ts
import {
  applyVersionToAttributions,
  normalizeForCompare,
  readPinnedVersion,
  stripHiddenFromFrontmatter,
} from '../../scripts/generate-agent-browser-skill.ts'
```

With `main()` unguarded at module scope, that import ran the full generate path against the real `skills/agent-browser/SKILL.md` and `ATTRIBUTIONS.md`, repairing any drift present. Test suite green, drift check green — a false green across the board.

## Solution

Guard the entrypoint, matching the sibling generators:

```ts
// Before — runs on import:
main()

// After — runs only on direct execution:
if (import.meta.main) {
  main()
}
```

The sibling scripts already carry the guard, one with an explicit comment:

```ts
// scripts/generate-registry.ts
// Only run main() when this file is invoked directly (not when imported by tests).
if (import.meta.main) {
  main(PROJECT_ROOT)
}
```

## Why This Works

`import.meta.main` is `true` only when the file is the direct entry point (`bun scripts/generate-agent-browser-skill.ts`). On import it is `false`, so the guard makes import-time side effects structurally impossible: importing runs only the module-level declarations, never the write path. Direct execution and `--check` still behave normally. This is the correct boundary for any script that has both a library interface (exported pure functions) and an imperative entry point (a `main()` that writes to disk).

## Prevention

**Every codegen script with a runnable `main()` must guard its entrypoint.**

1. If a script exports functions _and_ has a `main()` that writes files, the `main()` call MUST be inside `if (import.meta.main)`.
2. Any script a test imports MUST have zero import-time side effects. A test importing a generator is the tripwire that reveals a missing guard.
3. Keep a real-subprocess `--check` test as the drift tripwire — it exercises the gate without importing the module:

```ts
const result = Bun.spawnSync(
  ['bun', path.join(REPO_ROOT, 'scripts/generate-agent-browser-skill.ts'), '--check'],
  { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
)
expect(result.exitCode).toBe(0)
```

Verification procedure: introduce deliberate drift → run `bun test` → confirm the drift is _not_ repaired → confirm `bun run agent-browser:drift` still exits non-zero → remove the drift. If the test run silently makes the drift check pass, the guard is missing or ineffective.

## Related Issues

- [`unit-suite-rewrites-repo-file-trap-2026-07-17.md`](./unit-suite-rewrites-repo-file-trap-2026-07-17.md) — sibling in the same family (tests mutating committed files). Distinct mechanism: there a test _explicitly invoked_ the generator against the real repo path; here the write is an _import-time side effect_ of a missing guard.
- [`auto-generated-install-commands-mdx-pitfalls-2026-06-06.md`](../best-practices/auto-generated-install-commands-mdx-pitfalls-2026-06-06.md) — documents the same `import.meta.main` guard pattern for a docs generator that ran at module load.
- [`vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md`](../best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md) — the vendoring pattern whose generator this bug was found in.
