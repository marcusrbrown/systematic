---
title: "Host-contract evidence is CI-owned: nobody re-runs the suite by hand"
module: ".github/workflows/main.yaml host-contract job + scripts/lib/opencode-pin.ts"
date: 2026-09-04
problem_type: workflow_issue
component: testing_framework
severity: medium
tags:
  - renovate
  - opencode-ai
  - bunx
  - host-contract
  - skip-vs-fail
  - systematic-require-opencode
  - ci-gate
  - evidence-pin
applies_when:
  - "Renovate opens an OpenCode devDependency (@opencode-ai/sdk / @opencode-ai/plugin) bump PR"
  - "Deciding whether a pin bump needs a manual suite re-run before merge"
  - "An OpenCode-gated integration test skips unexpectedly and the job still looks green"
  - "Reviewing whether host-coverage evidence for a claim is still valid at the current pin"
---

# Host-contract evidence is CI-owned: nobody re-runs the suite by hand

## Context

[`version-pinned-evidence-must-be-reproven-2026-08-16.md`](version-pinned-evidence-must-be-reproven-2026-08-16.md)
established the invariant this doc keeps: evidence gathered against one pinned
OpenCode version is not evidence at another. That invariant survives unchanged.
What it prescribed as the *mechanism* — a human bumping the pin, then manually
running `bun test tests/integration/eval-runner.test.ts tests/integration/eval-artifact.test.ts
tests/integration/eval-fixture.test.ts` as a tracked background process and
recording the pass count in a doc — no longer exists. It was replaced by a
required CI job across four PRs: #916, #928, #930, #931 (plus three real-host
fixes the job itself caught: #932, #933, #936).

