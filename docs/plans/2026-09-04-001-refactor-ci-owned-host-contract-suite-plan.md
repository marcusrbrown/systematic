---
title: "refactor: Make the OpenCode host-contract suite CI-owned with a single version pin"
type: refactor
status: active
date: 2026-09-04
deepened: 2026-09-04
---

# refactor: Make the OpenCode host-contract suite CI-owned with a single version pin

## Overview

The OpenCode-dependent integration tests become CI-authoritative and locally best-effort. One version pin in `package.json` replaces the four-way lockstep; every OpenCode host is launched through `bunx opencode-ai@<pin>` so nothing needs to be installed on a developer machine or in CI; the one test that prompts a hosted model moves onto the scripted local provider the rest of the suite already uses; and the documented "re-prove locally per bump" rule is retired. The evidence that the plugin loads on the pinned host is produced by a required CI job, not by a person.

### Contributor experience after this lands

- `bun test tests/integration` online: the OpenCode suites run against `bunx opencode-ai@<pin>`. The first run downloads the launcher and one platform binary (about 150 MB) into Bun's cache; later runs start in under a second. Nothing is installed on PATH and the contributor's own `opencode`, if any, is never used.
- Offline or cache-cold: every OpenCode suite skips with one named reason (`bunx opencode-ai@<pin> --version` failed, with the captured stderr); `pi.test.ts`, `claude-code.test.ts`, and the synthetic eval-runner tests still run. A local skip is informational only — CI is the authority.
- Today, by contrast, the suite runs only if a contributor has installed the exact pinned version themselves, and a version bump asks them to re-run it for 15–17 minutes and paste the result.

### Keeping the suite versus dropping it

The alternative on the table was deleting the OpenCode-dependent suites and keeping unit coverage only. The suite stays because what it catches is "the published plugin does not load or misbehaves on the pinned host": the config hook crashing on an invalid color (a real v2.7.x incident), the packaged tarball loading differently from source, two registrations of the same plugin not converging, question and receipt shapes the guard depends on. Those surface after publish if nothing runs them. The price is about 15 minutes of runner time on code-bearing PRs and on the release path. The signal to revisit: if the job never turns red on an OpenCode bump over a sustained period, the coverage is not paying for its wall time and this decision should be reopened.

## Problem Frame

The suite under `tests/integration/` that spawns OpenCode, plus `scripts/eval-cases/opencode.ts` and the four manifests under `evals/cases/opencode/`, are harness-contract tests. They assert that the plugin loads, the config hook merges agents and skills without crashing, `systematic_skill` registers, `experimental.chat.system.transform` output carries the bootstrap and the host-rendered skill catalog, the question API produces the expected event shapes, and receipt markers survive a host restart. Every session/prompt test runs against a local scripted OpenAI-compatible server with dummy keys; no assertion checks model prose. Exactly one test (`tests/integration/opencode.test.ts`, the source/dist local group) runs `opencode run --model opencode/big-pickle`, a hosted model, and depends on it choosing to call `systematic_skill`.

None of this runs in CI. `.github/workflows/main.yaml` runs `bun test tests/unit` only. The only automated effect of the version pin is `tests/unit/eval-contract.test.ts` (the OpenCode host pin check), which fails the unit suite whenever `package.json` disagrees with two hand-edited constants — `EXPECTED_OPENCODE_VERSION` in `scripts/run-evals.ts` and `EXACT_OPENCODE_VERSION` in `tests/integration/fixtures/receipt-workflow-host.ts`. That turns every Renovate OpenCode bump red by construction, and the documented recovery (`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`) is a 15–17 minute local run that requires a specific OpenCode version on the developer's machine. The maintainer manages OpenCode through a separate `harness` CLI and does not use that version. The evidence the ritual produces is exactly what a CI job would produce for free.

Two adjacent facts shaped the design. `mise.toml` prepends `./node_modules/.bin` to PATH, so adding `opencode-ai` as a devDependency would shadow the maintainer's own binary — rejected. And `bunx opencode-ai@1.18.28 --version` resolves and runs the pinned launcher in 36 s cold with no install, so an exact pin can be honored everywhere without touching PATH.

## Requirements Trace

