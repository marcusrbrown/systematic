---
title: "Graduate ce-work-beta into ce-work via native task() dispatch"
type: feat
status: completed
date: 2026-05-05
origin: docs/brainstorms/2026-05-05-ce-work-beta-graduation-requirements.md
---

# Graduate ce-work-beta into ce-work via native task() dispatch

## Overview

Replace `skills/ce-work-beta/` (Codex CLI shell-exec delegation) with a single bundled implementer subagent and native OpenCode `task()` dispatch in `skills/ce-work/`. Single PR, minor version bump. No new TypeScript code, no new config block, no new skill-content injection mechanism — the existing `findAgentsInDir` + `config-handler.ts` pipeline handles everything via one new markdown file in `agents/workflow/`.

## Problem Frame

The dual-skill split (`/ce:work` stable, `/ce:work-beta` Codex-delegating) has carried a `[BETA]` tag for months without external user feedback. The beta variant ships 27 KB of skill prose plus 327 lines of `references/codex-delegation-workflow.md` gated behind a per-repo `.systematic/config.local.yaml` consent file that lives outside Systematic's normal config tree. The beta variant exists primarily for the maintainer's own use, and the maintainer wants delegation that integrates with OpenCode's native primitives instead of an external CLI.

OpenCode's built-in `task` tool already provides fresh-context subagent dispatch. Peer plugins (oh-my-opencode-slim, oh-my-openagent) ship bundled subagents via standard markdown files in `agents/<category>/<name>.md` and dispatch via `task({ subagent_type, description, prompt })`. Systematic's existing `findAgentsInDir` + `extractAgentFrontmatter` + `config-handler.ts:225-247` pipeline already merges bundled agents into `config.agent` at every plugin init. Registration shape is verified by code, not assumed.

V1's job is mechanical: write one markdown file, update one skill, delete one directory, clean up one registry entry, regenerate one auto-generated docs page. Behavioral correctness for parallel dispatch (file-collision detection, downgrade-to-serial, post-batch cross-check) is preserved as skill prose — the orchestrator-LLM still runs those checks, the dispatch primitive just changes from "your available subagent or task spawning mechanism" to a specific `task({ subagent_type: "systematic-implementer", ... })` call.

## Requirements Trace

