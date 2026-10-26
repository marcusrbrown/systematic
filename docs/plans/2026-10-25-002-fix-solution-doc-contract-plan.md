---
title: "fix: Make the solution-doc contract stack-neutral and consistent"
type: fix
status: active
date: 2026-10-25
origin: docs/brainstorms/2026-10-25-solution-doc-contract-requirements.md
---

# fix: Make the solution-doc contract stack-neutral and consistent

## Overview

Four consumers read or write `docs/solutions/` frontmatter: `ce-compound`, `ce-compound-refresh`, `compound-docs` and `learnings-researcher`. Two of them have drifted from the canonical `ce-compound` schema. This plan puts all four on one stack-neutral contract, adds the lifecycle fields that docs already carry, teaches the validator and the researcher to act on them, and tidies Systematic's own corpus to match. It ships as one `fix(skills)` patch.

## Problem Frame

`compound-docs` ships an older schema. Its exact-match gate rejects every knowledge-track doc, and it writes to a `patterns/` directory that does not exist. `learnings-researcher` hand-types its own enum list, routes to two missing directories, always reads a missing `critical-patterns.md`, and ranks superseded docs equal to live ones.

The canonical schema also ships Rails and product values to every user, while `status`, `superseded_by` and the other lifecycle fields appear in no schema. The origin document has the full frame.

## Requirements Trace

**One contract**
- R1. `ce-compound` holds the canonical schema. `ce-compound-refresh` and `compound-docs` ship byte-identical copies. (U1, U2)
- R2. `compound-docs` keeps its name, drops its older schema, and validates against the canonical copy it ships. (U2)
- R3. The parity test covers every copy, including `compound-docs`. (U2)

**Vocabulary**
- R4. Writers are offered 14 stack-neutral `component` values. (U1)
- R5. Nine Rails and product `component` values become legacy: accepted by validators and refresh, never offered to writers. (U1, U3)
- R6. `root_cause` and `resolution_type` lose their Rails wording. `missing_association` and `seed_data_update` become legacy. (U1)
- R7. `rails_version` becomes legacy, and `environment` is documented. (U1)
- R8. `category`, `last_updated` and `last_refreshed` are documented as optional. The plan adds `title` to that list. (U1)

**Lifecycle**
- R9. The schema documents optional `status`, `superseded_by`, `superseded_date`, `stale_reason` and `stale_date`. Writers keep those fields consistent. (U1, U3)
- R10. The CI validator rejects an unknown `status`. (U1)
- R11. The CI validator rejects a superseded doc whose `superseded_by` is missing or names no existing doc. (U1)
- R12. The researcher never returns a superseded doc. It returns the successor, labelled, and follows chains to the first doc that is not superseded. (U4)
- R13. The researcher shows a stale doc, including a stale successor, with a caution. (U4)

**Discovery and writers**
- R14. The researcher drops its enum list and its relative path into another skill. It discovers categories from the directories that exist and values from the docs. (U4)
- R15. The researcher reads `critical-patterns.md` only when it exists. A missing file or a missing `docs/solutions/` is not an error. (U4)
- R16. Writers file each doc under the directory the canonical mapping gives and create it on first use. (U2, U3)
- R17. No writer creates `patterns/` or `critical-patterns.md`. (U2, U3, U4)

**Systematic's own corpus**
- R18. Five misfiled docs move to the directory their `problem_type` maps to, with inbound links fixed and `category` set to the new directory name. (U5)
- R19. Docs with `category: best_practice` are corrected. (U5)

Acceptance examples:

| ID | Covers | Unit | Verified by |
|----|--------|------|-------------|
| AE1 | R1, R2, R16, R17 | U1, U2 | Validator test: a `convention` doc with no `symptoms` passes the real schema. U2 outcome checks on the `compound-docs` prose. |
| AE2 | R4, R5 | U1, U3, U4 | Validator test with `component: rails_model`. Scenario pass: a legacy-value doc under update. |
| AE3 | R12 | U4 | Scenario pass. |
| AE4 | R12 | U4 | Scenario pass, including a hand-built two-hop chain. |
| AE5 | R13 | U4 | Scenario pass, including a stale successor. |
| AE6 | R14, R15 | U4 | Scenario pass: no `docs/solutions/`, and no `critical-patterns.md`. |
| AE7 | R10, R11 | U1 | Validator tests naming the specific cause. |

## Scope Boundaries

- No change to the category mapping. The four narrow knowledge types keep sharing `best-practices/`.
- No change to the researcher's frontmatter `description`, so the registry and docs site do not churn.
- No curation of the researcher into `CURATED_PERSONAS`. Only the two stale comments (src and test) change.
- Existing `docs/plans/` links are not rewritten.
- No writer produces `status: superseded`. Superseding stays a manual edit.

