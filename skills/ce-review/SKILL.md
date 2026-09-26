---
name: ce-review
description: Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Use when reviewing code changes before creating a PR.
argument-hint: '[blank to review current branch, or provide PR link]'
metadata:
  harness-portability: neutral-v1
---

# Code Review

Reviews code changes using dynamically selected reviewer personas. Spawns parallel sub-agents that return structured JSON, then merges and deduplicates findings into a single report.

## When to Use

- Before creating a PR
- After completing a task during iterative implementation
- When feedback is needed on any code changes
- Can be invoked standalone
- Can run as a read-only or autofix review step inside larger workflows

## Argument Parsing

Parse `$ARGUMENTS` for the following optional tokens. Strip each recognized token before interpreting the remainder as the PR number, GitHub URL, or branch name.

| Token | Example | Effect |
|-------|---------|--------|
| `mode:autofix` | `mode:autofix` | Select autofix mode (see Mode Detection below) |
| `mode:report-only` | `mode:report-only` | Select report-only mode |
| `mode:headless` | `mode:headless` | Select headless mode for programmatic callers (see Mode Detection below) |
| `base:<sha-or-ref>` | `base:abc1234` or `base:origin/main` | Skip scope detection — use this as the diff base directly |
| `plan:<path>` | `plan:docs/plans/2026-03-25-001-feat-foo-plan.md` | Load this plan for requirements verification |

All tokens are optional. Each one present means one less thing to infer. When absent, fall back to existing behavior for that stage.

**Conflicting mode flags:** If multiple mode tokens appear in arguments, stop and do not dispatch agents. If `mode:headless` is one of the conflicting tokens, emit the headless error envelope: `Review failed (headless mode). Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.` Otherwise emit the generic form: `Review failed. Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.`

## Mode Detection

| Mode | When | Behavior |
|------|------|----------|
| **Interactive** (default) | No mode token present | Review, apply safe_auto fixes automatically, present findings, ask for policy decisions on gated/manual findings, and optionally continue into fix/push/PR next steps |
| **Autofix** | `mode:autofix` in arguments | No user interaction. Review, apply only policy-allowed `safe_auto` fixes, re-review in bounded rounds, write a run artifact, and emit residual downstream work when needed |
| **Report-only** | `mode:report-only` in arguments | Strictly read-only. Review and report only, then stop with no edits, artifacts, todos, commits, pushes, or PR actions |
| **Headless** | `mode:headless` in arguments | Programmatic mode for skill-to-skill invocation. Apply `safe_auto` fixes silently (single pass), return all other findings as structured text output, write run artifacts, skip todos, and return "Review complete" signal. No interactive prompts. |

### Autofix mode rules

- **Skip all user questions.** Never pause for approval or clarification once scope has been established.
- **Apply only `safe_auto -> review-fixer` findings.** Leave `gated_auto`, `manual`, `human`, and `release` work unresolved.
- **Write a run artifact** under `.context/systematic/ce-review/<run-id>/` summarizing findings, applied fixes, residual actionable work, and advisory outputs.
- **Create durable todo files only for unresolved actionable findings** whose final owner is `downstream-resolver`. Load the `todos` skill (Create section) for the canonical directory path and naming convention.
- **Never commit, push, or create a PR** from autofix mode. Parent workflows own those decisions.

### Report-only mode rules

- **Skip all user questions.** Infer intent conservatively if the diff metadata is thin.
- **Never edit files or externalize work.** Do not write `.context/systematic/ce-review/<run-id>/`, do not create todo files, and do not commit, push, or create a PR.
- **Report-only runs in memory.** Run raw-return structural validation, synthesis, and reporting without writing a run directory, artifact, or ignore file.
- **Safe for parallel read-only verification.** `mode:report-only` is the only mode that is safe to run concurrently with browser testing on the same checkout.
- **Do not switch the shared checkout.** If the caller passes an explicit PR or branch target, `mode:report-only` must run in an isolated checkout/worktree or stop instead of running `gh pr checkout` / `git checkout`.
- **Do not overlap mutating review with browser testing on the same checkout.** If a future orchestrator wants fixes, run the mutating review phase after browser testing or in an isolated checkout/worktree.

### Headless mode rules

