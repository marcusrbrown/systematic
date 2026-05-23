---
title: Wire CI automation for release-notes-narrative skill
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-release-notes-narrative-ci-automation-requirements.md
---

# Wire CI automation for release-notes-narrative skill

## Overview

Automate the v1 `release-notes-narrative` skill so every `semantic-release` publish on `main` produces a narrative GitHub release body without manual intervention. Wire `@semantic-release/exec` into `.releaserc.yaml`; its `successCmd` dispatches the existing `fro-bot.yaml` workflow with a prompt that loads the bundled skill and patches the just-published release. Reuses Fro Bot infrastructure end-to-end. No new TypeScript scripts. No new render path. The skill stays the canonical procedure for both manual and CI runs.

## Problem Frame

`v2.22.0` shipped with an auto-generated one-liner release body and was only rewritten to narrative after an operator manually ran the v1 skill against the just-published tag — proving inside its own release cycle that manual invocation is unreliable. v2 closes the loop by making the dispatch automatic at the moment of publish.

The brainstorm fully grounded this against the codebase: `@semantic-release/exec`'s `successCmd` is the cleanest synchronous post-publish hook (`fro-bot.yaml:152,173` confirms `FRO_BOT_PAT` is the relevant write credential, not the workflow `GITHUB_TOKEN`); `gh workflow run` does not return a parseable run ID so polling is required; failure modes must split into narrative (fail-soft) vs security-relevant (fail-hard).

## Requirements Trace

- R1. Trigger fires on every successful `semantic-release` publish from `main` (see origin: R1)
- R2. Hook dispatches `fro-bot.yaml` via `gh workflow run` (see origin: R2)
- R3. SuccessCmd waits for dispatched run via polling + `gh run watch`, bounded 10 min (see origin: R3)
- R4. Exit 0 for narrative-generation failures (see origin: R4)
- R5. Exit non-zero for security-relevant failures + Actions annotations on both classes (see origin: R5)
- R6. Prompt names target tag + bundled skill path + constrains scope (see origin: R6)
- R7. Skill at `.agents/skills/release-notes-narrative/SKILL.md` is the procedure; CI-only concerns may live in v2 infrastructure alongside (see origin: R7)
- R8. Fro Bot uses `FRO_BOT_PAT`; scope must be confirmed pre-merge (see origin: R8)
- R9. `@semantic-release/exec` added as devDependency, placed AFTER `@semantic-release/github` (see origin: R9)
- R10. SuccessCmd emits stdout + Actions annotations (see origin: R10)
- R11. Synthetic smoke test covers prompt construction + polling + annotation paths (see origin: R11)

## Scope Boundaries

- **Out of scope: rendering changes in the skill.** v2 inherits v1's render contract verbatim.
- **Out of scope: HUMAN:KEEP sentinel preservation.** Still deferred from v1.
- **Out of scope: auto-issue-creation on Fro Bot failure.** Actions annotations + dispatched-run status are the visibility surface.
- **Out of scope: multi-release backfill.** v2 fires on each new release going forward.
- **Out of scope: alternative LLM providers.** Fro Bot is the LLM; no fallback.
- **Out of scope: rate-limiting / throttling.** Releases ship rarely enough.
- **Out of scope: a dedicated release-notes-only workflow.** Reusing `fro-bot.yaml` via `workflow_call` is accepted coupling; extraction is a future iteration.
- **Out of scope: end-to-end live test before merge.** Cannot fully exercise the workflow_call→Fro Bot agent→`gh release edit` chain without a real release. U2 covers what is testable.

### Deferred to Separate Tasks

- **`@semantic-release/exec` plugin-load failure regression test:** Untested in this plan. Mitigation rationale: `bun install` (U1 verification) catches missing/broken package; semantic-release's own error reporting surfaces plugin-load failures with clear messages. Adding a synthetic test that mocks plugin-load failure is low-ROI for v2.

## Context & Research

### Relevant Code and Patterns