### Deferred to Separate Tasks

- Semantic or full-text search over solutions: a separate workstream.
- Migration tooling that rewrites users' legacy values: out. User docs are never rewritten.
- Retiring `compound-docs`: out.
- Documenting the stray keys `related`, `confidence`, `related_issues` and `resolution_time`: left undocumented.

## Context & Research

### Relevant Code and Patterns

Line numbers are as of HEAD `739b3135`. The cited source files are unchanged since `de3ab1bd`, the survey baseline.

- `scripts/content-integrity.ts`: `COMPOUND_SCHEMA_RELATIVE_PATH` (`:1322`), `CompoundSchema` (`:1333`), `loadCompoundSchema` (`:1394`), `checkSolutionEnumField` (`:1575`), `scanSolutionSchema` (`:1651`, hardcoded required fields at `:1693-1712`), `checkSolutionCitations` (`:2478`).
  - The loader reads `values` from `required_fields.component` and `required_fields.severity`, and the bug-track `root_cause` and `resolution_type` lists. It does not read the knowledge-track duplicates of those two lists.
- Wiring pattern to copy for the new lifecycle check: `solutionCitationViolations` on `CheckResult` (`:361`), the runner call (`:3768`), the result (`:3826`), `printSolutionCitationViolations` (`:3978`), the verbose line (`:3929`) and `totalViolations` (`:4207`).
- `tests/unit/content-integrity.test.ts`: `makeFixtureRepo` (`:50`), `writeSchemaFixture` (`:133`), `describe('checkSolutionSchema')` (`:3808`), the loader tests (`:5014`), the real-schema smoke test (`:5126`), the real-repo integration (`:5594`) and the CLI tests (`:5759`).
- `tests/unit/compound-contract-parity.test.ts`: header rationale at `:1-2`. The single-relative-path helper `assertContractParity` compares `ce-compound` with `ce-compound-refresh` only.
- `scripts/build-claude-code-plugin.ts`: `collectSkillFiles` (`:228`) copies each skill verbatim and keeps relative paths (`:241-242`). That is why copies stay per skill.
- Current corpus: 120 docs. 11 are `status: superseded`, each with a repo-root-relative `superseded_by` whose target exists and is not superseded. One doc is `status: stale`. None uses a legacy `component` value.
- `tests/unit/config-corpus.test.ts`: `canonicalJson` (`:36`) and `runCorpusEntry` (`:40`) are file-local, not exported. A throwaway script must reproduce them.

### Institutional Learnings

