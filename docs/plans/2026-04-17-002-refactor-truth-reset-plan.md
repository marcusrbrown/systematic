---
title: Truth Reset (Initiative 1 of 3)
type: refactor
status: completed
date: 2026-04-17
completed_at: 2026-04-17
origin: docs/brainstorms/2026-04-17-credibility-reset-requirements.md
supersedes_plan: docs/plans/2026-04-17-001-refactor-credibility-reset-plan.md
branch: feat/truth-reset
pr: https://github.com/marcusrbrown/systematic/pull/290
release: https://github.com/marcusrbrown/systematic/releases/tag/v2.4.0
merge_commit: 349596e
commits:
  - 2ed916d feat(trust): truth reset and final CEP divorce
  - 38d658f fix(sync): complete missed CEP→Systematic conversions in 41 files
  - 53e78a8 docs(plan): mark Units 1-6 executed, add execution notes
  - 5185374 fix(review): resolve P1/P2 findings from ce:review mode:report-only
  - fd80469 docs(solutions): capture 3 learnings from truth-reset cycle, archive 3 obsolete docs
  - f8f99fa fix(review): address Fro Bot + CodeQL findings on PR #290
closed_issues:
  - 'marcusrbrown/systematic#227 (CEP Sync Run 2026-03-24) — closed 2026-04-17'
  - 'marcusrbrown/systematic#231 (CEP Sync Run 2026-03-25) — closed 2026-04-17'
  - 'marcusrbrown/systematic#239 (CEP Sync Run 2026-03-26) — closed 2026-04-17'
---

# Truth Reset — Close the Gap Between Public Claims and Repo Reality

## Overview

Narrow-scope initiative focused exclusively on **trust repair**: make README, AGENTS.md, OCX registry advertising, and open GitHub issues match repo reality. Also complete the one-time final CEP reconciliation sync and delete CEP sync infrastructure (full divorce). Ships as a **minor version** (expected 2.4.0) — no breaking public API changes.

**What's deferred:**
- **Initiative #2 (Portfolio Rationalization):** merge `lfg+slfg`, retire `ce-work-beta`, merge todo trio, delete `setup`, rewrite/delete `orchestrating-swarms`, verify `deepen-plan`. Separate future major-version cycle with its own feature story.
- **Initiative #3 (Infra Improvements):** OCX registry auto-generation + parity check, legacy `commands/` deletion, error surfacing, validation.ts + bootstrap.ts tests, CI drift gate. Separate future cycle.

## Problem Frame

README claims 48 skills / 29 agents; reality is 45 / 49. README references skill names that don't exist (`create-agent-skill`, `file-todos`). OCX bundles advertised as "all 48 skills" but register only 8/45 + 24/49. Three GitHub issues (#227, #231, #239) signal an active CEP sync promise that was deleted in PR #243.

`sync-manifest.json` and the `convert-cc-defs` skill imply ongoing upstream tracking while the project has already decided to evolve independently. The codebase is better than its public-facing materials suggest — this reset closes the trust gap without taking on the larger catalog-rationalization or infrastructure-improvement work.

See origin: `docs/brainstorms/2026-04-17-credibility-reset-requirements.md`.

## Requirements Trace

Reduced from 24 requirements to the 10 that directly serve trust repair.

- **R1.** Pull 27 hash changes from CEP HEAD for **all** existing skills (no "skip to-be-deleted" optimization, since no skills are being deleted in this initiative) → Unit 1
- **R2.** Import missing sub-files for 5 skills → Unit 1
- **R3.** Update `manifest.files[]` arrays (then manifest gets deleted in Unit 3) → Unit 1
- **R4.** Delete CEP sync infrastructure (command, skill, check-upstream script, test) → Unit 2
- **R5.** Delete `sync-manifest.json`, `src/lib/manifest.ts`, `tests/unit/manifest.test.ts` → Unit 3
- **R6.** Update AGENTS.md for independence narrative → Unit 4
- **R4-integration.** Delete sync-cep and convert-cc-defs integration test blocks → Unit 5
- **R17.** README no longer claims counts — remove count language, link to reference docs → Unit 6
- **R18.** README contains no nonexistent skill/agent names (`create-agent-skill`, `file-todos` deleted) → Unit 6
- **R19.** AGENTS.md reflects current 45 / 49 catalog (no portfolio changes, just accurate counts) → Unit 6
- **R20.** Close GitHub issues #227, #231, #239 with comment linking to this PR → Unit 7