- `.releaserc.yaml` — current plugin order: commit-analyzer → release-notes-generator → npm → github → semantic-release-export-data
- `.github/workflows/fro-bot.yaml:24-29` — `workflow_call` accepts `prompt` input
- `.github/workflows/fro-bot.yaml:152,173` — `FRO_BOT_PAT` is the write credential (not `GITHUB_TOKEN`)
- `.github/workflows/fro-bot.yaml:160-178` — `fro-bot/agent` action consumes `prompt` as direct LLM instruction
- `.github/workflows/fro-bot.yaml:env:SCHEDULE_PROMPT` — canonical multi-paragraph instruction style for `workflow_call` prompts (use as model for v2's prompt shape)
- `scripts/content-integrity.ts`, `scripts/generate-registry.ts`, `scripts/build-registry.ts`, `scripts/generate-config-schema.ts` — existing TypeScript Bun scripts (convention reference; v2 does NOT add a script)
- `tests/integration/` — existing integration test directory using `bun:test`
- `.agents/skills/release-notes-narrative/SKILL.md` — the v1 procedure (v2 dispatches Fro Bot to run this)

### Institutional Learnings

- `docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md` — confirms `gh release edit` (not commit-message bodies) is the only mechanism for narrative release notes
- `docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md` — v1's procedure compound doc; v2 references it from the architecture compound doc
- Memory `#3082` and `#3014` — push/PR confirmation discipline (applies to U5 commit)
- Memory `#3128` — `@semantic-release/exec` is auto-grouped under `build:` commit-type via existing `@semantic-release/{/,}**` Renovate rule (verified at `.github/renovate.json5:17-24`); no separate Renovate config needed

### External References

(Skipped — brainstorm grounded this against documented `@semantic-release/exec` behavior; no version-specific external research warranted.)

## Key Technical Decisions

- ~~**Inline successCmd (no helper script).**~~ **SUPERSEDED — see External script for shell logic below.** The original decision to inline the bash block in `.releaserc.yaml` was invalidated by two consecutive production failures (v2.23.0 and v2.23.1). `@semantic-release/exec` passes the entire `successCmd` YAML value through Lodash's `_.template()` with `${...}` delimiters. Every bash parameter expansion (`${VAR:-default}`, `${VAR:+value}`, etc.) is evaluated as a JavaScript expression before the string reaches the shell, producing `SyntaxError: Unexpected token ':'`. The "escape as `\${VAR}`" workaround was empirically verified to fail: Lodash's default template settings have no escape-sequence support for `${...}`.
- **External script for shell logic.** All bash logic is extracted to `scripts/dispatch-release-notes.sh`. The YAML `successCmd:` is reduced to a single line: `'scripts/dispatch-release-notes.sh "${nextRelease.gitTag}"'`. After Lodash rendering, the shell sees `scripts/dispatch-release-notes.sh "v2.23.2"`. The script receives the tag as `$1` and is otherwise an ordinary shell script with no Lodash surface. The Lodash template surface shrinks from ~170 lines to one trivial line containing only the interpolation we WANT Lodash to perform.
- **Lodash template, then bash.** `@semantic-release/exec` resolves `${nextRelease.gitTag}` (and other context keys like `${nextRelease.version}`) via Lodash templating BEFORE handing the resulting string to the shell. After resolution, the bash block sees a literal value like `v2.23.0`. Implementer must use `${...}` for Lodash-template context, and `$VAR` for runtime bash variables. Mixing the two in the same expression is a common source of bugs.
- **Correlation-token-based polling.** `gh workflow run` accepts arbitrary `-f` inputs but they are not surfaced in `gh run list` output. To uniquely identify OUR dispatch, generate a UUID via `CORRELATION_ID="$(uuidgen)"` (or `cat /proc/sys/kernel/random/uuid`), pass it both as a `-f correlation-id=$CORRELATION_ID` field AND inside the prompt instructing Fro Bot to echo it as the first log line. Match by polling `gh run list --workflow=fro-bot.yaml --branch=main --json databaseId,createdAt --limit 10`, then for each candidate run `gh run view <id> --log --limit 50 | grep -q "correlation=$CORRELATION_ID"`. This eliminates same-second collision ambiguity. Bounded by a 90-second polling window (60s for dispatch registration + 30s for first log line to appear).
- **RELEASE_VERSION input validation.** Before any prompt construction or shell interpolation, validate `RELEASE_VERSION` against `^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$` (semver-shaped tag with optional pre-release). If validation fails, emit `::error::Invalid RELEASE_VERSION shape: <value>` and exit 1 (security-relevant: malformed input could indicate a tag-spoofing attempt or semantic-release misconfiguration). Defense-in-depth: even though `nextRelease.gitTag` is internally generated by semantic-release from versioned commit analysis, validating at the boundary catches future plugin upgrades that might change the contract.
- **`$GITHUB_REPOSITORY` for runtime env access.** Do NOT use `${{ github.repository }}` inside the bash block — workflow expressions are not interpolated inside `successCmd` strings (which run on the runner, not in the YAML preprocessor). Use the runtime env var `$GITHUB_REPOSITORY` instead (automatically set by GitHub Actions in every runner step). Verify with a unit test that the rendered prompt contains the literal repo name, not a workflow-expression syntax artifact.
- **Security-relevant failure signal list.** Treat as security-relevant (emit `::error::` annotation + exit 1):
  - Conclusion classifications: `failure`, `cancelled` (when caused by external policy), `action_required`, `skipped` (workflow_call skipped means policy/branch protection blocked dispatch)
  - Log content signals: `HTTP 401`, `HTTP 403`, `Bad credentials`, `Resource not accessible`, `requires authentication`, `permission denied`
  - Off-target release edits: `gh run view <id> --log | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'release edit v[0-9]+\.[0-9]+\.[0-9]+'` produces a tag OTHER than `$RELEASE_VERSION`. Strip ANSI codes before matching to handle colored output
  - Post-write integrity check fails: after Fro Bot completes, `gh release view $RELEASE_VERSION --json body --jq '.body | length'` returns a length less than 200 chars (indicating Fro Bot wrote a partial/empty body when narrative was expected)
  - Dispatched workflow run not found within 60s of `gh workflow run` (separate signal from log-content failures — means GitHub rejected the dispatch)
- **Narrative-failure signal list.** Treat as narrative-failure (emit `::warning::` annotation + exit 0):
  - Conclusion classifications: generic `failure` without security signals, `cancelled` (when caused by manual operator cancellation OR runner timeout)
  - Log content signals: model timeout, OpenCode agent error, generic non-zero exits without auth/permission keywords
  - Conclusion `neutral` (treat as no-action-taken; release body remains semantic-release's auto-generated default; not security)
- **Retry idempotency contract.** If the Release job is re-run after a transient failure (e.g., the v2.22.0 oven-sh/setup-bun retry pattern observed this session), the successCmd will fire again against the same tag. The v1 skill's procedure already includes a preflight that detects existing narrative markers (look for `## What's new` heading at the start of the body). The v2 successCmd instructs Fro Bot to: "If the existing release body already contains `## What's new` as its first heading, treat this as already-applied and exit cleanly without making changes." This makes the full chain idempotent.
- **Skip annotation emission for happy path.** Stdout already carries the success signal (target tag, run URL, conclusion). Annotations are reserved for failures — `::warning::` for narrative, `::error::` for security. Avoids noise in the GitHub Actions UI for routine successful releases.
- **Smoke test scope.** U2 covers: RELEASE_VERSION validation, prompt-string construction, `gh run list` JSON parser logic (mock its output), correlation-token matching, conclusion classifier branches (including all expanded taxonomy), annotation emission for each failure class. It does NOT mock the full Fro Bot dispatch — the test is shell-logic-level. End-to-end behavior is gated by the first real release post-merge.
- **`@semantic-release/exec` plugin position.** Inserted between `@semantic-release/github` and `semantic-release-export-data`. The brainstorm verified there is no load-bearing ordering against `semantic-release-export-data`; this position is chosen for log readability (success hook fires immediately after github, before export-data writes its outputs).

## Open Questions

### Resolved During Planning

- Renovate group config for `@semantic-release/exec`: Resolved. Existing `@semantic-release/{/,}**` rule at `.github/renovate.json5:17-24` already covers it with `semanticCommitType: 'build'`. No Renovate config change required.
- Prompt shape: Resolved. Modeled after `fro-bot.yaml`'s `SCHEDULE_PROMPT` — multi-paragraph, instruction-heavy, explicit resource names, explicit scope constraints. Full text in Unit 1.
- Polling-match strategy: Resolved via correlation-token approach. See "Correlation-token-based polling" in Key Technical Decisions. Replaces the earlier `createdAt > dispatched_at` strategy after adversarial review surfaced same-second collision risk.
- Security-signal list: Resolved. Expanded enum in Key Technical Decisions covers auth keywords, off-target edits (ANSI-stripped), post-write integrity, and policy-blocked conclusions. May tighten after first real release if false positives surface.
- Conclusion taxonomy: Resolved. All known GitHub Actions conclusions (`success`, `failure`, `cancelled`, `skipped`, `neutral`, `action_required`, `timed_out`) explicitly classified.
- RELEASE_VERSION validation: Resolved. Regex `^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$` validates input before interpolation.
- Retry idempotency: Resolved. Skill preflight detects existing narrative; successCmd instructs Fro Bot to short-circuit when applied.
- **FRO_BOT_PAT scope confirmation.** Resolved as a pre-merge gate with a concrete verification method: implementer must either (a) screenshot the FRO_BOT_PAT scope listing from GitHub Settings → Developer Settings → Personal Access Tokens, confirming the PAT has `repo` or fine-grained `releases: write` + `contents: write` scope, and attach to the PR description; OR (b) cite the v2.22.0 manual `gh release edit` audit URL (https://github.com/marcusrbrown/systematic/releases/tag/v2.22.0) which already demonstrated write success under this PAT. Acceptance criterion: PR description includes one of those two evidence items before merge.

### Deferred to Implementation

- **Exact `gh run view --log | grep` patterns after seeing real `fro-bot/agent` log output.** The expanded signal list (HTTP 401/403, Bad credentials, etc.) is best-effort; first real release exercises it. If false positives or negatives surface, next iteration tightens. This is genuinely unknowable from the plan side because `fro-bot/agent`'s log format varies by model and prompt.
- **`workflow_call` checkout ref resolution.** `fro-bot.yaml`'s checkout uses a conditional `ref:` expression that defaults to `''` (empty) under workflow_dispatch contexts. Empty ref tells `actions/checkout` to use the workflow's commit, which for a `gh workflow run --ref main` invocation resolves to `refs/heads/main`. Combined with `fetch-depth: 0`, this provides all tags including the just-created `$RELEASE_VERSION` tag. Verified by reading `fro-bot.yaml:142-152`. Implementer should add a defensive `git fetch --tags --force origin` step at the start of the Fro Bot prompt's procedure to handle race conditions where the tag is not yet visible at checkout time.

## Implementation Units

- [ ] **Unit 1: Add @semantic-release/exec and implement successCmd**

**Goal:** Wire the post-publish hook end-to-end: dependency addition, plugin registration, full successCmd logic.

**Requirements:** R1, R2, R3, R4, R5, R6, R8, R9, R10

**Dependencies:** None

**Files:**
- Modify: `package.json` (add `@semantic-release/exec` to devDependencies)
- Modify: `bun.lock` (regenerated by `bun install`)
- Modify: `.releaserc.yaml` (add `@semantic-release/exec` plugin entry with multi-line successCmd)

**Approach:**

The `.releaserc.yaml` plugin entry is shaped:

```yaml
- - '@semantic-release/exec'
  - successCmd: |
      <multi-line bash block>
```

The successCmd does this in order:
1. Lodash template substitutes `${nextRelease.gitTag}` BEFORE shell execution. The resulting bash sees a literal version like `v2.23.0`. Capture as `RELEASE_VERSION="v2.23.0"` (Lodash output).
2. Validate `RELEASE_VERSION` against `^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$`. On mismatch: `::error::Invalid RELEASE_VERSION shape: $RELEASE_VERSION` + exit 1.
3. Generate correlation token: `CORRELATION_ID="$(cat /proc/sys/kernel/random/uuid)"` (or `uuidgen` if available; the Ubuntu runner has both).
4. Construct the prompt as a heredoc; include target tag, correlation token (Fro Bot must echo `correlation=$CORRELATION_ID` as its first log line), bundled skill path, scope constraints (no comments, no issue creation, no PR-body edits), and the idempotency contract (if existing body already has `## What's new` as first heading, short-circuit).
5. Dispatch: `gh workflow run --ref main fro-bot.yaml -f "prompt=$PROMPT" -f "correlation-id=$CORRELATION_ID"` (capture stdout for the dispatch URL).
6. Poll up to 90s for a matching run:
   - Every 5s, `gh run list --workflow=fro-bot.yaml --branch=main --json databaseId,createdAt --limit 10`
   - For each candidate, fetch first 50 log lines: `gh run view <id> --log --limit 50 2>/dev/null | grep -q "correlation=$CORRELATION_ID"`
   - First matching `databaseId` is OUR run. Break.
   - On no-match-after-90s: `::error::Dispatched workflow run not found within 90s" + exit 1 (security-relevant; dispatch was rejected by GitHub or workflow never started).
7. `timeout 600 gh run watch "$RUN_ID" --exit-status` (10-minute hard timeout). Capture exit code as `WATCH_EXIT`.
8. Fetch conclusion: `CONCLUSION="$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion')"`.
9. Fetch full log (for grep-based analysis): `LOG="$(gh run view "$RUN_ID" --log 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')"` (strips ANSI codes).
10. Off-target check: `OFF_TARGET="$(echo "$LOG" | grep -E 'release edit v[0-9]+\.[0-9]+\.[0-9]+' | grep -v "release edit $RELEASE_VERSION" || true)"`. If non-empty: security-relevant.
11. Auth-keyword check: `echo "$LOG" | grep -qE 'HTTP 401|HTTP 403|Bad credentials|Resource not accessible|requires authentication|permission denied'`. If matches: security-relevant.
12. Post-write integrity check: `BODY_LEN="$(gh release view "$RELEASE_VERSION" --json body --jq '.body | length')"`. If `CONCLUSION == success` AND `BODY_LEN < 200`: security-relevant (Fro Bot reported success but body looks empty/partial).
13. Classify outcome by precedence:
    - WATCH_EXIT == 124 (timeout) → `::warning::Fro Bot run timed out" + exit 0 (narrative-failure)
    - OFF_TARGET non-empty → `::error::Off-target release edit detected: $OFF_TARGET" + exit 1 (security)
    - Auth keywords match → `::error::Auth failure in dispatched run" + exit 1 (security)
    - CONCLUSION in {failure} AND auth match → covered above
    - CONCLUSION == action_required → `::error::Workflow requires manual intervention" + exit 1 (security; policy/branch protection blocked)
    - CONCLUSION == skipped → `::error::Workflow was skipped (likely policy/branch protection)" + exit 1 (security)
    - CONCLUSION == cancelled → `::warning::Workflow cancelled" + exit 0 (narrative-failure; treat as transient)
    - CONCLUSION == success AND BODY_LEN < 200 → `::error::Reported success but body integrity check failed (BODY_LEN=$BODY_LEN)" + exit 1 (security)
    - CONCLUSION == success → log target tag + run URL + "narrative applied (correlation=$CORRELATION_ID)" + exit 0
    - CONCLUSION == neutral → log "no-action-taken (likely already-applied)" + exit 0 (the skill's idempotency short-circuit; expected on Release job re-runs)
    - CONCLUSION == failure (no other signals) → `::warning::Fro Bot run failed (narrative-failure)" + exit 0
    - Any other CONCLUSION → `::warning::Unknown conclusion: $CONCLUSION" + exit 0 (defaults to narrative-failure for forward-compat)

Prompt text (canonical shape — concrete; do NOT abbreviate during implementation; `$RELEASE_VERSION`, `$CORRELATION_ID`, and `$GITHUB_REPOSITORY` are runtime bash env vars expanded by the heredoc):

```
correlation=$CORRELATION_ID

You are running the release-notes-narrative skill against a just-published GitHub release.
First, echo the line "correlation=$CORRELATION_ID" to stdout (the line above this prompt) so
the dispatching workflow can identify this run. This is mandatory.

Target release tag: $RELEASE_VERSION
Target repository: $GITHUB_REPOSITORY

Idempotency check (do this FIRST):
- Fetch the current release body: `gh release view $RELEASE_VERSION --json body --jq '.body'`
- If the body starts with the heading `## What's new`, the narrative has already been applied.
  Log "already-applied; short-circuiting" and exit cleanly. Conclusion will be reported as `neutral`.

Procedure (only if idempotency check did NOT short-circuit):
1. Load the skill at .agents/skills/release-notes-narrative/SKILL.md from this checkout.
2. Execute the 13-step procedure against tag $RELEASE_VERSION.
3. Apply the rendered body via `gh release edit $RELEASE_VERSION --notes-file <tmpfile>`.

Scope constraints (do not violate):
- Do NOT comment on any PR, issue, or discussion.
- Do NOT open or close any issue.
- Do NOT edit any release body OTHER than $RELEASE_VERSION.
- Do NOT modify any file in the repository.
- Do NOT push commits, create branches, or create tags.

Report back with: the target tag, the chars-before and chars-after counts, and the
GitHub release URL.
```

The full bash block fits in ~50 lines including comments and shellcheck-friendly quoting. No external helper script.

**Patterns to follow:**
- `.releaserc.yaml` existing plugin entries (the `@semantic-release/github` entry uses the same `- - '<plugin>' / - <key>: <value>` array-of-tuples shape)
- `scripts/content-integrity.ts:1-20` for shellcheck-style bash quoting conventions (referenced for style; v2 uses bash inline)
- `fro-bot.yaml:env:SCHEDULE_PROMPT` for prompt instruction style

**Test scenarios:**
None — Unit 1 is configuration; behavioral coverage lives in Unit 2.

**Verification:**
- `bun install` succeeds and `bun.lock` updates cleanly with `@semantic-release/exec` resolved at version `^7.x`
- `.releaserc.yaml` parses as valid YAML (`bun -e "import('yaml').then(y => y.parse(require('fs').readFileSync('.releaserc.yaml','utf8')))"` or equivalent)
- The semantic-release dry-run on a feature branch (which has `DRY_RUN=true` per `.github/workflows/main.yaml:170`) loads the exec plugin without parse errors. NOTE: dry-run does NOT execute `successCmd` (semantic-release skips success hooks in dry-run mode), so live verification waits until the first real merge to main.
- Pre-merge gate: PR description includes ONE of (a) screenshot of `FRO_BOT_PAT` scope listing from GitHub PAT settings showing `repo` or fine-grained `releases: write` + `contents: write`, OR (b) link to v2.22.0 release URL as evidence of prior write success under this PAT.
- Shellcheck (if available locally; `brew install shellcheck`): extract the successCmd block and verify zero ShellCheck warnings. Optional but recommended.

- [ ] **Unit 2: Smoke test for successCmd logic**

**Goal:** Cover prompt construction, polling filter logic, conclusion classification, and annotation emission with a synthetic test that does NOT require dispatching a real Fro Bot run.

**Requirements:** R11

**Dependencies:** None (parallel-safe with Unit 1)

**Files:**
- Create: `tests/integration/release-notes-ci.test.ts`

**Approach:**

The integration test treats the successCmd's bash logic as a unit under test. Strategy:

1. Extract the successCmd's classification logic into a testable shape. Since the successCmd is a bash heredoc inside `.releaserc.yaml`, the test cannot import it. Two viable options:
   - Option A: The test reads `.releaserc.yaml`, extracts the successCmd block, writes it to a temp shell file, and invokes it with mocked `gh` and `jq` PATH entries (a `scripts/test-helpers/mock-gh.sh` shim that prints predetermined fixtures based on `$1`).
   - Option B: The test invokes the successCmd's bash inline via `Bun.spawn('bash', ['-c', '<extracted block>'], { env: { PATH: 'tests/fixtures/mock-bin:...' }})`.

   Choose Option A — easier to debug; the mock shim is reusable for future tests; the extraction-from-yaml step is itself a useful regression check that the successCmd block is well-formed.

2. Mock fixtures cover:
   - `gh workflow run` → prints "Created workflow_dispatch event for fro-bot.yaml at refs/heads/main" (real CLI output shape)
   - `gh run list` → prints JSON matching the expected jq filter, with controlled `createdAt` values
   - `gh run watch` → exits with controlled status code
   - `gh run view --log` → prints controlled log content (success body, 401 body, off-tag-edit body, etc.)
   - `gh run view --json conclusion` → prints `{"conclusion":"success|failure|cancelled"}`

3. Scenarios to cover:

**Patterns to follow:**
- `tests/integration/opencode.test.ts` for integration-test structure with `bun:test`
- `tests/unit/content-integrity.test.ts` for fixture-driven shell-script testing patterns

**Test scenarios:**

- **Validation — invalid RELEASE_VERSION.** Run successCmd with `RELEASE_VERSION="not-a-tag"`. Expect: `::error::Invalid RELEASE_VERSION shape"; exit 1; no `gh workflow run` invocation occurs.
- **Validation — valid pre-release.** Run with `RELEASE_VERSION="v2.23.0-rc.1"`. Expect: validation passes; dispatch proceeds.
- **Happy path — success conclusion + valid body length.** Mock `gh run watch` exits 0, conclusion=`success`, post-write `gh release view --json body` returns body with length 800. Expect: stdout contains target tag + run URL + "narrative applied (correlation=...)"; no annotation emitted; exit 0.
- **Happy path — neutral conclusion (idempotent short-circuit).** Mock conclusion=`neutral`. Expect: stdout contains "no-action-taken"; no annotation; exit 0.
- **Edge case — timeout (WATCH_EXIT=124).** Mock `gh run watch` exits 124. Expect: `::warning::` annotation containing "timed out"; exit 0.
- **Edge case — dispatch not registered within 90s.** Mock `gh run list` always returns no candidate matching correlation token. Expect: `::error::` annotation containing "not found within 90s"; exit 1.
- **Edge case — correlation token matches second-newest run, not first.** Mock `gh run list` returns 2 runs: newest has log content NOT matching correlation; second has matching correlation. Assert second run's `databaseId` is used.
- **Error path — HTTP 401 auth denial.** Mock conclusion=`failure`, log contains `HTTP 401: Bad credentials`. Expect: `::error::` annotation containing "Auth failure"; exit 1.
- **Error path — HTTP 403 + permission denied.** Mock conclusion=`failure`, log contains both `HTTP 403` and `permission denied`. Expect: `::error::` annotation; exit 1.
- **Error path — "Resource not accessible" auth keyword.** Mock conclusion=`failure`, log contains `Resource not accessible by integration`. Expect: `::error::`; exit 1.
- **Error path — off-target tag edit (ANSI-stripped).** Mock conclusion=`failure`, log contains ANSI-colored `\x1b[31mgh release edit v9.9.9\x1b[0m` while target is `v2.23.0`. Expect: after ANSI strip, off-target detection fires; `::error::` annotation containing "Off-target"; exit 1.
- **Error path — success conclusion but body too short.** Mock conclusion=`success`, body length=50. Expect: `::error::` containing "body integrity check failed"; exit 1.
- **Error path — action_required conclusion.** Mock conclusion=`action_required`. Expect: `::error::` containing "manual intervention"; exit 1.
- **Error path — skipped conclusion (policy block).** Mock conclusion=`skipped`. Expect: `::error::` containing "policy/branch protection"; exit 1.
- **Edge case — cancelled conclusion.** Mock conclusion=`cancelled`. Expect: `::warning::` annotation; exit 0.
- **Edge case — generic narrative failure.** Mock conclusion=`failure`, log contains no security signals, no off-target edits. Expect: `::warning::`; exit 0.
- **Edge case — unknown future conclusion.** Mock conclusion=`some_new_value`. Expect: `::warning::` containing "Unknown conclusion"; exit 0 (forward-compat).
- **Integration — prompt construction includes correlation token, target tag, repo name.** Run successCmd with `RELEASE_VERSION=v2.23.0`, `GITHUB_REPOSITORY=marcusrbrown/systematic`. Capture the `gh workflow run -f prompt=...` invocation via mock-gh; assert the prompt contains all three values literally (not as workflow-expression syntax artifacts).
- **Integration — prompt requires Fro Bot to echo correlation as first line.** Assert the prompt's first line is `correlation=<the-uuid>` and that the instruction text explicitly requires Fro Bot to echo it.

**Verification:**
- All 10 scenarios pass under `bun test tests/integration/release-notes-ci.test.ts`
- The mock-gh shim is repo-checked-in and has its own shebang + execute permission
- The extracted-from-yaml step in the test fails loudly if `.releaserc.yaml` is missing the successCmd block (prevents drift between U1 and U2)

- [ ] **Unit 3: Cross-reference v2 in v1 skill and procedure doc**

**Goal:** Surface the CI automation path in both the user-facing skill (so manual runs know they're now the exception) and the v1 architecture doc (so the corpus stays current).

**Requirements:** R7

**Dependencies:** Unit 1

**Files:**
- Modify: `.agents/skills/release-notes-narrative/SKILL.md` (add a "CI automation" section near the top explaining that the skill now also runs automatically post-publish; describe what changes for manual invocation)
- Modify: `docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md` (append a brief addendum at the bottom: "v2 (2026-05-23): CI automation now dispatches this procedure on every semantic-release publish via `@semantic-release/exec` successCmd → `fro-bot.yaml` workflow_call. See [v2 architecture doc].")

**Approach:**
- Skill addition is 5-10 lines under a new `## CI Automation (v2)` heading immediately after the `description:` frontmatter block; reads as procedure-context, not procedure-modifier (the 13 steps stay verbatim)
- Procedure doc addition is a single trailing section: `## Update: v2 CI Automation (2026-05-23)` with a 3-sentence summary and a forward-link to U4's compound doc

**Patterns to follow:**
- v1 skill's existing `## Overview` and `## Prerequisites` heading style
- v1 procedure doc's existing section structure

**Test scenarios:**
Test expectation: none — pure documentation; no behavioral change.

**Verification:**
- `bun scripts/content-integrity.ts` passes (no phantom systematic refs; no banned CC/CEP patterns introduced)
- Cross-references resolve: the procedure-doc forward-link points at the actual U4-created file

- [ ] **Unit 4: Compound the v2 architecture into a solution doc**

**Goal:** Capture the v2 architecture as a durable institutional learning. Distinct doc from v1's procedure doc — v1 was about WHAT (the procedure); v2 is about HOW it integrates with CI.

**Requirements:** Memory `#15` (compound docs in same branch as implementation)

**Dependencies:** Unit 3 (so this doc can cross-reference both v1's procedure and the just-modified v1 skill)

**Files:**
- Create: `docs/solutions/best-practices/release-notes-narrative-ci-automation-architecture-2026-05-23.md`

**Approach:**
Doc structure follows `skills/ce-compound/references/schema.yaml`. Frontmatter: `track: best_practice`, `module: release-pipeline`, `tags: [semantic-release, ci-automation, llm-in-ci, github-actions, workflow-call]`. Body:
- **Context** — why v2 exists (v2.22.0 proved manual invocation is unreliable)
- **Architecture** — the trigger chain: `npx semantic-release` → `@semantic-release/github` publishes → `@semantic-release/exec` successCmd → `gh workflow run fro-bot.yaml` → polling + `gh run watch` → annotation + exit
- **Key design decisions** — fail-soft for narrative / fail-hard for security split; `FRO_BOT_PAT` (not `GITHUB_TOKEN`) is the write credential; inline bash over external script; polling required because `gh workflow run` doesn't return run ID
- **Failure modes and detection** — the 8 scenarios from U2's test matrix
- **What we did NOT do** — explicit list: no separate workflow; no auto-issue-creation; no synthetic end-to-end mock; no fallback LLM provider
- **Forward references** — link to v1 procedure doc, v1 skill, brainstorm, plan

**Patterns to follow:**
- `docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md` (the v1 doc this complements)
- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` (another architecture-track best-practice doc; similar shape)

**Test scenarios:**
Test expectation: none — pure documentation.

**Verification:**
- `bun scripts/content-integrity.ts` clean
- Frontmatter validates against `skills/ce-compound/references/schema.yaml`
- All cross-references resolve

## System-Wide Impact

- **Interaction graph:** `.releaserc.yaml` now has 6 active plugins (was 5). The Release job in `main.yaml` gains an effective post-publish step via the new exec plugin but does not need its own YAML edit. `fro-bot.yaml` gains a new caller (Release job in main.yaml) but its surface is unchanged.
- **Error propagation:** Narrative-failure stops at the Release job's successCmd (exit 0); the dispatched Fro Bot run's status remains as the operator-visible signal. Security-failure propagates as a non-zero exit from the successCmd, which `semantic-release` reports as a failed publish hook. CRITICAL: `@semantic-release/github`'s publish has ALREADY succeeded by the time successCmd runs; the GitHub release IS live regardless of successCmd outcome. The "failed publish hook" status is cosmetic on the Release job, not transactional rollback.
- **State lifecycle risks:** None. The successCmd does not create persistent state; the dispatched workflow run is auditable via Actions UI; the release body edit is idempotent (running the skill twice produces the same narrative body).
- **API surface parity:** None. `.releaserc.yaml` is a private build-config artifact; semantic-release plugin order is a runtime contract but our change is additive (one new plugin) and well-bounded.
- **Integration coverage:** End-to-end chain (workflow_call → Fro Bot agent → `gh release edit` → live release body) cannot be exercised by unit tests. First real release post-merge is the integration validation. U2 covers all paths the successCmd controls; what it cannot cover is whether Fro Bot's agent actually follows the prompt instructions correctly under real LLM conditions.
- **Unchanged invariants:** v1 skill body unchanged. `fro-bot.yaml` workflow definition unchanged. `main.yaml` Release job's steps unchanged. semantic-release plugin order's existing entries unchanged (only one entry inserted).

## Risks & Dependencies

### Load-bearing (active mitigation required)

| Risk | Mitigation |
|------|------------|
| `FRO_BOT_PAT` lacks `releases: write` (or `contents: write`) scope | Pre-merge verification step in PR description (see Open Questions → Resolved During Planning). PR description must contain one of two evidence items before merge; v2.22.0's manual `gh release edit` already demonstrated write success under this PAT, but explicit confirmation is required. |
| Fro Bot prompt drift — future Fro Bot config changes could alter how `inputs.prompt` is consumed | Prompt is explicit + multi-paragraph + names exact resources. If the `fro-bot/agent` action upgrades and changes prompt semantics, the v2 successCmd may emit a malformed body. Detection: the first release after a Fro Bot upgrade exercises this; U4's compound doc names Fro Bot as a coupled dependency. |
| Conclusion taxonomy gap (new GitHub Actions conclusion value introduced in future) | Default branch in conclusion classifier emits `::warning::` + exit 0 (narrative-failure) for any unrecognized conclusion. Detection: log content captures the actual conclusion string so the gap is visible in CI history. Mitigation: tighten classifier when new conclusion appears. |
| `@semantic-release/exec` Lodash-template surface changes between versions | Pin range is `@semantic-release/exec@^7` (matching semantic-release@25). `nextRelease.gitTag` is documented as stable in exec README. Verify in U1's `bun install` step. |
| LLM idempotency on retry — if successCmd fires twice for same tag (Release job re-run), Fro Bot might re-render and overwrite | Mitigated by skill preflight: prompt instructs Fro Bot to short-circuit when existing body already has narrative markers. Test scenario in U2 covers this. |

### Observed but acceptable

| Risk | Why acceptable |
|------|----------------|
| Polling false-match across same-second `workflow_dispatch` runs | Eliminated by correlation-token matching (see Key Technical Decisions). Original `createdAt`-only filter is no longer used. |
| Real LLM nondeterminism varying narrative quality | v1 already proved quality across 4 retroactive releases. v2 inherits skill verbatim; this is not a v2-introduced risk. If quality degrades, fix lands in skill body. |
| Plugin order regression (someone inserts a plugin between github and exec in a future PR) | Low likelihood; `.releaserc.yaml` is rarely edited. If it happens, the successCmd may fire before npm/github finish, producing a release-edit on an incomplete release. Detection: real-release exercises this. Documented in U4's compound doc as a coupling note. |
| `workflow_call` runner exhaustion or backend hiccup causing dispatch to register but never start | 90s polling window allows for queued workflows; if it still doesn't appear, `::error::` exit (security-relevant signal because the operator needs to know). Manual remediation via re-run from Actions UI. |

## Documentation / Operational Notes

- PR description for this work includes a pre-merge checklist item: "Confirm `FRO_BOT_PAT` has releases-write scope OR has demonstrated write success via prior `gh release edit` runs in this repo's history."
- The first release after merge is the live acceptance gate. If that release's body is NOT narrative within 10 minutes of `gh release list` showing the tag, manually invoke the v1 skill and treat as a v2 regression (open follow-up issue, do not roll back).
- v4's compound doc names ongoing operational gotchas (plugin-order regression, Fro Bot upgrade coupling) so future operators have the context.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-release-notes-narrative-ci-automation-requirements.md](../brainstorms/2026-05-23-release-notes-narrative-ci-automation-requirements.md)
- Related code: `.releaserc.yaml`, `.github/workflows/fro-bot.yaml`, `.github/workflows/main.yaml`, `.agents/skills/release-notes-narrative/SKILL.md`
- Related PRs/issues: PR #429 (v1 skill landing), v2.22.0 release (live dogfood of the gap this PR closes)
- External docs: `@semantic-release/exec` README (lifecycle hooks reference, `nextRelease.gitTag` interpolation contract)