- `registry-drift-on-skill-description-change-2026-05-20`: reference-file changes alter the registry file list. Regenerate and check drift.
- `cross-harness-adapter-parity-contract-tests-2026-07-14`: parity is shown at the observable boundary. Assert that each copy accepts and rejects the same inputs, not only that values match.
- `typed-config-validation-build-time-codegen-2026-05-16` and `removing-config-key-strict-schema-2026-10-19`: inventory what is accepted before tightening. Accepting a value is not offering it.
- `content-integrity-mirror-runtime-drop-rules-2026-05-17`: derive gate semantics from the real producer and consumer.
- `schemas-need-adversarial-probes-not-just-compilation-2026-08-16` and `behavior-first-ajv-contract-verification-2026-07-21`: one test per rejection, asserting its specific cause, with valid controls, against the real schema.
- `reconciliation-sync-reference-integrity-20260417` (moves in U5): moved-doc links need an explicit resolution check.
- `claude-code-plugin-build-and-publish-architecture-2026-07-18`: the Claude Code bundle is derived. Verify through the build and never commit flattened output.
- `unit-suite-rewrites-repo-file-trap-2026-07-17` and `unguarded-generator-main-repairs-drift-when-imported-by-tests-2026-07-28`: tests use temp roots and must not modify tracked files.
- `workflow-guard-removed-2026-10-19`: the reference shape for a superseded doc, with `status`, `superseded_by` and `superseded_date`.
- `index-learnings-by-symptom-not-only-by-lesson-2026-08-23`: keep retrieval metadata searchable.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "marcusrbrown/systematic: scripts/content-integrity.ts, src/lib/removed-names.ts, skills/{ce-compound,ce-compound-refresh,compound-docs,ce-plan}, agents/research/learnings-researcher.md, tests/unit, docs/plans and docs/solutions (frontmatter only)",
  "freshness": {
    "vcs_reference": "de3ab1bd"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "scripts/content-integrity.ts: loadCompoundSchema / scanSolutionSchema / checkSolutionEnumField",
      "description": "Reads problem_type, component, severity, root_cause and resolution_type vocabularies from schema.yaml at runtime and rejects off-enum values via pushSchemaViolation",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/ce-compound/references/schema.yaml (Backward compatibility block)",
      "description": "Canonical contract; already states the accepted-but-not-offered idea for bug-track fields on knowledge docs, in prose only",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/lib/removed-names.ts: REMOVED_BUNDLED_SKILL_NAMES / REMOVED_CONFIG_KEYS",
      "description": "Accept-warn-and-ignore lists for removed skill, agent and config names; TypeScript constants for runtime config, not frontmatter vocabulary",
      "disposition": "insufficient",
      "insufficiency_reason": "Scoped to config keys and bundled names as TS constants with no schema.yaml form or frontmatter consumer; supplies the concept but cannot hold component, root_cause or resolution_type legacy values."
    },
    {
      "path_or_symbol": "docs/plans status / superseded_by convention; checkStalePlanStatus",
      "description": "Plan lifecycle using status and a repo-root-relative superseded_by path; the same format the 11 superseded solution docs use",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/compound-contract-parity.test.ts",
      "description": "Byte parity for ce-compound vs ce-compound-refresh copies of schema.yaml, yaml-schema.md and resolution-template.md",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "scripts/content-integrity.ts: checkSolutionCitations",
      "description": "Separate exported docs/solutions check with its own violation type, CheckResult field, printer and totalViolations wiring; the template for a standalone lifecycle check",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/ce-compound-refresh/SKILL.md: stale-marking writes",
      "description": "Already writes status: stale, stale_reason and stale_date on ambiguous or insufficient-evidence cases, but never clears them and never writes superseded",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "agents/research/learnings-researcher.md",
      "description": "Grep-first reader of docs/solutions with its own routing table, enum list and output templates; owns the discovery and ranking behavior this plan changes",
      "disposition": "extend"
    }
  ]
}
```

No existing `legacy_values` mechanism exists, so U1 introduces it beside `values` rather than reusing `removed-names.ts`.

## Key Technical Decisions

- **Per-skill byte-identical copies.** The Claude Code build flattens skills, so a cross-skill path cannot survive it. `compound-docs/schema.yaml` moves to `references/` so its path matches the canonical layout. Its `references/yaml-schema.md` and `assets/resolution-template.md` become copies of the canonical files, and the parity test loops over `ce-compound-refresh` and `compound-docs`.
- **`legacy_values` beside `values`.** It is on `component`, `root_cause` and `resolution_type`, and on both the bug-required and knowledge-optional `root_cause` and `resolution_type` lists, so writers see the same legacy set on either track. The loader reads the bug lists only. Writers read `values` only. The schema comment says update paths preserve existing legacy values and new docs read `values` only.
- **Vocabulary.** U1 lists the values. `rails_version` stays under `bug_optional_fields`, marked legacy. That is documentation only: the validator does not read the field today and gains no check for it. `environment` is documented. `related`, `confidence`, `related_issues` and `resolution_time` stay undocumented.
- **Lifecycle semantics.** `status` is an enum (`active`, `stale`, `superseded`) checked inside the schema scan. A missing `status` means active and an explicit empty value fails. A separate exported `checkSolutionLifecycle` follows the `checkSolutionCitations` pattern. A superseded doc's `superseded_by` must be a string naming a doc in the solution-file set (`docs/solutions/**/*.md`, excluding `README.md`) that parses and is not itself superseded. That one rule excludes chains, cycles and self-reference.
- **Repo-root path form only.** `superseded_by` is a repo-root `docs/solutions/...` path. No writer produces any other form, and all 11 existing docs use it. Anything else counts as unresolved: the validator fails it, and the researcher skips it with the "Skipped" line.
- **Researcher resolution is bounded.** The validator forbids chains in validated repos. The researcher's chain-following exists for user repos the validator never checks. It follows up to 5 hops with a visited set. An unresolvable successor (missing, absent, non-conforming path, cycle or over the cap) omits the doc and adds a line "Skipped: superseded, successor unresolved". This refines origin R12, which says "never returns a superseded doc", by saying what happens when no successor exists.
- **Refresh keeps the lifecycle consistent.** Keep or Update clears `status: stale`, `stale_reason` and `stale_date`. A ce-compound update does the same. Refresh never overwrites `superseded` with `stale`. Replace and Consolidate retarget any `superseded_by` pointing at the removed file to the survivor, before removing it. Delete leaves no survivor, so the superseded docs pointing at the deleted file are deleted in the same action: they are retired and their replacement is gone. Refresh names each one in the Delete action. Interactive mode asks the user to confirm the list, and autofix mode lists them in the report. Replace keeps deleting the old file but stops writing `supersedes:`.
- **Writers file by the canonical mapping.** Replace files the new doc by the mapping, not "same category as the old doc". `compound-docs` files knowledge docs under `best-practices/`, creating the directory on first use. Refresh Phase 1.5 scans `patterns/` only when it exists, as legacy and read-only.
- **`compound-docs` loses four things.** Two decision-menu options (Required Reading, hotwire-native) and two Step 7 writes (common-solutions, critical-pattern suggestion) go. Removing hotwire-native serves the success criterion that no Rails or product value is offered. `assets/critical-pattern-template.md` is deleted as an orphan. The Rails worked example and prose become neutral.
- **Prose behavior gets one scenario pass.** AE2 to AE6 and the writer lifecycle rules describe prose. One subagent pass against a fixture corpus in a temp directory verifies them, at the end of U4. There is no CI test and no repeated run.
- **config-corpus is regenerated once, after the scenario pass.** All 14 `expected.opencode.json` files embed the researcher prompt. A throwaway script outside the repo reproduces the corpus helpers and rewrites them. A parse of old and new JSON must show only `learnings-researcher.prompt` differing in each file. If the prompt changes after regeneration, rerun the regeneration and the parse check.
- **Single patch.** The release is one `fix(skills)` PR.

## Open Questions

### Resolved During Planning

- Origin question on `related`, `confidence` and the misspelled `components` key: `related` and `confidence` stay undocumented, and `components` is fixed to `related_components` in U5.
- Whether `title` is documented: yes, as optional. It is in 119 of 120 docs and the template writes it.
- Whether Replace writes `superseded_by` instead of deleting: no. It keeps deleting, since git history already records the replacement.

### Deferred to Implementation

- Where the reworded `missing_include` and `wrong_api` glosses live (schema description or `yaml-schema.md`): depends on how the final text reads.
- The violation `rule` name and message wording for lifecycle violations: set when the type is written, mirroring the citation type.
- The wording of the `Supersedes:` and `Caution:` lines: fixed while editing the prompt.
- The fixture-corpus layout for the scenario pass: chosen when it is built.

## Implementation Units

- [ ] U1. Canonical schema and validator

**Goal:** The canonical schema carries the neutral vocabulary, `legacy_values` and the lifecycle fields. The validator accepts legacy values and enforces `status` and `superseded_by`.

**Requirements:** R1, R4, R5, R6, R7, R8, R9, R10, R11

**Dependencies:** None

**Files:**
- Modify: `skills/ce-compound/references/schema.yaml`
- Modify: `skills/ce-compound/references/yaml-schema.md`
- Modify: `skills/ce-compound-refresh/references/schema.yaml` (byte copy)
- Modify: `skills/ce-compound-refresh/references/yaml-schema.md` (byte copy)
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`
- Modify: `ARCHITECTURE.md` (the content-integrity gate description under Cross-Cutting Concerns)