The pin now lives in exactly one place: the `@opencode-ai/sdk` /
`@opencode-ai/plugin` devDependencies in `package.json` (`package.json:100-101`),
read through `readOpencodeSdkPin()` (`scripts/lib/opencode-pin.ts:120-125`).
`EXPECTED_OPENCODE_VERSION` and `EXACT_OPENCODE_VERSION` are re-exports of that
value, not hand-edited constants (#916).

The host is launched through `bunx opencode-ai@<pin>`, never a bare `opencode`
on `PATH` and never `npx` (#928). `probeOpencodeAvailability()`
(`scripts/lib/opencode-availability.ts:109-183`) runs that launcher with
`--version` under a caller-built, isolated env and classifies the result as
`available`, `mismatch`, or `unavailable` — it never throws and never
memoizes. Every fixture-consuming suite wraps it in a memoizing
`isOpencodeAvailable()` (`tests/integration/fixtures/receipt-workflow-host.ts:199`).

The evidence itself is the required `host-contract` job in
`.github/workflows/main.yaml:162-407`. It sets
`SYSTEMATIC_REQUIRE_OPENCODE=1` (`.github/workflows/main.yaml:244`) and runs
`bun test tests/integration` with a JUnit reporter
(`.github/workflows/main.yaml:247-249`). `host-contract` is a required entry
in the `release` job's `needs` (`.github/workflows/main.yaml:475`), so a red
`host-contract` job blocks release the same way a red `test` or `typecheck`
job does. For pull requests the job is path-gated on `src/**`, `tests/**`,
`scripts/**`, `evals/**`, `skills/**`, `agents/**`, `registry/**`,
`package.json`, `bun.lock`, and the workflow file itself
(`.github/workflows/main.yaml:182-192`); on push to `main` it always runs. A
Renovate OpenCode-group bump touches `package.json`, so it always triggers the
job.

## Guidance

**A Renovate OpenCode bump is complete when the required `host-contract` job
is green on that PR. Nothing else re-proves the claim, and nothing else needs
to.** There is no follow-up command to run, no pass count to transcribe into a
doc, and no background process to babysit — the job already did that, against
the exact pin the PR proposes, on a clean checkout.

**Green is evidence only when the suite actually ran.** The job has no
top-level `if:` — gating happens per step, at
`.github/workflows/main.yaml:198-216` — so on a PR the path filter excludes
(docs-only, registry-only, etc.) every gated step is skipped and the job
still reports success. A green check on an unrelated PR is not host
evidence; it is the job correctly declining to run. This never undermines a
Renovate OpenCode bump specifically: the filter at
`.github/workflows/main.yaml:182-192` includes `package.json` and
`bun.lock`, both of which a pin bump always touches, so that PR's
`host-contract` green always means the suite ran. The qualifier matters for
any other PR whose green check might be mistaken for host coverage.

### Skip-vs-fail is the mechanism that makes this safe

The same fail-closed/fail-open split applies in both environments, but the
consequence differs by design:

- **Locally**, a missing or version-mismatched `bunx opencode-ai@<pin>` is a
  **named skip**. `isOpencodeAvailable()` returns `false`,
  `describe.skipIf(!isOpencodeAvailable())` skips the suite, and the skip
  reason names the classification and captured stderr
  (`opencodeAvailabilityReason()`). `bun test tests/unit` and the required
  `test` job never spawn the launcher at all, so nothing about local
  development requires a live host.
- **In CI**, `SYSTEMATIC_REQUIRE_OPENCODE=1` is set only by the `host-contract`
  job. Every fixture-consuming suite calls `requireOpencodeAvailable()`
  (`scripts/lib/opencode-availability.ts:192-201`) at module scope right after
  `isOpencodeAvailable()`. When the classification is not `available`, that
  call throws — a module-scope throw fails the file to load, Bun reports it as
  a suite error, the `host-contract` job goes red, and `release` is blocked by
  its `needs`. There is no path where a missing host quietly skips in CI.

That module-scope throw covers a missing or mismatched host, but not a
narrower failure: a single `test.skipIf(...)` inside an otherwise-loaded file
skipping for an unrelated reason while the job still reports green. The guard
step at `.github/workflows/main.yaml:259-397` closes that gap. It parses the
JUnit output and fails the job (`failed = true`, then `process.exit(1)`) on
any of five independent conditions:

1. `missingFiles.length > 0` — a known integration test file (the eleven
   listed in `EXPECTED_SUITE_FILES`, `.github/workflows/main.yaml:282-294`)
   produced no `<testsuite>` entry at all, meaning `bun test` never actually
   ran it.
2. `unexpected.length > 0` — a skipped test case is outside the exempt set.
3. `missingExempt.length > 0` — a known-exempt case did **not** skip. The
   exempt set (`.github/workflows/main.yaml:269-274`, today exactly one
   entry: the mixed-version test, which stays opt-in because running it
   would put a fetch of a published `@fro.bot/systematic` release on the
   path that gates publishing the next one) is bidirectional: it both
   permits that skip and asserts it happens. A future change that enables
   the mixed-version test without pruning the exempt set trips this branch
   instead of silently passing.
4. `!lastPassMatch` — no `<N> pass` summary line could be parsed from the
   captured log at all. This fails independently of the floor below; a log
   with zero parseable summary lines never reaches the floor comparison.
5. `passCount < PASS_FLOOR` — the parsed pass count is below
   `PASS_FLOOR = 120` (`.github/workflows/main.yaml:303`).

The combination — module-scope throw for "no host at all", five-way JUnit
guard for every shape of "host present but the run didn't actually cover
what it claims to" — is why "green with everything skipped" is not a
reachable state for this job. The bidirectional exempt check (condition 3)
makes that stronger than a permission list would: it is not enough for an
unexpected skip to be absent, the one expected skip must also be present, so
an exempt-set entry that silently stops applying is itself a red job.
Widening the exempt set or lowering the floor means editing the guard script
inline in the workflow, which is a reviewed diff, not a silent loosening.

## Why This Matters

The prior mechanism asked a person to notice a version bump, remember the
three-file command, run it as a tracked background process (the suite ran
long enough that the agent harness's ~7-minute foreground timeout couldn't
hold it), and transcribe a pass count into a doc by hand. Every one of those
steps could be forgotten or done against a stale checkout without anything
turning red. The new mechanism removes the person from the loop entirely: the
job runs on the PR that proposes the bump, against the exact proposed pin, on
a fresh checkout, and its own guard — not a human reading a summary line —
decides whether the count and skip set are acceptable.

The four PRs that shipped this surfaced three failure modes that only a real
host, not a mock, could catch: `opencode run` hanging on stdin EOF under
`bunx` (#932, fixed with `stdio: 'ignore'`), `process.emit('SIGINT', ...)`
reaching the test runner's own process instead of only the child under test
(#933), and the launcher's reported pid differing from the in-process pid
under `bunx` on Linux — because `bunx` execs in place on macOS but not
uniformly on Linux (#936). None of these would have been caught by a suite
that mocked the host, and none of them would have been caught by a person
running the old three-file command from memory instead of from a job
definition that pins the exact environment.

## When to Apply

- Reviewing a Renovate `OpenCode` group PR and deciding whether it is safe to
  merge.
- Writing or reviewing a doc that claims OpenCode host coverage at a specific
  version — check that the claim points at a `host-contract` job run, not at
  a hand-run command.
- An integration test unexpectedly skips in CI and `host-contract` is still
  green — that should not happen; if it does, the guard step or its exempt
  set is the first thing to inspect.
- Adding a new suite that reaches a real OpenCode host — it needs its own
  module-scope `isOpencodeAvailable()` + `requireOpencodeAvailable()` pair to
  inherit fail-closed behavior, and its file name needs adding to
  `EXPECTED_SUITE_FILES`.

## Examples

### Wrong: treat a pin bump like the old doc still describes

```bash
# Superseded — do not do this as the recovery for a Renovate OpenCode bump.
bun test tests/integration/eval-runner.test.ts \
         tests/integration/eval-artifact.test.ts \
         tests/integration/eval-fixture.test.ts
# ...then hand-transcribe "N pass" into a doc.
```

This suite no longer exists in this shape (Unit 3 deleted the no-op
host-version matrix test and replaced the hosted-model path with a scripted
provider), and even if it did, running it by hand duplicates work the
required job already does on every relevant PR.

### Right: let the required job be the evidence

Open the Renovate PR, wait for `host-contract` to report a conclusion. Green
means the bump is proven at the new pin; red means the guard, the
module-scope throw, or a real test assertion caught something, and the PR is
not ready to merge until it is fixed.

## Related

- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](version-pinned-evidence-must-be-reproven-2026-08-16.md) — superseded by this doc; the invariant it stated survives, the manual mechanism it prescribed does not.
- [`docs/solutions/integration-issues/availability-guards-must-check-executability-2026-08-16.md`](../integration-issues/availability-guards-must-check-executability-2026-08-16.md) — the same "report the real underlying condition, not a proxy" discipline `probeOpencodeAvailability()` follows.
- `docs/plans/2026-09-04-001-refactor-ci-owned-host-contract-suite-plan.md` — the plan that shipped this mechanism across Units 1-5.
- PRs: #916 (pin from `package.json`), #928 (bunx launcher + availability gate), #930 (scripted provider replaces hosted model), #931 (required `host-contract` job), #932/#933/#936 (real-host fixes the job caught).
