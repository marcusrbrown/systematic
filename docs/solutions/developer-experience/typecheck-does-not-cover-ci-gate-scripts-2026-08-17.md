---
title: Typecheck covers src/ only, so every CI gate is unchecked
date: 2026-08-17
category: developer-experience
module: typecheck-boundary
problem_type: developer_experience
component: tooling
severity: high
applies_when:
  - "Refactoring or adding TypeScript anywhere outside src/"
  - "Treating a green `bun run typecheck` as evidence that a change is complete"
  - "Reviewing changes to content-integrity, the registry builder, codegen, the plugin build, or the eval runner"
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

## Context

`tsconfig.json` scopes the compiler to one directory:

```json
"include": ["src/**/*"],
"exclude": ["node_modules", "dist", "lib", ".opencode"]
```

`package.json`'s `typecheck` script is `tsc --noEmit`, which uses that project. Nothing else typechecks TypeScript in this repo.

`scripts/` is not in `include`. It holds eight files, and they are not incidental — they are the machinery that enforces the repository's invariants:

| Script | Enforces |
|---|---|
| `content-integrity.ts` | phantom references, frontmatter contracts, dispatch identifiers, banned patterns |
| `build-registry.ts` | OCX registry, drift detection |
| `generate-config-schema.ts` | JSON Schema codegen + drift |
| `build-claude-code-plugin.ts` | the entire Claude Code bundle |
| `run-evals.ts` | the eval harness |

So the code that gates every other change is the least verified code in the repository.

## Guidance

**A green typecheck is scoped to `include`, and that scope is easy to not know.** Do not read a passing `tsc --noEmit` as "the TypeScript in my change is valid." Read it as "the TypeScript under `src/` is valid."

Verify the real boundary with a probe rather than by reading config. Config can be read wrong; a probe cannot:

```bash
cp scripts/content-integrity.ts /tmp/ci-probe.bak
printf '\nconst probe: number = "definitely not a number"\nthisDoesNotExist()\n' \
  >> scripts/content-integrity.ts

bun run typecheck; echo "exit: $?"

cp /tmp/ci-probe.bak scripts/content-integrity.ts
```

The probe must modify the real file in place. Copying it to `/tmp` and typechecking proves nothing — `/tmp` is outside `include` no matter how the project is configured, so that variant passes whether or not `scripts/` is covered.

Result at time of writing: **exit 0, no diagnostics.** Both a blatant type error and a call to an undefined function are invisible.

Until the boundary changes, the practical substitute for `scripts/` is the unit suite, which imports these modules and will surface a `ReferenceError` at runtime:

```bash
bun test tests/unit
```

**The fix direction is deliberately not prescribed here.** Either extend `include` to cover `scripts/`, or add a second tsconfig for it. There may be a reason `scripts/` was excluded — it was not established when this was written, and assuming there is none is how a config change turns into an afternoon of unrelated errors.

## Why This Matters

The failure mode is not "a type error slipped through." It is that a passing check was read as evidence of something it never covered.

A refactor deleted a helper from `scripts/content-integrity.ts` and left one call site behind. `bun run typecheck` reported clean. That clean result was taken as confirmation the refactor was complete. The unit suite caught it moments later:

```text
ReferenceError: isResolvableDispatchIdentifier is not defined
    at findNearMissAgentStem (scripts/content-integrity.ts:1226:7)
```

An undefined function is the most basic thing a typechecker catches. Getting a green result on one is a strong signal the check is not looking where you think — which is worth more attention than the missed error itself.

## When to Apply

- Before trusting `bun run typecheck` on any change touching `scripts/`.
- When a refactor deletes or renames something used by build tooling. The compiler will not find the orphaned call sites.
- When quoting verification evidence in a PR or commit. "Typecheck clean" is a claim about `src/`, and saying so is more accurate and no longer.
- Whenever a verification command is repo-wide in appearance but config-scoped in fact.

## Examples

**Misleading:**

```text
typecheck clean, so the refactor is complete
```

**Accurate:**

```text
typecheck clean (covers src/ only — tsconfig include is ["src/**/*"]);
scripts/ changes verified by `bun test tests/unit`
```

**Establishing coverage for an unfamiliar repo.** The general form of the probe: introduce an unmissable error in the file you care about, run the check, and confirm it fails. A check you have never seen fail on the file you are changing has not been shown to cover that file.

## Related

- [`docs/solutions/workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md`](../workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md) — the same shape with a different mechanism: there the scope was the filesystem, here it is compiler config. Both produce a green signal narrower than assumed.
- [`docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`](../best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — the general principle: ask what the instrument cannot see before trusting a clean result.
- [`docs/solutions/best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md`](../best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — quoting a verification result is a claim; it inherits the check's real scope.