**Approach:**
- Schema `component`: the current schema has 17 values. Offer 14 and move 9 to `legacy_values`.
  - Offered: `backend`, `frontend`, `api`, `database`, `background_job`, `authentication`, `infrastructure`, `configuration`, `dependencies`, `tooling`, `development_workflow`, `testing_framework`, `documentation`, `assistant`. Six are new: `backend`, `frontend`, `api`, `infrastructure`, `configuration`, `dependencies`.
  - Legacy: `rails_model`, `rails_controller`, `rails_view`, `service_object`, `frontend_stimulus`, `hotwire_turbo`, `email_processing`, `brief_system`, `payments`.
- Schema `root_cause` and `resolution_type`: `missing_association` (root cause) and `seed_data_update` (resolution type) move to `legacy_values`, on both the bug-required and knowledge-optional lists. `missing_include` is reworded as a missing eager load or N+1, and `wrong_api` generically.
- Schema optional fields: `environment`, `title`, `category`, `last_updated`, `last_refreshed` and the lifecycle fields (`status`, `superseded_by`, `superseded_date`, `stale_reason`, `stale_date`). `optional_fields.status.values` holds the enum. `rails_version` stays under `bug_optional_fields`, marked legacy, with no new validator check.
- `yaml-schema.md` mirrors the schema: vocabulary, optional fields, lifecycle semantics, and the legacy paragraph.
- Loader: `legacy_values` is optional. `optional_fields.status.values` is read like its siblings, and a malformed shape throws. `checkSolutionEnumField` accepts the union of `values` and `legacy_values`.
- Scan: check `status` as an enum after the severity check. Absent means active. An explicit empty value fails.
- `checkSolutionLifecycle(rootDir, files)`: apply the superseded rule from the decisions above. An unparseable successor fails as "unreadable successor". A non-string value fails as "not a string" and an empty string as "empty". A `superseded_by` on a doc that is not superseded is ignored. Exempt and unparseable source docs are skipped. With no schema present it does nothing.
- Wire the new violation type through `CheckResult`, the runner, the printer, the verbose line and `totalViolations`, as `checkSolutionCitations` does.
- ARCHITECTURE: describe legacy values, the `status` enum and the lifecycle check.