- R1. Single shipped work-execution skill, `[BETA]` tag and dual-skill split removed.
- R2. `skills/ce-work-beta/` deleted including `SKILL.md`, `references/codex-delegation-workflow.md`, `references/shipping-workflow.md`. (R10's KNOWN_ISSUES entry lives inside `ce-work-beta/SKILL.md` — satisfied by this deletion, no separate work item.)
- R3. `registry/registry.jsonc` updated; `bun run registry:build` and `registry:drift` pass.
- R4. `docs/src/content/docs/reference/skills/ce-work-beta.md` removed automatically by `bun run docs:generate` (verified: `docs/scripts/transform-content.ts:244` does `fs.rmSync` of the output dir before regeneration).
- R5. Single bundled implementer subagent at `agents/workflow/systematic-implementer.md`. Frontmatter omits `model:`, declares `mode: subagent`. (Storage location resolved at planning: not a new `agents/implementer/` category — single agent does not warrant its own top-level directory.)
- R6. Subagent system prompt encodes runtime invariants: NO stage, NO commit, NO push, NO full test suite.
- R7. `skills/ce-work/SKILL.md` Phase 1 Step 4 updated to name the bundled subagent and dispatch contract explicitly. (Specific edit: replace the generic phrase "your available subagent or task spawning mechanism" at line ~144 with explicit `task({ subagent_type: "systematic-implementer", description, prompt })` shape. The "Delegation routing gate" prose lives in `ce-work-beta/SKILL.md` only, so R9 is satisfied entirely by R2's directory deletion — no separate edit to `ce-work/SKILL.md` required for Codex prose removal.)
- R8. Existing parallel-safety-check skill prose preserved — file-collision detection, downgrade-to-serial, post-batch cross-check.
- R9. Codex CLI delegation path removed: argument tokens, fuzzy-activation phrases, consent-file YAML I/O, `references/codex-delegation-workflow.md` body. All of this lives in `ce-work-beta/` and is satisfied by R2.
- R10. Phantom — KNOWN_ISSUES entry lives inside `ce-work-beta/SKILL.md`; satisfied by R2.
- R11. Reintroducing Codex CLI not on any roadmap; brainstorm doc preserved as historical reference.

## Scope Boundaries

- No new `delegation` config block in `.opencode/systematic.json`. V1 hard-codes "always dispatch via `task()` for multi-unit plans, inline for trivial work."
- No new skill-content config injection mechanism. The existing `wrapSkillTemplate` + `extractSkillBody` pipeline is unchanged.
- No Phase 0 probe gating implementation. The brainstorm's spike already verified the `task()` invocation contract against `oh-my-opencode-slim`'s compiled hook (see Dependencies/Assumptions in the brainstorm).
- No async/background dispatch. Synchronous orchestrator-waits-for-each-task only.
- No multiple bundled implementers. Single `systematic-implementer` only.
- No migration tooling for `.systematic/config.local.yaml`. Users may delete the file manually; CHANGELOG mentions it explicitly.
- No `task.after` TypeScript hook for structured output extraction. The orchestrator-LLM reads each subagent's free-form response and reasons about it via natural language.

## Context & Research

### Relevant Code and Patterns

- `src/lib/agents.ts:49` — `findAgentsInDir` walks `agents/<category>/<name>.md`; `extractAgentFrontmatter` surfaces `name`, `description`, `mode`, `tools`, etc.
- `src/lib/config-handler.ts:225-247` — bundled-agent merge into `config.agent` at every plugin init. The merge is `{ ...bundledAgents, ...existingAgents }` so user agents win on collision.
- `src/lib/config-handler.ts:42-87` — `loadAgentAsConfig` passes the `mode` field through to OpenCode's runtime config (line 77: `if (mode !== undefined) config.mode = mode`).
- `scripts/content-integrity.ts` — `checkAgentModel` enforces "no `model:` field" on bundled agent markdown (PR #336 convention).
- `skills/ce-work/SKILL.md` Phase 1 Step 4 (current version) — strategy table with Inline / Serial subagents / Parallel subagents rows; Parallel Safety Check; subagent dispatch payload structure. The subagent dispatch section (line ~144) currently says "your available subagent or task spawning mechanism" — that phrase is the edit target.
- `skills/ce-work/references/shipping-workflow.md` — identical to `skills/ce-work-beta/references/shipping-workflow.md`; preserved unchanged.
- **`agents/workflow/lint.md`** and **`agents/workflow/bug-reproduction-validator.md`** — the only `mode: subagent` examples in `agents/workflow/`. Use these as frontmatter shape references. (Note: `spec-flow-analyzer.md` and `pr-comment-resolver.md` do NOT declare `mode: subagent` — do not use them as patterns.)
- `oh-my-opencode-slim` v1.0.6, compiled `dist/index.js` lines 23420-23456 — reference for `task` tool's actual argument contract: `{ subagent_type, description, prompt, task_id? }`. (The package ships only a compiled artifact; no public source repository to permalink. Verification was done locally against the installed npm package; an implementer can reproduce by inspecting the same lines in `node_modules/oh-my-opencode-slim/dist/index.js` after `npm i oh-my-opencode-slim@1.0.6` or by checking their own OpenCode plugin cache at `~/.cache/opencode/packages/oh-my-opencode-slim@1.0.6/`.)
- `docs/scripts/transform-content.ts:244` — `fs.rmSync` of the docs output dir before regeneration, which auto-prunes orphaned reference pages.

### Institutional Learnings

- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-2026-04-17.md` — relevant for any batch file edits. Use `find ... | while IFS= read -r f` (or `find ... -exec`), never `for f in $VAR`.
- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-2026-04-17.md` — relevant after deleting `skills/ce-work-beta/`: grep for orphaned references in source paths (skills/, agents/, src/, scripts/, registry/, tests/, docs/src/, AGENTS.md, package.json), excluding historical paths (`docs/brainstorms/`, `docs/plans/`, `docs/solutions/`).

### External References

None. The brainstorm's pre-flight spike confirmed the `task()` contract against slim's compiled source. No external best-practices research is required.

## Key Technical Decisions

- **Storage location: `agents/workflow/systematic-implementer.md`**. The agent executes plan implementation units, which is conceptually a workflow operation. Adding a new top-level `agents/implementer/` category for a single agent over-categorizes.
- **System prompt structure** (R6): single coherent instruction document with sections (a) Role — "You are a focused implementer dispatched by a parent OpenCode session orchestrating a multi-unit plan. You implement one unit's worth of changes and report back." (b) Constraints — explicit no-stage / no-commit / no-push / no-full-test-suite rules. (c) Approach — read unit's Goal/Files/Approach/Patterns/Test scenarios, make file edits, run only targeted tests for files touched. (d) Output — summarize changes, list files modified, surface deviations from declared `Files:` list, and note any orchestrator-attention issues. Concrete prompt text drafted during Unit 2; iterated against representative recent merged plans before final commit.
- **Skill-prose dispatch contract** (R7): replace the generic phrase "your available subagent or task spawning mechanism" at `skills/ce-work/SKILL.md` line ~144 with explicit `task({ subagent_type: "systematic-implementer", description: <unit goal>, prompt: <unit prompt body> })`. Update the unit prompt construction guidance to clarify what `description` (one-line unit Goal) and `prompt` (Files, Approach, Patterns, Test scenarios) each contain. The strategy table's Inline / Serial subagents / Parallel subagents rows describe execution patterns (not specific tools) and require no changes. The Parallel Safety Check section is unchanged. The parallel subagent constraints section is unchanged — the no-stage/no-commit/no-test rules are now duplicated between skill body (orchestrator-side) and bundled subagent's system prompt (subagent-side); both copies are intentional belt-and-suspenders.
- **Counts update** (Unit 1): `skills/` count is `46 → 45` (delete one); `agents/` count is `50 → 51` (add one). Verify with `find skills -name SKILL.md | wc -l` and `find agents -name '*.md' | wc -l`. Update both numbers in root `AGENTS.md`. (`docs/AGENTS.md` and `src/lib/AGENTS.md` to be checked for duplicated counts during execution.)
- **Orphan grep scope** (Unit 1 verification): use source paths only — `git grep -nE 'ce-work-beta|delegate:codex|delegate:local|\.systematic/config\.local\.yaml|references/codex-delegation-workflow\.md' -- skills/ agents/ src/ scripts/ registry/ tests/ docs/src/ docs/scripts/ AGENTS.md docs/AGENTS.md src/lib/AGENTS.md package.json`. Historical paths (`docs/brainstorms/`, `docs/plans/`, `docs/solutions/`) are not searched — they intentionally retain references for retrospective accuracy. Empirically (verified at planning time): only orphans outside the deletion target itself are in `registry/registry.jsonc` (already in Unit 1's scope).

## Open Questions

### Resolved During Planning

- **Where does `agents/implementer/` live?** Resolved: it doesn't. Agent ships at `agents/workflow/systematic-implementer.md`.
- **Does the bundled subagent's system prompt encode the no-stage/no-commit/no-push/no-test rules?** Resolved: yes, as runtime invariants. Orchestrator instructions are unit-specific only.
- **`task()` invocation contract**: resolved by brainstorm pre-flight spike — `task({ subagent_type, description, prompt, task_id? })`.
- **Return-value handling**: resolved — natural-language output. No `task.after` hook in V1.
- **Unit 3's edit target in `ce-work/SKILL.md`**: resolved — the "Delegation routing gate" paragraph is in `ce-work-beta` only; `ce-work` has no Codex prose. The actual edit is replacing one generic phrase at line ~144 with a specific `task()` call shape.
- **Files outside `skills/ce-work-beta/` that reference the beta skill**: resolved — empirically only `registry/registry.jsonc` (in Unit 1 scope) and `AGENTS.md` skill-count line (in Unit 1 scope). No source files, no test fixtures.
- **R10 KNOWN_ISSUES target**: resolved — entry lives inside `ce-work-beta/SKILL.md`, satisfied by R2's directory delete. No separate Unit 4 work.
- **Patterns to follow for `mode: subagent` agent**: resolved — `agents/workflow/lint.md` and `agents/workflow/bug-reproduction-validator.md` (not `spec-flow-analyzer.md`, which does not declare `mode: subagent`).

### Deferred to Implementation

- **Exact wording of `systematic-implementer` system prompt**: drafted during Unit 2; iterated against the 3 most recent merged plans in `docs/plans/` (currently `2026-05-01-001-fix-idempotent-plugin-registration-plan.md`, `2026-04-30-001-feat-writing-systematic-skills-plan.md`, `2026-04-25-001-feat-registry-automation-plan.md`) by mentally simulating dispatch.
- **Exact wording of `skills/ce-work/SKILL.md` line ~144 edit**: prose finalized during Unit 2.

## Implementation Units

- [ ] **Unit 1: Mechanical removal — delete ce-work-beta, clean registry, regenerate docs, update counts**

**Goal:** Remove `skills/ce-work-beta/` entirely, clean its registry references, regenerate the docs site to auto-prune the orphan reference page, and update `AGENTS.md` skill/agent counts. After this unit, the dual-skill split is gone; `bun run registry:drift` and `bun scripts/content-integrity.ts` pass; an exhaustive orphan grep returns zero source-tree matches.

**Requirements:** R1 (single shipped skill), R2 (dir deletion), R3 (registry cleanup), R4 (docs auto-prune), R9 (Codex prose removal — satisfied by R2), R10 (KNOWN_ISSUES — satisfied by R2).

**Dependencies:** None. First commit on the feature branch.

**Files:**
- Delete: `skills/ce-work-beta/SKILL.md`
- Delete: `skills/ce-work-beta/references/codex-delegation-workflow.md`
- Delete: `skills/ce-work-beta/references/shipping-workflow.md`
- Delete: `skills/ce-work-beta/` (the directory itself)
- Modify: `registry/registry.jsonc` (remove standalone `ce-work-beta` component entry at lines 452-462; remove `ce-work-beta` string from the `all-skills` bundle's `dependencies` array at line 754)
- Auto-pruned by `bun run docs:generate`: `docs/src/content/docs/reference/skills/ce-work-beta.md`
- Modify: root `AGENTS.md` (skill count `46 → 45` at line 50; agent count is updated in Unit 2 after the agent file lands, not here)
- Modify: `docs/AGENTS.md` (skill count `46 pages → 45 pages` at line 36; agent count is updated in Unit 2)
- `src/lib/AGENTS.md` carries no skill/agent counts — verified at planning time, no edit needed.
- Modify: `dist/registry/` (regenerated by `bun run registry:build`)

**Approach:**
- Branch from current `main` (HEAD `dfbe5c7` per planning-time check). Branch name: `feat/ce-work-graduation`.
- `rm -rf skills/ce-work-beta/` — single command.
- Edit `registry/registry.jsonc`: delete the `ce-work-beta` standalone component entry (lines 452-462) and the `ce-work-beta` string from `all-skills` dependencies (line 754). Visual confirm via `git diff registry/registry.jsonc`.
- Run `bun run docs:generate` — `transform-content.ts:244` rmSyncs the output dir before regen, so the orphan `ce-work-beta.md` reference page disappears automatically. Verify with `ls docs/src/content/docs/reference/skills/ce-work-beta.md` (should fail).
- Run `bun run registry:build` to regenerate `dist/registry/`.
- Run `bun scripts/content-integrity.ts` — confirm zero violations.
- Update skill counts only: root `AGENTS.md` line 50 (`46 → 45`) and `docs/AGENTS.md` line 36 (`46 pages → 45 pages`). Verify with `find skills -name SKILL.md | wc -l` (should print 45). Agent counts stay at 50 in this unit and are updated in Unit 2 after the new agent file lands.
- Run the orphan grep against source paths: `git grep -nE 'ce-work-beta|delegate:codex|delegate:local|\.systematic/config\.local\.yaml|references/codex-delegation-workflow\.md' -- skills/ agents/ src/ scripts/ registry/ tests/ docs/src/ docs/scripts/ AGENTS.md docs/AGENTS.md src/lib/AGENTS.md package.json`. Expected matches: zero (registry already cleaned in this unit).

**Patterns to follow:**
- `git rm -r` style cleanups in prior PRs (truth-reset PR #290 deleted entire skill directories cleanly).
- `bun run docs:generate` invocation per `docs/AGENTS.md`.

**Test scenarios:**
- Test expectation: this is a deletion + counts unit with no behavioral surface to test. Verification is via the post-unit gate runs.

**Verification:**
- `bun run registry:drift` exits 0.
- `bun run lint` exits 0.
- `bun run typecheck` exits 0.
- `bun scripts/content-integrity.ts` exits 0.
- The orphan grep above returns zero matches.
- `find skills -name SKILL.md | wc -l` prints 45.
- `git status` shows clean diff: deleted `skills/ce-work-beta/`, modified `registry/registry.jsonc`, deleted `docs/src/content/docs/reference/skills/ce-work-beta.md`, modified `dist/registry/*`, modified root `AGENTS.md` skill count, modified `docs/AGENTS.md` skill count.

---

- [ ] **Unit 2: Substantive change — add systematic-implementer agent, update ce-work skill prose**

**Goal:** Ship the `agents/workflow/systematic-implementer.md` bundled subagent and update `skills/ce-work/SKILL.md` Phase 1 Step 4 to dispatch against it via explicit `task()` call. Update root `AGENTS.md` agent count to reflect the new bundled agent.

**Requirements:** R5 (single bundled subagent), R6 (system prompt encodes invariants), R7 (skill prose dispatch contract), R8 (parallel-safety-check preserved).

**Dependencies:** Unit 1 (the registry+docs cleanup must complete first; the agent count update lands in this unit's commit alongside the new agent file).

**Files:**
- Create: `agents/workflow/systematic-implementer.md`
- Modify: `skills/ce-work/SKILL.md` (Phase 1 Step 4, line ~144)
- Modify: root `AGENTS.md` (agent count `50 → 51` at line 51)
- Modify: `docs/AGENTS.md` (agent count `50 pages → 51 pages` at line 37)
- Modify: `dist/registry/` (regenerated by `bun run registry:build`; the new agent appears as a registry component)

**Approach:**

Step 1 — write `agents/workflow/systematic-implementer.md`:
- Frontmatter: `name: systematic-implementer`, `description: <one-line description suitable for OpenCode tool catalog>`, `mode: subagent`. Omit `model:` per content-integrity gate.
- Body (system prompt) structured per Key Technical Decisions:
  - **Role**: "You are a focused implementer dispatched by a parent OpenCode session orchestrating a multi-unit plan. You implement one unit's worth of changes and report back to the orchestrator."
  - **Constraints**: "You MUST NOT stage files (`git add`), create commits, push to remote, or run the project's full test suite. The orchestrator handles all git operations and test orchestration after you complete." (Port the wording verbatim from `skills/ce-work/SKILL.md`'s existing parallel subagent constraints section.)
  - **Approach**: "Read the unit's Goal, Files, Approach, Patterns to follow, and Test scenarios. Make the file edits. Run only the targeted tests for files you touched (not the full suite). Report what you changed, any deviations from the unit's declared Files list, and any unresolved questions."
  - **Output**: "Your final response should summarize the changes you made, list files modified, and surface any issues that need orchestrator attention before the next dispatch."
- Iterate the prose against the 3 most recent merged plans (`docs/plans/2026-05-01-001-*`, `2026-04-30-001-*`, `2026-04-25-001-*`) by mentally simulating dispatch: would a fresh-context subagent reading this prompt + a unit's metadata produce sensible output? Tighten if simulation surfaces ambiguity.

Step 2 — update `skills/ce-work/SKILL.md` Phase 1 Step 4:
- Locate the subagent dispatch payload section. The phrase to replace is "your available subagent or task spawning mechanism" (around line 144 — confirm with `grep -n 'subagent or task spawning' skills/ce-work/SKILL.md` before editing).
- Replace with explicit `task({ subagent_type: "systematic-implementer", description: <unit goal>, prompt: <unit prompt body> })` call shape.
- Add a sentence clarifying what `description` and `prompt` carry: `description` is the one-line unit Goal; `prompt` carries Files, Approach, Patterns to follow, and Test scenarios.
- Verify the strategy table (Inline / Serial subagents / Parallel subagents rows) reads correctly under the new dispatch primitive — these describe execution patterns, not specific tools, so no changes expected.
- Verify the Parallel Safety Check section is unchanged — it operates on plan metadata (file-to-unit mapping), not on dispatch infrastructure.
- Verify the parallel subagent constraints section is unchanged — its no-stage/no-commit/no-test rules are intentional duplication with the bundled subagent's system prompt.
- End-to-end re-read of the modified skill body to confirm zero stray references to `delegate:codex`, `delegate:local`, `references/codex-delegation-workflow.md`, `.systematic/config.local.yaml`, `delegation_active`, or "fuzzy-activation". (Empirically zero before this unit per planning-time grep — the verification confirms no regression.)

Step 3 — update agent counts: root `AGENTS.md` line 51 (`50 → 51`) and `docs/AGENTS.md` line 37 (`50 pages → 51 pages`). Verify with `find agents -name '*.md' | wc -l` (should print 51 after Step 1 added the file).

Step 4 — run `bun run registry:build` so `dist/registry/` picks up the new agent component.

**Patterns to follow:**
- `agents/workflow/lint.md` and `agents/workflow/bug-reproduction-validator.md` — frontmatter shape (both declare `mode: subagent`) and prose-style references.
- `agents/document-review/coherence-reviewer.md` for system-prompt body structure.
- The "do not stage / do not create commits / do not run the project test suite" prose currently in `skills/ce-work/SKILL.md` Phase 1 Step 4 (parallel subagent constraints) — port verbatim into the system prompt's Constraints section.

**Test scenarios:**
- Edge case (gate): frontmatter MUST omit `model:` — content-integrity gate rejects any `model:` field on bundled agent markdown.
- Edge case (gate): frontmatter `mode` MUST be `subagent` — the integration test for agent loading verifies the field passes through to OpenCode runtime config.
- Edge case (skill body grep): `grep -nE 'codex|delegation_active|delegate:codex|delegate:local|systematic.config.local.yaml' skills/ce-work/SKILL.md` returns zero matches after the edit.
- Edge case (skill body grep): `grep -n 'systematic-implementer' skills/ce-work/SKILL.md` returns at least one match.

**Verification:**
- `bun scripts/content-integrity.ts` passes (no `model:` field, frontmatter conforms).
- `bun test tests/integration` passes (the test that exercises bundled-agent registration via `findAgentsInDir` picks up the new agent).
- `bun run registry:drift` exits 0.
- `bun run lint`, `bun run typecheck` pass.
- Manual diff review of the system-prompt body: a fresh-context reader can identify the constraints and the expected output shape without referencing other Systematic skills.
- Manual diff review of the `ce-work/SKILL.md` change: scope is one phrase replacement plus a clarifying sentence; the rest of the skill body is unchanged.
- `find agents -name '*.md' | wc -l` prints 51; root `AGENTS.md` line 51 reads "51 bundled agents"; `docs/AGENTS.md` line 37 reads "51 pages + index.mdx".

## Pre-Merge Verification Checklist

Before opening the PR, run an empirical validation that the orchestrator-LLM reliably runs the Parallel Safety Check (file-to-unit mapping, intersection check, downgrade-to-serial on overlap) when dispatching via `task()` against `systematic-implementer`. This is not unit-shaped work but is a real merge gate.

**Setup:**
- Build the local plugin: `bun run build`.
- Switch the user-level `~/.config/opencode/opencode.json` plugin entry from `@fro.bot/systematic@<version>` to the absolute path of the local `dist/index.js`. Back up the original first (`cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.pre-validation`).
- Kill any stale `opencode serve` processes that may hold cached pre-build module instances: `pkill -KILL -f '\.opencode serve'`. Confirm with `lsof -i :4096`.

**Synthetic test plan** (do not commit): write `/tmp/parallel-safety-test-plan.md` with 3 implementation units. Unit 1 unrelated. Unit 2 declares `Files: src/lib/foo.ts` (Modify). Unit 3 declares `Files: src/lib/foo.ts` (Modify) — deliberate file overlap.

**Test:**
- From a fresh OpenCode session in the systematic repo directory, invoke `/ce:work /tmp/parallel-safety-test-plan.md`.
- Run validation 3 times for variance control (LLM behavior is non-deterministic).

**Pass criteria** — `≥ 2 of 3` runs must show:
1. Orchestrator reads the plan.
2. Orchestrator runs the Parallel Safety Check at dispatch time.
3. Orchestrator detects the file overlap between Unit 2 and Unit 3.
4. Orchestrator downgrades to serial dispatch (acceptable alternative: orchestrator asks the user about the overlap; dispatching parallel without addressing the overlap is failure).

**Fail handling:**
- If `< 2 of 3` runs pass, the bundled subagent's system prompt or skill prose needs strengthening. Iterate on `agents/workflow/systematic-implementer.md` and/or `skills/ce-work/SKILL.md` Phase 1 Step 4. Rebuild and re-run validation. Document the iteration in the PR description.

**Cleanup (run regardless of outcome):**
- `rm /tmp/parallel-safety-test-plan.md`.
- `cp ~/.config/opencode/opencode.json.pre-validation ~/.config/opencode/opencode.json`.
- `rm ~/.config/opencode/opencode.json.pre-validation`.
- Re-run `/ce:work` against a real plan to confirm the user-level config restored cleanly (the plugin entry should be back to the npm package reference).

**Verification artifact:** record the validation outcome (pass count, any iterations, final transcript snippets) in the PR description's "Verification" section.

## System-Wide Impact

- **Interaction graph:** OpenCode's `task` tool is the new dispatch primitive. The bundled `systematic-implementer` agent registers via `findAgentsInDir` → `extractAgentFrontmatter` → `config-handler.ts:225-247`. The orchestrator-LLM invokes `task({ subagent_type: "systematic-implementer", ... })` from inside `ce-work` skill prose. No new TypeScript hooks. No `task.before` / `task.after` interception.
- **Error propagation:** if `task()` fails (subagent crashes, malformed response, OpenCode runtime rejects dispatch), the orchestrator-LLM observes the error in the natural-language response and handles it as it would any inline implementation failure. No structured-error contract.
- **State lifecycle risks:** dispatched subagent operates in a fresh context window but shares the orchestrator's working tree. The "no stage / no commit / no push" invariants in the bundled system prompt prevent git-index contention and accidental commits. The "no full test suite" invariant prevents test-run interference between concurrent subagents.
- **API surface parity:** no public API changes. `dist/index.js` exports remain default-only (per PR #335). The `systematic_skill` tool's behavior is unchanged. The new bundled agent surfaces in `client.tool.list` only via OpenCode's standard agent-registration path.
- **Integration coverage:** the existing `tests/integration/opencode.test.ts` test that loads bundled agents picks up `systematic-implementer` automatically (no test changes unless the test specifically counts agents — verify during execution).
- **Unchanged invariants:** `findAgentsInDir`, `extractAgentFrontmatter`, `config-handler.ts:225-247`, the existing `mode: subagent` registration path, the content-integrity gate, the registry drift check — all unchanged. This PR is mechanical use of existing infrastructure.

## Risks & Dependencies

| Risk                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator-LLM does NOT reliably run the Parallel Safety Check under `task()` dispatch                 | Pre-merge verification checklist gates merge. If `< 2 of 3` validation runs pass, iterate on bundled subagent system prompt or skill prose, rebuild, re-run. Worst case: PR ships with serial-only dispatch (parallel disabled in skill prose) until follow-up work strengthens reliability.                       |
| Bundled subagent's system prompt produces materially worse implementation output than inline execution | Manual diff review of the system prompt against representative recent merged plans during Unit 2 (3 plans, mental dispatch simulation). Fully reversible: revert by re-deleting `agents/workflow/systematic-implementer.md` and rolling back the skill prose change. If real users surface degradation, follow-up smart note tracks for V1.1. |

## Documentation / Operational Notes

- **CHANGELOG entry**: V1's CHANGELOG MUST mention: (a) `[BETA]` tag removed from `ce:work`; (b) `ce:work-beta` skill deleted; (c) Codex CLI delegation removed and not on a roadmap; (d) `.systematic/config.local.yaml` is now ignored — users may delete the file manually; (e) `/ce:work` dispatches multi-unit plans via `task()` to a bundled `systematic-implementer` subagent by default — this is a behavioral change for users who never used the beta path.
- **Version bump**: minor (`v2.7.x → v2.8.0`). Removes a public skill name (`ce-work-beta`) and changes the default dispatch behavior of `ce:work`, both user-visible.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-05-ce-work-beta-graduation-requirements.md`
- **Reference implementation:** `oh-my-opencode-slim` v1.0.6 compiled `dist/index.js` lines 23420-23456 (task tool argument contract). The package is a compiled npm artifact with no public source — see Context & Research for reproduction instructions.
- **Related code:** `src/lib/agents.ts` (findAgentsInDir), `src/lib/config-handler.ts:225-247` (bundled-agent merge), `scripts/content-integrity.ts` (checkAgentModel), `docs/scripts/transform-content.ts:244` (docs auto-prune).
- **Related PRs:** #336 (PR establishing `model:` field omission convention for bundled agents); #335 (PR establishing the empty-hooks singleton pattern, includes the empirical-verification approach mirrored in the pre-merge checklist).
- **Related skills:** `skills/ce-work/SKILL.md` (Phase 1 Step 4 — modification target); `skills/ce-work-beta/SKILL.md` (deletion target); `agents/workflow/lint.md`, `agents/workflow/bug-reproduction-validator.md` (frontmatter shape references for `mode: subagent`).
