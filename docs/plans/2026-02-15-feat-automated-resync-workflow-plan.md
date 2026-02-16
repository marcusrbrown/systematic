# Automated Re-sync Workflow Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a command-first automated re-sync workflow that detects upstream CEP changes, runs convert-cc-defs, and creates an issue + PR only when changes exist.

**Architecture:** Use a dedicated sync workflow (`.github/workflows/sync-cep.yaml`) for scheduled and manual runs, keeping fro-bot triage behavior separate. Add a new `.opencode/commands/` command that loads `convert-cc-defs` with scoped arguments, and add a deterministic pre-check (no LLM) to skip runs when upstream hashes are unchanged. Use `sync-manifest.json` as the source of truth for hashes, overrides, and notes.

**Tech Stack:** Bun, TypeScript (strict), GitHub Actions, gh CLI, OpenCode commands/skills.

---

## Enhancement Summary

**Deepened on:** 2026-02-15
**Sections enhanced:** Tasks 1–5 + References
**Research agents used:** repo-research-analyst, spec-flow-analyzer, framework-docs-researcher, explore (repo scan)

### Key Improvements
1. Added explicit handling for multi-file skill hashing, wildcard overrides, upstream deletions, and new upstream definitions in the pre-check phase.
2. Defined a prompt-native structure for sync prompts/command templates with identity, core behaviors, judgment criteria, and explicit boundaries.
3. Added CI security/performance best practices: least-privilege permissions, workflow_dispatch input types, action pinning, and PR token considerations.

### New Considerations Discovered
- Converter version changes should trigger re-sync even when upstream hashes are unchanged.
- Code-block audit is mandatory because the converter intentionally skips fenced code blocks.
- Phantom references must be detected by cross-checking commands against agent inventories.

## Found Brainstorm Context

Found brainstorm from **2026-02-15**: **automated-resync**. Using as context for planning.

Key decisions from brainstorm:
- Daily cron trigger with fro-bot workflow_dispatch prompt
- Scope: skills + agents + commands
- Issue + PR only when changes detected
- Command-first orchestration via `.opencode/commands/`
- Use `sync-manifest.json` for hash checks and notes

## Research Summary (Local)

**Repository patterns & constraints:**
- Existing fro-bot workflow: `.github/workflows/fro-bot.yaml` (daily cron; currently triage prompt; permissions read-only)
- Manifest utilities: `src/lib/manifest.ts` with read/write/validate + `findStaleEntries`
- Conversion workflow: `.opencode/skills/convert-cc-defs/SKILL.md` defines re-sync phases and override merge matrix
- Manifest schema: `sync-manifest.schema.json` includes `upstream_content_hash`, `rewrites`, `manual_overrides`
- CLI entry point: `src/cli.ts` (no sync command yet)

**Institutional learnings:**
- Prefer map-and-preserve conversion over destructive stripping (`docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`)
- Manual overrides must be structured objects to enable conflict detection (`docs/solutions/best-practices/structured-manual-override-tracking-Systematic-20260210.md`)
- Batch imports can create phantom references; validate inventory after sync (`docs/solutions/integration-issues/batch-import-cep-agents-to-systematic-20260210.md`)
- Code-block tool name audits are required (`docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`)

## SpecFlow Gap Fixes to Include

- Add deterministic pre-check to avoid LLM runs when hashes unchanged
- Define conflict handling for manual overrides in CI (report conflicts, skip auto-merge)
- Define PR/issue dedupe policy and branch strategy
- Explicitly handle upstream deletions and new upstream definitions
- Ensure multi-file skills hashing is consistent (documented decision)

## Assumptions to Confirm (Before Implementation)

1. **Command name**: `sync-cep` (command file `.opencode/commands/sync-cep.md`)
2. **PR branch**: fixed branch `chore/sync-cep` updated in-place (avoids PR spam)
3. **Issue handling**: single tracking issue labeled `sync-cep` updated via comments on subsequent runs
4. **Manual override conflicts**: skip conflicting definitions; report in issue + PR body
5. **Scope for new upstream definitions**: report in issue, do not auto-import

If any assumption is wrong, adjust the plan before implementation.

---

## Acceptance Criteria

