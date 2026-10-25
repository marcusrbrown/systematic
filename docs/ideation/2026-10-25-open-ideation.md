---
date: 2026-10-25
topic: open-ideation
mode: repo-grounded
---

# Ideation: Open improvement round (main 0cbde86f, v3.26.2)

## Grounding Context

**Codebase.** `@fro.bot/systematic` is an ESM TypeScript plugin built on Bun. It ships compound-engineering skills and agent personas for OpenCode, Pi and Claude Code.
- `src/lib/` holds 34+ modules.
- The repo has about 8 generate/drift script pairs and no umbrella verify command.
- `scripts/content-integrity.ts` is a 4.2k-line gate.
- Host Contract CI runs against real OpenCode.
- The declared peer floors (`@opencode-ai/plugin ^1.1.30`, Pi `^1.0.0`) are older than the versions CI tests (1.19.4 and 1.4.0).

**Past learnings.** Several problems recur across `docs/solutions/`:
- harness divergence across the three hosts
- generated surfaces drifting after skill or agent edits
- verification that looks complete but isn't (fixtures, mocks, unprepared worktrees)
- scope and review churn

11 solution docs are marked `status: superseded`.

## Ranked Ideas

### 1. Make the bundled knowledge-store contract Systematic-native

**Description:** The `ce-compound` schema's `component` enum still lists upstream product modules: `rails_model`, `rails_controller`, `rails_view`, `hotwire_turbo`, `email_processing` and `brief_system`. That schema ships to every user. `learnings-researcher` also routes to category directories this repo doesn't have, and always reads a `patterns/critical-patterns.md` that doesn't exist. Replace the enum with a stack-neutral one kept in a single schema source, align the researcher with the categories that actually exist, and make the critical-patterns read optional.

**Warrant:** direct. See `skills/ce-compound/references/schema.yaml:80-89` and `agents/research/learnings-researcher.md:28-29,70,164-165`. The `docs/solutions/` categories don't include `performance-issues/`, `database-issues/` or `patterns/`. The schema is copied into ce-compound-refresh and compound-docs.

**Rationale:** Every plan, review and compound run calls the researcher first. A wrong vocabulary and dead paths weaken retrieval for every user, not only this repo.

**Downsides:** Existing user docs may already use the old enum values, so the change needs a migration note or tolerant parsing.

**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 2. One manifest drives `verify`, `regen` and `affected`

**Description:** Declare each generated surface once as `{name, generate, check, trigger globs}`. CI, `postupgrade` and `git-commit-push-pr` all read that manifest. `affected` names the regeneration commands for a given diff, and a test asserts the manifest covers every surface.

**Warrant:** direct.
- `postupgrade` runs the registry generator but not `generate-pi-subagents-personas`.
- `.github/workflows/main.yaml` lists seven drift steps by hand.
- AGENTS.md describes the path→surface mapping in prose only.
- `registry-drift-on-skill-description-change-2026-05-20.md` records the failure this causes.

**Rationale:** A missed regeneration costs a CI failure plus a paid review cycle. The manifest also gives agents a single "run before PR" command.

**Downsides:** It's one more file to maintain. CI step granularity may coarsen.

**Confidence:** 80%
**Complexity:** Low-Medium
**Status:** Unexplored

### 3. Back the peer floors with evidence

**Description:** Raise `@opencode-ai/plugin` and Pi peer floors to the versions Host Contract and the integration tests actually run, or add a shard that tests the floor version. Pin `@types/bun`.

**Warrant:** direct. In `package.json`, the peers are `^1.1.30` and `^1.0.0`, the dev versions are 1.19.4 and 1.4.0, and `@types/bun` is `latest`. `tests/unit/package-exports.test.ts` only asserts that the peers are declared.

**Rationale:** The floor is a compatibility promise made to every user, and nothing verifies it today.

**Downsides:** Raising the floor drops users on older hosts. A floor shard adds CI time.

**Confidence:** 75%
**Complexity:** Low
**Status:** Unexplored

### 4. Knowledge-store search: generated index, lifecycle, and semantic retrieval

**Description:** Start with a drift-checked index of `docs/solutions` (path, title, module, tags, status). The researcher reads it first and skips superseded docs. The maintainer wants the scope extended to a full semantic search interface with local or customizable embeddings, along the lines of Magic Context and AFT, so retrieval matches meaning and not only frontmatter keywords. Idea 1 is a prerequisite.

**Warrant:** direct. 11 `status: superseded` docs are still searched. `/sync-cep` docs are stale. `learnings-researcher` greps about 120 docs per run. `index-learnings-by-symptom-not-only-by-lesson-2026-08-23.md` records a missed retrieval that cost days.

**Rationale:** Retrieval quality multiplies the value of every learning written.

**Downsides:**
- Embeddings bring a model or runtime dependency and an index lifecycle.
- They need a privacy story: local-first, no data leaving the machine by default.
- Behavior must stay the same across the three harnesses.

**Confidence:** 65%
**Complexity:** Medium (index), High (semantic)
**Status:** Unexplored, with the maintainer's additions pending