## Scope Boundaries

**In scope:**
- Final CEP reconciliation sync (one-time)
- Delete CEP sync infrastructure (full divorce)
- README truth reset (counts, nonexistent names, install examples)
- AGENTS.md truth reset (current 45/49 catalog)
- Close stale GitHub issues

**Explicitly NOT in scope (deferred to future initiatives):**
- Any skill deletions, merges, or renames (`setup`, `slfg`, `ce-work-beta`, todo trio, `lfg` merge)
- `orchestrating-swarms` or `deepen-plan` rewrites/deletions
- OCX registry component auto-generation or parity check
- Legacy `commands/` path deletion
- Bundled asset error surfacing (stop silent null returns)
- `validation.ts` or `bootstrap.ts` tests
- CI content integrity gate
- Any breaking API surface changes (keeps release as minor)

**Accepted trade-offs:**
- OCX registry still registers only 8/45 skills + 24/49 agents. **Not a trust gap anymore** because Unit 6 removes the "all 48/all 29" claims from README.
- The 3 stale skills (`orchestrating-swarms`, `setup`, `deepen-plan`) remain shipped as-is. `deepen-plan` already verified CEP-clean; `orchestrating-swarms` keeps its 114 CC-specific patterns until Initiative #2 decides delete-vs-rewrite.

## Context & Research

### Relevant Code and Patterns