- [ ] When no upstream changes are detected, the workflow exits with **no PR, no issue update, no commit**.
- [ ] When changes are detected **and converted files differ**, exactly **one PR** is created/updated with all converted changes.
- [ ] When only **report-only changes** are detected (new upstream definitions and/or upstream deletions), the workflow updates the tracking issue **without creating a PR**.
- [ ] The pre-check emits a **structured JSON summary** categorizing change types (hash changes, new upstream, deletions, converter version change).
- [ ] A **tracking issue** is created or updated with a run summary, including conflicts and skipped items.
- [ ] Manual overrides are **never overwritten**; conflicts are reported with both versions summarized.
- [ ] The slash command and CI workflow use the **same conversion logic** (convert-cc-defs).
- [ ] `sync-manifest.json` updates are committed alongside converted files in the same PR.
- [ ] Upstream deletions and new upstream definitions are **reported**, not auto-removed/imported.
- [ ] When only `converter_version` changes and conversion produces **no file diffs**, update the tracking issue only (no PR).
- [ ] Build, typecheck, lint, and tests pass before PR creation in CI.

---

## Implementation Plan (TDD, small steps)

### Task 0: Lock contracts before implementation

**Files:**
- Modify: `sync-manifest.schema.json`
- Modify: `src/lib/manifest.ts`
- Modify: `sync-manifest.json`
- Test: `tests/unit/manifest.test.ts`

**Step 1: Finalize manifest contract updates** (completed)

- Add optional `files: string[]` to manifest definition schema and runtime types.
- Keep `manual_overrides` as structured objects only; wildcard ownership is represented by `{ "field": "*", ... }`.
- Add a top-level `converter_version` field to record last synced converter version (applies to all definitions).
- Add helper for canonical manifest path resolution (`<repo>/sync-manifest.json`) for scripts.
- Export `CONVERTER_VERSION` from `src/lib/converter.ts` (or re-export from a shared module) so the pre-check can compare.
- Update `.opencode/skills/convert-cc-defs/SKILL.md` to remove string-array `manual_overrides` examples and use structured objects only (including wildcard ownership as `{ field: "*", reason: "..." }`).
- Migrate existing `sync-manifest.json` by setting `converter_version` in the same task so reads/validation remain consistent during rollout.

**Step 2: Add/adjust unit tests for schema + type guards** (completed)

- Validate `files` shape and rejection cases.
- Validate wildcard override object (`field: "*"`) as accepted structured data.
- Validate new `converter_version` field is present and properly typed.
- Add a note that this step fixes an existing schema/type mismatch for `files` already present in `sync-manifest.json`.

**Step 3: Commit** (pending)

```bash
git add sync-manifest.schema.json src/lib/manifest.ts sync-manifest.json tests/unit/manifest.test.ts
git commit -m "feat: add manifest contracts for sync precheck"
```

---

### Task 1: Add deterministic pre-check utility (no LLM)

**Files:**
- Create: `scripts/check-cep-upstream.ts`
- Modify: `src/lib/manifest.ts`
- Test: `tests/unit/manifest.test.ts`
- Test: `tests/unit/check-cep-upstream.test.ts`

**Step 1: Write failing tests for new manifest helpers** (completed)

Add tests in `tests/unit/manifest.test.ts` for (use full `ManifestDefinition` objects in fixtures, not partials):
- `listDefinitionsBySource(manifest, 'cep')` returns ordered list
- `getUpstreamHashes(manifest, 'cep')` returns map of definition → hash

```ts
// tests/unit/manifest.test.ts
import { describe, expect, it } from 'bun:test';
import { listDefinitionsBySource, getUpstreamHashes } from '../../src/lib/manifest.js';

it('lists definitions for a source', () => {
  const manifest = {
    sources: { cep: { repo: 'EveryInc/compound-engineering-plugin', branch: 'main', url: 'https://github.com/EveryInc/compound-engineering-plugin' } },
    definitions: {
      'skills/brainstorming': {
        source: 'cep',
        upstream_path: 'plugins/compound-engineering/skills/brainstorming/SKILL.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-15T00:00:00Z',
        notes: 'test',
        upstream_content_hash: 'a'
      },
      'agents/review/security-sentinel': {
        source: 'cep',
        upstream_path: 'plugins/compound-engineering/agents/review/security-sentinel.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-15T00:00:00Z',
        notes: 'test',
        upstream_content_hash: 'b'
      },
      'commands/workflows/plan': {
        source: 'other',
        upstream_path: 'plugins/compound-engineering/commands/workflows/plan.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-15T00:00:00Z',
        notes: 'test',
        upstream_content_hash: 'c'
      }
    }
  };

  expect(listDefinitionsBySource(manifest, 'cep')).toEqual([
    'agents/review/security-sentinel',
    'skills/brainstorming'
  ]);
});

it('returns upstream hash map for a source', () => {
  const manifest = {
    sources: { cep: { repo: 'EveryInc/compound-engineering-plugin', branch: 'main', url: 'https://github.com/EveryInc/compound-engineering-plugin' } },
    definitions: {
      'skills/brainstorming': {
        source: 'cep',
        upstream_path: 'plugins/compound-engineering/skills/brainstorming/SKILL.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-15T00:00:00Z',
        notes: 'test',
        upstream_content_hash: 'a'
      },
      'agents/review/security-sentinel': {
        source: 'cep',
        upstream_path: 'plugins/compound-engineering/agents/review/security-sentinel.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-15T00:00:00Z',
        notes: 'test',
        upstream_content_hash: 'b'
      }
    }
  };

  expect(getUpstreamHashes(manifest, 'cep')).toEqual({
    'agents/review/security-sentinel': 'b',
    'skills/brainstorming': 'a'
  });
});
```

