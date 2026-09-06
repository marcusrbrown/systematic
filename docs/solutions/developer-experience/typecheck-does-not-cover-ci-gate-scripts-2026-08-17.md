---
title: Typecheck covers src/ only, so every CI gate is unchecked
date: 2026-08-17
category: developer-experience
module: typecheck-boundary
problem_type: developer_experience
component: tooling
severity: high
applies_when:
  - "Treating a green `bun run typecheck` as evidence a whole change is complete"
  - "Reviewing changes to content-integrity, the registry builder, codegen, the plugin build, or the eval runner"
  - "Refactoring or adding TypeScript anywhere outside src/ that only the tests/ backlog still covers loosely"
  - "Deciding what a verification command actually proves before quoting it"
tags:
  - typescript
  - typecheck
  - tsconfig
  - ci-gates
  - scripts
  - false-green
---

# Typecheck covers src/ only, so every CI gate is unchecked

## Current State (as of PR #914)

The gap this doc originally reported — `scripts/` typechecking nothing — is
closed. Three tiers now exist:

```bash
bun run typecheck          # tsconfig.json — src/**/* only. Required in CI.
bun run typecheck:scripts  # tsconfig.scripts.json — adds scripts/, docs/scripts/. Required in CI.
bun run typecheck:all      # tsconfig.tests.json — adds tests/. Advisory only (continue-on-error), tracked in #897.
```

`typecheck:scripts` is the one that matters for this doc's original claim:
the eight files under `scripts/` — `content-integrity.ts`, `build-registry.ts`,
`generate-config-schema.ts`, `build-claude-code-plugin.ts`, `run-evals.ts`,
and others — are now typechecked and gate every PR. The probe below, run
against this state, confirms it: injecting a type error and an undefined
function into `scripts/content-integrity.ts` now fails `bun run
typecheck:scripts` with `TS2322` and `TS2304` — it no longer passes silently.

**The gap moved, it did not close entirely.** `tests/` (343 errors across 30
files at the time `typecheck:all` was added) is covered only by the advisory
tier, which reports but does not block. A type error introduced in a test
file today still produces a fully green *required* CI run — the same failure
mode this doc documents, just narrower in scope. Read the rest of this doc
with `tests/` substituted for `scripts/` wherever it discusses the boundary
that isn't enforced.

`docs/scripts/**/*` is typechecked by `typecheck:scripts` under the root
`tsconfig.json`'s module settings, but `docs/scripts/` is also inside the
`docs/` Astro workspace, which has its own `docs/tsconfig.json` (extends
`astro/tsconfigs/strict`, defines a `@/*` path alias `typecheck:scripts` does
not resolve). A docs script that starts depending on that alias or an
Astro-specific type would pass `bun run docs:build` while still failing the
required root-level gate — the inverse direction of this doc's original
finding, and worth knowing before assuming "docs build passed" says anything
about `typecheck:scripts`.

## Context (historical — the state before PR #914)

`tsconfig.json` scoped the compiler to one directory:

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist", "lib", ".opencode"]
```

`package.json`'s `typecheck` script was `tsc --noEmit`, which used that
project, and at the time nothing else typechecked TypeScript in this repo.

`scripts/` was not in `include`. It held eight files, and they were not
incidental — they are the machinery that enforces the repository's
invariants:

| Script | Enforces |
|---|---|
| `content-integrity.ts` | phantom references, frontmatter contracts, dispatch identifiers, banned patterns |
| `build-registry.ts` | OCX registry, drift detection |
| `generate-config-schema.ts` | JSON Schema codegen + drift |
| `build-claude-code-plugin.ts` | the entire Claude Code bundle |
| `run-evals.ts` | the eval harness |

So the code that gated every other change was, at the time, the least
verified code in the repository. `typecheck:scripts` (added in PR #914,
tracked under #897) is the fix.

## Guidance

**A green `bun run typecheck` is scoped to `src/**/*`, and that scope is easy
to not know.** Do not read a passing `tsc --noEmit` as "the TypeScript in my
change is valid." Read it as "the TypeScript under `src/` is valid" — and
separately check whether `typecheck:scripts` (required) or only
`typecheck:all` (advisory) covered the rest of what you touched. A red
`typecheck:all` is real signal; it just does not block merges until #897's
`tests/` burn-down completes.

Verify a boundary claim with a probe rather than by reading config. Config
can be read wrong; a probe cannot:

```bash
cp scripts/content-integrity.ts /tmp/ci-probe.bak
printf '\nconst probe: number = "definitely not a number"\nthisDoesNotExist()\n' \
  >> scripts/content-integrity.ts

