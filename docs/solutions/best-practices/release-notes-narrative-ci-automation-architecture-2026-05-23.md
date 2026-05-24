---
title: Release notes narrative CI automation architecture
date: 2026-05-23
last_updated: 2026-05-23
category: best-practices
module: release-pipeline
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Designing post-publish hooks that dispatch an LLM agent to enrich a just-shipped artifact
  - Wiring `@semantic-release/exec` to call external automation after a release lands
  - Dispatching a `workflow_call`-enabled GitHub Actions workflow from inside another workflow and waiting on the result
  - Splitting CI failure modes into fail-soft (narrative-quality) and fail-hard (security-relevant) classes
  - Identifying a dispatched workflow run reliably when the agent has multi-minute bootstrap time
  - Reasoning about `${...}` collisions between Lodash template rendering and bash parameter expansion
tags:
  - semantic-release
  - github-actions
  - workflow-call
  - workflow-dispatch
  - llm-in-ci
  - fail-soft
  - lodash-template
  - shell-extraction
  - run-identification
  - timestamp-polling
  - fro-bot
---

# Release notes narrative CI automation architecture

## Context

The v1 `release-notes-narrative` skill (shipped in v2.22.0) produces qualitatively-good release notes when an operator remembers to invoke it. v2.22.0's release cycle proved the manual-invocation gap inside its own publish: the initial auto-generated body was a one-liner, and the narrative version landed only after a manual skill run against the just-published tag. The fix needed to be automatic dispatch on every successful publish from `main`, without any operator-in-the-loop step.

Two architectural constraints shaped the design. First, `@semantic-release/github` does NOT publish in draft mode by default in this repo (no `draftRelease: true` in `.releaserc.yaml`), so the GitHub release is live the moment semantic-release finishes. Any post-publish narrative rewrite is editing an already-public artifact. Second, `release: published` event handlers fire AFTER the body is already visible, so a separate-workflow trigger creates a "bare-body blip" between publish and rewrite. The cleanest synchronous post-publish hook inside the Release job is `@semantic-release/exec`'s `successCmd`, which runs after all publish plugins complete but inside the same workflow run.

The v1 skill's procedure (`.agents/skills/release-notes-narrative/SKILL.md`) is the canonical implementation for both manual and CI runs. v2 does not fork the procedure or introduce a CI-specific render path. The skill stays the single source of truth; CI just dispatches it.

## Architecture

The trigger chain is fully synchronous inside the Release job, with all coordination happening through GitHub-native primitives (no external queues, no broker, no shared state):

```
.github/workflows/main.yaml: Release job
  └─ npx semantic-release
      ├─ @semantic-release/commit-analyzer
      ├─ @semantic-release/release-notes-generator (produces auto-body)
      ├─ @semantic-release/npm (publishes to npm)
      ├─ @semantic-release/github (creates GitHub release; body is live)
      ├─ @semantic-release/exec (NEW — successCmd fires here)
      │   └─ scripts/dispatch-release-notes.sh "$RELEASE_VERSION":
      │       ├─ RELEASE_VERSION = $1 (Lodash injected ${nextRelease.gitTag})
      │       ├─ validate against semver regex          ← reject malformed tags
      │       ├─ CORRELATION_ID = $(uuidgen)            ← unique per dispatch
      │       ├─ DISPATCH_EPOCH = $(date +%s)           ← captured BEFORE dispatch
      │       ├─ gh workflow run --ref main fro-bot.yaml \
      │       │     -f prompt=<release-notes-narrative-prompt> \
      │       │     -f correlation-id=$CORRELATION_ID
      │       ├─ poll up to 90s: gh run list --event=workflow_dispatch \
      │       │     | jq 'createdAt > $DISPATCH_EPOCH' | newest wins
      │       ├─ timeout 600 gh run watch $RUN_ID --exit-status
      │       ├─ fetch conclusion + log (ANSI-stripped) + post-write body length
      │       └─ classify: success / neutral / cancelled / timeout / auth-failure /
      │                   off-target-edit / action_required / skipped / integrity-fail
      └─ semantic-release-export-data (emits final outputs)

fro-bot.yaml (called via workflow_dispatch from the script above)
  └─ checkout main with FRO_BOT_PAT, fetch-depth: 0
      └─ fro-bot/agent action (LLM execution)
          └─ executes prompt:
              ├─ idempotency check: if existing body starts with ## What's new, short-circuit
              ├─ load .agents/skills/release-notes-narrative/SKILL.md
              ├─ execute 13-step procedure against target tag
              └─ apply via gh release edit --notes-file (using FRO_BOT_PAT)
```