**Step 2: Run tests to confirm failures** (completed)

Run: `bun test tests/unit/manifest.test.ts`
Expected: FAIL (new functions missing).

**Step 3: Implement helper functions** (completed)

Add pure functions in `src/lib/manifest.ts`:

```ts
export const listDefinitionsBySource = (manifest: SyncManifest, source: string): string[] => {
  return Object.keys(manifest.definitions)
    .filter((key) => manifest.definitions[key]?.source === source)
    .sort();
};

export const getUpstreamHashes = (manifest: SyncManifest, source: string): Record<string, string> => {
  const entries = listDefinitionsBySource(manifest, source);
  return Object.fromEntries(
    entries.map((key) => [key, manifest.definitions[key]?.upstream_content_hash ?? ''])
  );
};
```

**Step 4: Run tests to confirm pass** (completed)

Run: `bun test tests/unit/manifest.test.ts`
Expected: PASS.

**Step 5: Create deterministic pre-check script** (completed)

Create `scripts/check-cep-upstream.ts` to:
1. Read `sync-manifest.json`
2. Skip definitions with `manual_overrides` containing an object with `field: "*"` (full local ownership)
3. Detect **new upstream definitions** by comparing upstream tree listing vs manifest keys (report-only)
4. Detect **upstream deletions** (404 on upstream path) and report
5. Fetch upstream content hashes using `gh api` for each tracked definition
   - **Skills:** if `entry.files` exists, fetch each file from `upstream_path/<file>` and hash concatenated contents (sorted by file path)
   - **Agents/Commands:** fetch `upstream_path` directly as a single file
6. Compare to manifest `upstream_content_hash`
7. Compare stored `converter_version` to current `CONVERTER_VERSION` and flag changes
8. Exit code `0` if no changes, `1` if changes detected, `2` for errors (auth/network/manifest missing)

Implementation note: Use the GitHub **tree API** to list upstream files in a single call, then fetch content only for entries that need comparison. Avoid shell pipelines (`base64 -d`, `shasum`) in the plan; use Bun/Node APIs for hashing and decoding in the implementation.

**Step 6: Add script tests (required)** (completed)

Add `tests/unit/check-cep-upstream.test.ts` with mocked command execution to verify:
- exit code `0` when unchanged
- exit code `1` when hash differs
- exit code `1` when converter version differs
- exit code `1` when new upstream definitions or upstream deletions are found (report-only)
- exit code `2` on auth/network/manifest errors
- exit code `1` when `entry.files` multi-file hash differs
- skip when `manual_overrides` includes `{ field: "*" }`

### Research Insights (Task 1)

**Multi-file skills hashing:**
- For multi-file skills, hash concatenated contents of all files listed in `manifest.definitions[...].files` (sorted by path) rather than only `SKILL.md`.
- This requires adding `files?: string[]` to the manifest schema/type guard (currently present in data but not in schema).

**Converter version trigger:**
- If `CONVERTER_VERSION` changes, force a re-sync even when upstream hashes are unchanged. Store the last synced converter version in the manifest and compare during pre-check.

**API efficiency:**
- Prefer the GitHub **tree API** for listing all upstream files in one call, then fetch content only for changed entries.

**Exit codes:**
- `0` = no changes, `1` = changes detected, `2` = error. This prevents CI from treating errors as “changes.”

**Step 7: Manual dry run** (completed)

Run: `bun scripts/check-cep-upstream.ts`
Expected: exit code `0` or `1` with clear console output (include summary counts).

**Step 8: Commit** (pending)

```bash
git add src/lib/manifest.ts tests/unit/manifest.test.ts tests/unit/check-cep-upstream.test.ts scripts/check-cep-upstream.ts
git commit -m "feat: add manifest helpers for sync precheck"
```

---

### Task 2: Add sync command in `.opencode/commands/`