**Execution note:** Test-first, following the `test-driven-development` skill. Give every rejection its own test asserting the specific cause, plus valid controls.

**Patterns to follow:**
- `checkSolutionCitations` and its tests for a standalone check.
- `makeFixtureRepo` for temp roots.
- The real-schema smoke test: copy the real `schema.yaml` into a temp root rather than adding a test-only schema.

**Test scenarios:**
- Happy path: a doc with `component: rails_model` passes against a temp-root copy of the real schema.
- Happy path: a bug doc with `root_cause: missing_association` and `resolution_type: seed_data_update` passes. A knowledge doc carrying the same two values passes.
- Happy path (AE1): a `convention` doc with no `symptoms` passes.
- Error path: `component: nonsense` fails, and the message names `component`.
- Error path (AE7): `status: archived` fails naming `status`. An explicit empty `status:` fails. A missing `status` passes, and so do `active`, `stale` and `superseded`.
- Error path (AE7): a superseded doc with no `superseded_by` fails with a "missing" cause.
- Error path: a non-string `superseded_by` (a list) fails with a "not a string" cause. An empty string fails with an "empty" cause. Each is its own test.
- Error path (AE7): a superseded doc whose `superseded_by` names no file in the set fails and names the dangling target. A bare filename fails the same way.
- Error path: a successor that exists but has unparseable frontmatter fails with an "unreadable successor" cause.
- Edge case: `docs/solutions/README.md` is not in the solution-file set, so naming it as a successor fails.
- Error path: a target that is itself superseded fails. A self-reference fails. A two-doc cycle fails on both docs.
- Edge case: `superseded_by` on an active doc is ignored, even when it dangles.
- Edge case: a superseded doc pointing at a stale doc passes.
- Edge case: an exempt file and a malformed-frontmatter file are skipped by the lifecycle check, with no duplicate report.
- Edge case: with no schema file at the root, `checkSolutionLifecycle` returns nothing.
- Integration: the real schema's `values` and `legacy_values` are disjoint for `component`, `root_cause` and `resolution_type`.
- Integration: the aggregate result includes lifecycle violations and counts them in `totalViolations`. The CLI exits non-zero on a dangling `superseded_by` in a fixture repo, and the real repo passes.
- Integration: `writeSchemaFixture` carries `legacy_values` and the `status` block, and the existing schema tests still pass.

**Verification:**
- `bun scripts/content-integrity.ts` passes on the current corpus.
- The parity test passes with the new `ce-compound-refresh` copies.
- Rails and product tokens appear in the canonical schema only inside `legacy_values`, the legacy-marked `rails_version` entry and the legacy paragraph.

- [ ] U2. compound-docs on the canonical contract

**Goal:** `compound-docs` ships byte copies of the canonical contract and a knowledge-track path through its workflow, and no longer writes `patterns/`.

**Requirements:** R1, R2, R3, R16, R17

**Dependencies:** U1

**Files:**
- Move: `skills/compound-docs/schema.yaml` to `skills/compound-docs/references/schema.yaml`, replaced by a byte copy of the canonical file
- Modify: `skills/compound-docs/references/yaml-schema.md` (byte copy)
- Modify: `skills/compound-docs/assets/resolution-template.md` (byte copy)
- Modify: `skills/compound-docs/SKILL.md`
- Delete: `skills/compound-docs/assets/critical-pattern-template.md`
- Modify: `tests/unit/compound-contract-parity.test.ts`
- Modify: `registry/registry.jsonc` (generated)

**Approach:**
- Parity test: loop the three file checks and the knowledge problem-type equality over `ce-compound-refresh` and `compound-docs`. Keep the failure message telling the reader to copy the `ce-compound` version.
- `SKILL.md` knowledge-track branch:
  - Step 2: the blocking gate stops requiring the exact error, the stage and the Rails version for knowledge docs.
  - Step 4: naming works without a symptom.
  - Step 5: the gate validates against `references/schema.yaml`, and `symptoms` is required for the bug track only. The example failure is neutral.
  - Step 6: the hard-coded "lines 49-61" cite becomes a pointer to the mapping section. The mapped directory is created on first use.
- Step 7: remove the common-solutions write and the critical-pattern suggestion.
- Remove the Required Reading and hotwire-native options from both menus and renumber them: the post-capture decision menu (around `:259-279`) and the Example Scenario output (around `:491-505`).
- Neutralize the Rails worked example and the Rails prose in the overview and context steps.
- Point every reference at `references/schema.yaml`.

**Patterns to follow:**
- `skills/ce-compound/SKILL.md` for the track-aware workflow and the `mkdir -p` on first use.

