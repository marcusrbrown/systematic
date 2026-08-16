---
title: Version-pinned evidence must be re-proven when the pinned runtime moves
module: scripts/run-evals.ts + eval host pin
date: 2026-08-16
problem_type: workflow_issue
component: testing_framework
severity: medium
tags:
  - evals
  - version-pinning
  - drift-guard
  - opencode-host
  - test-evidence
applies_when:
  - A test asserts an external runtime version pin
  - Recorded evidence depends on that runtime's own behavior rather than on this repo's code
  - A dependency bump lands on main while a PR carrying version-dependent evidence is open
---

# Version-pinned evidence must be re-proven when the pinned runtime moves

## Context

Some claims in this repository are only true relative to a specific external runtime version. The clearest case is host skill discovery: Systematic can delete its own bootstrap skill catalog *because* OpenCode renders an equivalent catalog itself. That is not a property of Systematic's code — it is a property of the OpenCode build being run against. Change the build, and the evidence is no longer evidence.

`tests/unit/eval-contract.test.ts` guards the pins:

```ts
// EXPECTED_OPENCODE_VERSION  (scripts/run-evals.ts)
// EXACT_OPENCODE_VERSION     (tests/integration/fixtures/receipt-workflow-host.ts)
// must both equal the @opencode-ai/sdk devDependency, and
// @opencode-ai/sdk must equal @opencode-ai/plugin.
```

Its failure message is deliberately more than a diff report:

> `OpenCode host pin drift: <name> is <pin>, but package.json devDependencies @opencode-ai/sdk and @opencode-ai/plugin are <version>. Change <name> to <version>, then re-run the host-coverage eval before relying on bootstrap catalog deletion evidence.`

## Guidance

**Treat the version pin and the evidence gathered at that version as a single unit. When the pin moves, the evidence is invalidated until it is collected again at the new version. Bumping the constant to make the guard pass, without re-running the suite, converts a real gate into a rubber stamp.**

The sequence when a pinned runtime moves:

1. Bump every pin in lockstep — `EXPECTED_OPENCODE_VERSION`, `EXACT_OPENCODE_VERSION`, and the `@opencode-ai/sdk` / `@opencode-ai/plugin` devDependencies must all agree.
2. Re-run the version-dependent suite against the real host:

   ```bash
   bun test tests/integration/eval-runner.test.ts \
            tests/integration/eval-artifact.test.ts \
            tests/integration/eval-fixture.test.ts
   ```

3. Record the result at the new version. Only a fresh pass supports the claim.

That suite takes roughly 15 minutes. The agent harness kills foreground shell commands at about 7 minutes, so run it as a tracked background process and watch for completion rather than blocking a foreground call.

When writing a new pin guard, put the required follow-up action in the assertion message. A guard that says "these two numbers disagree" invites the minimal edit that silences it. A guard that says "change the pin, *then re-run X before relying on Y*" tells the next reader that the number was never the point.

## Why This Matters

This fired for real, mid-PR. PR #786 introduced the drift guard and collected its host-coverage evidence at OpenCode 1.18.17. While it was open, `main` merged #787, bumping `@opencode-ai/plugin` and `@opencode-ai/sdk` to 1.18.18. Updating the branch immediately failed the branch's own guard.

The cheap response — bump two constants, push, merge — would have shipped a deletion justified entirely by a measurement taken against a build no longer in use. Nothing would have failed. The suite would have been green. The claim would simply have been unproven.

Instead both pins moved to 1.18.18 and the real-host suite was re-run there: 51 pass, 0 fail, 328 assertions, 878 seconds. The host still covered every bundled skill at the new version, so the deletion stayed justified — this time with evidence that matched the runtime.

The guard is worth having precisely because it is inconvenient at exactly the right moment. It converts a silent staleness problem into a loud failing test.

## When to Apply

- A constant in the repo names an external runtime, SDK, CLI, or host version
- A test or documented claim depends on how that external thing behaves, not on how this repo's code behaves
- A dependency bump lands while a PR carrying such evidence is open
- Renovate opens a version-bump PR touching a pinned runtime — the bump and the re-proof belong in the same PR

## Examples

### Wrong: satisfy the guard, keep the old result

```diff
-export const EXPECTED_OPENCODE_VERSION = '1.18.17' as const
+export const EXPECTED_OPENCODE_VERSION = '1.18.18' as const
```

Tests pass. The host-coverage claim still rests on a 1.18.17 observation. The guard has been converted into a formality.

### Right: move the pin and re-collect the evidence

```diff
-export const EXPECTED_OPENCODE_VERSION = '1.18.17' as const
+export const EXPECTED_OPENCODE_VERSION = '1.18.18' as const
```

```diff
-export const EXACT_OPENCODE_VERSION = '1.18.17'
+export const EXACT_OPENCODE_VERSION = '1.18.18'
```

```bash
bun test tests/integration/eval-runner.test.ts \
         tests/integration/eval-artifact.test.ts \
         tests/integration/eval-fixture.test.ts
# 51 pass, 0 fail, 328 expect() calls
```

### Write the follow-up into the guard itself

```ts
throw new Error(
  `OpenCode host pin drift: ${name} is ${pin}, but package.json devDependencies ` +
  `@opencode-ai/sdk and @opencode-ai/plugin are ${sdkVersion}. Change ${name} to ` +
  `${sdkVersion}, then re-run the host-coverage eval before relying on bootstrap ` +
  `catalog deletion evidence.`,
)
```

The instruction is the load-bearing part. The comparison only detects drift; the message is what prevents the drift from being papered over.

## Related

- [`docs/solutions/best-practices/pi-real-runtime-integration-harness-2026-07-16.md`](../best-practices/pi-real-runtime-integration-harness-2026-07-16.md) — real-runtime verification over mocked approximations
- [`docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md`](../best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md) — contract tests across harnesses
- `ARCHITECTURE.md` — records the `host-skill-coverage` eval case as a standing gate to re-run on every pinned-runtime change
- PR #786 / #787 — where the guard fired and the evidence was re-collected