### 5. Skill size budgets and stage-gated loading

**Description:** Turn `SKILL.md` into a router, with each stage body under `references/` and loaded only when that stage starts. Enforce a byte budget per skill.

**Warrant:** direct. ce-review is 72 KB and ce-plan is 63 KB, and both load whole. `restoreCompactedSkillResults` in `src/index.ts` exists to fight compaction of skill output.

**Rationale:** Every invocation pays the full context cost, and models skip late stages of long skills.

**Downsides:** It's a large edit to the most-used skills, and stage handoffs could break.

**Confidence:** 60%
**Complexity:** Medium-High
**Status:** Unexplored

### 6. Remove duplicate skills

**Description:** Fold deepen-plan into ce-plan's deepen mode, and merge compound-docs into ce-compound and ce-compound-refresh. The removed-names accept-warn-drop mechanism covers existing configs.

**Warrant:** reasoned. ce-plan's own description says "Also deepen existing plans". The degree of overlap is unverified.

**Rationale:** Fewer catalog entries per session, and less ambiguity about which skill to route to.

**Downsides:** The rename churn touches user configs and docs.

**Confidence:** 50%
**Complexity:** Medium
**Status:** Unexplored

### 7. `systematic doctor`

**Description:** A local, read-only report covering the detected harness, plugin and host versions, loaded and disabled catalogs, and whether the bootstrap was applied. It prints in a paste-ready form for `report-bug-ce`.

**Warrant:** reasoned plus direct. The experimental hooks fail silently, `src/lib/capability-snapshot.ts` exists, and `report-bug-ce` collects environment data by hand.

**Rationale:** A broken install currently looks like "the model isn't using skills".

**Downsides:** It adds surface to the CLI, and detecting the host from outside a session is limited.

**Confidence:** 55%
**Complexity:** Medium
**Status:** Unexplored

## Prioritized Workstreams

This order merges the ranked ideas with a scan of plans, brainstorms and solutions.

1. **Knowledge-store contract fix (idea 1).**
   - Keep the old `component` values as aliases.
   - Discover the categories that exist in the consumer repository.
   - Filter superseded docs.
2. **Semantic-search proof (idea 4).** The proof is local only:
   - a hybrid of lexical and vector retrieval
   - one configured local embedding endpoint
   - 12-24 real queries, including a known missed retrieval

   It must beat the current researcher and a stronger lexical baseline before a shipped search feature is planned.
3. **Generated-surface manifest (idea 2).** It covers generated surfaces only, not every build step.
4. **Four AGENTS.md rules.** These are:
   - the PR title sets the release type
   - tests must not modify tracked files
   - a zero-match check proves nothing
   - verify against the exact checkout
5. **Peer floors (idea 3).** First gather evidence. Change the declared floors only if that evidence and the support policy call for it.
6. **Model-ID validation, narrowed to model values the package ships**, starting with the OMO profile and running offline. This replaces the whole-catalog snapshot plan.
7. **Progressive-loading pilot on one large skill (idea 5).** Measure it before setting any catalog-wide byte budget.
8. **`SECURITY.md`**, the open item from the gated-release plan.
9. **Plan status reconciliation.**
10. **A project-local `importing-upstream-content` skill.**

**Parked:** Systematic-native orchestration (brainstorm 2026-08-01). It waits for a decision to drop the external orchestrator dependency and for a named gap that the host plus Systematic cannot fill.

**Cut after the scan:**
- `systematic doctor`, because `systematic capabilities` already exists.
- Duplicate-skill removal.
- Blanket skill byte budgets.
- A committed knowledge index, which is folded into search.
- Automated stale-plan detection.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Stop committing generated artifacts | Git-based installs (Claude Code marketplace, OCX registry) read the committed outputs |
| 2 | Collapse review pipeline and validator | Reverses recently shipped, settled design with no evidence of failure |
| 3 | Capability-tagged per-harness compile targets | Cost far exceeds value, and it churns every skill |
| 4 | Generic skill-phase runner | Premature abstraction over three dissimilar helpers |
| 5 | Local session ledger | Privacy surface and a large build for speculative value |
| 6 | Learnings with `enforced_by` and path triggers | Ceremony on top of idea 4, plus a frontmatter migration across about 120 docs |
| 7 | Split content-integrity into a rule registry | Refactor with no user-visible value |
| 8 | Generate codemap and module table | The gate already names the missing row exactly |
| 9 | Host-divergence prose lint | Few known patterns, and the scanner blind-spot learning applies |
| 10 | Learnings fast path for ce:review | Duplicate of idea 4 |
| 11 | `.context` retention policy | Already covered by ce-review-cleanup |
| 12 | Pre-push batch mode | Folded into idea 2 |
| 13 | Review-round budget or delta review | Already covered by the stop-patching learning and orchestrator discipline |
| 14 | Bootstrap rules manifest | Only one rule exists, so wait for a third use |
| 15 | Trace-conformance evals | Conflicts with the stated direction against model-run matrices |
| 16 | Archive cep-guide and old plans | Below the ambition floor on its own; the superseded part is folded into idea 4 |