**Test scenarios:**
- Happy path: parity holds for `schema.yaml`, `yaml-schema.md` and `resolution-template.md` in both copies, and the knowledge problem-type sets are equal.
- Integration: the content-integrity sub-file reference check resolves every reference in `skills/compound-docs/SKILL.md`.
- Integration: the Claude Code build integration test still passes, and the bundle's `compound-docs` skill contains `references/schema.yaml`.
- Test expectation for the `SKILL.md` prose: none. No test pins skill body wording, so AE1 rests on the U1 validator test and the verification outcomes below.

**Verification:**
- `bun scripts/generate-registry.ts` then `bun run registry:drift` is clean. The registry lists the moved schema and no longer lists the deleted template.
- Nothing in the `compound-docs` prose requires `symptoms`, an error message, a stage or a Rails version for a knowledge-track doc.
- No reference to `patterns/`, `critical-patterns.md`, Required Reading, common-solutions or hotwire-native remains in `compound-docs`.

- [ ] U3. ce-compound and ce-compound-refresh writer prose

**Goal:** The two writers preserve legacy values, keep lifecycle fields consistent, and file by the canonical mapping.

**Requirements:** R5, R9, R16, R17

**Dependencies:** U1

**Files:**
- Modify: `skills/ce-compound/SKILL.md`
- Modify: `skills/ce-compound-refresh/SKILL.md`

**Approach:**
- Update paths: one line in each `SKILL.md` saying existing legacy values and `rails_version` are preserved and never rewritten, and that only new docs read `values`.
- Stale lifecycle: Keep or Update clears `status: stale`, `stale_reason` and `stale_date`, and a ce-compound update does the same. Guard the three stale writes in refresh (`:26`, `:331`, `:527`) so refresh never overwrites `status: superseded`.
- Retargeting: before Replace or Consolidate removes a file, find any doc whose `superseded_by` names it and point that doc at the survivor.
- Delete: add a step that finds every doc whose `superseded_by` names the file being deleted, names each in the Delete action, and deletes them in the same action. Interactive mode asks the user to confirm the list. Autofix mode lists them in the report.
- Replace flow (`:504-522`): file the new doc by the canonical mapping, and stop offering `supersedes:`. The old file is still deleted.
- Phase 1.5 (`:196-198`): scan `patterns/` only when it exists, as legacy and read-only.
- Reword the `patterns/` and `critical-patterns` hints at `ce-compound/SKILL.md:221` and `:228`.
- Neutralize product examples: `ce-compound/SKILL.md:226`, the transcript near `:394`, and `ce-compound-refresh/SKILL.md:361`.

**Patterns to follow:**
- Existing `ce-compound` wording for "create the directory on first use".

**Test scenarios:**
- Test expectation: none. No test pins these skill bodies. Content-integrity still covers phantom references and sub-file links. The U4 scenario pass covers AE2 and the writer lifecycle rules.

**Verification:**
- `bun scripts/content-integrity.ts` passes.
- Rails and product tokens are gone from both `SKILL.md` files.
- Both files give the same rule for clearing stale fields, and neither writes `patterns/` or `critical-patterns.md`.
- The Delete step, the retargeting step and the stale guard each appear once in `ce-compound-refresh`, and the scenario pass in U4 exercises them.

- [ ] U4. learnings-researcher, scenario pass and config-corpus

**Goal:** The researcher discovers what exists, resolves lifecycle status and reports it. One scenario pass verifies the prose behaviors, and the config-corpus fixtures are regenerated once afterward.

**Requirements:** R12, R13, R14, R15, R17 (AE2 to AE6)

**Dependencies:** U1, U3

**Files:**
- Modify: `agents/research/learnings-researcher.md`
- Modify: `skills/ce-review/SKILL.md` (the Learnings & Past Solutions line, `:551`)
- Modify: `skills/ce-review/references/review-output-template.md` (`:138`)
- Modify: `src/lib/pi-subagents-personas.ts` (the exclusion comment, `:55`)
- Modify: `tests/unit/generate-pi-subagents-personas.test.ts` (the matching test comment, `:498`)
- Modify: `tests/fixtures/config-corpus/*/expected.opencode.json` (all 14)

**Approach:**
- Researcher discovery: list the directories that exist under `docs/solutions/`. Drop the routing rows for missing directories, the hand-typed enum list, the Frontmatter Schema Reference section and its `../../skills/...` path, and the Rails examples.
- `critical-patterns.md`: read only if it exists, and exclude it from the candidate grep. Skip `_archived/` and `README.md`.
- Status map: one grep for `^(status|superseded_by):` across candidates replaces the 30-line frontmatter read for those fields. Add a step before scoring that resolves each candidate:
  - Active, or unknown or absent `status`: returned normally.
  - Stale: returned with a `Caution:` line.
  - Superseded with a resolvable successor: the superseded doc is omitted and the successor is returned, labelled "Supersedes/retires X". A stale successor also gets a `Caution:` line. Several superseded docs sharing one successor return it once, listing all of them.
  - Superseded with an unresolvable successor: omitted, with the "Skipped" line.
