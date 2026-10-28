---
title: "Host-contract evidence is CI-owned: nobody re-runs the suite by hand"
module: ".github/workflows/main.yaml host-contract jobs + scripts/host-contract-guard.ts + scripts/lib/opencode-pin.ts"
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
read through `readOpencodeSdkPin()` (`scripts/lib/opencode-pin.ts:196-198`).
`EXPECTED_OPENCODE_VERSION` and `EXACT_OPENCODE_VERSION` are re-exports of that
value, not hand-edited constants (#916).

The host is launched through `bunx opencode-ai@<pin>`, never a bare `opencode`
on `PATH` and never `npx` (#928). `probeOpencodeAvailability()`
(`scripts/lib/opencode-availability.ts:219-299`) runs that launcher with
`--version` under a caller-built, isolated env and classifies the result as
`available`, `mismatch`, or `unavailable` — it never throws and never
memoizes. Every fixture-consuming suite wraps it in a memoizing
`isOpencodeAvailable()` (`tests/integration/fixtures/opencode-host.ts:273`).

The evidence itself is three jobs in `.github/workflows/main.yaml`:

- `host-contract-gate` runs the path filter and exposes its verdict as the
  output `run`.
- `host-contract-shard` is a four-way matrix named `Host Contract shard N/4`.
  Each shard sets `SYSTEMATIC_REQUIRE_OPENCODE=1`, runs
  `bun test tests/integration --shard=N/4
  --timings=tests/integration/host-contract-timings.json` with a JUnit
  reporter, and uploads its report and log.
- `host-contract`, named `Host Contract`, is the aggregator. It always runs
  (`if: always()`) and judges the other two.

`Host Contract` is a required status check in the `main` ruleset and in the
classic branch protection (`.github/settings.yml`), so a red `host-contract`
job blocks the merge of any pull request, including the release PR. For pull
requests the gate filters on `src/**`, `tests/**`, `scripts/**`, `evals/**`,
`skills/**`, `agents/**`, `registry/**`, `package.json`, `bun.lock`, and
`.github/**`, via its "Detect relevant path changes" step. On push to `main`
the suite does not run and the gate reports it as not required: the release
gate reads the check runs on the release PR's head
(`scripts/release/gate-decide.ts`), and the strict up-to-date merge policy
(`.github/settings.yml`) means `main` receives a tree that was already tested.
A Renovate OpenCode-group bump touches `package.json`, so it always triggers
the suite.

## Guidance

**A Renovate OpenCode bump is complete when the required `host-contract` job
is green on that PR. Nothing else re-proves the claim, and nothing else needs
to.** There is no follow-up command to run, no pass count to transcribe into a
doc, and no background process to babysit — the job already did that, against
the exact pin the PR proposes, on a clean checkout.

**Green is evidence only when the suite actually ran.** A skipped required
check reads as passing, so the aggregator always runs, and it states its own
verdict. It fails unless the gate succeeded. When the gate says the suite was
not required (a docs-only PR the path filter excludes, or a push to `main`),
it reports success with a notice. When the suite was required, it fails unless
every shard succeeded; a skipped or cancelled shard is not a pass. A green
check on an unrelated PR is not host evidence; it is the aggregator correctly
declining to require the suite. This never undermines a Renovate OpenCode bump
specifically: the path filter includes `package.json`, which a pin bump always
touches (and `bun.lock`, which it touches in practice), so that PR's
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
- **In CI**, `SYSTEMATIC_REQUIRE_OPENCODE=1` is set only by the
  `host-contract-shard` jobs. Every fixture-consuming suite calls `requireOpencodeAvailable()`
  (`scripts/lib/opencode-availability.ts:345-354`) at module scope right after
  `isOpencodeAvailable()`. When the classification is not `available`, that
  call throws — a module-scope throw fails the file to load, Bun reports it as
  a suite error, that shard goes red, the aggregator goes red with it, and the
  required `Host Contract` check blocks the merge. There is no path where a missing host quietly skips in CI.

That module-scope throw covers a missing or mismatched host, but not a
narrower failure: a single `test.skipIf(...)` inside an otherwise-loaded file
skipping for an unrelated reason while the job still reports green. The
aggregator's "Guard skipped tests and pass floor" step closes that gap by
running `scripts/host-contract-guard.ts`, a standalone, unit-tested script
(extracted from an inline heredoc in #949) — not YAML. The step runs under
`!cancelled()`, so a failed shard still gets its diagnosis. It reads all four
shards' reports and logs as alternating `<junit> <log>` arguments and merges
them with `mergeEvidence()`: the union of produced files, every skipped case,
and the summed pass count. A shard whose log has no `<N> pass` line makes the
sum unknown, which fails as `no-pass-line`, and a missing or unreadable shard
report is a violation of its own. The guard parses the JUnit output
(`parseJUnitXml()`) and fails the job — `evaluate()` returns one or more
violations, and the script's CLI wrapper exits non-zero — on any of five
independent conditions over the merged evidence:

1. `missing-files` — a known integration test file (the fifteen listed in
   `scripts/host-contract-guard.ts`'s `EXPECTED_SUITE_FILES`) produced no
   `<testsuite>` entry in any shard, meaning `bun test` never actually ran it.
2. `unexpected-skips` — a skipped test case is outside the exempt set.
3. `missing-exempt-skips` — a known-exempt case did **not** skip. The
   exempt set (`scripts/host-contract-guard.ts`'s `EXEMPT_SKIPS`, today
   exactly one entry: the mixed-version test, which stays opt-in because
   running it would put a fetch of a published `@fro.bot/systematic` release
   on the path that gates publishing the next one) is bidirectional: it both
   permits that skip and asserts it happens. A future change that enables
   the mixed-version test without pruning the exempt set trips this branch
   instead of silently passing.
4. `no-pass-line` — no `<N> pass` summary line could be parsed from a shard's
   captured log. This fails independently of the floor below; a sum with an
   unreadable term never reaches the floor comparison.
5. `below-pass-floor` — the summed pass count is below
   `scripts/host-contract-guard.ts`'s `PASS_FLOOR = 120`.

The combination — module-scope throw for "no host at all", five-way merged
guard for every shape of "host present but the run didn't actually cover
what it claims to" — is why "green with everything skipped" is not a
reachable state for this job. The bidirectional exempt check (condition 3)
makes that stronger than a permission list would: it is not enough for an
unexpected skip to be absent, the one expected skip must also be present, so
an exempt-set entry that silently stops applying is itself a red job.
Widening the exempt set or lowering the floor means editing
`scripts/host-contract-guard.ts`, a reviewed diff with its own unit tests
(`tests/unit/host-contract-guard.test.ts`), not a silent loosening.

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
  inherit fail-closed behavior, its file name needs adding to
  `EXPECTED_SUITE_FILES`, and the file belongs in a refreshed timings file.
  Regenerate it locally with `bun test tests/integration
  --timings=tests/integration/host-contract-timings.json --update-timings`
  (with `SYSTEMATIC_REQUIRE_OPENCODE=1`, on an idle machine); CI never writes
  it.
- Shard times drifting apart — one shard running well past the others means
  the committed timings no longer match the suite; refresh them the same way.

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

Open the Renovate PR, wait for `Host Contract` to report a conclusion. Green
means the bump is proven at the new pin; red means the guard, the
module-scope throw, or a real test assertion caught something, and the PR is
not ready to merge until it is fixed.

## Related

- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](version-pinned-evidence-must-be-reproven-2026-08-16.md) — superseded by this doc; the invariant it stated survives, the manual mechanism it prescribed does not.
- [`docs/solutions/integration-issues/availability-guards-must-check-executability-2026-08-16.md`](../integration-issues/availability-guards-must-check-executability-2026-08-16.md) — the same "report the real underlying condition, not a proxy" discipline `probeOpencodeAvailability()` follows.
- `docs/plans/2026-09-04-001-refactor-ci-owned-host-contract-suite-plan.md` — the plan that shipped this mechanism across Units 1-5.
- PRs: #916 (pin from `package.json`), #928 (bunx launcher + availability gate), #930 (scripted provider replaces hosted model), #931 (required `host-contract` job), #932/#933/#936 (real-host fixes the job caught), #1161 (four timed shards behind an always-running aggregator).