The successCmd is implemented as `scripts/dispatch-release-notes.sh`, invoked from `.releaserc.yaml` via a one-line `successCmd:` field. See "External script for shell logic" in Key Design Decisions for why the inline approach was abandoned after two production failures.

## Key Design Decisions

### Fail-soft for narrative; fail-hard for security-relevant

The successCmd exits 0 (Release job stays green) for narrative-generation failures: timeouts, generic `failure` conclusion without security signals, `cancelled` conclusion, unknown future conclusion values. The release has already shipped to npm and GitHub by the time successCmd runs, so a failed narrative rewrite is best-effort polish, not part of the publish atomicity contract.

The successCmd exits 1 (Release job goes red) for security-relevant failures: HTTP 401/403, "Bad credentials", "Resource not accessible", "permission denied", `gh release edit` touching a tag other than the target, `action_required` conclusion (policy gate), `skipped` conclusion (branch protection blocked dispatch), post-write integrity failure (success conclusion but body length less than 200 chars).

Both classes also emit GitHub Actions log annotations regardless of exit code: `::warning::` for narrative-failure and `::error::` for security-relevant. This keeps both classes visible in the Actions UI even when the Release job itself is green.

This split was the resolution of an adversarial review finding. The earlier draft committed to exit-0-always, but blanket fail-soft would hide auth failures and prompt-injection attempts under green CI. Splitting by class preserves the "release ships even if narrative fails" guarantee while keeping security signals loud.

### `FRO_BOT_PAT` is the write credential, not `GITHUB_TOKEN`

The `fro-bot.yaml` workflow uses `secrets.FRO_BOT_PAT` (a Personal Access Token) for both its checkout step and the `github-token` input passed to the `fro-bot/agent` action. The workflow-level `permissions: contents: read` applies to the auto-generated `GITHUB_TOKEN` only — it does NOT block `gh release edit` calls that explicitly use the PAT.

This matters because GitHub's reusable-workflow permission rules forbid called workflows from elevating their token scope above the workflow-level declaration. If the `gh release edit` step were using `GITHUB_TOKEN`, it would inherit `contents: read` and fail with HTTP 403. Using the PAT bypasses that rule entirely; the only constraint is that `FRO_BOT_PAT` itself must have `releases: write` (or `contents: write`) scope. v2.22.0's manual `gh release edit` already demonstrated write success under this PAT, providing existence proof of sufficient scope.