- Resolution: only the repo-root path form counts. Follow chains up to 5 hops with a visited set.
- Output: keep the two templates and add optional `Supersedes:` and `Caution:` lines to each. Fix the Integration Points list to the real callers: `ce:plan`, `ce:review`, `ce:ideate`, `ce:compound` and `deepen-plan`.
- Keep the frontmatter `description` unchanged.
- ce-review: add one line to each file saying `Supersedes` and `Caution` lines are carried into the Known Pattern output.
- Pi comments: the researcher no longer references skill paths, so update both comments to say it is not curated and why. Do not add it to `CURATED_PERSONAS`.
- Scenario pass, once the prompt and U3 prose are final: build a fixture corpus in a temp directory outside the repo and run one subagent pass against the researcher and the refresh actions. Record the results for the PR body.
- config-corpus, after the pass: write a throwaway script outside the repo that reproduces `canonicalJson` and `runCorpusEntry`, then rewrite the 14 files. Parse old and new JSON for each and confirm only `learnings-researcher.prompt` differs. If the pass changes the prompt, rerun this step.

**Patterns to follow:**
- `tests/fixtures/config-corpus/README.md` on deliberate regeneration.
- The existing grep-first structure of the researcher.

**Test scenarios:**
- Test expectation for the prompt and refresh prose: none in CI. No test pins their wording. The scenario pass runs once and is not repeated.
- AE6: with no `docs/solutions/`, or no `critical-patterns.md`, the researcher completes without reading a missing file and without an error.
- AE3: when A (superseded, `superseded_by` B) and B both match, only B is returned.
- AE4: when only A matches, B is returned labelled "Supersedes/retires A". The fixture chain is hand-built, since the validator forbids chains: when B is superseded by C, C is returned. Two superseded docs sharing one successor return it once.
- AE5: a stale match, and a stale successor of a superseded match, each carry a `Caution:` line.
- Edge case: a cycle, a dangling pointer, a bare-filename successor or a chain over 5 hops omits the doc and adds the "Skipped" line. An unknown status is treated as active.
- AE2: refresh Update on a `rails_model` doc leaves the value in place, raises no off-vocabulary finding, and a new doc written there is not offered `rails_model`.
- Refresh Update clears `status: stale`, `stale_reason` and `stale_date`. Refresh never overwrites `status: superseded` with `stale`.
- Refresh Replace and Consolidate retarget a doc whose `superseded_by` named the removed file to the survivor.
- Refresh Delete of a file that other docs supersede into deletes those docs in the same action, names them, and asks for confirmation in interactive mode.
- Integration: `tests/unit/config-corpus.test.ts` passes byte-for-byte on the regenerated fixtures, and the old and new JSON differ only at `learnings-researcher.prompt` in all 14.
- Integration: `tests/unit/generate-pi-subagents-personas.test.ts` and `tests/unit/ce-review-selection-contract.test.ts` pass after the comment and one-line edits.

**Verification:**
- `bun run registry:drift` and `bun scripts/generate-pi-subagents-personas.ts --check` report no change. The `description` is untouched and the researcher is not curated.
- The prompt contains no hand-typed enum list, no relative skill path and no Rails example.
- No instruction in the prompt reads a path that may not exist unconditionally.
- The scenario-pass results are recorded, and the fixtures were regenerated after the last prompt change.

- [ ] U5. Corpus tidy

**Goal:** Systematic's own corpus satisfies the contract.

**Requirements:** R18, R19

**Dependencies:** U1

**Files:**
- Move: `docs/solutions/code-quality/ocx-registry-review-fixes.md` to `docs/solutions/best-practices/`
- Move: `docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md` to `docs/solutions/workflow-issues/`
- Move: `docs/solutions/workflow-patterns/iterative-oracle-plan-review.md` to `docs/solutions/workflow-issues/`
- Move: `docs/solutions/workflow-issues/sync-cep-missing-sub-files-SyncCEP-20260219.md` to `docs/solutions/integration-issues/`
- Move: `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md` to `docs/solutions/integration-issues/`
- Modify: `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md` and `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md` (`category: best_practice` to `best-practices`)
- Modify: inbound references in `docs/solutions/**`, including `related:` lists