**Files:**
- Create: `.opencode/commands/sync-cep.md`
- Modify: `.opencode/skills/convert-cc-defs/SKILL.md` (if needed to reference new command)

**Step 1: Draft the command frontmatter + template** (completed)

Create `.opencode/commands/sync-cep.md` with OpenCode command options:
- `name: sync-cep`
- `description: Sync upstream CEP definitions into Systematic using convert-cc-defs. Detects changes, converts files, reports override conflicts, and prepares issue/PR summaries.`
- `argument-hint: "[all|skills|agents|commands] [--dry-run]"`
- `subtask: true` (force subagent invocation per OpenCode command options)

**Note:** OpenCode command frontmatter supports `name`, `description`, `argument-hint`, `agent`, `subtask`, `model` (https://opencode.ai/docs/commands/#options). Avoid Claude/skill-only fields like `allowed-tools`, `disable-model-invocation`, or `context: fork` in `.opencode/commands/`.

Template should:
- Load `convert-cc-defs` skill
- Parse arguments: target (skills|agents|commands|all), dry-run (true/false)
- Explicitly state conflict policy: report conflicts, do not auto-merge

### Research Insights (Task 2)

**Prompt-native structure:**
- Add identity + core behavior sections for the sync command.
- Define feature sections: Pre-check gate, Conversion run, Conflict detection, Output formatting.
- Use judgment criteria (impact, conflict severity) rather than rigid rules.
- Add explicit boundaries: no auto-merge conflicts, no new upstream imports, no deletions without user decision.

**Conflict handling details:**
- Adopt the **override merge matrix** from convert-cc-defs:
  - Upstream unchanged + override exists → keep override
  - Upstream changed + override on SAME field → conflict, report only
  - Upstream changed + override on DIFFERENT field → apply upstream, preserve overrides
  - Override is `"*"` → skip re-sync entirely

**Rewrite re-application:**
- Re-apply `rewrites[]` for changed entries unless `manual_overrides` cover the same field.
- Report rewrite failures explicitly in PR/issue body.

**Code-block audit (mandatory):**
- After conversion, scan fenced code blocks for `Task(`, `TodoWrite`, `AskUserQuestion`, `.claude/`, `CLAUDE.md` and fix/report.

**Step 2: Validate command shape (not plugin CLI discovery)** (pending)

`bun src/cli.ts list commands` only lists bundled plugin commands from `commands/`, not project-local `.opencode/commands/` files. Validate by:
- confirming `.opencode/commands/sync-cep.md` exists with valid frontmatter keys
- running an OpenCode session and invoking `/sync-cep --help` or `/sync-cep all --dry-run`

**Step 3: Commit** (pending)

```bash
git add .opencode/commands/sync-cep.md
git commit -m "feat: add sync-cep command wrapper"
```

---

### Task 3: Add dedicated `sync-cep` workflow

**Files:**
- Create: `.github/workflows/sync-cep.yaml`

**Step 1: Add permission changes (tests not required)** (completed)

Use least privilege with workflow-level `permissions: { contents: read }` and job-level escalation only in the sync job:
- `contents: write`
- `issues: write`
- `pull-requests: write`

**Step 2: Add a sync-specific prompt path** (completed)

Add a `SYNC_PROMPT` environment variable containing a pre-filled prompt that:
- Runs `bun scripts/check-cep-upstream.ts` first and exits if unchanged
- Invokes `/sync-cep` with `target=all` and `dry-run=false`
- Updates or creates the tracking issue and PR

**Step 3: Choose schedule behavior** (completed)

Use an independent schedule in `sync-cep.yaml` (weekly recommended; daily only if the upstream churn justifies it) plus `workflow_dispatch` with typed inputs:
- `scope` (`choice`: all|skills|agents|commands)
- `dry_run` (`boolean`)

**Step 4: Ensure git config and gh auth** (completed)

Ensure the workflow uses `FRO_BOT_PAT` (or a GitHub App token) that can create PRs and trigger downstream PR checks, and configures git author for commits.

**Step 5: Add explicit CI gating before PR create/update** (completed)

In the sync run, execute and require success for:
- `bun run build`
- `bun run typecheck`
- `bun run lint`
- `bun test`

Only create/update PR when these pass.

**Step 6: Handle pre-check exit codes explicitly** (completed)

- Exit code `0` (no changes): stop workflow with success, update issue only if policy requires.
- Exit code `1` (changes detected): continue workflow (do **not** fail the job).
- Exit code `2` (error): fail workflow and post error summary to the tracking issue.
- If `converter_version` changed but conversion produced no file diffs: update tracking issue summary and exit success without creating/updating a PR.

Implement with a dedicated pre-check step that captures the exit code into `$GITHUB_OUTPUT`, then conditionally runs the sync job/steps based on that value.
Ensure the pre-check JSON summary is surfaced to the sync job (job outputs) and injected into the sync prompt so the agent does not rerun the pre-check.

**Step 7: Manual test (dry run)** (pending)

Run: `gh workflow run sync-cep.yaml -f scope=all -f dry_run=true`
Expected: workflow kicks off with the sync prompt.

Note: `gh workflow run` fails on this branch because the workflow file isn't on the default branch yet. Requires pushing branch or merging workflow to default before manual trigger.

**Step 8: Commit** (pending)

```bash
git add .github/workflows/sync-cep.yaml
git commit -m "ci: add dedicated sync-cep workflow"
```

### Research Insights (Task 3)

**Workflow separation vs. branching:**
- The existing fro-bot workflow already uses daily cron for triage. Consider **separate workflow** (`sync-cep.yaml`) to avoid mixing prompts and escalating permissions.

**PR token constraints:**
- PRs created with `GITHUB_TOKEN` do **not** trigger `pull_request` workflows. Use a GitHub App token or PAT for PR creation so CI checks run.

**workflow_dispatch inputs:**
- Use `type: choice` for scope and `type: boolean` for dry-run. Avoid raw string interpolation in shell steps.

**Action pinning:**
- Pin third-party actions to full SHA (supply chain hardening).

---

### Task 4: Add issue/PR dedupe logic and output format (prompt-level)

**Files:**
- Modify: `.opencode/commands/sync-cep.md`
- Modify: `.opencode/skills/convert-cc-defs/SKILL.md`

**Step 1: Define issue/PR dedupe policy in the prompt**

Add prompt instructions to:
- Reuse a fixed branch `chore/sync-cep`
- If a PR exists on that branch, update it rather than creating a new one
- Use or create an issue labeled `sync-cep`

**Step 2: Define output sections**

Ensure PR/issue body includes:
- Summary (changed / unchanged / skipped counts)
- Per-definition table (before/after hashes)
- Conflicts list (manual overrides)
- New upstream definitions list (report-only)

Add sections for:
- **Upstream deletions** (report-only, include keep/remove prompt)
- **Rewrite failures** (fields that couldn’t be re-applied)
- **Phantom references** (commands referencing missing agents/skills)

**Step 3: Commit**

```bash
git add .opencode/commands/sync-cep.md .opencode/skills/convert-cc-defs/SKILL.md
git commit -m "docs: define sync issue/PR reporting format"
```

---

### Task 5: Verification

**Step 1: Run unit tests**

Run: `bun test tests/unit/manifest.test.ts` and `bun test tests/unit/check-cep-upstream.test.ts`

**Step 2: Run full verification (CI parity)**

Run:
```bash
bun run build
bun run typecheck
bun run lint
bun test
```

**Step 3: Confirm command usability in OpenCode**

Validate `/sync-cep` through OpenCode command execution (local `.opencode/commands/` scope), not `bun src/cli.ts list commands`.

### Research Insights (Task 5)

Add explicit checks from convert-cc-defs Phase 5:
- `bun src/cli.ts list agents`
- `bun src/cli.ts list skills`
- `bun test tests/integration/converter-validation.test.ts`
- Code-block audit validation over `skills/`, `agents/`, `commands/`
- Phantom reference check: ensure all agent/skill references in commands resolve

---

## References

- `docs/brainstorms/2026-02-15-automated-resync-brainstorm.md`
- `.github/workflows/fro-bot.yaml`
- `.opencode/skills/convert-cc-defs/SKILL.md`
- `src/lib/manifest.ts`
- `sync-manifest.json`
- `sync-manifest.schema.json`
- `docs/solutions/best-practices/structured-manual-override-tracking-Systematic-20260210.md`
- `docs/solutions/integration-issues/batch-import-cep-agents-to-systematic-20260210.md`

### External References

- GitHub Actions workflow syntax: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
- GitHub Actions schedule trigger: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule
- GitHub Actions workflow_dispatch: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_dispatch
- GitHub Actions token permissions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#permissions-for-the-github_token
- GitHub REST API (contents): https://docs.github.com/en/rest/repos/contents#get-repository-content
- gh CLI: `gh api`: https://cli.github.com/manual/gh_api
- gh CLI: `gh pr create`: https://cli.github.com/manual/gh_pr_create
- gh CLI: `gh issue create`: https://cli.github.com/manual/gh_issue_create
- gh CLI: `gh workflow run`: https://cli.github.com/manual/gh_workflow_run