bun run typecheck; echo "exit: $?"
bun run typecheck:scripts; echo "exit: $?"

cp /tmp/ci-probe.bak scripts/content-integrity.ts
```

The probe must modify the real file in place. Copying it to `/tmp` and
typechecking proves nothing — `/tmp` is outside every `include` no matter how
the project is configured, so that variant passes whether or not `scripts/`
is covered.

**Result as of PR #914:** `bun run typecheck` still exits 0 (it only ever
covered `src/`, unchanged) — but `bun run typecheck:scripts` now exits 1 with
`TS2322: Type 'string' is not assignable to type 'number'` and `TS2304:
Cannot find name 'thisDoesNotExist'`. The same probe run against a `tests/`
file would still exit 0 on every *required* gate, because `tests/` is only
covered by the advisory `typecheck:all`. That is today's live instance of
this doc's lesson.

Until `tests/` is fully covered by a required gate, the practical substitute
for it is the unit suite, which imports these modules and will surface a
`ReferenceError` at runtime:

```bash
bun test tests/unit
```

## Why This Matters

The failure mode is not "a type error slipped through." It is that a passing
check was read as evidence of something it never covered.

A refactor deleted a helper from `scripts/content-integrity.ts` and left one
call site behind. `bun run typecheck` reported clean. That clean result was
taken as confirmation the refactor was complete. The unit suite caught it
moments later:

```text
ReferenceError: isResolvableDispatchIdentifier is not defined
    at findNearMissAgentStem (scripts/content-integrity.ts:1226:7)
```

An undefined function is the most basic thing a typechecker catches. Getting
a green result on one is a strong signal the check is not looking where you
think — which is worth more attention than the missed error itself. That
specific incident is closed by `typecheck:scripts`; the general risk is not
closed until every tree with production-relevant TypeScript is covered by a
required gate.

## When to Apply

- Before trusting `bun run typecheck` or `bun run typecheck:scripts` on any
  change touching `tests/` — neither is required to have seen it.
- When a refactor deletes or renames something used by build tooling or test
  helpers. A required gate will not find orphaned call sites outside its
  `include`.
- When quoting verification evidence in a PR or commit. "Typecheck clean" is
  a claim about `src/`; "`typecheck:scripts` clean" adds `scripts/` and
  `docs/scripts/`; neither says anything about `tests/`. Say which one ran.
- Whenever a verification command is repo-wide in appearance but
  config-scoped in fact.

## Examples

**Misleading:**

```text
typecheck clean, so the refactor is complete
```

**Accurate:**

```text
typecheck clean (src/ only) and typecheck:scripts clean (adds scripts/,
docs/scripts/); tests/ changes verified by `bun test tests/unit`, not by a
required typecheck
```

**Establishing coverage for an unfamiliar repo.** The general form of the
probe: introduce an unmissable error in the file you care about, run the
check, and confirm it fails. A check you have never seen fail on the file
you are changing has not been shown to cover that file.

## Related

- [`docs/solutions/workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md`](../workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md) — the same shape with a different mechanism: there the scope was the filesystem, here it is compiler config. Both produce a green signal narrower than assumed.
- [`docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — the general principle: ask what the instrument cannot see before trusting a clean result.
- [`docs/solutions/best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md`](../best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — quoting a verification result is a claim; it inherits the check's real scope.
