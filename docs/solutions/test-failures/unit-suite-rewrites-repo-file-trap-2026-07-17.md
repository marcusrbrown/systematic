---
title: Unit suite rewrites a committed repo file during verification
date: 2026-07-17
category: test-failures
module: tests/unit/generate-config-reference.test.ts
problem_type: test_failure
component: testing_framework
severity: high
symptoms:
  - A one-line docs fix keeps reverting between commits
  - Reviewer flags the same finding twice; author claims "fixed" while the file shows the old value
  - Committed generated-docs file flips content on every local `bun test tests/unit` run
root_cause: test_isolation
resolution_type: test_fix
tags:
  - test-isolation
  - docs-generator
  - side-effects
  - verification-discipline
---

# Unit suite rewrites a committed repo file during verification

## Problem

The `execMain` error-handling test in
`tests/unit/generate-config-reference.test.ts` invoked the real docs
generator, which defaulted its write target to the repo's committed
`docs/src/content/docs/reference/configuration.mdx` — with a pinned old
version (`2.11.0`). Every unit-suite run silently rewrote the `$schema`
example URL from `v3` back to `v2`.

## Symptoms

On PR #653 this produced a two-round review failure: Fro Bot flagged the
stray `v2` URL; the fix was applied, then the verification suite run
itself reverted it before commit; the "fixed" claim shipped with the
regression intact; Fro Bot flagged it again with proof the commit never
touched the file.

## What Didn't Work

- **Fix the file, then run the suite as verification.** The suite was the
  mutator — verification undid the fix. Any "edit → test → commit" loop
  where a test writes repo files can invert its own result.
- **Trusting a subagent's completion claim.** The fixer reported the edit
  done; the artifact on disk disagreed. Only checking the file caught it.

## Solution

`docs/scripts/generate-config-reference.ts` — `execMain` takes an
injectable target (`execMain(version?, mdxPath = CONFIG_MDX_PATH)`), so
the script path is unchanged while tests redirect the write. The test
copies the real MDX to a temp dir, runs against the copy, and asserts
BOTH directions: the temp copy contains the downgraded URL (generator ran)
and the repo file does not (repo untouched).

```ts
const tmpMdxPath = path.join(tmpDir, 'configuration.mdx')
fs.copyFileSync(realMdxPath, tmpMdxPath)
const exitCode = await mod.execMain('2.11.0', tmpMdxPath)
expect(exitCode).toBe(0)
expect(fs.readFileSync(realMdxPath, 'utf-8')).not.toContain(
  'schemas/v2/systematic-config.schema.json',
)
expect(fs.readFileSync(tmpMdxPath, 'utf-8')).toContain(
  'schemas/v2/systematic-config.schema.json',
)
```

## Why This Works

Verification becomes non-destructive: the suite can run any number of
times without mutating the committed source of truth, and the
repo-file-untouched assertion turns any future regression of this trap
into a test failure instead of a silent flip-flop.

## Prevention

- Tests must never write repo-committed files. Any test invoking a
  generator/CLI main against real paths needs an injectable target plus a
  repo-file-untouched assertion.
- When a fix "doesn't stick," suspect the verification loop itself before
  suspecting the edit — check `git status` after the suite runs.
- Verify claimed fixes by reading the artifact on disk, not by trusting
  the runner's (or a subagent's) completion report.

## Related

- `docs/solutions/integration-issues/workflow-command-prompt-dry-run-integration.md`
  — sibling verification-side-effect trap (dry-run vs mutating runs).
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
  — generator self-write / stale-read boundaries for build-time codegen.
- `docs/solutions/best-practices/auto-generated-install-commands-mdx-pitfalls-2026-06-06.md`
  — docs-generator + MDX unit-testability adjacency.
