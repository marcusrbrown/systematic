---
title: A duplicated literal is a registration point nobody documented
module: scripts/run-evals.ts + tests/integration/eval-runner.test.ts
date: 2026-08-16
problem_type: test_failure
component: testing_framework
severity: medium
tags:
  - evals
  - fixture-drift
  - registration-points
  - integration-tests
  - duplicated-literal
symptoms:
  - Unit suite passes 1798/0 while the integration suite fails two tests
  - '`direct CLI argument errors are one concise JSON object` fails with a one-line diff'
  - The `--help` assertion fails on text that looks correct in the source
root_cause: missing_workflow_step
resolution_type: test_fix
---

# A duplicated literal is a registration point nobody documented

## Problem

Registering a new case in the eval runner has four documented touch points in `scripts/run-evals.ts`: `CASE_IDS`, `CASE_ASSERTIONS`, `CLI_USAGE`, and `parseCaseManifest`. All four were updated. The unit suite passed 1798/0. The integration suite then failed two tests.

There was a fifth touch point, and nothing named it: `tests/integration/eval-runner.test.ts` holds a hand-maintained verbatim copy of the runner's help text as `EXPECTED_CLI_HELP` and asserts stderr equals it exactly.

## Symptoms

```
(fail) local OpenCode eval runner > direct CLI argument errors are one concise JSON object
  Expected  - 1
  Received  + 1
  at tests/integration/eval-runner.test.ts:2065:40
```

The unit suite stayed green throughout. Only the integration suite, which spawns the runner as a subprocess and compares real stderr, saw the mismatch.

## What Didn't Work

Following the documented registration list. It was complete and correct, and it was not sufficient. The four points live in the source module; the fifth lives in a test file, holds a copy of one of them, and is reachable only by reading the test.

Trusting the unit suite as a proxy for "the change is wired up." Unit tests import the runner's constants, so they agree with the source by construction. The duplicate can only disagree with something that observes the runner from outside.

## Solution

Update the copy. The change is one line — adding the new case id to the `--case <id>` line — and the useful part is the check that proves the two agree:

```bash
diff <(sed -n '38,49p' tests/integration/eval-runner.test.ts) \
     <(sed -n '754,765p' scripts/run-evals.ts)
```

Empty output means they match.

## Why This Works

The test asserts an exact string equality against a literal it owns. There is no import, no generation step, and no shared constant between the two, so nothing detects divergence until the assertion runs. Restoring equality restores the contract the test was written to enforce.

## Prevention

The obvious fix is to import `CLI_USAGE` into the test. Resist it, or at least price it honestly: the test would then assert the runner matches itself, which passes unconditionally and proves nothing. The duplication is what gives the assertion its value — it is an independent statement of what the CLI should print.

The real options, in order of preference:

| Option | Cost | What it buys |
|---|---|---|
| Keep the duplicate, add an explicit drift check | One CI step or unit test running the `diff` above | Independent assertion preserved, divergence caught immediately |
| Generate the fixture from the source at build time | Build wiring | No drift, but the assertion weakens toward tautology |
| Import the constant | Free | Nothing. The test stops testing the text |

When a duplicate must exist for independence, the duplication itself deserves a named guard. Otherwise the second copy is a registration point that only failure will teach you about.

More generally: when a change has a documented list of touch points, the list describes the module, not the repository. Grep the full tree for a distinctive fragment of whatever you edited before believing the list is complete.

```bash
# Before trusting a registration list, look for copies of what you just changed
rg --fixed-strings 'Repeatable: bootstrap-loading' -- . 
```

## Related

- [`docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md) — same family: a mechanical gate passed while the real artifact differed
- [`docs/solutions/test-failures/unit-suite-rewrites-repo-file-trap-2026-07-17.md`](unit-suite-rewrites-repo-file-trap-2026-07-17.md) — another case where the unit suite's view diverged from reality
- PR #790 — where this surfaced