**Approach:**
- Measure the dead-link baseline before moving anything, with a Markdown-link scan of `docs/solutions/` only (5 at HEAD). Compare like with like afterward.
- Move with history preserved. Set each moved doc's `category` to its new directory name. The SyncCEP doc is already correct. Fix `components` to `related_components` in the OCX doc. Remove the emptied `code-quality/` and `workflow-patterns/`.
- Rewrite inbound references by slug, not only by directory-qualified path, since relative links and bare filenames both occur. At HEAD the slug search hits 12 files outside `docs/plans/`, all under `docs/solutions/` and 3 of them the moved docs.
- `docs/plans/` has 9 files besides this plan that reference the moved slugs. They stay untouched, including the live link at `docs/plans/2026-04-18-001-feat-content-integrity-gate-plan.md:398`, which becomes dead. That is accepted.

**Test scenarios:**
- Test expectation: none. The moves are verified by search and by the gates below.

**Verification:**
- A search for the five old paths returns no hit under `docs/solutions/`, and the dead-link set equals the baseline.
- The five moved docs sit in the directory their `problem_type` maps to, with matching `category`.
- No doc has `category: best_practice`.
- `bun scripts/content-integrity.ts` passes on the tidied corpus.
- A Rails-token search across the four consumers hits only `legacy_values`, the legacy-marked `rails_version` entry and the legacy paragraph. Other agents that mention Rails for unrelated reasons are out of scope.
- `bun scripts/generate-registry.ts`, `bun run registry:drift`, `bun scripts/generate-pi-subagents-personas.ts --check` and markdownlint on changed Markdown are clean.
## System-Wide Impact

- **Interaction graph:** `ce:plan`, `ce:ideate`, `ce:compound` (Related Docs Finder), `deepen-plan` and `ce:review` dispatch the researcher. Only `ce:review` renders its output, in the Known Pattern section. The others read it as text.
- **Error propagation:** a missing `docs/solutions/` or `critical-patterns.md` is not an error. An unresolvable successor surfaces as a "Skipped" line, not a failure.
- **State lifecycle risks:** refresh removal can strand a `superseded_by` pointer. Replace and Consolidate retarget it to the survivor, and Delete removes the referring docs with it. The validator runs only in Systematic's CI, so in user repos the writer prose is the only protection for the lifecycle.
- **API surface parity:** `ce-compound`, `ce-compound-refresh` and `compound-docs` must stay byte-identical on three files. The parity test enforces it.
- **Delivery paths:**
  - npm ships `skills` and `agents` via the package `files` list.
  - Pi loads `./skills` through its manifest, so the `compound-docs` file move reaches it unchanged.
  - The registry file lists change and are regenerated.
  - The Claude Code bundle copies each skill verbatim with relative paths, so every skill must carry its own copy.
- **User repos:** not migrated. Docs with legacy values keep passing the validator and refresh. Only new docs stop being offered them.
- **Unchanged invariants:** the category mapping, the researcher's `description`, `CURATED_PERSONAS` and the problem-type lists keep their current contents.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| config-corpus churn: 14 fixtures change for one prompt edit. | Regenerate deliberately with a script outside the repo. Parse old and new JSON and require that only `learnings-researcher.prompt` differs. Explain it in the PR body. |
| Missed inbound links after the moves: no link checker exists. | Search by slug, capture the dead-link baseline first, and require zero hits for the old paths and an unchanged dead-link set. |
| Prose behavior cannot be CI-tested. | One scenario pass at the end of U4 with cited results, plus validator tests for the parts that are code. Accept that the prose is not regression-protected. |
| The new lifecycle check fails on an existing doc. | All 11 superseded docs already name existing, non-superseded targets, so the corpus passes before U5. |
| Parity copies drift after this patch. | The loop-based parity test fails CI on any divergence. |
| `compound-docs/schema.yaml` has an outside consumer. | Search for references before moving it. Only `SKILL.md` and the registry reference it at HEAD. |

## Documentation / Operational Notes

- `ARCHITECTURE.md`: update the content-integrity description for legacy values, the `status` enum and the lifecycle check (U1).
- The PR body lists the removed `compound-docs` items: the Required Reading and hotwire-native menu options, and the common-solutions and critical-pattern Step 7 writes. It states that no user docs are migrated. It explains the config-corpus regeneration and cites the scenario-pass results.
- The docs-site reference content is generated and gitignored, so it needs no manual edit. `HARNESSES.md` has nothing on this surface.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-10-25-solution-doc-contract-requirements.md`. The path is untracked and gitignored in this repository, so it exists only on the author's machine and a clone will not contain it.
- Related code: `scripts/content-integrity.ts`, `skills/ce-compound/references/schema.yaml`, `agents/research/learnings-researcher.md`, `tests/unit/compound-contract-parity.test.ts`
- Related PRs: #840 (refresh used a stale copy), #797 (duplicated contract fixed with one canonical reference), #1000 (introduced the validator)