- **Skip all user questions.** Never use the platform question tool (`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait) or other interactive prompts. Infer intent conservatively if the diff metadata is thin.
- **Require a determinable diff scope.** If headless mode cannot determine a diff scope (no branch, PR, or `base:` ref determinable without user interaction), emit `Review failed (headless mode). Reason: no diff scope detected. Re-invoke with a branch name, PR number, or base:<ref>.` and stop without dispatching agents.
- **Apply only `safe_auto -> review-fixer` findings in a single pass.** No bounded re-review rounds. Leave `gated_auto`, `manual`, `human`, and `release` work unresolved and return them in the structured output.
- **Return all non-auto findings as structured text output.** Use the headless output envelope format (see Stage 6 below) preserving severity, autofix_class, owner, requires_verification, confidence, pre_existing, and suggested_fix per finding. Enrich with detail-tier fields (why_it_matters, evidence[]) from the validated inline persona returns (see Detail enrichment in Stage 6).
- **Write a run artifact** under `.context/systematic/ce-review/<run-id>/` summarizing findings, applied fixes, and advisory outputs. Include the artifact path in the structured output.
- **Do not create todo files.** The caller receives structured findings and routes downstream work itself.
- **Do not switch the shared checkout.** If the caller passes an explicit PR or branch target, `mode:headless` must run in an isolated checkout/worktree or stop instead of running `gh pr checkout` / `git checkout`. When stopping, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.`
- **Not safe for concurrent use on a shared checkout.** Unlike `mode:report-only`, headless mutates files (applies `safe_auto` fixes). Callers must not run headless concurrently with other mutating operations on the same checkout.
- **Never commit, push, or create a PR** from headless mode. The caller owns those decisions.
- **End with "Review complete" as the terminal signal** so callers can detect completion. If all reviewers fail or time out, emit `Code review degraded (headless mode). Reason: 0 of N reviewers returned results.` followed by "Review complete".

## Severity Scale

All reviewers use P0-P3:

| Level | Meaning | Action |
|-------|---------|--------|
| **P0** | Critical breakage, exploitable vulnerability, data loss/corruption | Must fix before merge |
| **P1** | High-impact defect likely hit in normal usage, breaking contract | Should fix |
| **P2** | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward |
| **P3** | Low-impact, narrow scope, minor improvement | User's discretion |

## Action Routing

Severity answers **urgency**. Routing answers **who acts next** and **whether this skill may mutate the checkout**.

| `autofix_class` | Default owner | Meaning |
|-----------------|---------------|---------|
| `safe_auto` | `review-fixer` | Local, deterministic fix suitable for the in-skill fixer when the current mode allows mutation |
| `gated_auto` | `downstream-resolver` or `human` | Concrete fix exists, but it changes behavior, contracts, permissions, or another sensitive boundary that should not be auto-applied by default |
| `manual` | `downstream-resolver` or `human` | Actionable work that should be handed off rather than fixed in-skill |
| `advisory` | `human` or `release` | Report-only output such as learnings, rollout notes, or residual risk |

Routing rules:

- **Synthesis owns the final route.** Persona-provided routing metadata is input, not the last word.
- **Choose the more conservative route on disagreement.** A merged finding may move from `safe_auto` to `gated_auto` or `manual`, but never the other way without stronger evidence.
- **Only `safe_auto -> review-fixer` enters the in-skill fixer queue automatically.**
- **`requires_verification: true` means a fix is not complete without targeted tests, a focused re-review, or operational validation.**

## Reviewers

13 reviewer personas in layered conditionals, plus CE-specific conditional agents. See the persona catalog included below for the full catalog.

**Always-on (every review):**

| Agent | Focus |
|-------|-------|
| `systematic:correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation |
| `systematic:testing-reviewer` | Coverage gaps, weak assertions, brittle tests |
| `systematic:project-standards-reviewer` | AGENTS.md compliance -- frontmatter, references, naming, portability |

**Cross-cutting conditional (selected per diff):**

| Agent | Select when diff touches... |
|-------|---------------------------|
| `systematic:maintainability-reviewer` | Materially adds/reshapes abstractions, coupling, state/control-flow complexity, naming/ownership, dead code, or a broad refactor |
| `systematic:security-reviewer` | Auth, public endpoints, user input, permissions |
| `systematic:performance-reviewer` | DB queries, data transforms, caching, async |
| `systematic:api-contract-reviewer` | Routes, serializers, type signatures, versioning |
| `systematic:data-migrations-reviewer` | Migrations, schema changes, backfills |
| `systematic:reliability-reviewer` | Error handling, retries, timeouts, background jobs |
| `systematic:adversarial-reviewer` | >=50 changed lines of executable production code, excluding tests, generated files, lockfiles, instruction/prose Markdown, JSON schemas, and config; OR regardless of file type for auth, payments, data mutations, external APIs, or another explicitly high-risk domain |
| `systematic:cli-readiness-reviewer` | CLI command definitions, argument parsing, CLI framework usage, command handler implementations |
| `systematic:previous-comments-reviewer` | Reviewing a PR that has existing review comments or threads |

**Stack-specific conditional (selected per diff):**

| Agent | Select when diff touches... |
|-------|---------------------------|
| `systematic:kieran-typescript-reviewer` | TypeScript components, services, hooks, utilities, or shared types |

**CE conditional (selected per diff):**

| Agent | Select when diff includes... |
|-------|------------------------------|
| `systematic:agent-native-reviewer` | User- or agent-facing UI/CLI/tool/workflow capability, or a changed access path where agent parity/discoverability is material |
| `systematic:learnings-researcher` | Bug/regression/hardening work, a recurring failure class, a documented solution/module change, or a plan/PR citing relevant prior art |
| `systematic:deployment-verification-agent` | Database migrations, schema changes, or data backfills |

## Review Scope

Every review selects exactly the three always-on personas -- `correctness`, `testing`, and `project-standards` -- then adds the cross-cutting, stack-specific, and CE conditional agents that fit the diff. A tiny prose or fixture correction with no structural decision and no user- or agent-facing or other specialist surface selects only the core three; a structural refactor may add `maintainability`; an auth feature may add `security` and `reliability`. Reviewer count is an outcome, not a target or a success metric. All four modes (interactive, autofix, report-only, and headless) use the same reviewer-selection policy; only mutation and output behavior differ.

## Protected Artifacts

The following paths are systematic pipeline artifacts and must never be flagged for deletion, removal, or gitignore by any reviewer:

- `docs/brainstorms/*` -- requirements documents created by systematic:ce-brainstorm
- `docs/plans/*.md` -- plan files created by systematic:ce-plan (living documents with progress checkboxes)
- `docs/solutions/*.md` -- solution documents created during the pipeline

If a reviewer flags any file in these directories for cleanup or removal, discard that finding during synthesis.

## How to Run

### Stage 1: Determine scope

Compute the diff range, file list, and diff. Minimize permission prompts by combining into as few commands as possible.

**If `base:` argument is provided (fast path):**

The caller already knows the diff base. Skip all base-branch detection, remote resolution, and merge-base computation. Use the provided value directly:

```
BASE_ARG="{base_arg}"
BASE=$(git merge-base HEAD "$BASE_ARG" 2>/dev/null) || BASE="$BASE_ARG"
```

Then produce the same output as the other paths:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

This path works with any ref — a SHA, `origin/main`, a branch name. Automated callers (systematic:ce-work, lfg, slfg) should prefer this to avoid the detection overhead. **Do not combine `base:` with a PR number or branch target.** If both are present, stop with an error: "Cannot use `base:` with a PR number or branch target — `base:` implies the current checkout is already the correct branch. Pass `base:` alone, or pass the target alone and let scope detection resolve the base." This avoids scope/intent mismatches where the diff base comes from one source but the code and metadata come from another.

**If a PR number or GitHub URL is provided as an argument:**

If `mode:report-only` or `mode:headless` is active, do **not** run `gh pr checkout <number-or-url>` on the shared checkout. For `mode:report-only`, tell the caller: "mode:report-only cannot switch the shared checkout to review a PR target. Run it from an isolated worktree/checkout for that PR, or run report-only with no target argument on the already checked out branch." For `mode:headless`, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.` Stop here unless the review is already running in an isolated checkout.

First, verify the worktree is clean before switching branches:

```
git status --porcelain
```

If the output is non-empty, inform the user: "You have uncommitted changes on the current branch. Stash or commit them before reviewing a PR, or use standalone mode (no argument) to review the current branch as-is." Do not proceed with checkout until the worktree is clean.

Then check out the PR branch so persona agents can read the actual code (not the current checkout):

```
gh pr checkout <number-or-url>
```

Then fetch PR metadata. Capture the base branch name and the PR base repository identity, not just the branch name:

```
gh pr view <number-or-url> --json title,body,baseRefName,headRefName,url
```

Use the repository portion of the returned PR URL as `<base-repo>` (for example, `marcusrbrown/systematic` from `https://github.com/marcusrbrown/systematic/pull/348`).

Then compute a local diff against the PR's base branch so re-reviews also include local fix commits and uncommitted edits. Substitute the PR base branch from metadata (shown here as `<base>`) and the PR base repository identity derived from the PR URL (shown here as `<base-repo>`). Resolve the base ref from the PR's actual base repository, not by assuming `origin` points at that repo:

```
PR_BASE_REMOTE=$(git remote -v | awk 'index($(2), "github.com:<base-repo>") || index($(2), "github.com/<base-repo>") {print $(1); exit}')
if [ -n "$PR_BASE_REMOTE" ]; then PR_BASE_REMOTE_REF="$PR_BASE_REMOTE/<base>"; else PR_BASE_REMOTE_REF=""; fi
PR_BASE_REF=$(git rev-parse --verify "$PR_BASE_REMOTE_REF" 2>/dev/null || git rev-parse --verify <base> 2>/dev/null || true)
if [ -z "$PR_BASE_REF" ]; then
  if [ -n "$PR_BASE_REMOTE_REF" ]; then
    git fetch --no-tags "$PR_BASE_REMOTE" <base>:refs/remotes/"$PR_BASE_REMOTE"/<base> 2>/dev/null || git fetch --no-tags "$PR_BASE_REMOTE" <base> 2>/dev/null || true
    PR_BASE_REF=$(git rev-parse --verify "$PR_BASE_REMOTE_REF" 2>/dev/null || git rev-parse --verify <base> 2>/dev/null || true)
  else
    if git fetch --no-tags https://github.com/<base-repo>.git <base> 2>/dev/null; then
      PR_BASE_REF=$(git rev-parse --verify FETCH_HEAD 2>/dev/null || true)
    fi
    if [ -z "$PR_BASE_REF" ]; then PR_BASE_REF=$(git rev-parse --verify <base> 2>/dev/null || true); fi
  fi
fi
if [ -n "$PR_BASE_REF" ]; then BASE=$(git merge-base HEAD "$PR_BASE_REF" 2>/dev/null) || BASE=""; else BASE=""; fi
```

```
if [ -n "$BASE" ]; then echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard; else echo "ERROR: Unable to resolve PR base branch <base> locally. Fetch the base branch and rerun so the review scope stays aligned with the PR."; fi
```

Extract PR title/body, base branch, and PR URL from `gh pr view`, then extract the base marker, file list, diff content, and `UNTRACKED:` list from the local command. Do not use `gh pr diff` as the review scope after checkout -- it only reflects the remote PR state and will miss local fix commits until they are pushed. If the base ref still cannot be resolved from the PR's actual base repository after the fetch attempt, stop instead of falling back to `git diff HEAD`; a PR review without the PR base branch is incomplete.

**If a branch name is provided as an argument:**

Check out the named branch, then diff it against the base branch. Substitute the provided branch name (shown here as `<branch>`).

If `mode:report-only` or `mode:headless` is active, do **not** run `git checkout <branch>` on the shared checkout. For `mode:report-only`, tell the caller: "mode:report-only cannot switch the shared checkout to review another branch. Run it from an isolated worktree/checkout for `<branch>`, or run report-only on the current checkout with no target argument." For `mode:headless`, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.` Stop here unless the review is already running in an isolated checkout.

First, verify the worktree is clean before switching branches:

```
git status --porcelain
```

If the output is non-empty, inform the user: "You have uncommitted changes on the current branch. Stash or commit them before reviewing another branch, or provide a PR number instead." Do not proceed with checkout until the worktree is clean.

```
git checkout <branch>
```

Then detect the review base branch and compute the merge-base. Run the `references/resolve-base.sh` script, which handles fork-safe remote resolution with multi-fallback detection (PR metadata -> `origin/HEAD` -> `gh repo view` -> common branch names):

When this skill loads, its own directory is stated in the surrounding instructions; set `SKILL_DIR` to that directory because the scripts live beside this file.

```
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
RESOLVE_OUT=$(bash "$SKILL_DIR/references/resolve-base.sh") || { echo "ERROR: resolve-base.sh failed"; exit 1; }
if [ -z "$RESOLVE_OUT" ] || echo "$RESOLVE_OUT" | grep -q '^ERROR:'; then echo "${RESOLVE_OUT:-ERROR: resolve-base.sh produced no output}"; exit 1; fi
BASE=$(echo "$RESOLVE_OUT" | sed 's/^BASE://')
```

If the script outputs an error, stop instead of falling back to `git diff HEAD`; a branch review without the base branch would only show uncommitted changes and silently miss all committed work.

On success, produce the diff:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

You may still fetch additional PR metadata with `gh pr view` for title, body, and linked issues, but do not fail if no PR exists.

**If no argument (standalone on current branch):**

Detect the review base branch and compute the merge-base using the same `references/resolve-base.sh` script as branch mode:

```
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
RESOLVE_OUT=$(bash "$SKILL_DIR/references/resolve-base.sh") || { echo "ERROR: resolve-base.sh failed"; exit 1; }
if [ -z "$RESOLVE_OUT" ] || echo "$RESOLVE_OUT" | grep -q '^ERROR:'; then echo "${RESOLVE_OUT:-ERROR: resolve-base.sh produced no output}"; exit 1; fi
BASE=$(echo "$RESOLVE_OUT" | sed 's/^BASE://')
```

If the script outputs an error, stop instead of falling back to `git diff HEAD`; a standalone review without the base branch would only show uncommitted changes and silently miss all committed work on the branch.

On success, produce the diff:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

Using `git diff $BASE` (without `..HEAD`) diffs the merge-base against the working tree, which includes committed, staged, and unstaged changes together.

**Untracked file handling:** Always inspect the `UNTRACKED:` list, even when `FILES:`/`DIFF:` are non-empty. Untracked files are outside review scope until staged. If the list is non-empty, tell the user which files are excluded. If any of them should be reviewed, stop and tell the user to `git add` them first and rerun. Only continue when the user is intentionally reviewing tracked changes only. In `mode:headless` or `mode:autofix`, do not stop to ask — proceed with tracked changes only and note the excluded untracked files in the Coverage section of the output.

### Stage 2: Intent discovery

Understand what the change is trying to accomplish. The source of intent depends on which Stage 1 path was taken:

**PR/URL mode:** Use the PR title, body, and linked issues from `gh pr view` metadata. Supplement with commit messages from the PR if the body is sparse.

**Branch mode:** Run `git log --oneline ${BASE}..<branch>` using the resolved merge-base from Stage 1.

**Standalone (current branch):** Run:

```
echo "BRANCH:" && git rev-parse --abbrev-ref HEAD && echo "COMMITS:" && git log --oneline ${BASE}..HEAD
```

Combined with conversation context (plan section summary, PR description), write a 2-3 line intent summary:

```
Intent: Simplify tax calculation by replacing the multi-tier rate lookup
with a flat-rate computation. Must not regress edge cases in tax-exempt handling.
```

Pass this to every reviewer in their spawn prompt. Intent shapes *how hard each reviewer looks* and may clarify *what kind of surface* a change represents -- for example whether it is a bug/regression, an agent-facing capability, or a risk domain -- but it never selects a reviewer without a corresponding changed repository surface.

**When intent is ambiguous:**

- **Interactive mode:** Ask one question using the platform's interactive question tool (`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait): "What is the primary goal of these changes?" Do not spawn reviewers until intent is established.
- **Autofix/report-only/headless modes:** Infer intent conservatively from the branch name, diff, PR metadata, and caller context. Note the uncertainty in Coverage or Verdict reasoning instead of blocking.

### Stage 2b: Plan discovery (requirements verification)

Locate the plan document so Stage 6 can verify requirements completeness. Check these sources in priority order — stop at the first hit:

1. **`plan:` argument.** If the caller passed a plan path, use it directly. Read the file to confirm it exists.
2. **PR body.** If PR metadata was fetched in Stage 1, scan the body for paths matching `docs/plans/*.md`. If exactly one match is found and the file exists, use it as `plan_source: explicit`. If multiple plan paths appear, treat as ambiguous — demote to `plan_source: inferred` for the most recent match that exists on disk, or skip if none exist or none clearly relate to the PR title/intent. Always verify the selected file exists before using it — stale or copied plan links in PR descriptions are common.
3. **Auto-discover.** Extract 2-3 keywords from the branch name (e.g., `feat/onboarding-skill` -> `onboarding`, `skill`). Glob `docs/plans/*` and filter filenames containing those keywords. If exactly one match, use it. If multiple matches or the match looks ambiguous (e.g., generic keywords like `review`, `fix`, `update` that could hit many plans), **skip auto-discovery** — a wrong plan is worse than no plan. If zero matches, skip.

**Confidence tagging:** Record how the plan was found:
- `plan:` argument -> `plan_source: explicit` (high confidence)
- Single unambiguous PR body match -> `plan_source: explicit` (high confidence)
- Multiple/ambiguous PR body matches -> `plan_source: inferred` (lower confidence)
- Auto-discover with single unambiguous match -> `plan_source: inferred` (lower confidence)

If a plan is found, read its **Requirements Trace** (R1, R2, etc.) and **Implementation Units** (checkbox items). Store the extracted requirements list and `plan_source` for Stage 6. Do not block the review if no plan is found — requirements verification is additive, not required.

### Stage 3: Select reviewers

Read the diff and file list from Stage 1. Always select exactly the three always-on personas: `correctness`, `testing`, and `project-standards`. For each cross-cutting, stack-specific, and CE conditional in the persona catalog included below, decide whether the diff warrants it. This is agent judgment, not keyword matching. Intent, PR, and plan context may clarify whether a changed surface is a bug/regression, an agent-facing capability, or a risk domain, but they never select a reviewer without a corresponding changed repository surface.

- **`maintainability`** -- select when the diff materially adds or reshapes abstractions, raises cross-module coupling, adds state/control-flow complexity, changes naming or ownership structure, removes dead code, or performs a broad refactor. Do not select it for a tiny prose or fixture correction with no structural decision.
- **CE `agent-native-reviewer`** -- select for user- or agent-facing UI/CLI/tool/workflow capabilities or changed access paths where agent parity or discoverability is material.
- **CE `learnings-researcher`** -- select for bug, regression, or hardening work, a recurring failure class, a change to a documented solution or module, or a plan/PR that cites relevant prior art.
- **CE `deployment-verification-agent`** -- select for migrations, schema changes, or data backfills.
- **All other conditionals** -- preserve their catalog triggers: `security`, `performance`, `api-contract`, `data-migrations`, `reliability`, `adversarial`, `cli-readiness`, `previous-comments`, and `kieran-typescript`.

**File-type awareness for conditional selection:** Instruction-prose files (Markdown skill definitions, JSON schemas, config files) are product code but do not benefit from runtime-focused reviewers. The adversarial reviewer's techniques (race conditions, cascade failures, abuse cases) target executable code behavior. Select it for >=50 changed lines of executable production code -- excluding tests, generated files, lockfiles, instruction/prose Markdown, JSON schemas, and config -- or regardless of file type when the diff touches auth, payments, data mutations, external APIs, or another explicitly high-risk domain; count only executable production code lines toward the line-count threshold.

**`previous-comments` is PR-only.** Only select this persona when Stage 1 gathered PR metadata (PR number or URL was provided as an argument, or `gh pr view` returned metadata for the current branch). Skip it entirely for standalone branch reviews with no associated PR -- there are no prior comments to check.

Stack-specific personas are additive. A TypeScript API diff may warrant `kieran-typescript` plus `api-contract` and `reliability`.

Record `selection_reason` and a non-empty `selection_surface` for each selected structured conditional persona; core personas may omit both. Pass the selection reason and surface into the structured reviewer prompt. CE conditional agents receive the same reason/surface in their unstructured prompt and report it in the team and Coverage; they never receive a raw-return dispatch record.

A selected risk-critical reviewer's failure (`malformed`, `never_returned`, or `validation_unavailable`) remains blocking and cannot disappear from Coverage by shrinking the reported team; it stays blocking unless a qualifying validated finding from another persona covers the lost surface.

Announce the team before spawning:

```
Review team (all four modes use the same reviewer-selection policy):
- correctness (core)
- testing (core)
- project-standards (core)
- maintainability -- structural refactor reshaped the merge pipeline
- security -- new endpoint in routes.rb accepts a user-provided redirect URL
- data-migrations -- adds migration 20260303_add_index_to_orders
- agent-native-reviewer -- new export CLI capability
- No other conditional selected: no additional surface triggered
```

This is progress reporting, not a blocking confirmation. Distinguish core reviewers, each selected conditional with a one-line rationale and its triggering repository-relative paths/surfaces, an explicit "no conditional selected" case, and any selected-but-failed/malformed/validation-unavailable reviewer. Never label an unselected reviewer as failed.

Record each structured conditional persona's selection reason and triggering repository-relative paths on its dispatch record; see the [synthesis artifact contract](./references/synthesis-artifact-contract.md) for the field semantics.

**Execution probes.** An execution probe is a separate parent decision, independent of reviewer selection, not a reviewer and not a substitute for risk-critical coverage. A pure renderer or asset-delivery change with no conditional surface may warrant one focused runtime or browser probe, but a change that separately triggers `agent-native-reviewer`, `security`, or another conditional still selects those reviewers. A probe never adds `maintainability` and never restores a reviewer floor; when selected, record the probe target and its permission boundary in Coverage.

### Stage 3b: Discover project standards paths

Before spawning sub-agents, find the file paths (not contents) of all relevant standards files for the `project-standards` persona. Use the native file-search/glob tool to locate:

1. Use the native file-search tool (e.g., Glob in OpenCode) to find all `**/AGENTS.md` and `**/AGENTS.md` in the repo.
2. Filter to those whose directory is an ancestor of at least one changed file. A standards file governs all files below it (e.g., `plugins/systematic/AGENTS.md` applies to everything under `plugins/systematic/`).

Pass the resulting path list to the `project-standards` persona inside a `<standards-paths>` block in its review context (see Stage 4). The persona reads the files itself, targeting only the sections relevant to the changed file types. This keeps the orchestrator's work cheap (path discovery only) and avoids bloating the subagent prompt with content the reviewer may not fully need.

### Stage 4: Spawn sub-agents

#### Sub-agent dispatch and model policy

Persona sub-agents do focused, scoped work. Dispatch the named bundled agent for each role so the user's configured model assignment applies; the orchestrator itself stays on the default model.

Dispatch named bundled agents for all persona and CE sub-agents. The named agent applies the user's configured model assignment; model policy is user-owned configuration, not a skill-level dispatch parameter.

The same applies to CE conditional agents (`systematic:agent-native-reviewer`, `systematic:learnings-researcher`, `systematic:deployment-verification-agent`): dispatch each by its bundled name so its configured assignment applies.

The orchestrator (this skill) stays on the default model because it handles intent discovery, reviewer selection, finding merge/dedup, and synthesis -- tasks that benefit from stronger reasoning.

#### Ignore preparation (writing modes only)

Before the first artifact-directory creation in interactive, autofix, or headless mode, invoke the producer-local ignore-preparation helper:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/ensure-ignore.mjs" --root "."
```

`--root "."` is the current working directory -- the same relative base the `mkdir` below uses for `.context/systematic/ce-review/$RUN_ID`. Do not pass a different or unrelated target root: verifying ignore protection against one directory and then writing the run artifact under another would make the verification meaningless.

Exit 0 with `status: "protected"` or `status: "not-applicable"` permits persistence to continue. Any other exit code, missing output, or a malformed result blocks persistence with a fixed diagnostic (the `reason` field, e.g. `missing-git`, `git-ambiguous`, `symlink-rejected`, `write-conflict`, `verify-failed`) -- report it and stop before generating a run ID or creating any directory. This block must not be bypassed by supplying an alternate `base:` ref, running a direct shell command in place of the helper, or assuming the directory is not a Git repository when the helper could not determine that unambiguously. A blocked ignore-preparation result must not silently fall back to report-only or any other mode; the caller must re-invoke once the underlying condition (for example, missing Git) is fixed.

**Report-only mode:** Skip run-id generation, directory creation, and ignore preparation entirely; the ignore helper is never invoked in this mode, consistent with report-only's no-write contract.

#### Run ID

Generate a unique run identifier before dispatching any agents. This ID scopes the parent-owned per-agent records and the post-review run artifact to the same directory.

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
mkdir -p ".context/systematic/ce-review/$RUN_ID"
```

Keep `{run_id}` in the parent orchestrator. Do not pass it, an artifact path, or any write instruction to persona sub-agents. The parent writes a per-agent record only after the returned payload passes validation.

Capture the actual invoking harness once in the parent (`opencode`, `pi`, or `claude-code`). Do not infer it from persona metadata or declared tools. Add this parent-owned value to each persisted record and to the synthesis artifact so R6 remains explicit. `mode:report-only` still records nothing because it has no run artifact.

#### Spawning

Omit the `mode` parameter when dispatching sub-agents so the user's configured permission settings apply. Do not pass `mode: "auto"`.

Spawn each selected persona reviewer as a parallel sub-agent using the subagent template included below. Each persona sub-agent receives:

1. Their persona file content (identity, failure modes, calibration, suppress conditions)
2. Shared diff-scope rules from the diff-scope reference included below
3. The JSON output contract from the findings schema included below
4. PR metadata: title, body, and URL when reviewing a PR (empty string otherwise). Passed in a `<pr-context>` block so reviewers can verify code against stated intent
5. Review context: intent summary, file list, diff
6. Reviewer name for the returned `reviewer` field
7. **Selected structured conditionals only:** the `selection_reason` and non-empty `selection_surface` from Stage 3, passed into the review context. Core personas receive empty values for both
8. **For `project-standards` only:** the standards file path list from Stage 3b, wrapped in a `<standards-paths>` block appended to the review context

Persona sub-agents are **read-only** with respect to the project: they review and return structured JSON. They do not edit project files, write artifacts, or propose refactors. The parent orchestrator owns all persistence.

Read-only here means **non-mutating**, not "no shell access." Reviewer sub-agents may use non-mutating inspection commands when needed to gather evidence or verify scope, including read-oriented `git` / `gh` usage such as `git diff`, `git show`, `git blame`, `git log`, and `gh pr view`. They must not edit project files, change branches, commit, push, create PRs, or otherwise mutate the checkout or repository state.

Each persona sub-agent returns one full JSON payload (all schema fields) to the parent:

```json
{
  "reviewer": "security",
  "findings": [
    {
      "title": "User-supplied ID in account lookup without ownership check",
      "severity": "P0",
      "file": "orders_controller.rb",
      "line": 42,
      "confidence": 0.92,
      "autofix_class": "gated_auto",
      "owner": "downstream-resolver",
      "requires_verification": true,
      "pre_existing": false,
      "why_it_matters": "An unowned lookup can expose another account's orders.",
      "evidence": [
        "orders_controller.rb:42 uses params[:id] without an ownership guard."
      ],
      "suggested_fix": "Add current_user.owns?(account) guard before lookup"
    }
  ],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

`why_it_matters` and `evidence` are returned inline with the merge-tier fields. `suggested_fix` remains optional. The parent validates the complete payload before writing any per-agent record; a malformed or rejected return is never partially persisted.

Returning the detail tier inline increases parent context per persona. The previous compact/detail split kept synthesis context lean, so this is an intentional cost of deleting the sub-agent write path. Verify it against a real multi-persona run. If it materially degrades synthesis, use a second targeted request per persona and keep the write parent-side; never restore sub-agent disk access.

**CE conditional agents** (agent-native-reviewer, learnings-researcher) are dispatched as standard Agent calls when their Stage 3 triggers apply, in parallel with the persona agents. Give them the same review context bundle the personas receive (entry mode, any PR metadata gathered in Stage 1, intent summary, review base branch name when known, `BASE:` marker, file list, diff, and `UNTRACKED:` scope notes) plus the selection reason and triggering surface. Do not invoke them with a generic "review this" prompt. Their output is unstructured and synthesized separately in Stage 6; they never receive a raw-return dispatch record.

**CE conditional agents** (deployment-verification-agent) are also dispatched as standard Agent calls when applicable. Pass the same review context bundle plus the selection reason and triggering surface (for example, which migration files triggered the agent). Their output is unstructured and must be preserved for Stage 6 synthesis just like the other CE conditional agents.

#### Screen each return (all modes)

Before parsing a persona return into fields, assessing evidence, synthesizing, or persisting anything, admit it with the packaged structural validator's `screen` phase. `screen` replaces the former separate raw-return-admission and dispatch-identity-binding steps with one call: it structurally admits the return and binds it to the dispatched persona in the same pass. Invoke it through this skill's own installed directory (`node "$SKILL_DIR/scripts/validate-review.mjs" screen --reviewer <persona> --harness <opencode|pi|claude-code>`, the raw return on stdin through a fresh single-quoted heredoc delimiter) so every harness resolves the same committed bytes. The full envelope shape, the fresh-delimiter rules, and the invocation block are in [pipeline invocation: screen](./references/pipeline-invocation.md#screen).

Read the exit status:

- **exit 0** — structurally admitted. Parse the already structurally validated JSON without logging the raw text; the parent adds `harness` and `dispatch_outcome` from the result to the persisted per-agent dispatch record. `exit 0` with zero findings is `dispatch_outcome: "empty"`; `exit 0` with findings is `dispatch_outcome: "findings"`, each finding already carrying a stable `input_id` and `disposition: "surviving"`.
- **exit 1** — the whole return is `dispatch_outcome: "malformed"`, and the parent must never parse or persist its payload fields or values; retain only the bounded validator diagnostic in Coverage. This covers malformed JSON, a schema violation, and a dispatch identity mismatch alike.
- **exit 2**, a missing or unreadable helper, or a command launch failure — validation unavailable. Withhold the return and report the exact unavailability and what was withheld. Update that selected persona's preinitialized dispatch entry from `never_returned` to `dispatch_outcome: "validation_unavailable"` with `input_finding_count: 0` and, optionally, a safe `rejection_reason` naming the exit status, missing helper, or launch failure without payload values; set `run_status` to `degraded`. A run that contains `validation_unavailable` evidence can never finalize as `completed`, and that persona must not have an admitted input finding. Never omit the dispatch entry, never leave it as `never_returned`, never label it `malformed`, never admit the payload, and never fabricate a reviewer record or a rejected-summary ledger row. The word `unavailable` also names the artifact-level self-validation status, a different object and phase; never repurpose the artifact-level `validation` fields.

**Dispatch identity binding.** `screen` confirms the returned `reviewer` field matches the dispatched persona before it admits anything; an identity mismatch is rejected as `dispatch_outcome: "malformed"` and degrades the run. This comparison happens inside the same exit 0/exit 1 decision above, before the parent parses a single finding field -- structural admission never proves identity on its own.

A task that did not return is `never_returned`: a task-lifecycle fact recorded without invoking the validator. Validation unavailable is not malformed and is not never_returned; they are distinct coverage states. The public `systematic validate-review-return` command is an operator/development fallback selected before invocation, never a fallback chosen because a validator run exited 1 or 2.

Structural validity never implies evidence validity. A return that passes `screen` is admitted structurally only. The parent must still assess evidence for its claims, and only then add parent annotations, persist, or synthesize -- a wrong-checkout or unsupported citation remains unverified until current-target evidence resolves it.

A helper failure is never permission to hand-synthesize an admitted finding, a dispatch outcome, or a rejected-summary row; see [Never-bypass](./references/pipeline-invocation.md#never-bypass) for the retry and correction protocol every phase shares.

### Stage 5: Merge findings

The parent-owned artifact and its reconciliation rules are defined in the [synthesis artifact contract](./references/synthesis-artifact-contract.md). Stage 5 no longer computes the confidence gate, candidate grouping, cross-reviewer agreement, route narrowing, partitioning, sorting, or coverage union by hand -- the `prepare` and `merge` phases of the packaged validator compute all of it deterministically. The model's remaining job is adjudication: deciding, for each file's candidate group, which findings describe the same underlying defect, and proposing each merged finding's narrative and route.

1. **Assemble every screen result.** Collect the `screen` output for every persona that returned (including `malformed`, `never_returned`, and `validation_unavailable` entries), plus the Stage 3 selection record (`selected_dispatches`), into the `prepare` input envelope. See [pipeline invocation: prepare](./references/pipeline-invocation.md#prepare) for the exact shape and invocation.
2. **Run `prepare`.** It applies the confidence gate (suppress below 0.60, except P0 at 0.50+ survives), groups admitted findings into candidate groups by `normalize(file)` (never by line), sorts each group's members by line, and unions selection-surface coverage. Its output's `singletons` need no adjudication; its `candidate_groups` do.
3. **Adjudicate every candidate group.** For each group, decide whether its members describe the same underlying defect (merge) or genuinely different defects (decline). Adjacency creates a candidate, not a conclusion -- findings on the same line describing different defects must stay declined. For a merge decision, write the merged finding's `title`, `why_it_matters`, `evidence`, and `line`, plus (when the route should narrow) a `proposed_route` with a `route_narrowing_reason`; optionally note `disagreement_facts` when reviewers disagreed on severity/autofix_class/owner, and `eligible_agreement_credit` for personas that agree without their own input finding in the group. For a decline decision, write a `declined_reason`. Every candidate-group member must be cited by exactly one decision -- no omissions, no double-citations.

   Worked example: at `src/lib/model-availability.ts:139`, reliability's `Config hook awaits providers API without a timeout` and adversarial's `Config startup can hang forever behind a stalled /config` describe the same underlying defect in different words, so they merge.
4. **Run `merge`.** It applies the adjudication envelope to `prepare`'s output, deriving each merged finding's severity, the cross-reviewer-agreement-boosted confidence (+0.10, capped at 1.0, for a merge with 2+ independent submitters), the fingerprint (`normalize(file) + "|" + line`), and the conservatively narrowed `autofix_class`/`owner`/`requires_verification` -- synthesis may narrow a route, never widen it without new evidence. It also returns `validator_requests`: the merged findings that need Stage 5b validation. See [pipeline invocation: merge](./references/pipeline-invocation.md#merge).
5. **Preserve CE agent artifacts.** Keep the outputs of the selected learnings, agent-native, schema-drift, and deployment-verification agents alongside the merged finding set for Stage 6 rendering. Do not drop unstructured agent output just because it does not match the persona JSON schema.

A helper failure (`prepare` or `merge` exiting 1 or 2) is never permission to hand-assemble a merged finding, a route, or a confidence value; see [Never-bypass](./references/pipeline-invocation.md#never-bypass).

### Stage 5b: Validation pass

Dispatch validators for exactly the findings `merge`'s `validator_requests` names -- the P0/P1-or-`requires_verification` gating band is already computed; Stage 5b no longer identifies the gated set by hand.

1. For each entry in `validator_requests`, spawn one validator subagent in parallel using the validator template at `references/validator-template.md`. Look up that finding's full fields (title, why_it_matters, evidence, file, line, severity, autofix_class, owner, suggested_fix) from `merge`'s `merged_findings` by `finding_id`, and pass them along with the intent summary, file list, and full diff.
2. Collect `{outcome: 'true'|'false'|'failed'|'unavailable', reason?}` from each validator, keyed by `finding_id`. `outcome: 'true'` needs no reason; the other three outcomes each require one.
3. Carry every result forward as `validator_lifecycle_results` into `finalize` (Stage 6). Do not reconcile filtered findings, update ledger dispositions, or recompute the "Filtered (not validated)" group by hand -- `finalize` derives all of it from these results plus `merge`'s output.

**Outcome semantics** (enforced by `finalize`, not the model): `true` validates the finding -- it flows to Stage 6 unchanged. `false` filters the finding -- it drops out of the surviving/actioned set, receives disposition `filtered` with the validator's exact one-sentence reason, and appears in the "Filtered (not validated)" group. `failed` and `unavailable` leave the finding actionable and unvalidated (no `validated` annotation; it appears in the normal severity tables) but each records a lifecycle failure that marks the run `degraded` and blocks a clean verdict -- report the failed/unavailable validator in Coverage rather than silently treating it as validated.

Findings outside the gating band (no `validator_requests` entry) carry no `validated` annotation and appear in Stage 6 severity tables unchanged.

### Stage 6: Synthesize and present

Call `finalize` with `applied_fixes: []` to synthesize the run's report projection -- verdict, findings, coverage, disposition counts, and every queue (`fixer`, `residual`, `report_only`) -- from `merge`'s output, `prepare`'s output, the screen results, the dispatch records, the Stage 5b validator lifecycle results, and the Stage 2b plan assessment below. See [pipeline invocation: finalize](./references/pipeline-invocation.md#finalize) for the exact envelope. This first call's `report.queues` feeds the post-review action sets directly (see Step 1 under [After Review](#after-review)); a fix-applying mode calls `finalize` again after fixes land with the real `applied_fixes`, and only that second call is persisted.

**Plan assessment.** Read the plan's Requirements Trace and Implementation Units located in Stage 2b, and check each one against the diff: met / not addressed / partially addressed. For every requirement or unit not clearly met, produce one plan-assessment result:

- **`explicit_unmet_requirement`** -- the plan is `plan_source: explicit` (caller-provided or an unambiguous PR body match) and a stated requirement is unaddressed. Routes to residual actionable work and blocks a clean verdict.
- **`inferred_gap`** -- the plan is `plan_source: inferred` (auto-discovered), or the gap is a suspicion rather than a stated requirement. Routes to advisory-only output and never blocks the verdict by itself.

Neither kind becomes a finding -- `finalize` routes `results` directly into `residual_actionable_work` or `advisory_outputs` strings, never into the severity tables. Omit plan assessment entirely when no plan was found in Stage 2b -- do not mention the absence of a plan, and pass an empty `results` array so `finalize` neither fabricates a gap nor silently relaxes the verdict gate.

Assemble the final report using **pipe-delimited markdown tables for findings** from the review output template included below, rendering `finalize`'s report projection directly -- do not recompute any of the fields it already derived. The table format is mandatory for finding rows in interactive mode — do not render findings as freeform text blocks or horizontal-rule-separated prose. Other report sections (Applied Fixes, Learnings, Coverage, etc.) use bullet lists and the `---` separator before the verdict, as shown in the template.

1. **Header.** Scope, intent, mode, harness, reviewer team with per-conditional justifications.
2. **Findings.** Rendered as pipe-delimited tables grouped by severity (`### P0 -- Critical`, `### P1 -- High`, `### P2 -- Moderate`, `### P3 -- Low`) from `report.findings`. Each finding row shows `#`, file, issue, reviewer(s), confidence, and synthesized route. Omit empty severity levels. Never render findings as freeform text blocks or numbered lists. Only findings with `validated: true` (or no `validated` annotation) appear in these tables.
3. **Requirements Completeness.** Include only when a plan was found in Stage 2b. Render the met/not-addressed/partially-addressed checklist from the plan-assessment step above, then list `report.residual_actionable_work` and `report.advisory_outputs` as their own bullet lists -- these are plain descriptions, not findings, and never gain a file/line/route. Omit this section entirely when no plan was found.
4. **Applied Fixes.** Include only if a fix phase ran in this invocation.
5. **Residual Actionable Work.** Render `report.queues.residual` as a table of findings whose owner is `downstream-resolver`, using `report.input_dispositions` to resolve each entry's fields.
6. **Pre-existing.** Render `report.pre_existing_findings`. Separate section, does not count toward verdict.
7. **Filtered (not validated).** Include when `report.findings` contains any entry with `validated: false`. Render as a pipe-delimited table with columns `#`, `File`, `Issue`, `Reviewer`, `Confidence`, `Validator reason`. These findings are surfaced for human review — they are not removed from the report. The validator found evidence that the issue may not be real in the code as written, was not introduced by this diff, or is already handled elsewhere; the human reviewer makes the final call. Omit this section when no findings were filtered.
8. **Learnings & Past Solutions.** Render only when CE `learnings-researcher` was selected and returned relevant output: if past solutions are relevant, flag them as "Known Pattern" with links to docs/solutions/ files. Omit the section otherwise.
9. **Agent-Native Gaps.** Render only when CE `agent-native-reviewer` was selected and returned relevant output. Omit the section otherwise.
10. **Deployment Notes.** If deployment-verification-agent ran, surface the key Go/No-Go items: blocking pre-deploy checks, the most important verification queries, rollback caveats, and monitoring focus areas. Keep the checklist actionable rather than dropping it into Coverage.
11. **Coverage.** Render `report.coverage` directly: suppressed count, residual risks, testing gaps, failed/timed-out reviewers, validator lifecycle failures (`failed`/`unavailable` outcomes from Stage 5b), risk-coverage entries with citing input finding IDs and exit conditions for blocked entries, and any intent uncertainty carried by non-interactive modes. For raw returns, state each selected persona's admission state — `findings`, `empty`, `malformed`, `never_returned`, `validation_unavailable` (the persisted raw dispatch outcome; distinct from the artifact-level `validation.status: "unavailable"`) — and what was admitted or withheld. Report admission states here only; do not add fields to `review-summary.v1`. Distinguish core reviewers, each selected conditional with its one-line rationale and triggering repository-relative paths, an explicit "no conditional selected" case, and any selected-but-failed/malformed/validation-unavailable reviewer; never label an unselected reviewer as failed.
12. **Verdict.** Render `report.verdict` directly: Ready to merge / Ready with fixes / Not ready, with fix order if applicable. `finalize` already applies the risk-aware degraded verdict rule and the plan-assessment gate from the [synthesis artifact contract](./references/synthesis-artifact-contract.md) -- do not recompute or override it.

Do not include time estimates.

**Format verification:** Before delivering the report, verify the findings sections use pipe-delimited table rows (`| # | File | Issue | ... |`) not freeform text. If you catch yourself rendering findings as prose blocks separated by horizontal rules or bullet points, stop and reformat into tables.

### Headless output format

In `mode:headless`, replace the interactive pipe-delimited table report with a structured text envelope. The envelope follows the same structural pattern as document-review's headless output (completion header, metadata block, findings grouped by autofix_class, trailing sections) while using systematic:ce-review's own section headings and per-finding fields.

```
Code review complete (headless mode).

Scope: <scope-line>
Intent: <intent-summary>
Reviewers: <reviewer-list with conditional justifications>
Verdict: <Ready to merge | Ready with fixes | Not ready>
Artifact: .context/systematic/ce-review/<run-id>/review-summary.json

Applied N safe_auto fixes.

Gated-auto findings (concrete fix, changes behavior/contracts):

[P1][gated_auto -> downstream-resolver][needs-verification] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>
  Suggested fix: <suggested_fix or "none">
  Evidence: <evidence[0]>
  Evidence: <evidence[1]>

Manual findings (actionable, needs handoff):

[P1][manual -> downstream-resolver] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>
  Evidence: <evidence[0]>

Advisory findings (report-only):

[P2][advisory -> human] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>

Pre-existing issues:
[P2][gated_auto -> downstream-resolver] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>

Filtered (not validated):
[P1][gated_auto -> downstream-resolver] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Validator reason: <one-sentence reason from the validator>

Residual risks:
- <risk>

Learnings & Past Solutions:
- <learning>

Agent-Native Gaps:
- <gap description>

Schema Drift Check:
- <drift status>

Deployment Notes:
- <deployment note>

Testing gaps:
- <gap>

Coverage:
- Suppressed: <N> findings below 0.60 confidence (P0 at 0.50+ retained)
- Filtered (not validated): <N> findings surfaced for human review
- Untracked files excluded: <file1>, <file2>
- Failed reviewers: <reviewer>

Review complete
```

**Detail enrichment (headless only):** The headless envelope includes `Why:`, `Evidence:`, and `Suggested fix:` lines. `finalize`'s report projection already carries `why_it_matters`, `evidence`, and `suggested_fix` inline on every finding in `report.findings` -- render them directly. No in-memory matching against persona returns is needed or performed; that matching step is obsolete now that `merge` derives every detail-tier field as part of the merged finding itself.

**Formatting rules:**
- The `[needs-verification]` marker appears only on findings where `requires_verification: true`.
- The `Artifact:` line gives callers the path to the parent-written `review-summary.json` for machine-readable access to the complete findings schema, provenance, dispatch outcomes, and disposition ledger. The text envelope is the primary handoff; the artifact is for debugging and full-fidelity access.
- Findings with `owner: release` appear in the Advisory section (they are operational/rollout items, not code fixes).
- Findings with `pre_existing: true` appear in the Pre-existing section regardless of autofix_class.
- Findings with `validated: false` from Stage 5b appear in the "Filtered (not validated)" section. They are surfaced for human review — not removed. Include the validator reason on the indented `Validator reason:` line.
- The Verdict appears in the metadata header (deliberately reordered from the interactive format where it appears at the bottom) so programmatic callers get the verdict first.
- Omit any section with zero items.
- If all reviewers fail or time out, emit `Code review degraded (headless mode). Reason: 0 of N reviewers returned results.` followed by "Review complete".
- End with "Review complete" as the terminal signal so callers can detect completion.

## Quality Gates

Before delivering the review, verify:

1. **Every finding is actionable.** Re-read each finding. If it says "consider", "might want to", or "could be improved" without a concrete fix, rewrite it with a specific action. Vague findings waste engineering time.
2. **No false positives from skimming.** For each finding, verify the surrounding code was actually read. Check that the "bug" isn't handled elsewhere in the same function, that the "unused import" isn't used in a type annotation, that the "missing null check" isn't guarded by the caller.
3. **Severity is calibrated.** A style nit is never P0. A SQL injection is never P3. Re-check every severity assignment.
4. **Line numbers are accurate.** Verify each cited line number against the file content. A finding pointing to the wrong line is worse than no finding.
5. **Protected artifacts are respected.** Discard any findings that recommend deleting or gitignoring files in `docs/brainstorms/`, `docs/plans/`, or `docs/solutions/`.
6. **Findings don't duplicate linter output.** Don't flag things the project's linter/formatter would catch (missing semicolons, wrong indentation). Focus on semantic issues.

## Language-Aware Conditionals

This skill uses stack-specific reviewer agents when the diff clearly warrants them. Keep those agents opinionated. They are not generic language checkers; they add a distinct review lens on top of the core and cross-cutting personas.

Do not spawn them mechanically from file extensions alone. The trigger is meaningful changed behavior, architecture, or UI state in that stack.

## After Review

### Mode-Driven Post-Review Flow

After presenting findings and verdict (Stage 6), route the next steps by mode. Review and synthesis stay the same in every mode; only mutation and handoff behavior changes.

#### Step 1: Build the action sets

Call `finalize` with `applied_fixes: []` (see [Stage 6](#stage-6-synthesize-and-present)) and read the action sets directly from `report.queues` -- do not recompute them by hand.

- **Clean review** means `report.queues.fixer`, `report.queues.residual`, and `report.queues.report_only` are all empty. Skip the fix/handoff phase when the review is clean.
- **Fixer queue:** `report.queues.fixer` -- findings routed to `safe_auto -> review-fixer`.
- **Residual actionable queue:** `report.queues.residual` -- unresolved `gated_auto` or `manual` findings whose final owner is `downstream-resolver`.
- **Report-only queue:** `report.queues.report_only` -- `advisory` findings and any outputs owned by `human` or `release`.
- **Never convert advisory-only outputs into fix work or todos.** Deployment notes, residual risks, `report.advisory_outputs`, and release-owned items stay in the report.

#### Step 2: Choose policy by mode

**Interactive mode**

- Apply `safe_auto -> review-fixer` findings automatically without asking. These are safe by definition.
- Ask a policy question **using the platform's blocking question tool** (`question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini; in Pi, use the blocking-question extension if available, otherwise present numbered options in chat and wait) only when `gated_auto` or `manual` findings remain after safe fixes. Do not replace with a conversational open-ended question. Adapt the options to match what actually remains:

  **When `gated_auto` findings are present** (with or without `manual`):
  ```
  Safe fixes have been applied. What should I do with the remaining findings?
  1. Review and approve specific gated fixes (Recommended)
  2. Leave as residual work
  3. Report only -- no further action
  ```

  **When only `manual` findings remain** (no `gated_auto`):
  ```
  Safe fixes have been applied. The remaining findings need manual resolution. What should I do?
  1. Leave as residual work (Recommended)
  2. Report only -- no further action
  ```

  If no blocking question tool is available, present the applicable numbered options as text and wait for the user's selection before proceeding.
- If no `gated_auto` or `manual` findings remain after safe fixes, skip the policy question entirely — report what was fixed and proceed to next steps.
- Only include `gated_auto` findings in the fixer queue after the user explicitly approves the specific items. Do not widen the queue based on severity alone.

**Autofix mode**

- Ask no questions.
- Apply only the `safe_auto -> review-fixer` queue.
- Leave `gated_auto`, `manual`, `human`, and `release` items unresolved.
- Prepare residual work only for unresolved actionable findings whose final owner is `downstream-resolver`.

**Report-only mode**

- Ask no questions.
- Do not build a fixer queue.
- Do not create residual todos or `.context` artifacts.
- Stop after Stage 6. Everything remains in the report.

**Headless mode**

- Ask no questions.
- Apply only the `safe_auto -> review-fixer` queue in a single pass. Do not enter the bounded re-review loop (Step 3). Spawn one fixer subagent, apply fixes, then proceed directly to Step 4.
- Leave `gated_auto`, `manual`, `human`, and `release` items unresolved — they appear in the structured text output.
- Output the headless output envelope (see Stage 6) instead of the interactive report.
- Write a run artifact (Step 4) but do not create todo files.
- Stop after the structured text output and "Review complete" signal. No commit/push/PR.

#### Step 3: Apply fixes with one fixer and bounded rounds

- Spawn exactly one fixer subagent for the current fixer queue in the current checkout. That fixer applies all approved changes and runs the relevant targeted tests in one pass against a consistent tree.
- Do not fan out multiple fixers against the same checkout. Parallel fixers require isolated worktrees/branches and deliberate mergeback.
- Re-review only the changed scope after fixes land.
- Bound the loop with `max_rounds: 2`. If issues remain after the second round, stop and hand them off as residual work or report them as unresolved.
- If any applied finding has `requires_verification: true`, the round is incomplete until the targeted verification runs.
- Do not start a mutating review round concurrently with browser testing on the same checkout. Future orchestrators that want both must either run `mode:report-only` during the parallel phase or isolate the mutating review in its own checkout/worktree.

#### Step 4: Emit artifacts and downstream handoff

- In interactive, autofix, and headless modes, write **`review-summary.json` unconditionally** under `.context/systematic/ce-review/<run-id>`; `mode:report-only` remains the deliberate no-write exception.
- If a fix phase ran (Step 3), call `finalize` again with the exact applied-fix outcomes in `parent_run_metadata.applied_fixes` and the same `validator_lifecycle_results` used in Step 1; only this second call's output is persisted. If no fix phase ran, Step 1's call already is the output to persist -- do not call `finalize` a third time.
- `review-summary.json` is the persisted call's `artifact` value, written verbatim. `finalize`'s writing-mode stdout is the wrapper `{ kind: 'writing', artifact, report }`, so extract only its `artifact` member -- never the whole wrapper -- and write that JSON to a same-directory temp file created exclusively with owner-only permissions inside `.context/systematic/ce-review/<run-id>`, then atomically rename it over `review-summary.json`; remove the temp file on any non-success. See [Persisting the artifact](./references/pipeline-invocation.md#persisting-the-artifact).
- After the rename, run the existing `artifact` subcommand on the persisted file exactly as before; see the [artifact validation and failure path](./references/synthesis-artifact-contract.md#artifact-validation).
- `review-summary.json`'s lifecycle, dispatch outcomes, complete input ledger, synthesized and filtered findings with provenance, disposition counts, and downstream work are defined in the [canonical synthesis artifact contract](./references/synthesis-artifact-contract.md), whose vocabulary and bounds are executable in [`findings-schema.json`](./references/findings-schema.json).
- Capture `branch` and `head_sha` at dispatch time, before any autofixes land, and pass them in `parent_run_metadata` with `completed_at` when the verdict is finalized; see the [canonical synthesis artifact contract](./references/synthesis-artifact-contract.md) for the provenance semantics.
- In autofix mode, create durable todo files only for unresolved actionable findings whose final owner is `downstream-resolver` (`report.queues.residual`). Load the `todos` skill (Create section) for the canonical directory path, naming convention, YAML frontmatter structure, and template. Each todo should map the finding's severity to the todo priority (`P0`/`P1` -> `p1`, `P2` -> `p2`, `P3` -> `p3`) and set `status: ready` since these findings have already been triaged by synthesis.
- Do not create todos for `advisory` findings, `owner: human`, `owner: release`, or protected-artifact cleanup suggestions.
- If only advisory outputs remain, create no todos.
- Interactive mode may offer to externalize residual actionable work after fixes, but it is not required to finish the review.
- Report-only mode never runs this step (no ignore preparation, no run directory, no temp file, no artifact write, no `artifact` subcommand validation): it calls `finalize` once (Step 1) and renders `report` directly, in memory.

#### Step 5: Final next steps

**Interactive mode only:** after the fix-review cycle completes (clean verdict or the user chose to stop), offer next steps based on the entry mode. Reuse the resolved review base/default branch from Stage 1 when known; do not hard-code only `main`/`master`.

- **PR mode (entered via PR number/URL):**
  - **Push fixes** -- push commits to the existing PR branch
  - **Exit** -- done for now
- **Branch mode (feature branch with no PR, and not the resolved review base/default branch):**
  - **Create a PR (Recommended)** -- push and open a pull request
  - **Continue without PR** -- stay on the branch
  - **Exit** -- done for now
- **On the resolved review base/default branch:**
  - **Continue** -- proceed with next steps
  - **Exit** -- done for now

If "Create a PR": first publish the branch with `git push --set-upstream origin HEAD`, then use `gh pr create` with a title and summary derived from the branch changes.
If "Push fixes": push the branch with `git push` to update the existing PR.

**Autofix, report-only, and headless modes:** stop after the report, artifact emission, and residual-work handoff. Do not commit, push, or create a PR.

## Fallback

If the platform doesn't support parallel sub-agents, run reviewers sequentially. Everything else (stages, output format, merge pipeline) stays the same.

---

## Included References

### Persona Catalog

@./references/persona-catalog.md

### Subagent Template

@./references/subagent-template.md

### Diff Scope Rules

@./references/diff-scope.md

### Findings Schema

@./references/findings-schema.json

### Synthesis Artifact Contract

@./references/synthesis-artifact-contract.md

### Review Output Template

@./references/review-output-template.md