- R1. The OpenCode version is read from `package.json` at runtime — the `@opencode-ai/sdk` devDependency is the canonical value and `@opencode-ai/plugin` is held equal to it. No hand-maintained copy of the version exists anywhere in `scripts/` or `tests/`.
- R2. Every OpenCode host the suite launches is `bunx opencode-ai@<pin>`; no `npx`, no PATH lookup of `opencode`, no devDependency on the launcher.
- R3. A CI job runs the OpenCode-dependent integration suite on pull requests that can change the outcome, and the `release` job cannot publish without it passing.
- R4. In CI, an unavailable or wrong-version host is a failure, never a skip. Locally, it is a skip with a named reason.
- R5. No test in the suite depends on a hosted model or on network access beyond fetching the pinned launcher.
- R6. A Renovate bump of the `OpenCode` group requires no human step for the suite to run at the new version.
- R7. The retired local re-run rule is superseded in `docs/solutions/` and its citations are corrected.

## Scope Boundaries

- The suite's assertions change in exactly two deliberate places: the hosted-model trigger in `tests/integration/opencode.test.ts` becomes a scripted one (the assertions on the result are unchanged, but the real-model path is no longer exercised anywhere — by design, since the suite tests the harness, not a model), and the `HOST_VERSIONS` log-only test is deleted. Everything else keeps its assertions; this plan changes how the host is launched, how the pin is read, and where the suite runs.
- `evals/`, "grade", "assertion ID", and the eval-runner vocabulary are not renamed.
- The receipt-workflow host process-group reaping is PR #896 and lands before this work; this plan assumes it.
- OpenCode `1.18.28` is the pin the first implementation lands on (superseding Renovate PR #880), but choosing the version is not part of the design.

### Deferred to Separate Tasks

- Renaming `evals/` and its grading vocabulary to host-contract terms: future iteration, after this lands and the naming can be judged against the CI job.
- A cache step for the `bunx` download in CI: only if the measured cold cost on the runner is material (see Deferred to Implementation).

## Context & Research

### Relevant Code and Patterns

- `tests/integration/fixtures/receipt-workflow-host.ts` — `OPENCODE_AVAILABLE` gate, `startOpencodeServer` / `startExactOpencodeServer` (the exact-version spawn currently uses `npx --yes opencode-ai@${EXACT_OPENCODE_VERSION}`), `runOpencode`, `buildChildEnv` and its env allowlist, the HOME/XDG redirection every child inherits.
- `scripts/eval-cases/opencode.ts` — `startOpencodeHost` (`npx --yes opencode-ai@${EXPECTED_OPENCODE_VERSION} serve`), `startMockModelServer` (the scripted OpenAI-compatible provider with dummy keys), `observePromptComposition`.
- `scripts/run-evals.ts` — `EXPECTED_OPENCODE_VERSION`, `verifyExactOpencodeRuntime` (probes `npx --yes opencode-ai@<pin> --version` and classifies available/mismatch/unavailable), the result envelope's `identity.opencodeVersion` / `identity.opencodeBuildId`.
- `tests/unit/eval-contract.test.ts` — the four-way host pin check being retired.
- `tests/integration/eval-runner.test.ts` — `countEvalServeProcesses` matches `ps` lines on `opencode-ai@${EXPECTED_OPENCODE_VERSION}` and `serve`; the `EXPECTED_CLI_HELP` duplicate of the runner's help text.
- `tests/integration/opencode.test.ts` — the `describe.skipIf(!OPENCODE_AVAILABLE)` source/dist group that runs `opencode run --model opencode/big-pickle`; the packaged-plugin group; `test.skipIf(!DIST_LOCAL_AVAILABLE)` as the named-skip pattern.
- `tests/integration/question-attestation-opencode.test.ts` — the scripted provider wiring (`u6-question` provider/model IDs) to mirror for the big-pickle replacement.
- `tests/integration/receipt-workflow-guard-real-host.test.ts` — `HOST_VERSIONS` matrix and the hardcoded `'1.18.5'` cells.
- `.github/workflows/main.yaml` — job conventions (Bun + Node 24 setup, `bun install --frozen-lockfile`, per-job `timeout-minutes`, the `release` job's `needs` list).
- `.github/renovate.json5` — `@opencode-ai/**` is already grouped as `OpenCode`; `postUpgradeTasks` runs `bun install`, `bun run fix`, `bun run postupgrade`.
- `mise.toml` — `_.path = ["./node_modules/.bin"]`.

### Institutional Learnings

- `docs/solutions/best-practices/vendor-npm-packaged-skill-as-generated-artifact-2026-07-28.md` — the direct prior art: an exact pin in `package.json` as the single source of truth, no `npx`, Renovate-tracked, CI-gated. This plan applies the same shape to a runtime rather than an asset.
- `docs/solutions/integration-issues/availability-guards-must-check-executability-2026-08-16.md` — gate optional real-host suites on a successful trivial invocation, never on `which`; include captured stderr in the skip reason.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — live harness tests verify the current checkout, isolate HOME/XDG/config together, forward env through an allowlist, and treat host exit 0 as saying nothing about plugin hooks.
- `docs/solutions/test-failures/duplicated-cli-help-fixture-is-a-hidden-registration-point-2026-08-16.md` — a copied literal is an independent contract; if it must exist, guard it explicitly.
- `docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md` — when retiring a gate, enumerate every field it observed and make sure the replacement observes them all.
- `docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md` — the rule being superseded. Its invariant (evidence is only valid at the pin it was gathered at) survives; its mechanism (a human re-runs it) does not.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "tests/, scripts/, .github/",
  "freshness": {
    "vcs_reference": "00c87ce475a70232847c5047fd2d59a5217371a7"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "tests/integration/fixtures/receipt-workflow-host.ts:startExactOpencodeServer",
      "description": "Spawns a pinned OpenCode host for fixture-backed integration tests; resolves the launcher through npx --yes opencode-ai@<version>.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/integration/fixtures/receipt-workflow-host.ts:OPENCODE_AVAILABLE",
      "description": "Gates the OpenCode integration suites on a host being present.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/eval-cases/opencode.ts:startOpencodeHost",
      "description": "Starts the eval host via npx --yes opencode-ai@<EXPECTED_OPENCODE_VERSION> serve and records runtime availability.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/run-evals.ts:verifyExactOpencodeRuntime",
      "description": "Probes the pinned OpenCode version and classifies available/mismatch/unavailable.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/eval-contract.test.ts:OpenCode host pin check",
      "description": "Enforces the four-way version lockstep between package.json and the two hard-coded runtime pins.",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **The pin is `package.json`, read at runtime.** One small helper reads `devDependencies['@opencode-ai/sdk']` from the repository's `package.json` and exports it; both former constants become re-exports of that value. Rationale: Renovate already edits `package.json`; a derived value cannot drift. Two devDependencies still exist because both packages are consumed, so the lockstep unit test shrinks to the one assertion that still guards something — `@opencode-ai/sdk` equals `@opencode-ai/plugin`. Renovate's existing `OpenCode` group bumps both in one PR, so the equality check is a backstop for manual edits, not a routine gate.
- **`bunx opencode-ai@<pin>` is the only launcher, everywhere.** Rationale: it honors an exact pin with no install step, so CI needs no setup and a developer machine needs nothing on PATH. It is also the reason a devDependency was rejected: `mise.toml` puts `node_modules/.bin` on PATH and a bundled `opencode` would shadow the maintainer's own. `bunx` matches the project's Bun toolchain; `npx` is removed from every spawn site. The launcher-chain orphan risk this keeps is what PR #896's process-group reaping addresses.
- **One probe, two outcomes.** A single module-scope probe runs `bunx opencode-ai@<pin> --version` under the same isolated HOME/XDG the fixture children get, with a bounded timeout. Success means the reported version equals the pin. Anywhere else, the suites skip with a named reason that includes the status and captured stderr. When `SYSTEMATIC_REQUIRE_OPENCODE=1` (set only by the CI job), the same probe failure throws at module scope, so a green CI run can never be a run of zero tests. Rationale: `availability-guards-must-check-executability` plus the flow analysis's silent-skip finding.
- **The host-contract job is a required predecessor of `release`, and runs unconditionally on every push to `main`.** Rationale: the failure it catches is "the published plugin does not load on the pinned host", which is precisely what must never ship. The suite is hermetic (scripted provider, dummy keys), so the cost is wall time — roughly 15 minutes on the `main` push before publish — not flakiness. Path-gating applies only to pull requests and only at step level: the job always completes and reports a status, so it can be a required check. It must never be skipped at job level, because a `needs` dependency that is skipped skips `release` too — a docs-only push that should publish a patch would silently publish nothing. The fail-closed property rests on three things the workflow owns and a PR cannot alter: `SYSTEMATIC_REQUIRE_OPENCODE=1` is set in the workflow's `env` (a pull request, including one from a fork, cannot change the workflow that runs against it); the job is in `release`'s `needs`; and the job asserts after the run that no OpenCode suite reported the fixture's skip reason. A local skip is never authoritative.
- **The `1.18.3/4/5` matrix test is deleted.** Its only assertion is that each cell's status is `pass` or `blocked`, which cannot fail; it costs up to 36 minutes and three launcher downloads of old versions. The `'1.18.5'` cells in the same file use the pin. This is the one test removal in the plan and it removes no coverage.
- **The hosted-model test moves to the scripted provider.** `opencode/big-pickle` is free but is a real network model whose choice to call `systematic_skill` is the only nondeterministic step in the suite. The scripted provider emits that tool call deterministically, matching how every other prompt test already works.
- **`bun test tests/integration` runs whole.** The non-OpenCode files (`pi.test.ts`, `claude-code.test.ts`, `eval-fixture.test.ts`) are hermetic and fast; running the directory keeps the job definition to one line and gives those files CI coverage they do not have today.

## Open Questions

### Resolved During Planning

- Should OpenCode be a devDependency so `bun install` supplies it? No — `mise.toml` puts `node_modules/.bin` on PATH and it would shadow the maintainer's harness-managed binary.
- Should CI install OpenCode globally and fixtures use PATH? No — `bunx` with an exact pin gives one code path for CI and local with no install and no PATH dependence.
- Does the `HOST_VERSIONS` matrix conflict with a single pin? No — the test cannot fail and is deleted.
- Is a Renovate rule needed? No — `@opencode-ai/**` is already grouped as `OpenCode`, and derived constants need no `postUpgradeTasks` step.
- Does the `bunx` launcher work with an exact version? Yes — measured: `bunx opencode-ai@1.18.28 --version` printed `1.18.28`, 36 s cold, no stray processes.
- Does `countEvalServeProcesses` still match after the launcher change? Yes — measured: a `bunx opencode-ai@1.18.28 serve` host's `ps` command line is `<bunx cache dir>/bunx-<uid>-opencode-ai@1.18.28/node_modules/.bin/opencode serve --port 0`, which contains both `opencode-ai@<pin>` and `serve`. `bunx` execs the binary directly, so the host is a single process with no launcher grandchild at steady state.

### Deferred to Implementation

- Cold `bunx` cost on the CI runner and whether a cache step (Bun's install cache directory) is worth adding: measure on the first job run before deciding.
- The exact per-job `timeout-minutes` after deleting the matrix test: derive from a measured run, not from summing the per-test timeout ceilings.

## Implementation Units

- [ ] **Unit 1: Derive the OpenCode pin from `package.json`**

**Goal:** One readable source of the pinned OpenCode version, with the two former constants and the lockstep test reduced to it.

**Requirements:** R1, R6

**Dependencies:** None

**Files:**
- Create: `scripts/lib/opencode-pin.ts`
- Modify: `scripts/run-evals.ts` (`EXPECTED_OPENCODE_VERSION`), `tests/integration/fixtures/receipt-workflow-host.ts` (`EXACT_OPENCODE_VERSION`), `tests/unit/eval-contract.test.ts` (host pin check)
- Test: `tests/unit/opencode-pin.test.ts`

**Approach:**
- The helper reads the repository `package.json` (path resolved relative to the module, not `cwd`), returns `devDependencies['@opencode-ai/sdk']` as an exact semver string, and throws a clear error if the field is missing or not an exact version (a range would silently break "exact pin" semantics).
- `EXPECTED_OPENCODE_VERSION` and `EXACT_OPENCODE_VERSION` stay exported under their current names as re-exports, so every existing importer keeps working; the literal `'1.18.21'` disappears from both files.
- The host pin check keeps one assertion — `@opencode-ai/sdk` equals `@opencode-ai/plugin` — and drops the two constant comparisons, since those values are now the same field.
- Check whether `scripts/lib/` carries a registration surface (a README or table listing its modules); if it does, add the new module there.

**Patterns to follow:**
- `scripts/lib/` sibling helpers consumed by `scripts/run-evals.ts` for module placement and import style.
- `docs/solutions/test-failures/duplicated-cli-help-fixture-is-a-hidden-registration-point-2026-08-16.md` for why the remaining sdk/plugin equality check stays rather than being dropped.

**Test scenarios:**
- Happy path: helper returns the exact string in `package.json` for `@opencode-ai/sdk`.
- Error path: a `package.json` (temp copy) whose sdk entry is a range (`^1.18.0`) makes the helper throw with a message naming the field.
- Error path: a `package.json` missing the sdk entry makes the helper throw.
- Integration: `EXPECTED_OPENCODE_VERSION` and `EXACT_OPENCODE_VERSION` both equal the helper's value, and `tests/unit/eval-contract.test.ts` still fails when sdk and plugin devDependencies disagree (prove by a temp `package.json` fixture, not by editing the real one).

**Verification:**
- No literal OpenCode version remains in `scripts/` or `tests/` other than through the helper (a grep for the current pin finds only `package.json`, `bun.lock`, and historical docs).
- Unit suite green.

- [ ] **Unit 2: Launch every OpenCode host through `bunx opencode-ai@<pin>`**

**Goal:** Remove `npx` and PATH lookup from all three spawn sites; make the availability probe executable-based and version-checked with skip-or-fail semantics.

**Requirements:** R2, R4

**Dependencies:** Unit 1; PR #896 merged (process-group reaping)

**Files:**
- Modify: `tests/integration/fixtures/receipt-workflow-host.ts` (`OPENCODE_AVAILABLE`, `startOpencodeServer`, `startExactOpencodeServer`, `runOpencode`), `scripts/eval-cases/opencode.ts` (`startOpencodeHost`), `scripts/run-evals.ts` (`verifyExactOpencodeRuntime`)
- Modify: `tests/integration/eval-runner.test.ts` (`countEvalServeProcesses` if the command line changes)
- Test: `tests/unit/opencode-availability.test.ts` (probe classification, fake launcher), existing integration suites as consumers

**Approach:**
- Every spawn of an OpenCode host or command becomes `bunx` with `opencode-ai@<pin>` as the first argument, followed by the existing OpenCode arguments. `startOpencodeServer` and `startExactOpencodeServer` collapse to one path since "exact" is now the only mode; keep both names exported if callers differ, or fold and update callers.
- The probe: run `bunx opencode-ai@<pin> --version` once at module scope under the fixture's isolated HOME/XDG env (built through the existing allowlist helper), with a bounded timeout generous enough for a cold download on CI. Classify: `available` when exit 0 and stdout equals the pin; `mismatch` when exit 0 and stdout differs; `unavailable` otherwise (with status/signal and up to a few hundred characters of stderr). The isolation is of config, cache, and data directories, not execution containment: the probe and the hosts run a downloaded binary with the checkout readable, exactly as the `npx` path did. No repository write path is provided to them; the fixture's existing repo-untouched assertions remain the check.
- `OPENCODE_AVAILABLE` stays a boolean for the existing `describe.skipIf` sites, plus an exported reason string. Every `skipIf` site's description or a `console.warn` at module scope carries the reason so a skipped local run is legible.
- When `process.env.SYSTEMATIC_REQUIRE_OPENCODE === '1'` and the classification is not `available`, throw at module scope with the reason. This is the CI fail-closed path.
- `verifyExactOpencodeRuntime` in the eval runner reuses the same classification rather than keeping its own `npx` probe.
- `runOpencode` (used for `opencode run` and `opencode debug config`) goes through the same launcher.

**Patterns to follow:**
- `docs/solutions/integration-issues/availability-guards-must-check-executability-2026-08-16.md`
- The env allowlist in `buildChildEnv` for the probe's environment.
- `test.skipIf(!DIST_LOCAL_AVAILABLE)` in `tests/integration/opencode.test.ts` for named optional coverage.

**Test scenarios:**
- Happy path: probe with a fake launcher printing the pin → `available`, suites run.
- Edge case: fake launcher printing a different version → `mismatch`; locally the suites skip and the reason names both versions; with `SYSTEMATIC_REQUIRE_OPENCODE=1` the module throws.
- Error path: fake launcher exiting non-zero with stderr → `unavailable`; the reason contains the stderr excerpt; with the CI flag set the module throws.
- Edge case: fake launcher hanging past the timeout → `unavailable` with a timeout reason, no lingering process (the group reaping from #896 applies).
- Integration: a real host started through `bunx` reaches the same URL-ready state the current `npx` path did, and `stop()` leaves no `opencode` process (verified by process listing after the suite).

**Verification:**
- `npx` no longer appears in `scripts/` or `tests/` outside historical docs.
- A local run with no network and an empty Bun cache skips every OpenCode suite with a readable reason and runs everything else.
- The eval runner's result envelope still records `identity.opencodeVersion` equal to the pin.

- [ ] **Unit 3: Put the hosted-model test on the scripted provider and delete the no-op matrix**

**Goal:** Remove the suite's only network model dependency and its only unfalsifiable test.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify: `tests/integration/opencode.test.ts` (source/dist local group), `tests/integration/receipt-workflow-guard-real-host.test.ts`
- Test: the modified files are the tests

**Approach:**
- In `opencode.test.ts`, the group that runs `opencode run --model opencode/big-pickle` starts the scripted provider (mirroring `question-attestation-opencode.test.ts`'s provider/model wiring) with a response script that emits the `systematic_skill` tool call the assertions look for, then a short completion. The assertions themselves — plugin loaded, tool registered, skill output present, env isolation, repo `.opencode` untouched — do not change.
- In `receipt-workflow-guard-real-host.test.ts`, delete the "reports each exact host version cell independently" test and the `HOST_VERSIONS` constant; replace the literal `'1.18.5'` in the remaining cells with the pin.

**Patterns to follow:**
- `startMockModelServer` in `scripts/eval-cases/opencode.ts` and the `u6-question` provider config in `question-attestation-opencode.test.ts`.

**Test scenarios:**
- Happy path: the source-local test passes with the scripted provider and no network; the tool-invocation assertions hold on the scripted tool call.
- Error path: if the scripted response omits the tool call, the test fails on the tool-registration assertion (proves the assertion is still live, not vacuous).
- Edge case: the packed-runtime cell in the real-host file runs at the pin and still asserts `mint` in marker kinds.

**Verification:**
- No `--model opencode/` string remains in `tests/`.
- No test in `tests/integration/` has an assertion that admits every outcome.

- [ ] **Unit 4: Add the `host-contract` CI job**

**Goal:** Run the integration suite in CI on the PRs that can change its outcome, fail closed, and gate release on it.

**Requirements:** R3, R4, R6

**Dependencies:** Units 1–3

**Files:**
- Modify: `.github/workflows/main.yaml`
- Test expectation: none — workflow change; proven by the job running on this plan's own PR.

**Approach:**
- New job `host-contract`: `ubuntu-latest`, same Bun and Node 24 setup as the `test` job, `bun install --frozen-lockfile`, then `bun test tests/integration` with `SYSTEMATIC_REQUIRE_OPENCODE=1` in `env`. `timeout-minutes` set from a measured run plus headroom.
- Path gating, pull requests only: a `paths-filter` step decides whether the PR touches `src/`, `tests/`, `scripts/`, `evals/`, `package.json`, `bun.lock`, or the workflow file, and the install/test steps are conditioned on its output. The job itself has no `if:` — it always runs to completion and reports a status. On `push` to `main` the filter step is bypassed and the suite always runs, so `release` (which `needs` this job) is never skipped and never publishes without a host-contract result from the same run.
- Add the job to the `release` job's `needs`.
- After the test step, a guard step fails the job if the captured output contains the fixture's named skip reason for any OpenCode suite, so a green job is never a run in which those suites were skipped.
- Upload the test log as an artifact on failure so a host that dies on startup is diagnosable without re-running.
- No secrets and no elevated permissions: the job inherits the workflow-level `contents: read` token and declares nothing else; the scripted provider uses dummy keys that are never real credentials.

**Patterns to follow:**
- The existing `test` and `docs` jobs in `main.yaml` for setup steps, caching, and `timeout-minutes` placement.

**Verification:**
- On this plan's PR the job runs, every OpenCode suite executes (not skipped), and the job is green.
- A deliberate break (for example, a wrong pin in a throwaway commit) turns the job red rather than green-with-skips; revert before merge.
- `release` lists `host-contract` in `needs`.

- [ ] **Unit 5: Supersede the local re-run rule and correct its citations**

**Goal:** `docs/solutions/` says what is true after this lands.

**Requirements:** R7

**Dependencies:** Unit 4

**Files:**
- Create: `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`
- Modify: `docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md` (superseded pointer), and the citing passages in `docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`, `docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md`, `docs/solutions/workflow-issues/a-capability-that-works-has-not-named-its-cause-2026-08-24.md`, `docs/solutions/workflow-issues/fail-closed-components-report-their-own-state-2026-08-23.md`, `docs/solutions/workflow-issues/clean-checkout-baselines-before-quoting-metrics-2026-08-17.md`
- Test expectation: none — documentation; `bun scripts/content-integrity.ts` and the compound frontmatter schema are the gates.

**Approach:**
- The new doc keeps the surviving invariant (evidence is only valid at the pin it was gathered at) and replaces the mechanism: the pin is `package.json`, the host is `bunx`, the evidence is the `host-contract` job, and a Renovate bump is complete when that job is green. Index it by symptom (`renovate`, `opencode-ai`, `bunx`, `host-contract`, `skip-vs-fail`) per `docs/solutions/documentation-gaps/index-learnings-by-symptom-not-only-by-lesson-2026-08-23.md`.
- The old doc gets a superseded note at the top pointing to the new one; its body stays as history.
- Each of the five citing docs is read at the cited line; where the citation is used to justify a manual re-run, the sentence is corrected; where it is used for the invariant, it is retargeted to the new doc.

**Verification:**
- Content-integrity clean; frontmatter validates against the compound schema (`applies_when` ≤ 5, `tags` ≤ 8).
- No doc in `docs/solutions/` instructs a manual re-run of the OpenCode suite as the recovery for a pin bump.

## System-Wide Impact

- **Interaction graph:** Every OpenCode integration suite, both eval entry points (`runSourceEval` / `runInstalledEval`), the CLI's runtime-identity probe, and the `release` job's `needs` list.
- **Error propagation:** Locally, a host problem becomes a named skip. In CI it becomes a module-scope throw, which Bun reports as a suite error, which fails the job, which blocks release.
- **State lifecycle risks:** `bunx` populates Bun's cache; a cold runner pays the download once per job. Orphaned hosts are covered by #896's group reaping; the probe's own child is short-lived.
- **API surface parity:** `EXPECTED_OPENCODE_VERSION` and `EXACT_OPENCODE_VERSION` keep their names and types; only their source changes. The eval result envelope's identity fields are unchanged.
- **Integration coverage:** The `bunx` command line satisfies `countEvalServeProcesses` (measured, see Resolved During Planning); the eval-runner interruption and timeout tests keep their process-count assertions unchanged.
- **Unchanged invariants:** No assertion in the suite changes. Bundled agents stay model-free. The privacy allowlist on persisted eval output is untouched because no new field is written.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `bunx` resolution differs on the Ubuntu runner (network policy, cache location) | The probe fails closed under `SYSTEMATIC_REQUIRE_OPENCODE=1`; the first job run measures cold cost; a cache step is a deferred, optional follow-up. |
| Supply chain: the job fetches `opencode-ai@<pin>` and a platform binary from npm on every cold run and executes them | Exposure is unchanged from the current `npx --yes opencode-ai@<pin>` path — same package, same registry, same exact pin. The pin fixes the version, not the tarball contents; that residual risk is accepted, as it already was. The job holds only the workflow's read-only token and no secrets, so a compromised release could read the checkout but could not publish or push. |
| The scripted provider's tool-call script diverges from what `opencode run` expects at a future OpenCode version | That is the host contract the suite exists to catch; a failure is signal, not flake. |
| Release wall time grows by the suite's duration | Accepted: the failure it prevents is a published plugin that does not load. The job is path-gated so docs and registry PRs are unaffected. |
| A future test adds a `describe.skipIf` without the reason string | The exported reason and the CI throw are module-level in the fixture; any suite importing `OPENCODE_AVAILABLE` gets both. |
| Deleting the matrix test removes a signal someone relied on | It asserted nothing and its log line was never consumed; the packed-runtime cell at the pin keeps the real assertion. |

## Documentation / Operational Notes

- `AGENTS.md`'s Commands block lists `bun test tests/integration`; add a one-line note that OpenCode suites skip locally unless `bunx opencode-ai@<pin>` can run, and that CI runs them with `SYSTEMATIC_REQUIRE_OPENCODE=1`.
- After this lands, Renovate PR #880 (OpenCode 1.18.21 → 1.18.25) is superseded by a bump straight to the current version; the `host-contract` job on that PR is the evidence.

## Sources & References

- Related code: `tests/integration/fixtures/receipt-workflow-host.ts`, `scripts/eval-cases/opencode.ts`, `scripts/run-evals.ts`, `tests/unit/eval-contract.test.ts`, `.github/workflows/main.yaml`, `.github/renovate.json5`, `mise.toml`
- Related PRs/issues: #896 (process-group reaping), #880 (OpenCode bump this supersedes), #856 (the last manual lockstep bump)
- Institutional learnings: listed under Context & Research