The pre-merge gate for the v2 PR requires explicit evidence of PAT scope (either a screenshot of GitHub PAT settings or citation of v2.22.0's successful manual run). Going to production without verifying this gate would deploy a successCmd that silently fails on every release.

### Timestamp-based polling with correlation as audit anchor

**Supersedes the original "Correlation-token-based polling" design.** The first draft of v2 polled `gh run view --log` on each candidate run for a correlation token Fro Bot was instructed to echo as its first log line. This was production-tested in v2.23.3 and proven structurally unworkable: Fro Bot's OpenCode agent has a multi-minute bootstrap sequence (runner spin-up → full checkout → `bun install --frozen-lockfile` → model/auth setup → MCP server startup → OpenCode CLI launch) before any prompt-derived content reaches the run's logs. A 90-second log-scan budget completes long before the token ever appears in the logs. Mock-based integration tests with `mock-gh.sh` returned canned log content instantly, so the failure mode was invisible to the test suite — production caught what mocks could not.

The replacement design (landed in PR #434, verified on v2.23.4):

1. Capture `DISPATCH_EPOCH=$(date +%s)` IMMEDIATELY before `gh workflow run`.
2. Dispatch the workflow with the correlation UUID as a structured `-f correlation-id=$UUID` field (and embedded in the prompt as a secondary audit anchor).
3. Poll `gh run list --workflow=fro-bot.yaml --branch=main --event=workflow_dispatch --json databaseId,createdAt`.
4. Filter candidates with jq: `[.[] | . + {epoch: (.createdAt | fromdateiso8601)}] | map(select(.epoch > $cutoff)) | sort_by(.epoch) | reverse | .[0].databaseId // empty`.
5. The first match is the dispatched run. `gh run list` reflects run-CREATION time, not first-log time, so the run is visible to the API as soon as registered — typically within 1–5 seconds.

The correlation-id field is preserved as a secondary audit anchor. It's still passed to `gh workflow run`, still declared on `fro-bot.yaml` as an optional input on both `workflow_dispatch:` and `workflow_call:` blocks (PR #433 added that declaration; without it, the API rejects the dispatch with `HTTP 422: Unexpected inputs provided: ["correlation-id"]` — the called workflow's input schema is validated at dispatch time regardless of whether the workflow body uses the value). The token remains visible in the dispatched run's `inputs` metadata for any future debugging session, but it is no longer the primary identification mechanism.

This eliminates the bootstrap-time race entirely. Production runs see the dispatched run identified within 1–5 seconds of `gh workflow run` returning; the 90-second poll budget exists for GitHub backend hiccups, not for agent boot time. Same-second collisions in this repo's single-dispatcher topology are not a concern — `main.yaml`'s Release job is the only caller. If multiple dispatchers were to share `fro-bot.yaml`, the correlation token would need to upgrade from audit-only to primary-key status, with polling validating it against the dispatched run's `inputs.correlation-id` via `gh api`.

### Lodash template, then bash

`@semantic-release/exec` resolves `${nextRelease.gitTag}` (and other context keys like `${nextRelease.version}`) via Lodash templating BEFORE handing the resulting string to the shell. After resolution, the bash block sees a literal value like `v2.23.0` — no shell variable expansion is happening at that point.

The implementer must use `${...}` for Lodash-template context keys and `$VAR` for runtime bash variables. Mixing the two in the same expression is a common source of bugs. The successCmd documents this in a header comment, and the integration test verifies it by substituting `${nextRelease.gitTag}` with a bash env var (`${RELEASE_VERSION:-v2.23.0}`) when writing the extracted script to a temp file. Production runs and tests exercise different substitution paths but produce equivalent semantic-release-style and bash-style behavior.

### External script for shell logic

**Supersedes the original "Inline successCmd" decision.** Two consecutive production releases (v2.23.0 and v2.23.1) failed with `SyntaxError: Unexpected token ':'` from bash `${VAR:-default}` parameter expansion being consumed by Lodash's template renderer before the string reached the shell.

The root cause: `@semantic-release/exec` passes the entire `successCmd` YAML value through Lodash's `_.template()` with default interpolation settings (`${...}` delimiters). Lodash evaluates EVERY `${...}` occurrence as a JavaScript expression — including bash parameter expansions like `${VAR:-default}`, `${VAR:+value}`, and `${#VAR}`. The "escape as `\${VAR}`" workaround was attempted and empirically verified to fail: `template('\\${VAR}')({})` throws `ReferenceError: VAR is not defined` because Lodash's default template settings have no escape-sequence support for `${...}`.

The fix: extract all bash logic to `scripts/dispatch-release-notes.sh` and reduce the YAML `successCmd:` to a single line containing only the one genuine Lodash interpolation:

```yaml
successCmd: 'scripts/dispatch-release-notes.sh "${nextRelease.gitTag}"'
```

After Lodash rendering, the shell sees `scripts/dispatch-release-notes.sh "v2.23.2"`. The script receives the tag as `$1` and is otherwise an ordinary shell script with no Lodash surface. The Lodash template surface shrinks from ~170 lines to one trivial line containing only the interpolation we WANT Lodash to perform.

### Skill stays the single source of truth, with optional CI escape hatches

The v1 skill at `.agents/skills/release-notes-narrative/SKILL.md` is the procedure both manual and CI runs follow. CI-specific concerns (correlation token, timeout escape hatches for tests) live in v2 infrastructure (`.releaserc.yaml` successCmd, `RELEASE_NOTES_TEST_*` env vars), not in the skill body. If a procedure gap surfaces during CI runs that does NOT apply to manual runs, the fix lands in v2 infrastructure. If the gap applies to both modes, it lands in the skill.

This split was clarified in document review. The earlier draft insisted on "skill stays the only canonical source" without acknowledging that CI mode has constraints (no operator-in-the-loop, hard timeouts, non-interactive auth) that don't apply to manual runs. The current contract allows v2 to evolve its CI-specific affordances without bloating the skill body, while preserving the skill as the procedure description.

## Failure Modes and Detection

The successCmd classifies all observable outcomes from `gh run watch` + `gh run view` into one of three exit posture classes. The integration test (`tests/integration/release-notes-ci.test.ts`) covers each path with deterministic mock fixtures.

| Outcome | Exit | Annotation | Class |
|---------|------|------------|-------|
| `success` + body length ≥ 200 chars | 0 | none | Happy path |
| `success` + body length < 200 chars | 1 | `::error::` | Integrity failure |
| `neutral` | 0 | none | Idempotent short-circuit |
| `failure` + auth keyword in log | 1 | `::error::` | Auth failure |
| `failure` + off-target tag in log | 1 | `::error::` | Scope abuse |
| `failure` + no security signals | 0 | `::warning::` | Generic narrative failure |
| `cancelled` | 0 | `::warning::` | Narrative failure (transient) |
| `timeout` (WATCH_EXIT=124) | 0 | `::warning::` | Narrative failure (slow Fro Bot) |
| `action_required` | 1 | `::error::` | Policy gate |
| `skipped` | 1 | `::error::` | Branch protection block |
| Unknown future conclusion | 0 | `::warning::` | Narrative failure (forward-compat default) |
| Dispatched run not found within 90s | 1 | `::error::` | Dispatch rejected/never started |

The auth-keyword check looks for any of: `HTTP 401`, `HTTP 403`, `Bad credentials`, `Resource not accessible`, `requires authentication`, `permission denied`. The off-target check strips ANSI escape codes from the log first (`sed 's/\x1b\[[0-9;]*m//g'`) and then greps for `release edit v<semver>` lines that don't match the target tag. The post-write integrity check fetches `gh release view <tag> --json body --jq '.body | length'` after Fro Bot reports success and asserts the body is at least 200 characters.

The forward-compat default for unknown conclusions emits a `::warning::` and exits 0. New GitHub Actions conclusion values added in future API versions would fall into this bucket — the log message captures the actual conclusion string so the gap is visible in CI history, and a future iteration can tighten the classifier when needed.

## What We Did NOT Do

Several alternatives were explicitly rejected during planning or document review:

- **A dedicated `release-notes-narrative.yaml` workflow** instead of reusing `fro-bot.yaml` via `workflow_call`. Extraction is a meaningful surface-area cost (a second workflow file, separate concurrency group, separate maintenance) for marginal coupling reduction. The accepted coupling risk is documented: if `fro-bot/agent` changes how `inputs.prompt` is consumed, v2 may need to update the prompt format. Detection is the first release after the action upgrade.
- **Auto-issue-creation on Fro Bot failure.** The fail-soft contract uses Actions annotations plus the dispatched run's own status as the visibility surface. Auto-creating issues for every transient failure would pollute the issue tracker; release frequency is low enough that operator review of failed Actions runs is sufficient.
- **A fallback LLM provider when Fro Bot is unavailable.** v2 fails-soft on narrative-generation; the release still ships with the auto-generated body, and the operator can manually invoke the skill against an alternative provider if narrative quality matters for that specific release.
- **Backfill of historical releases on the v2 PR.** v1 already retroactively patched v2.20.5, v2.20.6, v2.21.0, and v2.22.0. v2 fires on each NEW release going forward; older releases remain patchable via manual skill invocation if needed.
- **An end-to-end synthetic test of the full chain** (`workflow_call` → Fro Bot agent → `gh release edit`). The chain cannot be fully exercised before a real release ships. The smoke test covers the prompt construction, polling, watch handling, classification, and annotation paths — everything the successCmd controls. The end-to-end behavior is validated by the first real release after merge. **In practice, the first release was not enough**: four consecutive production releases (v2.23.0–v2.23.3) each surfaced a different contract violation invisible to mock-based tests. See the Production Verification section below.
- **Cancellation of the Fro Bot run on Release job interrupt.** If the operator cancels the Release job mid-run, the dispatched Fro Bot run continues to completion. This is acceptable because (a) the Fro Bot run is read-mostly until the final `gh release edit`, and (b) the idempotency contract handles re-runs cleanly.

## Production Verification

The v2 automation took five releases to reach a stable green pipeline. Each step in the chain surfaced a contract violation that mock-based integration tests could not detect. The pattern is worth preserving as a check-list for future automation that bridges semantic-release, GitHub Actions workflow dispatch, and agent-driven runs.

| PR | Tag | Failure | Root cause |
|----|-----|---------|------------|
| #430 | v2.23.0 | `SyntaxError: Unexpected token ':'` from `@semantic-release/exec` | Inline `successCmd` YAML scalar contained `${VAR:-default}` bash parameter expansion, eaten by Lodash template renderer |
| #431 | v2.23.1 | Same SyntaxError, this time from the comment block in the YAML | `\${VAR}` escape attempt; Lodash default settings have no backslash-escape semantics. Verified locally: `template('\\${VAR}')({})` throws `VAR is not defined` |
| #432 | v2.23.2 | `HTTP 422: Unexpected inputs provided: ["correlation-id"]` at dispatch | `fro-bot.yaml` did not declare `correlation-id` as a `workflow_dispatch:` / `workflow_call:` input. GitHub validates input names against the called workflow's schema at dispatch time, regardless of body usage |
| #433 | v2.23.3 | Polling timed out after 90s scanning logs for correlation token | Fro Bot's OpenCode agent takes several minutes to bootstrap before emitting any prompt-derived log content. Log-scan-based identification cannot win against multi-minute boot times |
| #434 | v2.23.4 | **SUCCESS** — auto-narrative end-to-end | Timestamp-based identification via `gh run list --json createdAt` filtering. `gh run list` reflects run-creation time, visible to the API within 1–5 seconds of dispatch |

The structural lesson: **mock-based integration tests cover everything the dispatching script controls, but cannot model real-world Lodash rendering, GitHub API contract validation, or agent runtime characteristics.** Any new automation in this class needs either:

1. A staging environment where the actual remote contracts can be exercised before merge to `main`, OR
2. Explicit acceptance of the "first N releases catch contract violations" pattern, with fail-soft semantics that keep the release shipping even when the automation fails.

This automation chose option 2. The fail-soft contract for narrative-generation failures kept npm and GitHub release publishing fully functional across all four failed attempts, so the only operational impact was missing prose in four release bodies (later patched manually using the v1 skill procedure).

For the next class of automation that bridges these systems, consider adding a one-line local Lodash render check as a pre-push gate:

```bash
bun -e "
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
const { default: template } = await import('lodash-es/template.js');
const config = yaml.load(readFileSync('.releaserc.yaml', 'utf8'));
const exec = config.plugins.find(p => Array.isArray(p) && p[0] === '@semantic-release/exec');
if (!exec) process.exit(0);
const rendered = template(exec[1].successCmd)({ nextRelease: { gitTag: 'v0.0.0' } });
console.log('OK:', rendered);
"
```

If this throws `ReferenceError: VAR is not defined`, the YAML has a Lodash collision before any release runs. The local check would have caught PRs #430 and #431 before merge.

## Operational Considerations

- **Retry semantics.** If the Release job is re-run from the Actions UI after a transient failure (the v2.22.0 oven-sh/setup-bun pattern), the successCmd fires again. The dispatched Fro Bot prompt includes an idempotency check: if the existing release body starts with `## What's new`, treat as already-applied and exit cleanly. The Fro Bot run reports conclusion `neutral` in that case, which the successCmd classifies as a happy-path no-op (exit 0, no annotation).
- **PAT rotation.** If `FRO_BOT_PAT` is rotated while a release is in flight, the dispatched Fro Bot run may fail with HTTP 401 (using the cached token). This is detected as a security-relevant failure and turns the Release job red. The operator restores the token, re-runs the failed job, and the idempotent retry path applies. No leaked-token incident response is defined here; that belongs in a separate security runbook.
- **Plugin order regression.** If a future PR inserts a plugin between `@semantic-release/github` and `@semantic-release/exec` in `.releaserc.yaml`, the successCmd may fire before the inserted plugin completes. No automated regression test catches this; the first release after the change exercises it. The risk is low (`.releaserc.yaml` is rarely edited) and the fix is mechanical.
- **GitHub Actions conclusion taxonomy drift.** New conclusion values added by GitHub fall into the forward-compat default branch with `::warning::` exit 0. Tighten the classifier when a new value appears in production logs.

## Related

- [`docs/solutions/best-practices/release-notes-narrative-procedure-2026-05-23.md`](release-notes-narrative-procedure-2026-05-23.md) — the v1 procedure compound doc; v2 inherits its render contract and idempotency definition verbatim
- [`.agents/skills/release-notes-narrative/SKILL.md`](../../.agents/skills/release-notes-narrative/SKILL.md) — the canonical 13-step procedure both manual and CI runs follow
- [`docs/solutions/developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md`](../developer-experience/semantic-release-body-ingestion-myth-2026-05-17.md) — the original lesson establishing that `gh release edit` is the only mechanism for narrative release notes
- [`docs/brainstorms/2026-05-23-release-notes-narrative-ci-automation-requirements.md`](../../brainstorms/2026-05-23-release-notes-narrative-ci-automation-requirements.md) — v2 requirements (gitignored, local-only) [if reading from a checkout]
- [`docs/plans/2026-05-23-002-feat-release-notes-narrative-ci-automation-plan.md`](../../plans/2026-05-23-002-feat-release-notes-narrative-ci-automation-plan.md) — v2 implementation plan
