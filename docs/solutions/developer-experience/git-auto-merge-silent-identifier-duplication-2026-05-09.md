---
title: Git auto-merge silently duplicates test setup/teardown identifiers
date: 2026-05-09
category: developer-experience
module: testing-infrastructure
problem_type: developer_experience
component: testing_framework
severity: high
applies_when:
  - Rebasing a feature branch onto main when both branches added or modified test setup/teardown
  - Resolving merge conflicts that auto-merge cleanly with no visible markers
  - Verifying a rebase before push when the only check is `grep -E '<<<<<<< |======='`
related_components:
  - development_workflow
  - tooling
tags: [git, rebase, auto-merge, testing, conflict-resolution, false-positive]
---

# Git auto-merge silently duplicates test setup/teardown identifiers

## Context

During the PR #345 rebase onto current `main`, git's 3-way merge auto-merged
`tests/integration/opencode.test.ts` with **zero conflict markers reported** —
the conflict-marker grep returned clean and the file was staged automatically.
The merge nevertheless produced four redundancies inside the same describe
block:

- duplicate `let originalHomedir: typeof os.homedir` declarations (lines 107
  and 110)
- duplicate `originalHomedir = os.homedir` assignments inside `beforeEach`
- conflicting `os.homedir = () => ...` reassignments — one pointing at a real
  `homeDir` directory created by `fs.mkdirSync`, the other pointing at a
  sibling path (`path.join(tempDir, 'home')`) that was **never created**
- duplicate `os.homedir = originalHomedir` restore in `afterEach`

This survived the conflict-marker check and was only caught when TypeScript's
duplicate-declaration error emitted at test load time.

The mechanism: PR #346 (already in `main`) and PR #345 (the branch being
rebased) **independently added the same hoisted `let originalHomedir`
declaration plus its associated assignment/restore pattern** at slightly
different positions inside the same `describe` block. Each side's hunk anchored
on different surrounding lines, so git's diff3 fell back to "additive merge" —
both blocks were inserted and considered resolved.

## Guidance

When rebasing or merging branches that both touched test scaffolding (`describe`
bodies, `beforeEach`/`afterEach` hooks, fixture builders, mock setup), do not
trust a clean conflict-marker grep alone. Run a second verification pass that
checks for **duplicate identifier declarations** in the auto-merged hunks.

```sh
# After rebase/merge, before push, for any test file the merge touched:
git diff main -- tests/ | grep -E '^\+ *let ' | sort | uniq -d
# Any output here means the same identifier is being declared in multiple
# places inside the same scope (or scopes that share TS lexical declaration
# rules). Inspect those locations manually.
```

For Bun/Vitest-style tests, also add a scope check for duplicate `os.homedir =`
or other module-mock reassignments that should appear exactly once per
beforeEach:

```sh
git show HEAD:tests/integration/opencode.test.ts | \
  awk '/beforeEach\(/,/}\)/' | grep -c 'os.homedir = '
# Expect exactly 1 (or your project's known count). >1 means duplicated.
```

Treat the canonical `bun run typecheck` and `bun test` commands as the actual
merge gate — never skip them after a non-trivial rebase, even when the rebase
"completed cleanly."

## Why This Matters

- **Conflict markers are necessary but not sufficient evidence of correctness.**
  Git marks conflicts when its merge algorithm cannot decide, but it can decide
  *incorrectly* and produce code that compiles in some languages and crashes
  at load time in others.
- **Test scaffolding is a high-incidence area for this failure mode.** Setup
  hooks accumulate hoisted state (`let foo: T`) and reassignment patterns
  (`originalFoo = foo; foo = mock`) that are very likely to be added by
  multiple PRs in parallel during active development. Two PRs landing the same
  isolation pattern within hours of each other is the worst case.
- **The TypeScript error caught it; a JS-only project might not have.** The
  redundant assignments are syntactically valid JS — they would silently shadow
  earlier values and break the assumption that `originalFoo` holds the real
  module's pre-mock value, leaking mocks across tests.
- **Lint rules like `noRedeclare` would flag this too** if enabled with
  `--max-diagnostics` high enough. Biome flagged it but only after exhausting
  the default warning cap.

## When to Apply

- Any rebase of a feature branch onto a `main` that has merged a PR which
  modified the same test file
- Any merge that auto-resolves test setup/teardown hunks
- Fast-iteration windows where multiple PRs ship in the same day touching
  shared infrastructure

## Examples

### Before (broken auto-merge — both blocks survived)

```ts
describe('SystematicPlugin config hook integration', () => {
  let tempDir: string
  let originalHomedir: typeof os.homedir   // ← from PR #346 (main)
  let projectDir: string
  let homeDir: string
  let originalHomedir: typeof os.homedir   // ← from PR #345 (rebased branch)
                                            //   TS: redeclared identifier

  beforeEach(() => {
    _resetPluginSingleton()
    originalHomedir = os.homedir            // ← from PR #346
    tempDir = fs.mkdtempSync(...)
    homeDir = path.join(tempDir, 'fake-home')
    fs.mkdirSync(homeDir, { recursive: true })
    originalHomedir = os.homedir            // ← from PR #345 (duplicate)
    os.homedir = () => homeDir              // ← from PR #346 — points at real dir
    projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    os.homedir = () => path.join(tempDir, 'home')  // ← from PR #345 —
                                                    //   points at uncreated sibling
  })

  afterEach(() => {
    os.homedir = originalHomedir            // ← from PR #346
    _resetPluginSingleton()
    delete process.env.OPENCODE_CONFIG_DIR
    os.homedir = originalHomedir            // ← from PR #345 (duplicate)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})
```

### After (resolved by keeping the fully-realized side)

```ts
describe('SystematicPlugin config hook integration', () => {
  let tempDir: string
  let projectDir: string
  let homeDir: string
  let originalHomedir: typeof os.homedir

  beforeEach(() => {
    _resetPluginSingleton()
    originalHomedir = os.homedir
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))

    homeDir = path.join(tempDir, 'fake-home')
    fs.mkdirSync(homeDir, { recursive: true })
    os.homedir = () => homeDir

    projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    os.homedir = originalHomedir
    _resetPluginSingleton()
    delete process.env.OPENCODE_CONFIG_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})
```

The resolution rule: when both sides add structurally similar hooks, prefer the
side whose effects are **fully realized** — here, the `homeDir` variant whose
`fs.mkdirSync` actually creates the directory `os.homedir` returns.

### Verification command from the rebase that caught this

```sh
# This is what flagged the issue, after `git rebase --continue` reported
# "Successfully rebased":
bun test tests/integration/opencode.test.ts -t 'config hook' 2>&1 | head -20
# error: "originalHomedir" has already been declared
#     at tests/integration/opencode.test.ts:110:7
# note: "originalHomedir" was originally declared here
#    at tests/integration/opencode.test.ts:107:7
```

The duplicate-declaration error is the canary. If your test files emit one
after a rebase, this is almost always the cause.

## Related

- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-2026-04-17.md`
  — sibling pattern: a separate verification pass that uses the *same broken
  iteration* as the conversion will fail in lockstep. Always verify with a
  *different* mechanism than the one you used to apply the change.
- PR #345 (squash 1eecfb0) — the rebase where this was first observed and fixed
- PR #346 (squash 7e4cb92) — the main-side commit that introduced the
  competing test isolation block
