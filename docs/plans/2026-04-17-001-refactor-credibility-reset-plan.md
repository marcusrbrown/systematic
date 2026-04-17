---
title: Credibility Reset + Final CEP Divorce [SUPERSEDED]
type: refactor
status: superseded
date: 2026-04-17
deepened: 2026-04-17
origin: docs/brainstorms/2026-04-17-credibility-reset-requirements.md
superseded_by: docs/plans/2026-04-17-002-refactor-truth-reset-plan.md
superseded_reason: Document-review convergence — 3 reviewers (scope-guardian, product-lens, adversarial) flagged overscope. Split into 3 initiatives. Initiative #1 (truth reset) proceeds in the superseding plan. Initiatives #2 (portfolio rationalization) and #3 (infra improvements) deferred to future brainstorms.
---

> **⚠️ SUPERSEDED** — This plan was split into three separate initiatives after document-review. Execution follows **`docs/plans/2026-04-17-002-refactor-truth-reset-plan.md`** (Initiative #1: Truth Reset). The research, technical decisions, and unit-level analysis in this plan remain useful as reference when Initiatives #2 (portfolio rationalization) and #3 (infra improvements) are planned separately.

# Credibility Reset + Final CEP Divorce [SUPERSEDED]

## Overview

Execute a one-time credibility reset on `marcusrbrown/systematic`: final reconciliation-only CEP sync, full deletion of CEP sync infrastructure, portfolio rationalization (delete/merge/rewrite 6 skills), OCX registry auto-generation, public-surface truth reset (README/AGENTS.md/issues), and targeted code-quality hardening (legacy deletion, error surfacing, two new test files).

After this lands, Systematic is fully independent of CEP. No manifest, no sync workflow, no upstream tracking — just a curated OpenCode-native plugin with a truthful public surface.

## Problem Frame

README claims 48 skills / 29 agents; reality is 45 / 49. OCX advertises bundles as "all 48 / all 29" but registers only 8/45 + 24/49. README references skill names that don't exist (`create-agent-skill`, `file-todos`). Three skills carry unconverted Claude Code / CEP references (`setup`, `orchestrating-swarms`, `deepen-plan`). Three GitHub issues signal a CEP-sync promise that was deleted in PR #243. `sync-manifest.json` and `convert-cc-defs` imply ongoing upstream tracking while the project has decided to evolve independently. The codebase is better than its public materials suggest — this reset closes that gap.

See origin: `docs/brainstorms/2026-04-17-credibility-reset-requirements.md`.

## Requirements Trace

All 24 requirements from the origin document are addressed.

- **R1.** Pull 27 hash changes from CEP HEAD, skip 6 soon-to-be-deleted skills → Unit 1
- **R2.** Import missing sub-files for 5 skills (dhh-rails-style, dspy-ruby, andrew-kane-gem-writer, claude-permissions-optimizer, every-style-editor) → Unit 1
- **R3.** Update `manifest.files[]` arrays for affected skills (before manifest deletion) → Unit 1
- **R4.** Delete CEP sync infrastructure (command, skill, script, its tests) → Unit 2
- **R5.** Delete `sync-manifest.json`, `src/lib/manifest.ts`, `tests/unit/manifest.test.ts` → Unit 3
- **R6.** Update AGENTS.md to remove all CEP-sync references → Unit 4
- **R7.** Delete `skills/setup/` → Unit 6
- **R8.** Merge `lfg` + `slfg` into single `lfg` skill with documented swarm mode → Unit 7
- **R9.** Delete `skills/ce-work-beta/` → Unit 8
- **R10.** Merge `todo-create/resolve/triage` trio into `todos` skill → Unit 9
- **R11.** Rewrite `orchestrating-swarms` for OpenCode primitives → Unit 10
- **R12.** Verify `deepen-plan` is free of CEP references (already cleaned — zero matches on April 17, 2026) and that all 14 `systematic:*` agent references resolve to real files in `agents/` → Unit 11
- **R13.** Every bundled skill/agent exists as OCX component → Unit 12
- **R14.** Two catalog bundles (`skills`, `agents`) matching README claims → Unit 12
- **R15.** Profiles (omo, standalone) remain hand-curated → Unit 12
- **R16.** Parity check fails build on filesystem/registry drift → Unit 13
- **R17.** README no longer claims counts (remove rather than auto-derive) → Unit 14
- **R18.** README contains no nonexistent skill/agent names → Unit 14
- **R19.** AGENTS.md, README, docs reflect post-reset state → Units 4, 14, 15
- **R20.** Close GitHub issues #227, #231, #239 → Unit 16
- **R21.** Delete legacy `commands/` path (5-file ripple) → Unit 17
- **R22.** Stop swallowing bundled asset parse errors silently → Unit 18
- **R23.** Add `tests/unit/validation.test.ts` → Unit 19
- **R24.** Add `tests/unit/bootstrap.test.ts` → Unit 20

## Scope Boundaries

- **Not in scope:** CI content integrity gate (banned-pattern, count-drift, parity-drift detection). Deferred; discipline-only during transition.
- **Not in scope:** Importing 14 new CEP definitions or applying 8 CEP deletions. Reconciliation-only sync.
- **Not in scope:** New OpenCode hooks (`experimental.session.compacting`, `tool.execute.before/after`). Next cycle.
- **Not in scope:** Code refactoring of `converter.ts` `convertContent` God function, `skill-tool.ts` long methods, or `validation.ts` `normalizePermission` extraction. Cosmetic; not blocking trust.
- **Not in scope:** Future CEP imports. After this reset, there is no CEP sync path.

## Context & Research

### Relevant Code and Patterns

- **Skill discovery:** `src/lib/skills.ts:90-122` (`findSkillsInDir` walks directories with `maxDepth=3`, looks for `SKILL.md`, extracts frontmatter). Reuse pattern for Unit 12 registry walker.
- **Agent discovery:** `src/lib/agents.ts:49-60` (`findAgentsInDir` walks with `maxDepth=2`, derives `category` from parent dir). Reuse pattern for Unit 12.
- **Silent null returns to fix:** `src/lib/config-handler.ts:84-87` (`loadAgentAsConfig`), `src/lib/config-handler.ts:124-127` (`loadCommandAsConfig`), `src/lib/skills.ts:85-87` (`extractFrontmatter`). Target of Unit 18.
- **Test pattern:** `tests/unit/config-handler.test.ts:18-35` sets up temp dir via `fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-config-test-'))`, cleans with `fs.rmSync({recursive: true, force: true})`. Use this shape in Units 19 and 20.
- **Fixture pattern:** `tests/unit/config-handler.test.ts:41-83` defines `createSkill`, `createAgent`, `createCommand` helpers. Mirror in Units 19 and 20.
- **Frontmatter fixture:** Use `formatFrontmatter` from `src/lib/frontmatter.ts` (referenced in existing tests) to generate YAML in fixtures.
- **Bootstrap contract:** `src/lib/bootstrap.ts:32-68` reads `using-systematic/SKILL.md`, strips frontmatter, wraps in `<SYSTEMATIC_WORKFLOWS>` tags with tool mapping template. `BootstrapDeps` is `{ bundledSkillsDir: string }`.
- **Skip heuristic:** `src/index.ts:10-14` `INTERNAL_AGENT_SIGNATURES` array; case-insensitive substring match against `output.system.join('\n')` at `src/index.ts:91-110`.
- **CEP conversion patterns:** `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c sed ordering is specific-before-general to avoid double-conversion. Phase 3d mandatory code-block audit because converter skips fenced blocks. Always exclude `sync-manifest.json` and `claude-permissions-optimizer` (targeted fix only: plugin prefix + OC tool names, preserve CC refs).
- **Registry structure:** `registry/registry.jsonc` uses `{ name, type, description, files: [{ path, target }] }` component shape. `resolveComponentFilePath` (`scripts/build-registry.ts:181-204`) maps `ocx:skill` → `skills/{name}/{file.path}`, `ocx:agent` → `{file.path}` project-relative.
- **Registry validation:** `validateRegistry` (`scripts/build-registry.ts:206-279`) already errors on unlisted files in a skill directory. Hook the parity check into this path for Unit 13.
- **docs:generate pipeline:** `docs/scripts/transform-content.ts` (364 lines) generates Starlight MDX to `docs/src/content/docs/reference/{skills,agents}/`. Does not produce README-inlinable output. Confirms R17's "remove counts entirely" is the simpler path.

### Institutional Learnings

- **`docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`** — Converter skips fenced code blocks by design; 47 broken tool names in `orchestrating-swarms` came from skipping Phase 3d audit. Mandatory grep-sweep for `Task(`, `TodoWrite`, `.claude/` in code blocks before Phase 4 completion.
- **`docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`** — Prior import dropped 32 sub-files silently. `check-cep-upstream.ts` needed per-skill file enumeration. PR #258 fixed document-review, ce-review, ce-compound, ce-compound-refresh. This plan finishes the job for 5 remaining skills in Unit 1.
- **`docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`** — `TOOL_NAME_MAP` in converter must stay in sync with `TOOL_MAPPINGS` in `bootstrap.ts`. Unknown frontmatter fields must pass through.
- **`docs/solutions/integration-issues/batch-import-cep-agents-to-systematic-20260210.md`** — Past imports introduced phantom agents (`code-philosopher`, `devops-harmony-analyst`, `dependency-detective`) that never existed upstream. Cross-reference with `bun src/cli.ts list agents` during Unit 14 README fixes.
- **`docs/solutions/code-quality/ocx-registry-review-fixes.md`** — Prefer Node.js built-ins over external binaries (jq) in scripts. Extract test helpers to stay under Biome's 15-point cognitive complexity ceiling. Registry URLs must point to real endpoints.

### External References

None. Local patterns are strong; no new technology. Skipped external research.

## Key Technical Decisions

- **Phase A skips 6 to-be-deleted skills** during reconciliation sync (`setup`, `slfg`, `ce-work-beta`, `todo-create`, `todo-resolve`, `todo-triage`). Wasted work otherwise; these disappear in PR 2.
- **Phase C+D must be the same PR.** Post-C/pre-D state has a broken registry — validation would fail on references to deleted skills. Atomicity required.
- **3 PR strategy:** PR 1 (Phases A+B sync + divorce), PR 2 (Phases C+D rationalization + registry), PR 3 (Phases E+F public surface + code quality). Each PR keeps the repo buildable/testable at every commit; the reset story survives review fatigue by arriving in digestible chunks.
- **Remove README counts entirely rather than auto-derive.** `docs:generate` produces Starlight MDX, not README-inlinable output. Engineering a new manifest pipeline is YAGNI when a link to the reference docs is sufficient.
- **Registry becomes filesystem-derived.** `scripts/build-registry.ts` shifts from validator-of-hand-curated to generator-plus-validator. Profiles (`omo`, `standalone`) stay hand-curated in `registry/registry.jsonc`; skill/agent components become machine-generated.
- **Error surfacing at build time, graceful degradation at runtime.** Build-time `silent: false` mode throws on first parse failure with file path; runtime (plugin hook) keeps the current null-return behavior to avoid breaking user sessions.
- **Swarm-mode invocation in merged `lfg`:** `mode:swarm` token pattern (primary, matching established `ce-review` convention). OpenCode skills DO parse arguments via `$ARGUMENTS` — injected by `src/lib/skill-loader.ts:52-53` into a `<user-request>` block. Phase 0 of the merged skill parses `$ARGUMENTS` for `mode:swarm`, strips it, and branches. Keyword fallback (`/parallel|concurrent|swarm|simultaneously/i`) is secondary. Default is sequential (backward compat with original `lfg`).
- **`todos` merge strategy:** `mode:create|mode:resolve|mode:triage` tokens (primary). Keyword fallback uses distinct verbs (create/add/new/write → create; resolve/close/complete/done → resolve; triage/prioritize/review/approve → triage). Default is triage (read-first, lowest risk). Multi-intent phrases resolve first-match-wins with advisory to re-run for the second mode.
- **Mid-flow mode switches not supported.** User must re-invoke with explicit mode. Documented in both skills.
- **Integration test cleanup in PR 1:** `tests/integration/opencode.test.ts` has `describe('sync-cep workflow simulation')` and `describe('convert-cc-defs skill discoverability')` blocks. Delete them alongside the infrastructure.

## Open Questions

### Resolved During Planning

- **Should Phase A skip skills Phase C will delete?** Yes — wasted work otherwise (spec-flow-analyzer).
- **README counts: auto-derive or remove?** Remove. `docs:generate` produces Starlight MDX, not README-inlinable output; engineering a new pipeline is overkill.
- **Delete sync-cep integration test blocks?** Yes — they reference deleted infrastructure.
- **Fix latent bugs found during validation/bootstrap test writing?** Yes if <2 hours total; otherwise defer and file a follow-up.
- **PR structure?** 3 PRs: (A+B), (C+D atomic), (E+F).
- **Order within PR 2:** catalog rationalization (Units 6–11) must land before registry auto-generation (Units 12–13) within the same PR. Registry walker needs the final catalog shape.
- **Mode detection in merged `lfg`:** `mode:swarm` token (primary) via `$ARGUMENTS` parsing. Keyword fallback (`/parallel|concurrent|swarm|simultaneously/i`) secondary. Default: sequential. Follows established `ce-review` convention. The brainstorm's implicit "no argument parsing" assumption was wrong — OpenCode skills do support `$ARGUMENTS` via `src/lib/skill-loader.ts:52-53`.
- **Mode detection in merged `todos`:** `mode:create|mode:resolve|mode:triage` tokens (primary). Keyword fallback map: create/add/new/write → create; resolve/close/complete/done → resolve; triage/prioritize/review/approve → triage. "fix" → resolve (closing is more common intent). Multi-intent: first-match wins with advisory. Default: triage (read-first, safest entry).
- **Unit 12 file allowlist:** USE DENYLIST INSTEAD. Repo contains `.py` (5), `.rb` (3), `.mjs` (3), `.txt` (1) files that the original `.md/.sh/.yaml/.yml/.json` allowlist would exclude incorrectly. Denylist: `.DS_Store`, `.gitkeep`, `*.bak`, `*.tmp`.
- **`registry.jsonc` source-of-truth model:** `registry.jsonc` remains the source file with hand-curated profiles, plugin entry, and bundle descriptions. `scripts/build-registry.ts` reads it, merges generated skill/agent components, and writes to `dist/registry/`. The source file is NOT auto-modified — only the build output changes. Avoids merge conflicts on rebase.
- **Release versioning strategy:** PR 1 commit `feat(sync): ...` → 2.x.y minor. PR 2 commit `feat(catalog)!: ...` with `BREAKING CHANGE:` footer → 3.0.0. PR 3 commit `docs: ...` → 3.0.1. Units 6–9 are the breaking changes (public skill catalog removals).
- **Consumer migration posture:** OCX `ocx add systematic/<deleted-name>` returns clean "component not found" error. User configs with `disabled_skills: ["slfg"]` are silently ignored (graceful). No aliases layer needed — CHANGELOG migration notes sufficient.

### Deferred to Implementation

- **Pre-sync CEP HEAD re-check behavior:** if precheck finds >32 hash changes (materially more than the 27 noted in the brainstorm), pause and reassess. Exact tolerance ±5 in Unit 1.
- **`orchestrating-swarms` and `deepen-plan` conceptual content:** value prop preserved (see Units 10–11 verification catalogs); exact rewrite wording determined when writing.
- **Build-time error aggregation vs fail-fast:** fail-fast on first parse error. Simpler, no batching complexity. Unit 18.
- **`cli.ts` `list commands` behavior post-R21:** keep the `commands` case but make it error cleanly (`"No bundled commands. Use .opencode/commands/ for project-specific commands."`). Unit 17.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Registry auto-generation flow (Units 12–13)

```
scripts/build-registry.ts
  ├─ generateRegistrySource()        ← NEW: walks filesystem
  │    ├─ walkDir(skills/, depth=3) → skill components
  │    │    - include SKILL.md + all sub-files recursively
  │    │    - emit { name, type: 'ocx:skill', description, files: [...] }
  │    ├─ walkDir(agents/, depth=2) → agent components
  │    │    - emit { name, type: 'ocx:agent', description, files: [{path, target}] }
  │    └─ mergeWithHandCuratedSections(registry.jsonc)
  │         - preserve: profiles, plugin entry, bundle descriptions
  │         - regenerate: skill components, agent components
  │         - bundles: list aggregate 'skills' and 'agents' with all components as deps
  │
  ├─ parityCheck()                    ← NEW: drift detection
  │    - compare generated skill set vs filesystem
  │    - compare generated agent set vs filesystem
  │    - fail build on mismatch with diff
  │
  └─ validateRegistry()               ← EXISTING: enhanced
       - add parityCheck() to validation pass
```

### PR sequence and state invariants

```
main branch
  │
  ▼
PR 1 ─── Final CEP Sync + Divorce (Phases A+B)
  │      Invariant: build green before and after; no catalog shape change
  │
  ▼
PR 2 ─── Rationalize + Registry (Phases C+D, atomic)
  │      Invariant: catalog finalized (40/49), registry matches filesystem
  │      Risk window: post-C/pre-D — must be same PR to avoid
  │
  ▼
PR 3 ─── Public Surface + Code Quality (Phases E+F)
         Invariant: README truthful, tests added, legacy gone
```

## Implementation Units

### PR 1 — Final CEP Sync + Divorce (Phases A+B)

- [ ] **Unit 1: Execute final reconciliation CEP sync**

**Goal:** Pull 27 hash updates + missing sub-files for 5 skills. Skip 6 to-be-deleted skills. Update manifest one final time before R5 deletes it.

**Requirements:** R1, R2, R3

**Dependencies:** None.

**Files:**
- Modify: `skills/<each-of-27>/SKILL.md` and any sub-files listed in CEP HEAD for those 27 skills
- Create: `skills/dhh-rails-style/**` (7 sub-files), `skills/dspy-ruby/**` (9 sub-files), `skills/andrew-kane-gem-writer/**` (6 sub-files), `skills/claude-permissions-optimizer/**` (3 sub-files), `skills/every-style-editor/**` (2 sub-files)
- Modify: `sync-manifest.json` — update `hash` and `files[]` for each touched definition

**Approach:**
- Re-run `bun scripts/check-cep-upstream.ts` as precheck. If total hash-change count is within 27±5, proceed; else pause and reassess.
- For each of the 27 hash changes, skip `setup`, `slfg`, `ce-work-beta`, `todo-create`, `todo-resolve`, `todo-triage` (will be deleted in PR 2).
- Fetch full file trees for the 5 multi-file skills from CEP HEAD.
- Apply batch sed replacements per `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c ordering, excluding `sync-manifest.json` and special-casing `claude-permissions-optimizer` (plugin prefix + OC tool names only; preserve CC refs).
- Run mandatory Phase 3d code-block audit: `grep -rnE 'Task\(|TodoWrite|AskUserQuestion|\.claude/' skills/ agents/` — must match only `claude-permissions-optimizer` and nothing else.
- Run verification grep (both checks): (1) no remaining CC/CEP refs in touched files, (2) no over-conversions (`.opencode/.opencode/`, `config/opencode/.config/`, etc.).
- Update `sync-manifest.json` with new hashes and full `files[]` arrays for the 5 multi-file skills.

**Patterns to follow:** `.opencode/skills/convert-cc-defs/SKILL.md` Phase 2c–3d workflow (used one last time).

**Test scenarios:**
- `bun run build && bun run typecheck && bun run lint && bun test` all pass after sync
- Verification greps return zero unexpected matches
- `sync-manifest.json` validates via `readManifest` without errors

**Verification:**
- Build green
- No CC/CEP refs outside the two documented exceptions
- All 5 multi-file skills have their complete sub-file trees

---

- [ ] **Unit 2: Delete CEP sync infrastructure (command + skill + script)**

**Goal:** Remove the `/sync-cep` command, `convert-cc-defs` skill, `check-cep-upstream.ts`, and its test.

**Requirements:** R4

**Dependencies:** Unit 1 (sync complete before deleting the tools that ran it).

**Files:**
- Delete: `.opencode/commands/sync-cep.md`
- Delete: `.opencode/skills/convert-cc-defs/` (entire directory)
- Delete: `scripts/check-cep-upstream.ts`
- Delete: `tests/unit/check-cep-upstream.test.ts`

**Approach:**
- Delete the four paths.
- Verify nothing else imports from these files: `grep -rE 'convert-cc-defs|sync-cep|check-cep-upstream' src/ scripts/ tests/ .opencode/`.
- Expected residual matches: integration tests (handled in Unit 5) and docs references (handled in Unit 4).

**Patterns to follow:** Prior deletions in PR #243.

**Test scenarios:**
- Build green
- No residual imports of deleted files (grep confirms)

**Verification:**
- `bun run build && bun run typecheck && bun run lint && bun test tests/unit` all pass
- Four paths no longer exist on disk

---

- [ ] **Unit 3: Delete sync-manifest.json and manifest module**

**Goal:** Remove `sync-manifest.json`, `src/lib/manifest.ts`, and `tests/unit/manifest.test.ts`. Manifest is only referenced by the now-deleted `check-cep-upstream.ts`, so removal is clean.

**Requirements:** R5

**Dependencies:** Unit 2 (check-cep-upstream.ts is the only consumer of manifest.ts in src/).

**Files:**
- Delete: `sync-manifest.json`
- Delete: `src/lib/manifest.ts`
- Delete: `tests/unit/manifest.test.ts`

**Approach:**
- Confirm manifest.ts has no remaining imports from `src/` (spec-flow-analyzer research confirmed zero imports in src/).
- Delete the three paths.
- Update `src/lib/AGENTS.md` to remove the manifest module row from the module table.

**Patterns to follow:** None — straight deletion.

**Test scenarios:**
- Build green, no module resolution errors
- All unit tests pass

**Verification:**
- `grep -rE 'from.*manifest|import.*manifest' src/ tests/` returns zero matches
- `sync-manifest.json` no longer exists

---

- [ ] **Unit 4: Update AGENTS.md for independence narrative**

**Goal:** Reframe AGENTS.md as an independent project. Remove all CEP-sync language. Keep CLI `convert` command documentation (converter itself is still useful for ad-hoc).

**Requirements:** R6, R19 (partial)

**Dependencies:** Units 2, 3 (references to deleted files must be removed).

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/lib/AGENTS.md` (remove manifest module row, if not done in Unit 3)

**Approach:**
- Delete the "Upstream Sync" section entirely.
- Remove `sync-manifest.json` from the "Where to Look" table.
- Remove `scripts/check-cep-upstream.ts` references.
- Update overview to describe Systematic as independent: "OpenCode plugin providing structured engineering workflows. Originally adapted from CEP but now evolves independently."
- Drop CEP-specific language from the `convert` CLI description (it still converts CC-format files; just not specifically CEP).
- Update the structure diagram to remove `sync-manifest.json`.

**Patterns to follow:** PR #243 narrative (original CEP-tether removal).

**Test scenarios:** N/A (docs only).

**Verification:**
- `grep -E 'sync-manifest|check-cep-upstream|sync-cep' AGENTS.md src/lib/AGENTS.md` returns zero matches

---

- [ ] **Unit 5: Delete sync-cep and convert-cc-defs integration test blocks**

**Goal:** Remove `describe('sync-cep workflow simulation')` and `describe('convert-cc-defs skill discoverability')` blocks from integration tests. They reference infrastructure deleted in Units 2–3.

**Requirements:** R4 (integration test side)

**Dependencies:** Unit 2.

**Files:**
- Modify: `tests/integration/opencode.test.ts`

**Approach:**
- Delete the two `describe` blocks (`sync-cep workflow simulation` and `convert-cc-defs skill discoverability`).
- The `extractCommandFrontmatter` import remains in `opencode.test.ts:6` for now — its deletion belongs to Unit 17 (PR 3), since that's when `src/lib/commands.ts` itself goes away. Leaving it untouched here keeps PR 1 surgical.

**Patterns to follow:** Existing integration test structure.

**Test scenarios:**
- `bun test tests/integration/opencode.test.ts` passes

**Verification:**
- Integration test count drops by the two removed `describe` blocks
- `extractCommandFrontmatter` import stays until Unit 17 removes it

---

### PR 2 — Portfolio Rationalization + OCX Registry (Phases C+D, atomic)

- [ ] **Unit 6: Delete `setup` skill**

**Goal:** Remove the placeholder `setup` skill that explicitly declares itself inert.

**Requirements:** R7

**Dependencies:** None.

**Files:**
- Delete: `skills/setup/` (entire directory)
- Modify: `registry/registry.jsonc` — if setup is listed, remove (unlikely per current state)

**Approach:**
- Delete the directory.
- `grep -rE 'systematic:setup|skills/setup' docs/ README.md .opencode/` to find references; remove or update.

**Test scenarios:**
- Build green, no orphan references

**Verification:**
- `ls skills/setup/` returns "No such file or directory"
- No grep matches for `setup` as a skill name in docs/

---

- [ ] **Unit 7: Merge `lfg` + `slfg` → unified `lfg` with swarm mode**

**Goal:** Single `lfg` SKILL.md documents sequential (default) and swarm (parallel) execution modes. Mode detection via `mode:swarm` token pattern (established `ce-review` convention).

**Requirements:** R8

**Dependencies:** None.

**Files:**
- Modify: `skills/lfg/SKILL.md` (rewrite to include swarm mode section)
- Modify: `skills/lfg/SKILL.md` frontmatter: add `argument-hint: '[mode:swarm] [feature description]'`
- Delete: `skills/slfg/` (entire directory)

**Approach:**

Research ground truth: `slfg` adds 3 material differences over `lfg` (not just a keyword):
1. `ce:work` invocation with explicit "Use swarm mode: launch an army of agent swarm subagents" instruction
2. `ce:review` runs `mode:report-only` as background Task in parallel with `test-browser`, then runs `mode:autofix` sequentially after
3. Named phases with explicit parallelism markers vs flat numbered list in `lfg`

Rewrite strategy: preserve both workflows as branches of the same skill.

**Mode Detection Algorithm (Phase 0):**

```
1. Parse $ARGUMENTS for `mode:swarm` token (primary mechanism)
   - If found: SWARM_MODE = true, strip token from arguments
2. Else scan $ARGUMENTS for natural-language signals
   - Regex: /\b(parallel|concurrent|swarm|simultaneously)\b/i
   - If match: SWARM_MODE = true (log which keyword triggered)
3. Else: SWARM_MODE = false (default — backward compat with original lfg)

Echo detected mode in first output line: "Detected mode: [sequential|swarm]. Proceeding."
```

**Mid-flow switches:** Not supported. If user requests switch mid-flow, document re-invocation pattern and skip-to-phase guidance.

**Patterns to follow:** `skills/ce-review/SKILL.md` token-parsing pattern (`mode:autofix`, `mode:report-only`). `skills/ce-compound-refresh/SKILL.md` for consistent style.

**Test scenarios:**
- Input `$ARGUMENTS = "mode:swarm build auth feature"` → swarm mode, args become `"build auth feature"`
- Input `$ARGUMENTS = "run lfg concurrently on this"` → swarm mode (keyword fallback)
- Input `$ARGUMENTS = "run the swarm-style review"` → swarm mode (false positive acceptable — downstream agents ignore the phrasing)
- Input `$ARGUMENTS = "build auth feature"` → sequential mode (default)
- `bun src/cli.ts list skills` shows `lfg` but not `slfg`
- `docs:generate` produces updated reference page

**Verification:**
- `ls skills/slfg/` returns "No such file or directory"
- `skills/lfg/SKILL.md` contains both sequential and swarm phase definitions
- Swarm phase section explicitly instructs `ce:work` with "swarm mode" + "Task list"
- Swarm phase section explicitly uses `run_in_background=true` on parallel `ce:review mode:report-only` and `test-browser` calls
- All 9 original `lfg` steps present in sequential mode section (grep for `/ce:plan`, `/ce:work`, `/ce:review`, `/todo-resolve`, `/test-browser`, `/feature-video`)
- `deepen-plan` conditional logic preserved (grep for "Standard or Deep" and high-risk trigger list)

---

- [ ] **Unit 8: Delete `ce-work-beta`**

**Goal:** Remove the experimental Codex delegation variant. Any valuable bits graduate into `ce-work` (decide during implementation).

**Requirements:** R9

**Dependencies:** None.

**Files:**
- Delete: `skills/ce-work-beta/` (entire directory)
- Modify: `skills/ce-work/SKILL.md` if any beta-only mechanism graduates

**Approach:**
- Read `skills/ce-work-beta/SKILL.md` and diff against `skills/ce-work/SKILL.md`.
- Decide per-mechanism: drop (experimental only, not production-ready) or graduate (add to `ce-work`).
- Delete the directory.

**Test scenarios:**
- Build green, no orphan references in docs or registry

**Verification:**
- `ls skills/ce-work-beta/` returns "No such file or directory"

---

- [ ] **Unit 9: Merge `todo-create` + `todo-resolve` + `todo-triage` → `todos`**

**Goal:** Single `todos` skill with three modes (create, resolve, triage) sharing a common foundation. Mode detection via `mode:<name>` token pattern.

**Requirements:** R10

**Dependencies:** None.

**Files:**
- Create: `skills/todos/SKILL.md`
- Create: `skills/todos/assets/`, `skills/todos/references/` as needed (adopt sub-files from the three originals if any)
- Delete: `skills/todo-create/`, `skills/todo-resolve/`, `skills/todo-triage/`

**Approach:**

Research ground truth: the three originals share a strong common foundation (same directory paths `.context/systematic/todos/` + legacy `todos/`, same file naming `{issue_id}-{status}-{priority}-{description}.md`, same YAML schema, same status values `pending/ready/complete`, same priority values `p1/p2/p3`). Mode-specific logic can build on the shared base.

**Frontmatter:** `argument-hint: '[mode:create|mode:resolve|mode:triage] [description or context]'`

**Mode Detection Algorithm (Phase 0):**

```
1. Parse $ARGUMENTS for `mode:create`, `mode:resolve`, or `mode:triage` token (primary)
   - If found: set mode, strip token from arguments
2. Else scan $ARGUMENTS for keyword signals (first match wins):
   - /\b(create|add|new|write|track|log)\b/i → create mode
   - /\b(resolve|close|complete|done|finish|mark)\b/i → resolve mode
   - /\b(triage|prioritize|review|approve|sort|categorize)\b/i → triage mode
3. Ambiguity rules:
   - "fix" → resolve (closing is more common intent than triage)
   - "handle" → triage (read-first is safer)
4. Multi-intent (multiple modes detected):
   - Execute first-match mode
   - Output advisory: "Detected additional intent for [mode]. Run `/todos` again to execute."
5. No signal present:
   - Default to triage (read-first, safest, natural entry)
   - Output: "No mode detected. Defaulting to triage (review pending todos)."

Echo detected mode: "Detected mode: [create|resolve|triage]. Proceeding."
```

**Skill structure:**
- Shared section: file format, directory paths (`.context/systematic/todos/` canonical, `todos/` legacy), YAML frontmatter schema, status/priority values, naming convention
- Mode-specific section: create workflow (write-focused, template-driven)
- Mode-specific section: resolve workflow (batch processing, parallel `systematic:workflow:pr-comment-resolver` dispatch, commit+push, `ce:compound` for learnings)
- Mode-specific section: triage workflow (interactive approve/skip/modify loop, Haiku model switch, file renaming `pending` → `ready`)

**Patterns to follow:** Unit 7 structural pattern; existing `skills/ce-review/SKILL.md` token parsing.

**Test scenarios:**
- Input `$ARGUMENTS = "mode:create fix N+1 query"` → create mode, args `"fix N+1 query"`, new file at `.context/systematic/todos/NNN-pending-p2-fix-n-plus-1.md`
- Input `$ARGUMENTS = "resolve my todos"` → resolve mode (keyword), parallel subagent dispatch on `ready` todos
- Input `$ARGUMENTS = "triage the pending items"` → triage mode, interactive loop
- Input `$ARGUMENTS = "fix my todos"` → resolve mode (ambiguity rule)
- Input `$ARGUMENTS = "create some todos and then triage them"` → create mode executed, advisory emitted for triage
- Input `$ARGUMENTS = ""` → triage mode (default)

**Verification:**
- Three old directories deleted (`ls skills/todo-create skills/todo-resolve skills/todo-triage` all fail)
- `skills/todos/SKILL.md` contains all three mode sections explicitly
- Shared foundation section enumerates both paths, full YAML schema, status/priority model
- `pr-comment-resolver` agent referenced in resolve mode (verify agent exists in `agents/workflow/`)
- `bun src/cli.ts list skills` shows `todos` but not the originals

---

- [ ] **Unit 10: Rewrite `orchestrating-swarms` for OpenCode primitives**

**Goal:** Replace CEP-era `TaskCreate` / `claude-code-guide` references with real OpenCode `task()` + `subagent_type` patterns. Skill teaches real multi-agent orchestration in OpenCode.

**Requirements:** R11

**Dependencies:** None.

**Files:**
- Modify: `skills/orchestrating-swarms/SKILL.md` (likely full rewrite)

**Approach:**

The current content has 25+ distinct CC-specific patterns requiring replacement:

| CC Reference                                 | Location                         | Replacement Strategy                                                                                  |
| -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TeammateTool`                                 | Lines 424–593 (entire section)   | Remove or document as aspirational — OpenCode has no native equivalent                                |
| `Teammate({ operation: "spawnTeam" })`         | Lines 428–439                    | Replace with OpenCode team-coordination pattern using multiple `task(run_in_background=true)`             |
| `Teammate({ operation: "write" })`             | Lines 487–497                    | Remove (no OpenCode messaging primitive)                                                              |
| `Teammate({ operation: "broadcast" })`         | Lines 500–519                    | Remove                                                                                                |
| `Teammate({ operation: "requestShutdown" })`   | Lines 521–528                    | Remove                                                                                                |
| `Teammate({ operation: "cleanup" })`           | Lines 586–593                    | Remove                                                                                                |
| `TaskCreate`                                   | Lines 600–609, 843–857, 997–1014 | Replace with `task(subagent_type=..., prompt=..., run_in_background=true)`                                  |
| `TaskList`                                     | Lines 611–621                    | Remove (OpenCode tracks background task IDs but no public listing API in skill-accessible surface)    |
| `TaskGet`                                      | Lines 623–629                    | Replace with `background_output(task_id=...)` on system completion notification                         |
| `TaskUpdate`                                   | Lines 631–645                    | Remove                                                                                                |
| `~/.opencode/teams/`                           | Lines 127–139, 1129–1135         | Remove path refs or mark conceptual                                                                   |
| `~/.opencode/tasks/`                           | Lines 136–139, 668–684           | Remove path refs or mark conceptual                                                                   |
| `claude-code-guide` subagent type              | Line 291                         | Replace with real subagent (`research` or `general`)                                                      |
| `CLAUDE_CODE_TEAM_NAME`                        | Lines 1053–1060                  | Remove env-var references                                                                             |
| `CLAUDE_CODE_AGENT_ID`                         | Line 1054                        | Remove                                                                                                |
| `CLAUDE_CODE_SPAWN_BACKEND`                    | Lines 1299–1307                  | Remove                                                                                                |
| `task({ team_name, name, ... })`                 | Lines 199–215, 800–870           | Simplify to `task(subagent_type, prompt, run_in_background)` — OpenCode signature                         |
| `subagent_type: "systematic:review:*"`         | Lines 320–355                    | Verify each name exists in `agents/review/`. Current dir has: adversarial-reviewer, agent-native-reviewer, api-contract-reviewer, architecture-strategist, cli-agent-readiness-reviewer, cli-readiness-reviewer, code-simplicity-reviewer, correctness-reviewer, data-integrity-guardian, data-migration-expert, data-migrations-reviewer, deployment-verification-agent, dhh-rails-reviewer, julik-frontend-races-reviewer, kieran-python-reviewer, kieran-rails-reviewer, kieran-typescript-reviewer, maintainability-reviewer, pattern-recognition-specialist, performance-oracle, performance-reviewer, previous-comments-reviewer, project-standards-reviewer, reliability-reviewer, schema-drift-detector, security-reviewer, security-sentinel, testing-reviewer |
| `subagent_type: "systematic:research:*"`       | Lines 374–395                    | Verify in `agents/research/`: best-practices-researcher, framework-docs-researcher, git-history-analyzer, issue-intelligence-analyst, learnings-researcher, repo-research-analyst |
| `subagent_type: "systematic:workflow:*"`       | Lines 414–420                    | Verify in `agents/workflow/`: bug-reproduction-validator, lint, pr-comment-resolver, spec-flow-analyzer |
| `subagent_type: "systematic:design:*"`         | Lines 405–411                    | Verify in `agents/design/`: design-implementation-reviewer, design-iterator, figma-design-sync |

Rewrite teaches real OpenCode orchestration:
- **Parallel `task()` invocations** with `run_in_background=true` for divide-and-conquer
- **Subagent selection** from real agents cataloged above (no phantoms)
- **Result collection** via `background_output(task_id=...)` after system notification (never poll)
- **Session continuation** via `session_id` for follow-ups without re-exploration
- **Pipeline patterns** — fan-out/fan-in, research-then-implement, plan-approval, coordinated refactoring
- **Aspirational note** preserved: "OpenCode lacks native swarm primitives (Teams, Inboxes, Broadcast). Current alternative: multiple `task(run_in_background=true)` invocations with system-notification-driven result collection."

Mandatory Phase 3d code-block audit after rewrite.

**Patterns to follow:** How `ce-review/SKILL.md` and `document-review/SKILL.md` structure parallel persona-agent orchestration.

**Test scenarios:**
- `grep -nE 'TaskCreate|TaskList|TaskGet|TaskUpdate|Teammate\(|CLAUDE_CODE_|claude-code-guide|compound-engineering' skills/orchestrating-swarms/` returns zero
- Every `subagent_type: "..."` value in the rewritten skill matches a real entry in `agents/<category>/`
- Example `task()` calls use only documented OpenCode parameters (`subagent_type`, `prompt`, `run_in_background`, `session_id`)
- `docs:generate` produces updated reference page without errors
- Aspirational note remains and correctly describes the OpenCode alternative

**Verification:**
- Zero CC/CEP refs remain (25+ patterns catalogued above all replaced or removed)
- Every subagent reference cross-checks against agents/ directory
- Distinct value vs `ce-plan`, `ce-review`, `ce-work` is preserved — orchestrating-swarms remains the only skill teaching swarm primitives

---

- [ ] **Unit 11: Verify `deepen-plan` is CEP-free and agents resolve**

**Goal:** Re-verify the skill is free of CEP references (grep returned zero matches on April 17, 2026 — scope-guardian review caught stale assumption in original plan) and validate all 14 agent references resolve to real files in `agents/`. This unit is lightweight verification, not a rewrite.

**Requirements:** R12

**Dependencies:** None.

**Files:**
- Modify: `skills/deepen-plan/SKILL.md` (only if verification finds residual drift — agent references pointing to renamed/deleted agents, or any CC refs that reappeared via a recent sync)

**Approach:**

Current content references 14 distinct agents. Verify each exists in the post-reset `agents/` tree before finalizing the rewrite:

| Referenced Agent                              | Expected Location                                  | Verification |
| --------------------------------------------- | -------------------------------------------------- | ------------ |
| `systematic:research:repo-research-analyst`     | `agents/research/repo-research-analyst.md`           | grep check   |
| `systematic:research:learnings-researcher`      | `agents/research/learnings-researcher.md`            | grep check   |
| `systematic:research:framework-docs-researcher` | `agents/research/framework-docs-researcher.md`       | grep check   |
| `systematic:research:best-practices-researcher` | `agents/research/best-practices-researcher.md`       | grep check   |
| `systematic:research:git-history-analyzer`      | `agents/research/git-history-analyzer.md`            | grep check   |
| `systematic:review:architecture-strategist`     | `agents/review/architecture-strategist.md`           | grep check   |
| `systematic:review:pattern-recognition-specialist` | `agents/review/pattern-recognition-specialist.md` | grep check   |
| `systematic:workflow:spec-flow-analyzer`        | `agents/workflow/spec-flow-analyzer.md`              | grep check   |
| `systematic:review:performance-oracle`          | `agents/review/performance-oracle.md`                | grep check   |
| `systematic:review:security-sentinel`           | `agents/review/security-sentinel.md`                 | grep check   |
| `systematic:review:data-integrity-guardian`    | `agents/review/data-integrity-guardian.md`           | grep check   |
| `systematic:review:data-migration-expert`       | `agents/review/data-migration-expert.md`             | grep check   |
| `systematic:review:deployment-verification-agent` | `agents/review/deployment-verification-agent.md`    | grep check   |

Other CEP leftovers to remove:
- `.context/compound-engineering/deepen-plan/` cache path references → replace with `.context/systematic/deepen-plan/` (or remove if unused)
- `compound-engineering` MCP tool names (none expected after catalog audit)

Rewrite teaches:
- Second-pass confidence checking of plans (keep existing structure — this is the unique value)
- Checklist-based gap scoring with risk weighting (keep)
- Targeted research agent selection using verified agent list above
- Artifact-backed vs direct research modes (keep)
- Synthesis rules — what to change, what not to change (keep)

Mandatory Phase 3d code-block audit.

**Patterns to follow:** How `ce-plan/SKILL.md` structures Phase 1 research with parallel agents.

**Test scenarios:**
- `grep -nE 'compound-engineering|\.context/compound-engineering' skills/deepen-plan/` returns zero
- Every `systematic:*` agent reference in the skill is validated against the 14-agent list above
- Cross-check against `agents/` filesystem: `for ref in $(grep -oE 'systematic:[^" ]*' skills/deepen-plan/SKILL.md | sort -u); do find agents/ -name "$(basename $ref).md" || echo "MISSING: $ref"; done` produces zero MISSING lines
- Scoped invocation syntax (`Scope: architecture, patterns`) preserved

**Verification:**
- Zero CEP tool-name or cache-path refs remain
- All 14 agent references resolve to real files in `agents/`
- Distinct value vs `ce-plan`, `ce-review`, `ce-work` is preserved — `deepen-plan` remains the only skill focused on strengthening existing plans

---

- [ ] **Unit 12: Create filesystem-walk generator in `build-registry.ts`**

**Goal:** Transform `build-registry.ts` from validator-only to generator-plus-validator. Create new `generateRegistrySource()` function (~150-200 lines of new code), walk `skills/` and `agents/`, emit components for each, preserve hand-curated profiles and plugin entry.

**Requirements:** R13, R14, R15

**Dependencies:** Units 6–11 (catalog must be final before walking).

**Files:**
- Modify: `scripts/build-registry.ts`
- Modify: `registry/registry.jsonc` — shrink to only hand-curated sections (profiles, plugin entry, bundle descriptors); skill/agent components become generated in memory
- Modify: `tests/unit/build-registry.test.ts`

**Approach:**

**Source-of-truth model:** `registry/registry.jsonc` remains the source file containing only hand-curated sections (profiles `omo` and `standalone`, plugin entry, bundle descriptions/metadata). The file is NOT auto-modified on build — merge conflicts on rebase are avoided. Build output goes to `dist/registry/`.

Add `generateRegistrySource(handCurated, filesystem)` function that:
1. Walks `skills/` via pattern from `src/lib/skills.ts` (depth 3)
2. For each skill dir: emit `{ name, type: 'ocx:skill', description, files }` where `files` includes every file recursively under `skills/<name>/`, filtered by denylist (see below), mapped to `{ path: <relative>, target: '.opencode/skills/<name>/<relative>' }`
3. Walks `agents/` via pattern from `src/lib/agents.ts` (depth 2)
4. For each agent file: emit `{ name, type: 'ocx:agent', description, files: [{ path, target }] }`
5. Merges generated components with hand-curated sections from `registry.jsonc`
6. Fills `skills` and `agents` bundle `dependencies` arrays with every generated component name
7. Writes merged result to `dist/registry/` (NOT to `registry.jsonc`)

**File filtering: DENYLIST (not allowlist).** Filesystem audit revealed `.py` (gemini-imagegen, 5 files), `.rb` (dspy-ruby, 3 files), `.mjs` (onboarding + claude-permissions-optimizer, 3 files), and `.txt` (gemini-imagegen, 1 file) are legitimate asset files. An allowlist would drop 12 real files. Denylist:

```
Exclude:
  - .DS_Store          (macOS artifact)
  - .gitkeep           (placeholder)
  - *.bak, *.tmp, *~   (editor artifacts)
  - Directory names:   __pycache__, .pytest_cache, node_modules
```

**Description sourcing:** Component `description` field comes from the asset's frontmatter `description:` verbatim. Frontmatter review showed current descriptions are generally good enough to ship; Units 10 and 11 rewrites further improve the two problematic ones.

Test: generate registry from fixture filesystem containing all legitimate extension types, assert output shape.

**Patterns to follow:** `src/lib/skills.ts` / `src/lib/agents.ts` discovery code; `scripts/build-registry.ts` existing `resolveComponentFilePath` logic.

**Test scenarios:**
- Fixture with 3 skills, 2 agents → generates 5 components + 2 bundles + preserves profiles
- Skill with `.md`, `.sh`, `.py`, `.rb`, `.mjs`, `.yaml`, `.json`, `.txt` sub-files → all included in component `files[]`
- Skill directory containing `.DS_Store` → excluded from component `files[]`
- Skill without `SKILL.md` → generator errors with file path (use for invalid-input test)
- Source `registry.jsonc` unchanged after build — only `dist/registry/` files change
- Real-repo smoke test: `bun scripts/build-registry.ts` against current filesystem generates component count matching `ls skills/ | wc -l` and agent total

**Verification:**
- `bun scripts/build-registry.ts` succeeds against real repo post-Unit-11
- Generated registry skills count == `ls skills/ | wc -l` (expected: 40 post-rationalization)
- Generated registry agents count == `find agents -mindepth 2 -type f -name '*.md' | wc -l` (expected: 49)
- `git diff registry/registry.jsonc` after build is empty (source file not modified)
- All 12 previously-excluded non-`.md` asset files from `gemini-imagegen`, `dspy-ruby`, `onboarding`, `claude-permissions-optimizer` are included in their components

---

- [ ] **Unit 13: Filesystem/registry parity check in build pipeline**

**Goal:** Registry build fails if filesystem and registry disagree on component membership. Drift becomes impossible.

**Requirements:** R16

**Dependencies:** Unit 12.

**Files:**
- Modify: `scripts/build-registry.ts` — add `parityCheck()` invocation
- Modify: `tests/unit/build-registry.test.ts` — add parity-check test cases

**Approach:**
- Insert `parityCheck()` call between `generateRegistrySource()` and `validateRegistry()` in `main()`. Ordering: generate → parity-check → validate → build. Parity-check operates on the in-memory registry structure, not file output.
- Check symmetry in both directions:
  - Every `skills/<name>/` directory → must have a generated skill component
  - Every `agents/<cat>/<name>.md` → must have a generated agent component
  - Every generated component → must have a corresponding filesystem entry (already guaranteed by generator, but belt-and-suspenders)
- Fail build with descriptive diff on mismatch — list unexpected filesystem entries and missing components.
- Test: add fixture with intentional drift (e.g., skill directory with no `SKILL.md`) and assert build error with correct message.

**Patterns to follow:** Existing `validateRegistry` error-reporting style.

**Test scenarios:**
- Happy path: 3/3 skills match → no errors
- Skill added to filesystem without registry → parity error
- Component references deleted skill → parity error

**Verification:**
- Parity check integrated into CI path (`bun run registry:validate` now includes it)
- Test suite has coverage for both mismatch directions

---

### PR 3 — Public Surface + Code Quality Hardening (Phases E+F)

- [ ] **Unit 14: README truth reset — remove false counts + nonexistent skill names**

**Goal:** Every README claim matches repo reality. Counts removed entirely (linked to reference docs instead). Nonexistent skill/agent names deleted. Every `ocx add` example resolves to a real component.

**Requirements:** R17, R18, R19 (partial)

**Dependencies:** Units 6–13 (catalog and registry final).

**Files:**
- Modify: `README.md`

**Approach:**
- Remove "Batteries Included — 48 skills and 29 agents ship" claim; replace with "Batteries Included — curated skills and agents ship."
- Remove "(View all 48 skills →)" with explicit count; replace with link only: "View all skills →".
- Remove "All 48 skills" / "All 29 agents" descriptions from OCX bundle examples; replace with "All bundled skills" / "All bundled agents".
- Delete references to `create-agent-skill` and `file-todos` in the Skills section.
- Update Skills and Agents tables to match current filesystem. Use `bun src/cli.ts list skills` and `bun src/cli.ts list agents` as source of truth.
- Re-verify every `/systematic:<name>` and `ocx add systematic/<name>` example resolves.
- Update Project Structure diagram to reflect post-reset state (no `sync-manifest.json`, `manifest.ts`).

**Patterns to follow:** Existing README structure; keep tables compact.

**Test scenarios:**
- `grep -E '48 skills|29 agents|create-agent-skill|file-todos' README.md` returns zero
- Every `ocx add systematic/` example in README maps to a real component post-Unit 12

**Verification:**
- All README examples resolvable
- No numerical count claims remain

---

- [ ] **Unit 15: AGENTS.md catalog refresh**

**Goal:** AGENTS.md structure section, module tables, and supporting text reflect post-rationalization catalog and post-deletion module set.

**Requirements:** R19

**Dependencies:** Units 6–11, 17 (catalog and module surface final).

**Files:**
- Modify: `AGENTS.md`
- Modify: `src/lib/AGENTS.md`

**Approach:**
- Update structure block: `skills/` now "40 bundled skills", `agents/` stays "49 bundled agents".
- Remove `commands/` line (handled in Unit 17).
- Update Code Map to remove `findCommandsInDir`, `readManifest`, `validateManifest`, `writeManifest`, `findStaleEntries`.
- Update src/lib/AGENTS.md module tables to remove `commands.ts` and `manifest.ts` rows.
- Refresh the file count ("13 core modules" becomes "11 core modules" post-deletions).

**Test scenarios:** N/A (docs only).

**Verification:**
- `grep -E 'commands\.ts|manifest\.ts|compound-engineering' AGENTS.md src/lib/AGENTS.md` returns zero

---

- [ ] **Unit 16: Close stale GitHub issues + file CI drift gate followup**

**Goal:** Issues #227, #231, #239 (CEP sync runs from March 24–26) closed with comment linking to the reset. New issue filed to track the deferred CI drift gate — discipline-as-mitigation gets an explicit owner.

**Requirements:** R20 (plus followup owner for the deferred CI drift gate)

**Dependencies:** PR 3 merged.

**Files:** None in-repo.

**Approach:**

1. **Close stale issues** (after PR 3 merges):
   - `gh issue close 227 --comment "Closed as part of the credibility reset (PR #NNN). The CEP sync workflow was deleted in PR #243 and this reset completes the divorce — no further CEP sync runs will occur."`
   - Repeat for #231 and #239 with the same comment.

2. **File CI drift gate issue:**
   ```
   gh issue create \
     --title "CI content integrity gate (parity + banned-pattern detection)" \
     --body "$(cat <<'EOF'
   ## Context

   The credibility reset (PR #NNN) established parity between the repo, README, and OCX registry.
   Without a CI drift gate, discipline alone prevents regression. This issue tracks adding CI enforcement.

   ## Scope

   - [ ] Add `scripts/check-drift.ts` that fails CI on:
     - Count drift between README and filesystem
     - Nonexistent skill/agent names referenced in README/docs
     - Banned CC remnants: `TaskCreate`, `AskUserQuestion`, `\.claude/`, `CLAUDE\.md`, `compound-engineering:` (with claude-permissions-optimizer exemption)
     - Registry/filesystem parity drift (catches the Unit 12 case)
   - [ ] Wire into `.github/workflows/main.yaml` as required check
   - [ ] Consider: auto-update README skill/agent counts via generated manifest (lower priority)

   ## Priority

   P2, next cycle after reset lands.

   ## References

   - Credibility reset plan: `docs/plans/2026-04-17-001-refactor-credibility-reset-plan.md`
   - Reset brainstorm: `docs/brainstorms/2026-04-17-credibility-reset-requirements.md`
   EOF
   )"
   ```

3. **Add smart note** via `ctx_note` for dreamer surfacing:
   - Content: "CI drift gate issue tracked (#NNN). After reset stabilizes, pick up the followup scope."
   - Surface condition: "When reviewing followup work in marcusrbrown/systematic and the credibility reset reset PR has been merged for >14 days"

**Verification:**
- `gh issue list --state open` no longer includes #227, #231, #239
- New issue exists with the CI drift gate scope
- Smart note registered (surfaces ~2 weeks post-merge)

---

- [ ] **Unit 17: Delete legacy `commands/` path**

**Goal:** Remove empty `commands/` dir, `src/lib/commands.ts`, its test, and all consumers. Project-specific commands still work via user-level `.opencode/commands/` (handled by OpenCode core, not our plugin).

**Requirements:** R21

**Dependencies:** Unit 5 (integration test already cleaned).

**Files:**
- Delete: `commands/` directory (empty, just `.gitkeep`)
- Delete: `src/lib/commands.ts`
- Delete: `tests/unit/commands.test.ts`
- Modify: `src/cli.ts` (line 5 import; `list commands` case keeps but prints clean message)
- Modify: `src/lib/config-handler.ts` (line 3 import; remove `collectCommands`, `loadCommandAsConfig`, `bundledCommandsDir` parameter)
- Modify: `src/index.ts` (line 21 `bundledCommandsDir` declaration; line 54 `createConfigHandler` call)
- Modify: `tests/integration/opencode.test.ts` (line 6 import + line 52 usage — both used only by the sync-cep test blocks that Unit 5 already deleted, so these become dead references after Unit 5 and must be removed here)
- Modify: `tests/unit/config-handler.test.ts` (remove `createCommand` helper and `bundledCommandsDir` fixture setup)

**Approach:**
- Remove `import { extractCommandFrontmatter } from '../../src/lib/commands.ts'` from `opencode.test.ts:6`; remove the `extractCommandFrontmatter(content)` call on line 52 (dead code after Unit 5).
- Remove `import * as commands from './lib/commands.js'` from `cli.ts:5`.
- Update `cli.ts` `list commands` case to print `"No bundled commands. Use .opencode/commands/ for project-specific commands."` and exit 0 (not error).
- Remove `import { extractCommandFrontmatter, findCommandsInDir } from './commands.js'` from `config-handler.ts:3`.
- Remove `bundledCommandsDir` from `ConfigHandlerDeps` interface and all call sites.
- Remove `collectCommands` + `loadCommandAsConfig` from `config-handler.ts`.
- Update `tests/unit/config-handler.test.ts` fixtures to remove `createCommand` helper uses and `bundledCommandsDir` setup.
- Delete the empty `commands/` directory.

**Patterns to follow:** Prior cleanups of dead code paths.

**Test scenarios:**
- Build green, typecheck green, lint green
- All unit tests pass after fixture updates
- `bun src/cli.ts list skills` and `list agents` still work

**Verification:**
- `grep -rE 'commands\.ts|bundledCommandsDir|findCommandsInDir|loadCommandAsConfig|extractCommandFrontmatter|collectCommands' src/ tests/` returns zero matches
- `ls commands/` returns "No such file or directory"

---

- [ ] **Unit 18: Stop swallowing bundled asset parse/convert errors**

**Goal:** Build-time parse failures surface with file path; runtime remains graceful.

**Requirements:** R22

**Dependencies:** None; runs in parallel with other PR 3 units.

**Files:**
- Modify: `src/lib/config-handler.ts` (`loadAgentAsConfig`, `loadSkillAsCommand`)
- Modify: `src/lib/skills.ts` (`extractFrontmatter`)
- Modify: `scripts/build-registry.ts` if it calls these paths
- Modify: `tests/unit/config-handler.test.ts` — add cases for build-time error surfacing

**Approach:**
- Introduce a `strict: boolean` option on the relevant internal functions. When `strict: true`, throw with file path context on parse/convert failure. When `strict: false`, keep current null-return behavior.
- Build pipeline (registry build, CLI) passes `strict: true`. Plugin hook (`createConfigHandler`) passes `strict: false` — runtime must degrade gracefully.
- Error message format: `"Failed to parse <category> at <path>: <underlying error>"`.
- Test: fixture with malformed YAML → `strict: true` throws with expected message; `strict: false` returns null silently.

**Patterns to follow:** Existing test temp-dir pattern from `tests/unit/config-handler.test.ts:18-35`.

**Test scenarios:**
- Valid asset, `strict: true` → succeeds
- Valid asset, `strict: false` → succeeds
- Malformed YAML, `strict: true` → throws with file path
- Malformed YAML, `strict: false` → returns null, no throw
- Missing required frontmatter field, `strict: true` → throws with field name

**Verification:**
- `bun test tests/unit/config-handler.test.ts` all pass including new cases
- `bun run build` still succeeds (no current bundled asset trips strict mode)
- If a bundled asset trips strict mode during build, fix the asset or re-evaluate the strictness rule

---

- [ ] **Unit 19: Add `tests/unit/validation.test.ts`**

**Goal:** Direct unit tests for `src/lib/validation.ts`. Cover `normalizePermission`, `isAgentMode`, `isPermissionSetting`, `isRecord`, `extractString`, `extractBoolean`.

**Requirements:** R23

**Dependencies:** None; runs in parallel.

**Execution note:** Start with failing test scaffolding for each function; implement assertions to probe current behavior; note any unexpected results as defects to fix in scope (if <2 hours) or file as follow-ups.

**Files:**
- Create: `tests/unit/validation.test.ts`
- Modify: `src/lib/validation.ts` only if tests reveal latent bugs and fix is <2 hours

**Approach:**
- Test file structure mirrors `tests/unit/frontmatter.test.ts` style (no temp dirs needed; pure function tests).
- `describe('validation')` block with nested `describe` per function.
- `normalizePermission`: test all three input shapes (string, boolean, `ask/allow/deny` record), malformed inputs, missing keys, invalid values. Include nested bash-map case: `{ bash: { "npm install": "allow", "rm -rf": "deny" } }` → returns valid `PermissionConfig` with `bash` as `Record<string, PermissionSetting>`.
- `isAgentMode`: test legal values (`primary`, `subagent`, `all`), illegal values, non-string types.
- `isPermissionSetting`: test valid shapes, malformed shapes.
- `isRecord`: test objects, arrays, null, primitives.
- `extractString` / `extractBoolean`: test happy path, missing key, wrong type, default value path.

**Patterns to follow:** `tests/unit/frontmatter.test.ts` for pure-function test style.

**Test scenarios:**
- ~20 tests covering all exported functions
- Both happy path and defensive behavior
- Edge cases: bash permission map, nested permission structures

**Verification:**
- `bun test tests/unit/validation.test.ts` passes
- Coverage of all exported symbols in `validation.ts`

---

- [ ] **Unit 20: Add `tests/unit/bootstrap.test.ts`**

**Goal:** Direct unit tests for `src/lib/bootstrap.ts` (`getBootstrapContent`) and the `INTERNAL_AGENT_SIGNATURES` skip heuristic in `src/index.ts`.

**Requirements:** R24

**Dependencies:** None; runs in parallel.

**Execution note:** Test-first. Fixture using-systematic SKILL.md in temp dir, exercise all branches.

**Files:**
- Create: `tests/unit/bootstrap.test.ts`

**Approach:**
- Test file uses temp-dir pattern (needs `using-systematic/SKILL.md` fixture).
- `describe('getBootstrapContent')` with cases:
  - Default config (`bootstrap.enabled: true`, no `bootstrap.file`) + fixture SKILL.md → returns wrapped content
  - `bootstrap.enabled: false` → returns null
  - Custom `bootstrap.file` (absolute path) → reads custom file
  - Custom `bootstrap.file` with `~/` prefix → expands to home dir
  - Custom `bootstrap.file` pointing to missing path → falls through to default `using-systematic/SKILL.md` (per `bootstrap.ts:40-47` — custom file is tried first via `fs.existsSync`; if missing, default path is used)
  - Missing `using-systematic/SKILL.md` in `bundledSkillsDir` → returns null
  - SKILL.md with no frontmatter → uses full content as body
  - Content wrapping: returns `<SYSTEMATIC_WORKFLOWS>` tags and tool mapping template
- `describe('INTERNAL_AGENT_SIGNATURES skip')` with cases:
  - Title generator signature in system prompt → skip (no injection)
  - Conversation summary signature → skip
  - Normal system prompt → inject bootstrap
  - Case-insensitive match (e.g., lowercase signature variant) → skip
  - Multiple system messages concatenated → matches across boundaries

**Patterns to follow:** `tests/unit/config-handler.test.ts` temp-dir setup; `tests/unit/skill-tool.test.ts` for plugin-hook-level testing.

**Test scenarios:** ~12 tests covering all branches of `getBootstrapContent` + skip heuristic.

**Verification:**
- `bun test tests/unit/bootstrap.test.ts` passes
- Both `getBootstrapContent` and the `system.transform` skip logic are covered

## System-Wide Impact

- **Interaction graph:** The plugin factory in `src/index.ts` passes `bundledCommandsDir` to `createConfigHandler`. Unit 17 removes this wire; all three files (`index.ts`, `config-handler.ts`, `cli.ts`) must be updated in the same commit to keep the build green.
- **Error propagation:** Unit 18 introduces a `strict: boolean` option. Runtime always uses `strict: false`. Build pipeline (registry, CLI) uses `strict: true`. A single shared utility for the error-wrap ensures consistent messaging.
- **State lifecycle risks:** None. The reset is in-place; no persistent state to migrate.
- **API surface parity:** The plugin's three OpenCode hooks (`config`, `tool`, `system.transform`) keep identical signatures. Consumer-facing behavior only changes if they rely on specific skill names (setup/slfg/ce-work-beta/todo-*). Note in CHANGELOG.
- **Integration coverage:** Unit 5 deletes two `describe` blocks from integration tests but keeps the bootstrap-injection test block intact. Unit 20 adds focused unit tests for the same bootstrap behavior. Net integration coverage: lower-level, higher-confidence.
- **Registry build pipeline:** Unit 12 inverts the source-of-truth direction (filesystem → registry, not registry → validate filesystem). Any downstream consumer of `registry/registry.jsonc` must either read the generated output from `dist/registry/` or run `bun run registry:build` first.

## Risks & Dependencies

- **Risk: CEP HEAD moves between precheck and sync execution.** Mitigation: re-run `check-cep-upstream.ts` immediately before Unit 1 starts; pause if change count differs materially (tolerance ±5 on the 27 figure).
- **Risk: Unit 10/11 rewrites drift from the intended value prop.** Mitigation: compare rewritten skills against `ce-plan`/`ce-review`/`ce-work` to confirm distinct value before completing; if overlap is unavoidable, consider deleting the skill instead.
- **Risk: Unit 12 walker misses edge-case file types in `skills/<name>/`.** Mitigation: denylist excludes `.DS_Store`, `.gitkeep`, `*.bak`, `*.tmp`, `*~`, and artifact directories (`__pycache__`, `.pytest_cache`, `node_modules`). All other file types (including `.py`, `.rb`, `.mjs`, `.txt`) are included. Fixture tests cover the denylist. This replaces the earlier allowlist proposal, which would have dropped 12 legitimate asset files.
- **Risk: Unit 17 has ripples I missed in third-party consumers (e.g., `docs/` scripts).** Mitigation: comprehensive `grep -rE 'commands\.ts|bundledCommandsDir|findCommandsInDir|loadCommandAsConfig'` before starting; verify `bun run docs:generate` post-change.
- **Risk: Unit 14 README updates drift again after the next catalog change.** Mitigation: Unit 16 files a GitHub issue for the CI drift gate (P2, next cycle) and registers a smart note that surfaces ~2 weeks post-merge. "Discipline-only" is the transitional state, not the final state — explicit followup owner is now recorded.
- **Risk: OCX consumer with pinned version hits missing components after 3.0.0.** Mitigation: CHANGELOG migration notes document the exact `ocx remove` / `ocx add` commands. Major version bump signals breaking change. Consumers on `@latest` follow automatically.
- **Risk: User config `disabled_skills: ["slfg"]` causes errors post-reset.** Mitigation: `src/lib/config-handler.ts:191-209` iterates skill list and only skips entries that match — stale entries are silently ignored. No action required from users. CHANGELOG notes this explicitly.
- **Risk: Registry walker drops asset files with non-`.md` extensions.** Mitigation: switched from allowlist to denylist after filesystem audit found 12 legitimate `.py`/`.rb`/`.mjs`/`.txt` files that would have been excluded. Denylist explicitly excludes `.DS_Store`, `.gitkeep`, `*.bak`, `*.tmp`, `*~`, and artifact directories.
- **Risk: `registry.jsonc` becomes a merge conflict hotspot if auto-modified during build.** Mitigation: source file stays hand-curated; generated output goes to `dist/registry/`. The source file is never auto-modified on build — rebase conflicts only occur on genuinely hand-edited changes.
- **Risk: Mode-detection false positives (e.g., "run the swarm-style review" in lfg, "fix my todos" in todos ambiguous).** Mitigation: both skills echo detected mode in first output line. Users can re-invoke with explicit `mode:...` token if misdetected. Behavioral tests cover the ambiguity matrix.
- **Dependency: `.opencode/skills/convert-cc-defs/` exists until Unit 2 deletes it.** Unit 1 uses it one last time.
- **Dependency: `sync-manifest.json` exists until Unit 3 deletes it.** Unit 1 updates it one last time.
- **Dependency: Unit 12 runs after Units 6–11 complete.** Walker operates on final catalog.
- **Dependency: Unit 14 runs after Units 6–13 complete.** README reflects final state.

## Documentation / Operational Notes

### Commit Message Strategy (controls release versioning)

semantic-release uses Conventional Commits. PR-final commit messages drive the version bump:

| PR   | Final commit message                                                                    | Expected release | Rationale                                                                                   |
| ---- | --------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| PR 1 | `feat(sync): final CEP reconciliation and infrastructure divorce`                         | 2.x.y (minor)    | New behavior (final sync + infra removal) but no public-API breakage                        |
| PR 2 | `feat(catalog)!: rationalize skill portfolio and auto-generate registry`                  | **3.0.0**            | `!` marker + `BREAKING CHANGE:` footer trigger major bump                                       |
| PR 3 | `docs: public surface truth reset and code quality hardening`                             | 3.0.1 (patch)    | Docs + legacy cleanup + tests — no new public behavior                                      |

**PR 2 commit message must include the `BREAKING CHANGE:` footer:**

```
feat(catalog)!: rationalize skill portfolio and auto-generate registry

BREAKING CHANGE: Removes skills: setup, slfg, ce-work-beta, todo-create, todo-resolve, todo-triage.
Adds: todos (unified). Modifies: lfg (adds swarm mode via mode:swarm token).
OCX consumers must remove references to deleted skills and re-add using new names.
```

### CHANGELOG Migration Notes (for 3.0.0 release)

```markdown
### 3.0.0 — Credibility Reset

### Removed Skills (Breaking)

| Removed         | Replacement                                                |
| --------------- | ---------------------------------------------------------- |
| `slfg`            | Use `lfg` with `mode:swarm` token (or "parallel" keyword)    |
| `ce-work-beta`    | Use `ce-work` (Codex delegation was experimental)            |
| `setup`           | Removed (was a placeholder)                                |
| `todo-create`     | Use `todos` with `mode:create` token                         |
| `todo-resolve`    | Use `todos` with `mode:resolve` token                        |
| `todo-triage`     | Use `todos` with `mode:triage` token (or no argument → default) |

### OCX Consumers

If you have pinned versions, update to `@^3.0.0`:

```bash
# Remove deleted components
ocx remove systematic/slfg systematic/ce-work-beta systematic/setup \
  systematic/todo-create systematic/todo-resolve systematic/todo-triage

# Add new unified skills
ocx add systematic/lfg systematic/todos
```

### Configuration

Stale entries in `disabled_skills` / `disabled_agents` / `disabled_commands` are silently ignored — no action required, but you can clean them up:

```json
{
  "disabled_skills": []  // remove entries for deleted skills if present
}
```

### Infrastructure

- `sync-manifest.json` removed. Systematic now evolves independently of CEP.
- `/sync-cep` slash command removed. No upstream sync path exists.
- `convert-cc-defs` skill removed. CLI `systematic convert` still handles ad-hoc Claude Code format conversions.
```

### Rollback Windows

Each PR is revertable, but "safe" has an explicit expiration:

| PR   | Safe revert window         | Effectively unrevertable after                                     |
| ---- | -------------------------- | ------------------------------------------------------------------ |
| PR 1 | Until PR 2 merges          | PR 2 merge (the sync tools would reference deleted skills)         |
| PR 2 | Until 3.0.0 is on npm      | 3.0.0 published (consumers may have adopted `todos`, merged `lfg`)     |
| PR 3 | Until external links exist | External docs/blog posts reference the new README                  |

**Recommendation:** If issues surface in PR 2, revert BEFORE releasing 3.0.0. Once `@fro.bot/systematic@3.0.0` is on npm, forward-fix only.

### Release Cadence

3 PRs → 3 releases. Intermediate states are never broken for users. Consumer impact limited to anyone depending on specific deleted skill names (addressed by CHANGELOG migration notes above).

### Post-Reset Documentation

Write `docs/solutions/workflow-patterns/credibility-reset-20260417.md` capturing the reset approach as a reusable pattern. Specifically:
- "Atomic C+D PR" pattern — catalog changes and registry regeneration must land together
- "Skip to-be-deleted during reconciliation sync" pattern — avoid wasted work when sync and rationalization cycles overlap
- "Denylist vs allowlist for filesystem walkers" pattern — denylist wins when diverse asset types exist
- "Token-based mode detection" pattern — `mode:<value>` in `$ARGUMENTS` is the established Systematic convention

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-17-credibility-reset-requirements.md](../brainstorms/2026-04-17-credibility-reset-requirements.md)
- **Oracle assessment:** Session context — strengths/gaps analysis that originated this reset
- **Prior CEP-tether removal:** PR #243 (`chore/break-cep-tether`), commit `561f53c`
- **Prior CEP sync restoration:** PR #255 (`chore/restore-sync-cep-command`)
- **Prior sub-file imports:** PR #258 (document-review, ce-review, ce-compound, ce-compound-refresh)
- **Node.js interop fix context:** PR #271 (`--target bun` + jsonc-parser bundling)
- **Institutional learnings referenced:**
  - `docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md`
  - `docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md`
  - `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`
  - `docs/solutions/integration-issues/batch-import-cep-agents-to-systematic-20260210.md`
  - `docs/solutions/code-quality/ocx-registry-review-fixes.md`
- **Open GitHub issues to close:** #227, #231, #239