- **CEP conversion patterns:** `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c sed ordering, Phase 3d mandatory code-block audit, exclusions for `sync-manifest.json` and `claude-permissions-optimizer`.
- **Manifest module:** `src/lib/manifest.ts` has zero imports from plugin code (only consumed by `scripts/check-cep-upstream.ts`). Clean deletion.
- **docs:generate pipeline:** `docs/scripts/transform-content.ts` generates Starlight MDX, not README-inlinable output. Confirms R17's "remove counts entirely" is the simpler path.
- **Current state numbers (verified April 17, 2026):** 45 skills, 49 agents, 8 OCX skills registered, 24 OCX agents registered, npm v2.3.3.

### Institutional Learnings

- **`docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`** — Converter skips fenced code blocks; Phase 3d audit mandatory for `Task(`, `TodoWrite`, `.claude/`.
- **`docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`** — Prior imports dropped sub-files silently. Unit 1 finishes sub-file import for 5 remaining skills.
- **`docs/solutions/best-practices/structured-manual-override-tracking-Systematic-20260210.md`** — Sync-manifest handling patterns (about to become moot post-R5).

### External References

None. All work is internal cleanup against established patterns.

## Key Technical Decisions

- **Full CEP divorce, not mothballing.** All sync infrastructure deleted. No backdoor. Brainstorm-level decision, preserved.
- **Reconciliation-only sync.** Pull 27 hash changes + 5 skills' missing sub-files. No new defs, no deletions applied. Brainstorm-level decision, preserved.
- **Remove README counts, not auto-derive.** `docs:generate` doesn't produce README-inlinable output; engineering a new pipeline is overkill for docs fix.
- **No "skip to-be-deleted skills" optimization in Unit 1.** Because this initiative deletes no skills, all 27 CEP hash changes apply. Unit 1 is simpler than the superseded plan's version.
- **Single PR.** No atomic-PR concerns since catalog stays constant and registry stays hand-curated. No C+D coupling to manage.
- **Minor version bump (2.4.0 or similar), not major.** No breaking API surface changes. No skills removed. Semantic-release will compute minor via `feat:` prefix on final commit.
- **Commit message:** `feat(trust): truth reset and final CEP divorce` — not a `BREAKING CHANGE:`, not a `!` marker.
- **`orchestrating-swarms` stays broken.** Keeps 114 CC-specific patterns for now. Initiative #2 decides delete-vs-rewrite. README stops advertising it as working CEP-native (already does — no README mention references CC specifics).
- **Catalog size frozen at 45 skills / 49 agents through this initiative.** README reflects this accurately.

## Open Questions

### Resolved During Planning

- **Scope of CEP sync in Unit 1:** all 27 hash changes (no skip list needed, no skills being deleted).
- **README strategy:** remove counts, link to reference docs.
- **Release posture:** minor version bump; no breaking changes.
- **PR structure:** single PR.
- **Deferred initiatives documented:** Initiative #2 (portfolio rationalization) and Initiative #3 (infra improvements) tracked here for future brainstorming.

### Deferred to Implementation

- **Pre-sync CEP HEAD re-check tolerance:** if precheck finds >32 hash changes at execution time, pause and document the delta. Specific re-scope decision happens when the condition fires.

## Implementation Units

- [x] **Unit 1: Execute final reconciliation CEP sync (all 27 hashes + 5 missing sub-file sets)** — executed with scope expansion (see Execution Notes)

**Goal:** Pull 27 hash updates plus missing sub-files for 5 skills. Manifest updated one final time before Unit 3 deletes it.

**Requirements:** R1, R2, R3

**Dependencies:** None.

**Files:**
- Modify: `skills/<each-of-27>/SKILL.md` and any CEP-sub-files for those 27 skills
- Create: `skills/dhh-rails-style/**` (7 sub-files), `skills/dspy-ruby/**` (9 sub-files), `skills/andrew-kane-gem-writer/**` (6 sub-files), `skills/claude-permissions-optimizer/**` (3 sub-files), `skills/every-style-editor/**` (2 sub-files)
- Modify: `sync-manifest.json` — update `hash` and `files[]` for each touched definition

**Approach:**
- Re-run `bun scripts/check-cep-upstream.ts` precheck. If hash-change count is within 27±5, proceed; else pause and re-scope (document delta, decide whether to land partial sync or defer).
- For all 27 hash changes: fetch updated upstream content, apply batch sed per `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c ordering, exclude `sync-manifest.json` and special-case `claude-permissions-optimizer` per existing conventions.
- Fetch full file trees from CEP HEAD for 5 multi-file skills needing sub-files.
- Run mandatory Phase 3d code-block audit: `grep -rnE 'Task\(|TodoWrite|AskUserQuestion|\.claude/' skills/ agents/` — must match only `claude-permissions-optimizer` and any pre-existing `orchestrating-swarms` content (the 114 patterns) which stays broken until Initiative #2.
- Two-sided verification grep: (1) no remaining CC/CEP refs in touched files, (2) no over-conversions (`.opencode/.opencode/`, etc).
- Update `sync-manifest.json` with new hashes and full `files[]` arrays.

**Patterns to follow:** `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c–3d workflow (used one final time).

**Test scenarios:**
- Build, typecheck, lint, tests all pass after sync
- Verification greps return expected results (zero in touched files; known 114 matches in `orchestrating-swarms`)
- `sync-manifest.json` validates via `readManifest` without errors

**Verification:**
- Build green
- All 5 multi-file skills have complete sub-file trees
- No unintended CC/CEP drift into previously-clean skills

---

- [x] **Unit 2: Delete CEP sync infrastructure**

**Goal:** Remove the `/sync-cep` command, `convert-cc-defs` skill, `check-cep-upstream.ts` script, and its unit test.

**Requirements:** R4

**Dependencies:** Unit 1 (sync complete before deleting the tools that ran it).

**Files:**
- Delete: `.opencode/commands/sync-cep.md`
- Delete: `.opencode/skills/convert-cc-defs/` (entire directory)
- Delete: `scripts/check-cep-upstream.ts`
- Delete: `tests/unit/check-cep-upstream.test.ts`

**Approach:**
- Delete the four paths.
- Verify nothing else imports from them: `grep -rE 'convert-cc-defs|sync-cep|check-cep-upstream' src/ scripts/ tests/ .opencode/` — expected residuals handled in Units 4-5.

**Test scenarios:**
- Build, typecheck, lint, all unit tests pass
- No residual imports

**Verification:**
- Four paths no longer exist
- Build green

---

- [x] **Unit 3: Delete sync-manifest.json and manifest module**

**Goal:** Remove `sync-manifest.json`, `src/lib/manifest.ts`, `tests/unit/manifest.test.ts`. Confirmed clean removal — manifest module has zero imports from plugin code.

**Requirements:** R5

**Dependencies:** Unit 2.

**Files:**
- Delete: `sync-manifest.json`
- Delete: `src/lib/manifest.ts`
- Delete: `tests/unit/manifest.test.ts`
- Modify: `src/lib/AGENTS.md` — remove manifest module row from the table

**Approach:**
- Confirm via `grep -rE 'from.*manifest|import.*manifest' src/ tests/` — should return only the file being deleted.
- Delete the three paths.
- Update `src/lib/AGENTS.md` module table and "Modules" data-flow diagram.

**Test scenarios:**
- Build green, no module resolution errors
- All unit tests pass

**Verification:**
- `grep -rE 'from.*manifest|import.*manifest' src/ tests/` returns zero
- `sync-manifest.json` gone

---

- [x] **Unit 4: Update AGENTS.md for independence narrative**

**Goal:** Reframe AGENTS.md to reflect fully independent project. Remove all CEP-sync language. Keep CLI `convert` command documentation.

**Requirements:** R6, R19 (partial)

**Dependencies:** Units 2, 3 (references to deleted files must be removed).

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/lib/AGENTS.md`

**Approach:**
- Delete "Upstream Sync" section.
- Remove `sync-manifest.json` and `scripts/check-cep-upstream.ts` from "Where to Look".
- Update Overview: "OpenCode plugin providing structured engineering workflows. Originally adapted from CEP, now evolves independently."
- Update Structure diagram to remove `sync-manifest.json`, `commands/.gitkeep`.
- Update Code Map to remove `readManifest`, `validateManifest`, `writeManifest`, `findStaleEntries` rows.
- Update "Notes" section — remove entries referencing sync-manifest or sync workflows.
- Drop CEP-specific language from `convert` CLI description.
- Update skill/agent counts: 45 skills, 49 agents.
- Update test counts: 13 unit (was 15 before deletions), 2 integration.

**Test scenarios:** N/A (docs only).

**Verification:**
- `grep -E 'sync-manifest|check-cep-upstream|sync-cep|Upstream Sync' AGENTS.md src/lib/AGENTS.md` returns zero
- Counts match reality (45 / 49 / 13)

---

- [x] **Unit 5: Delete sync-cep and convert-cc-defs integration test blocks**

**Goal:** Remove `describe('sync-cep workflow simulation')` and `describe('convert-cc-defs skill discoverability')` blocks from integration tests. They reference infrastructure deleted in Units 2-3.

**Requirements:** R4 (integration test side)

**Dependencies:** Unit 2.

**Files:**
- Modify: `tests/integration/opencode.test.ts`

**Approach:**
- Delete the two `describe` blocks.
- The `extractCommandFrontmatter` import at `opencode.test.ts:6` stays — it's also used elsewhere in the file, and `src/lib/commands.ts` remains in this initiative (Initiative #3 deletes it).

**Test scenarios:**
- `bun test tests/integration/opencode.test.ts` passes

**Verification:**
- Two `describe` blocks gone
- `extractCommandFrontmatter` import still present (used by surviving code)

---

- [x] **Unit 6: README + docs/ truth reset**

**Goal:** README contains no false counts and no nonexistent skill/agent names. Every `ocx add systematic/<name>` example resolves to a real registered component. AGENTS.md and docs match.

**Requirements:** R17, R18, R19

**Dependencies:** Units 1-4 (counts depend on post-Unit-4 state).

**Files:**
- Modify: `README.md`
- Modify: `docs/src/content/docs/index.mdx` (if counts mentioned)
- Modify any `docs/src/content/docs/guides/` page with count claims

**Approach:**
- Remove "Batteries Included — 48 skills and 29 agents ship" → "Batteries Included — a curated catalog of engineering skills and agents ships."
- Remove explicit count parentheticals like "(View all 48 skills →)" → "View all skills →".
- Remove "All 48 skills" / "All 29 agents" descriptions from OCX bundle examples → "All bundled skills" / "All bundled agents".
- Delete references to `create-agent-skill` and `file-todos` in Skills tables.
- Cross-check every `/systematic:<name>` and `ocx add systematic/<name>` example against real components (`bun src/cli.ts list skills` and `grep '"name":' registry/registry.jsonc`).
- Update Skills and Agents tables to match current filesystem (use `bun src/cli.ts list` as source of truth).
- Update Project Structure diagram to remove `sync-manifest.json`.
- Update "Converting from Claude Code" section to reference the `convert` CLI only (sync-cep is gone).

**Patterns to follow:** Existing README structure; keep tables compact.

**Test scenarios:**
- `grep -E '48 skills|29 agents|create-agent-skill|file-todos' README.md docs/` returns zero
- Every `ocx add systematic/<name>` example maps to a real registered component (8 skills + 24 agents)
- Every `/systematic:<name>` example maps to a real skill

**Verification:**
- README counts match reality or are absent
- No references to nonexistent skills/agents
- All install examples resolvable

---

- [ ] **Unit 7: Close stale GitHub issues** — deferred to post-PR-merge (depends on PR number to reference in close comment)

**Goal:** Issues #227, #231, #239 (CEP sync runs from March 24-26) closed with comment referencing the reset PR.

**Requirements:** R20

**Dependencies:** This PR merged.

**Files:** None in-repo.

**Approach:**
- After this PR merges:
  ```
  gh issue close 227 --comment "Closed as part of the truth reset (PR #NNN). The CEP sync workflow was deleted in PR #243, and this reset completes the divorce — no further CEP sync runs will occur."
  ```
- Repeat for #231 and #239 with the same comment.

**Verification:**
- `gh issue list --state open` no longer shows the three issues

## Execution Notes (April 17, 2026)

Executed via `ce:work` on branch `feat/truth-reset`. Two commits produced:

| Commit    | Purpose                                              | Files    | Diff            |
| --------- | ---------------------------------------------------- | -------- | --------------- |
| `2ed916d` | Truth reset and CEP divorce (Units 1-6 initial pass) | 87       | +3468 / −8017   |
| `38d658f` | Fix missed CEP→Systematic conversions (see below)    | 42       | +262 / −262     |

### Unit 1 — scope expanded 2.3× from plan

Precheck against CEP HEAD at execution time showed **63 hash changes** — not the 27 the plan anticipated. Tolerance was ±5 (plan said pause if outside). User approved **Option A (full sync)** rather than subset/skip.

All 63 definitions converted cleanly. No failures. 120 files written through the converter. Verification of the 5 multi-file skills revealed all sub-file trees already existed on disk — the plan's "CREATE" work was vacuously satisfied (prior memory was stale).

### Silent failure → fix commit

The Unit 1 batch-sed post-sync cleanup at commit `2ed916d` **failed silently** due to a zsh word-splitting bug: `for f in $FILES; do ... done` with unquoted `$FILES` iterates ONCE in zsh with `$f` being the entire multi-line string (unlike bash). `[ -f "$f" ] || continue` returned false, the loop body never ran, and the downstream verification grep had the same bug — producing empty output that falsely signaled "clean". Both the conversion AND the safety net failed together.

Discovery: user reported residual `Claude Code` refs in SKILL.md files. Oracle independent audit + self-grep converged on 41 affected files, ~200+ unconverted lines across:
- `Claude Code` branding in multi-platform comparison prose
- `AskUserQuestion`, `TaskCreate`, `TodoWrite` tool names inside backticks (converter skips code blocks by design; batch sed was supposed to catch these)
- `compound-engineering:{review,research,workflow,design,docs,document-review}:*` plugin prefixes
- `.context/compound-engineering/` runtime paths (`ce-review`, `todo-*`, `ce-work-beta`)
- `plugins/compound-engineering/` path examples
- `ai:compound-engineering` / `Compound Engineering` identity strings (`proof` skill had 32 hits alone)
- `${CLAUDE_PLUGIN_ROOT}/skills/git-worktree/scripts/` CC-specific env var paths
- `.compound-engineering/config.local.yaml` local config path
- `CLAUDE.md` → `AGENTS.md` rewrites (plus downstream surgical cleanup of `AGENTS.md and AGENTS.md` redundancies created by the blanket replacement in `ce-compound-refresh` and `ce-compound`)

Fix (commit `38d658f`): drove all conversions through `find ... | while IFS= read -r f` instead of the broken zsh for-loop. Same Phase A→G ordering as before. Added two surgical edits to simplify the now-logically-inverted shim-comparison sentences. Verified zero residual patterns, zero over-conversions. Memory #677 saved to prevent recurrence.

### Plan-vs-reality deviations

| Plan assumption                                | Reality                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| 27 hash changes                                | 63 hash changes (2.3×); user approved full sync                         |
| 5 skills need sub-file CREATE                  | All sub-files already on disk; only content updated                     |
| Single commit via batch sed                    | Required follow-up fix commit due to zsh bug                            |
| Unit 4 test counts: 13 unit, 2 integration     | Accurate after deletions (down from 15 unit)                            |
| `sync-manifest.json` would get one final update | Deleted entirely in Unit 3 as planned                                   |

### Exceptions preserved (verified)

- `skills/claude-permissions-optimizer/` — 15 CC refs intentional (targets CC settings); 0 `compound-engineering` refs
- `skills/orchestrating-swarms/` — 29+ pre-existing patterns untouched (Initiative #2 scope)
- `AGENTS.md` — CEP historical attribution kept in Overview
- `src/lib/converter.ts` + `tests/unit/converter.test.ts` — rule documentation
- `docs/src/content/docs/guides/conversion-guide.mdx` — migration guide (legitimately describes CC)
- Multi-platform comparison clauses — semantically correct after tool-name rewrites: `` `question` in OpenCode, `request_user_input` in Codex, `ask_user` in Gemini``

### Quality gate (final state)

- Build ✅ | Typecheck ✅ | Lint ✅ (0 errors, 1 warning from pre-existing upstream source)
- Unit tests: 279/279 across 11 files (down from 331/13 after deleting manifest + check-cep-upstream tests)
- Integration tests: 14/14 across 2 files (down from 28 after deleting sync-cep + convert-cc-defs describe blocks)
- Zero CC/CEP refs remaining in actionable source files
- Zero over-conversions

## System-Wide Impact

- **Interaction graph:** Unit 3 deletes `manifest.ts` — verified zero imports from plugin code; only `scripts/check-cep-upstream.ts` used it, and that's also deleted in Unit 2.
- **Error propagation:** Unchanged. No error handling logic touched.
- **State lifecycle risks:** None. No persistent state to migrate.
- **API surface parity:** Unchanged. Plugin's three hooks keep identical signatures. No skill names change. No config field changes. Consumer impact: zero.
- **Integration coverage:** Unit 5 deletes two `describe` blocks; remaining integration tests still cover the full plugin surface.
- **Registry:** Unchanged in this initiative. Still hand-curated with 8 skill + 24 agent components. README now accurately describes what's registered (not advertising parity anymore).

## Risks & Dependencies

- **Risk: CEP HEAD moves between precheck and sync execution.** Mitigation: re-run `check-cep-upstream.ts` immediately before Unit 1; pause and re-scope if change count differs materially (tolerance ±5 on the 27 figure).
- **Risk: Batch sed introduces unintended over-conversions.** Mitigation: two-sided grep verification (remaining refs + over-conversions) per `convert-cc-defs` Phase 3d.
- **Risk: `orchestrating-swarms` code-block audit flags the 114 existing CC patterns as "new drift".** Mitigation: Phase 3d audit explicitly acknowledges `orchestrating-swarms` as pre-existing broken state; audit only flags NEW drift introduced by Unit 1 sync.
- **Risk: README updates drift again after Initiative #2 changes the catalog.** Accepted: Initiative #2 will re-run README updates against its new catalog. The CI drift gate remains in Initiative #3 scope.
- **Risk: `manifest.ts` delete breaks a consumer I missed.** Mitigation: verified via `grep -rE 'from.*manifest|import.*manifest' src/ tests/` — zero matches outside the file itself and its test.
- **Dependency: `.opencode/skills/convert-cc-defs/` must exist for Unit 1 to execute. Unit 2 deletes it afterward.** Ordering enforced by dependency chain.

## Documentation / Operational Notes

### Commit Message Strategy

Single PR, single semantic-release entry:

```
feat(trust): truth reset and final CEP divorce

- Final CEP reconciliation sync (27 hash changes + 5 skills' missing sub-files)
- Delete CEP sync infrastructure (/sync-cep, convert-cc-defs, check-cep-upstream)
- Delete sync-manifest.json and src/lib/manifest.ts
- Update README to remove false counts and nonexistent skill names
- Update AGENTS.md to reflect current 45/49 catalog and independence narrative
- Close stale CEP sync issues #227/#231/#239

No breaking API changes. Catalog stays at 45 skills / 49 agents.
Initiatives #2 (portfolio rationalization) and #3 (infra improvements) tracked separately.
```

Expected release: **2.4.0** (minor — no BREAKING CHANGE, no `!` marker).

### CHANGELOG Additions

```markdown
### 2.4.0 — Truth Reset

- Catalog now truthfully advertised: README reflects 45 skills / 49 agents (previously incorrect as 48/29).
- Removed CEP upstream tracking: `sync-manifest.json`, `/sync-cep` command, and `check-cep-upstream` script deleted. Systematic evolves independently. The CLI `convert` command remains for ad-hoc CEP → OpenCode conversions.
- Completed final reconciliation sync of 27 skill updates + sub-files for 5 skills.
- No breaking API changes. No skills added or removed.

_Initiative #1 of 3. Initiative #2 (portfolio rationalization) and #3 (infra improvements) tracked separately._
```

### Rollback Plan

- **Safe revert window:** Until 2.4.0 publishes to npm.
- **Effectively unrevertable after:** External references to new README, or when Initiative #2 builds on this state.
- **Recovery if publish breaks:** 72-hour npm unpublish window exists, but not needed — no breaking changes mean low consumer-impact risk.

### Deferred Initiatives (for future brainstorms)

**Initiative #2 — Portfolio Rationalization (breaking, 3.0.0 major)**
- Delete `skills/setup/` (placeholder)
- Merge `lfg` + `slfg` or keep `slfg` as alias — decide in Initiative #2 brainstorm
- Retire `ce-work-beta` or graduate bits to `ce-work`
- Merge todo trio into unified `todos` or keep as aliases — decide in brainstorm
- Delete `orchestrating-swarms` (114 CC-specific patterns, teaches nonexistent OpenCode primitives) or rewrite — decide in brainstorm
- Verify `deepen-plan` (confirmed CEP-clean as of April 17, 2026; just validate agent refs)
- Product decision: whether the consolidation value justifies breaking consumers' pinned skill names

**Initiative #3 — Infra Improvements (minor, CI & code quality)**
- OCX registry auto-generation from filesystem (`scripts/build-registry.ts` extension)
- Registry / filesystem parity check
- CI content integrity gate (banned-pattern detection, count-drift detection)
- Delete legacy `commands/` path + 4-file ripple
- Stop swallowing bundled asset parse/convert errors silently
- Add `tests/unit/validation.test.ts`
- Add `tests/unit/bootstrap.test.ts`

### Post-Reset Documentation

Write `docs/solutions/workflow-patterns/truth-reset-20260417.md` capturing:
- "Separate trust repair from catalog changes" pattern — narrow initiatives with clean rationale outperform large bundled ones
- "Document-review convergence as scope signal" — when 3 reviewers independently flag "too broad", split

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-17-credibility-reset-requirements.md](../brainstorms/2026-04-17-credibility-reset-requirements.md) (full 24-requirement scope; this plan executes a subset)
- **Superseded plan:** [docs/plans/2026-04-17-001-refactor-credibility-reset-plan.md](2026-04-17-001-refactor-credibility-reset-plan.md) — contains research + deepening for Initiative #2 and #3 work; useful reference when those initiatives are planned
- **Oracle strengths/gaps assessment:** session context (April 17, 2026) that identified trust damage as P0
- **Document-review findings:** April 17, 2026 — 4 reviewers (feasibility, product-lens, scope-guardian, adversarial) converged on "plan is overscoped". Scope narrowing is the direct response.
- **Prior CEP-tether removal:** PR #243 (`chore/break-cep-tether`, commit 561f53c)
- **Prior CEP sync restoration:** PR #255 (`chore/restore-sync-cep-command`)
- **Prior sub-file imports:** PR #258
- **Institutional learnings referenced:**
  - `docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`
  - `docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`
  - `docs/solutions/best-practices/structured-manual-override-tracking-Systematic-20260210.md`
- **Stale issues to close:** #227, #231, #239
