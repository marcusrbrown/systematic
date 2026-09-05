---
title: 'refactor: Enforce the review artifact contract'
type: refactor
status: completed
date: 2026-08-16
origin: docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md
---

# refactor: Enforce the review artifact contract

## Overview

`ce:review` has run 24 times on this repository since May 2026, writing per-persona artifacts to `.context/systematic/ce-review/<run-id>/` each time. Three independent analyses of that corpus tried to answer whether any review personas duplicate each other enough to merge. None could. Not because the personas are demonstrably distinct, but because the artifacts do not record what would settle it.

This plan moves artifact emission from agent prose into plugin code that validates and rejects, then requires the recording that makes review measurable. It also corrects one categorization error the investigation surfaced.

It merges, renames, moves, and deletes no persona.

## Relationship to I4

**This plan does not satisfy I4's entry gate and does not claim to.**

I4 asks to collapse one redundant persona cluster, and its gate requires paired deletion of that cluster into temporary aliases. This plan collapses nothing and deletes no persona. Reviewers correctly rejected an earlier framing that presented a deleted instruction block as satisfying that gate; deleting a write path is not deleting a persona cluster, and calling it one was scope evasion.

The honest relationship is a dependency, not a substitution. I4's gate also demands seeded defects and a coordination baseline. Three analyses established that the recorded data cannot produce either — 11 of 19 runs have any synthesis artifact, 5 preserve reviewer credit. I4 stays open and blocked, and this is prerequisite work it depends on.

Whether I4 is ever worth doing is a separate question this plan takes no position on. The measurement it enables may well show the collapse is not worth the compatibility cost, which is a legitimate outcome.

## Problem Frame

Two findings and one dead end came out of investigating I4's entry gate.

**The named cluster is not what the initiative assumed.** I4 points at personas differing only by prose framing. The three closest candidates — `architecture-strategist`, `pattern-recognition-specialist`, `code-simplicity-reviewer` — were dispatched by `ce:review` zero times in 24 runs. They appear in neither `skills/ce-review/SKILL.md`'s selection tables nor `skills/ce-review/references/persona-catalog.md`. They were never selectable. Their real consumers are `skills/ce-compound/SKILL.md`, `skills/deepen-plan/SKILL.md`, and `skills/ce-plan/references/deepening-workflow.md`.

**The redundancy question is unanswerable from what was recorded.** A semantic analysis found 59 cross-persona duplicate pairs across 27 defects; an independent validation against review-time merge decisions could not ratify it. Coverage is why: 11 of 19 qualifying runs have any synthesis artifact, and only 5 record which reviewers contributed to a merged finding. One run recorded 22 raw findings and 8 named outcomes, with no disposition for the other 14. The single claim strong enough to act on — that `api-contract` finds nothing another persona also finds — rests on 2 of its 6 findings having ground truth, and one of those two was a shared false positive both personas got wrong.

That last detail is the crux. A duplicate is not a defect. Artifacts recording agreement without recording whether the agreed finding survived validation cannot distinguish convergence on truth from convergence on error.

**The dead end:** the recording cannot be fixed by asking more nicely. Today the skill instructs sub-agents in Markdown to write JSON to a path. Nothing checks what lands. Tightening the instructions produces better-behaved artifacts on average and no guarantee, which is how the current gaps arose — the contract was already documented.

## Requirements Trace

- R1. Ownership of shared personas is discoverable from the persona itself, not inferred from its directory.
- R2. Artifact writes are validated at the write boundary; non-conforming artifacts are rejected rather than persisted.
- R3. Every run emits a synthesis artifact recording which personas were dispatched, which contributed to each merged finding, and what disposition every input finding received.
- R4. Findings carry non-empty, bounded reasoning and evidence, with repo-relative paths, a defined overflow policy, and no environment values.
- R5. No persona is renamed, moved between categories, merged, or deleted.
- R6. Every artifact records which harness produced it, so analysis can distinguish runs by the guarantees that applied.

## Scope Boundaries

- No persona collapse. The evidence that would justify one does not exist; this plan is what makes collecting it possible.
- No identifier changes. Personas reach five namespaces — OpenCode's filename stem, Pi's runtime frontmatter `name`, Pi export's `systematic-<name>.md`, Claude Code's flattened name, and the registry's `agent-<stem>` — with no alias layer spanning them. `src/lib/removed-names.ts` accepts-and-drops stale config values; it maps nothing. R5 exists because violating it turns a documentation fix into a cross-harness migration.
- No change to persona selection. Adding the three misfiled personas to `ce:review`'s roster would raise dispatch cost with no evidence any review needed them.
- No retroactive repair of the 24 existing run directories. They are historical records, and analyses citing them must say they predate this contract.
- No new review personas.
- No change to `document-review`, which received its equivalent contract fix in PR #679.

### Deferred to Separate Tasks

- Re-running the overlap measurement once decision-grade runs accumulate. This is the question the plan unblocks. The threshold is not a fixed run count — it is enough runs for the per-pair co-occurrence denominators to stop being single-digit, which the prior analysis named as its own largest weakness.
- Deciding what to do about `api-contract`, the most-contained persona under an unratified measurement.
- Reconciling the two confidence scales: PR #679 moved `document-review` to integer anchors `0 | 25 | 50 | 75 | 100`, while `ce:review` still uses continuous `0.0-1.0` with a `0.60` gate. The contracts have diverged. Deliberate or drift is a separate question, and converging them exceeds a recording fix. Recorded here so it is a known divergence rather than an unnoticed one.
- **The `tools:` frontmatter divergence.** `src/lib/agents.ts:30` types `tools` as `Record<string, boolean>`, so the string form every bundled agent uses (`tools: Read, Grep, Glob, Bash`) fails `isToolsMap()` and is discarded — OpenCode applies no restriction. Pi parses the same string as a least-privilege allowlist. One declaration, opposite meanings. This plan routes around it rather than fixing it, but it is a live cross-harness defect deserving its own issue.

## Context & Research

### Relevant Code and Patterns

- `skills/ce-review/SKILL.md` — the artifact contract lives here inline, unlike `document-review` which extracts its synthesis pipeline to a reference. Stage 4 defines what sub-agents write and where, Stage 5 defines merge and dedup and the cross-reviewer agreement boost, Stage 5b the validation pass, Stage 6 report assembly and the run artifact.
- `skills/ce-review/references/findings-schema.json` — the schema personas are given, with a merge-tier vs detail-tier split; `why_it_matters` and `evidence[]` live on the detail tier.
- `skills/ce-review/references/subagent-template.md` — the prompt each persona receives, including the artifact write path.
- `skills/ce-review/references/persona-catalog.md` — the roster the skill treats as authoritative.
- `src/lib/agent-resolver.ts:151-199` — `OPENCODE_TO_PI_TOOL` and `resolveToolAllowlist`. Pi maps persona `tools:` declarations against a fixed built-in table and throws on anything unrecognized. This is why a custom sub-agent-callable tool cannot exist on Pi, and why review personas declaring `Read, Grep, Glob, Bash` have no write capability there.
- `src/lib/agents.ts:30,80` — OpenCode types `tools` as `Record<string, boolean>`, so the string form every bundled agent uses fails `isToolsMap()` and is discarded. The same declaration that restricts Pi restricts nothing on OpenCode.
- `skills/ce-review/SKILL.md:384-395` — the parent already generates the run id and creates the artifact directory, so it is the natural place for persistence.
- `tests/unit/document-review-findings-schema.test.ts` — compiles `document-review`'s real schema with AJV and validates representative findings. There is no `ce:review` equivalent; `skills/ce-review/references/findings-schema.json` has never been executably validated, which is why its drift went unnoticed. AJV 8.20.0 is a direct dependency.

### Institutional Learnings

- `docs/solutions/best-practices/qualified-persona-ids-are-canonical-validated-references-2026-07-17.md` — `systematic:<category>:<name>` references are validated against physical files. Do not weaken them to bare names.
- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md` — high severity: content updates that miss referenced agent files ship dangling dispatch targets.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md` — the gate is binary and fails closed. A check either fails the build or does not exist.
- `docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md` — a gate observing a subset of what it guards proves less than it claims. Applies directly to schema enforcement here.

### Prior Art In This Repository

[`docs/plans/2026-07-21-001-fix-document-review-findings-contract-plan.md`](2026-07-21-001-fix-document-review-findings-contract-plan.md) (shipped as PR #679 → v3.2.4) fixed the equivalent producer/consumer contract failure for `document-review`. It settles two questions:

- **Producer and consumer ship as one release slice.** No mergeable state may carry a mixed contract, because a reviewer dispatched under the old contract returning to a new consumer is the failure being fixed.
- **Behavioral verification means dispatching real personas** and validating their returned JSON, not asserting on prose.

It also shows the limit worth learning from: that plan's enforcement was an AJV regression test over the schema document, which proves the schema is valid and not that emitted artifacts conform. `ce:review` has the same gap plus no test at all. This plan closes both, and the write-boundary tool is the part PR #679 did not have.

## Key Technical Decisions

- **Enforce at a boundary, not in prose.** Instructions in a Markdown skill are advisory by construction — the current contract is already documented and the gaps exist anyway. The AJV test is a regression guard on the schema, not the enforcement.
- **Enforce by deleting the write path, not by guarding it.** A validating tool must be reachable and mandatory; on Pi it is not reachable, and on OpenCode it cannot be made mandatory. Moving persistence to the parent removes the bypass by construction and works identically on all three harnesses, including Claude Code, because it needs no plugin runtime. This is smaller than the tool design it replaces — two Markdown files instead of a TypeScript module and two registration sites.
- **Bound what evidence may contain.** `evidence[]` holds verbatim excerpts from the reviewed diff, and requiring it means every review persists source text — including from private repositories — to local disk. The model-inheritance eval one week earlier was required to persist structural facts only, with that restriction asserted in a contract test. Review artifacts genuinely need excerpts where that eval did not, so the answer is bounds rather than prohibition: capped length, capped count, repo-relative paths, no environment values.
- **Fix recording rather than acting on thin evidence.** Acting on `api-contract` at n=2 verified findings would repeat the error that produced the unfalsifiable 1.000 uniqueness result — trusting a measurement whose instrument could not detect what it looked for.
- **Correct ownership in documentation, not by moving files.** The three personas are correctly implemented and actively used; only their location misleads. Moving them changes their category, which changes overlay keys and reaches all five namespaces.
- **Distinguish submission from agreement credit.** `20260522` credits `correctness` and `kieran-typescript` on a merged `testing` finding while both recorded zero findings. Under the current contract those are indistinguishable, and any overlap measurement reading it over-counts.

## Open Questions

### Resolved During Planning

- Are the three personas dead code? No. `ce:review` never dispatches them; `ce-compound`, `deepen-plan`, and `ce-plan`'s deepening workflow do.
- Is the redundancy real? Unproven. The strongest confirmed instance is one six-persona cluster in one run; corpus-wide rates are unratifiable.
- Can `src/lib/removed-names.ts` carry persona aliases? No.
- Does removing an agent break existing user config? Yes, loudly — `validateExactAgentOverlays` throws on an unknown `agents.<name>` key. Reinforces R5.
- Can a validating tool cover all three harnesses? No, and the question is moot. Pi's fixed tool table rejects custom tools at catalog-build time, OpenCode cannot make a tool mandatory, and Claude Code ships static Markdown. Parent-side persistence sidesteps all three.
- Is `.context/` committed? No — gitignored at `.gitignore:49`, no tracked files. Artifacts are ephemeral local output, invisible to CI unless a job generates them.

### Deferred to Implementation

- Whether a rejected artifact fails the review run or degrades it with the rejection recorded. Failing is stricter; degrading preserves partial results and keeps one malformed persona from destroying a whole review. The choice affects Unit 4's disposition semantics and should be settled in Unit 3.
- Whether returning the detail tier inline measurably degrades parent context on a full multi-persona run. Unit 3's execution note names the fallback if it does.
- Whether tightening the schema reveals that the documented contract already disagrees with what Stage 5 consumes. If so, that is the same producer/consumer mismatch class PR #679 fixed and Unit 2 grows.

## Implementation Units

- [x] **Unit 1: Correct the ownership record for three shared personas**

**Goal:** Make it discoverable that `architecture-strategist`, `pattern-recognition-specialist`, and `code-simplicity-reviewer` are dispatched by `ce-compound` and plan-deepening, not `ce:review`.

**Requirements:** R1, R5

**Dependencies:** None. Independent of Units 2-4 and separately revertable.

**Files:**
- Modify: `agents/review/architecture-strategist.md`
- Modify: `agents/review/pattern-recognition-specialist.md`
- Modify: `agents/review/code-simplicity-reviewer.md`
- Modify: `skills/ce-review/references/persona-catalog.md`
- Regenerate: `registry/registry.jsonc` — generated output that embeds agent `description` verbatim (`registry/registry.jsonc:43`), so any frontmatter description edit drifts it. Run `bun scripts/generate-registry.ts`.
- Regenerate: `tests/fixtures/pi-subagents-personas/systematic-{architecture-strategist,code-simplicity-reviewer,pattern-recognition-specialist}.md` and `systematic-personas-manifest.json` — all three personas are in `CURATED_PERSONAS` (`src/lib/pi-subagents-personas.ts:102,112,137`), so the committed Pi-export fixtures embed their descriptions and a source-side drift gate in `tests/unit/generate-pi-subagents-personas.test.ts` fails otherwise. Run `bun scripts/generate-pi-subagents-personas.ts`.

**Blast-radius note:** editing one bundled agent's `description` touches three generated surfaces. The plan's original four-file list was wrong twice over; both gaps were caught by drift gates rather than by planning, which is the gates working as intended.

**Approach:**
- State each persona's consuming workflow in its own description so the fact travels with the agent to every harness rather than living only in a catalog.
- Record in the persona catalog that `agents/review/` is a shared pool rather than `ce:review`'s roster. Frame this as establishing directory semantics that were never defined, not as correcting a misfiling — no document ever claimed the directory implied ownership, and the ambiguity is the actual defect.
- Preserve every identifier exactly. No file moves, no frontmatter `name` changes, no category changes.

**Patterns to follow:**
- Existing `agents/review/` frontmatter conventions — description phrasing that names the triggering condition.
- Qualified `systematic:review:<name>` reference form.

**Test scenarios:**
- Happy path: `bun run scripts/content-integrity.ts` reports clean with no phantom references.
- Edge case: the three agents still appear in emitted OpenCode config under unchanged keys.
- Edge case: after regenerating, the `registry/registry.jsonc` diff contains only `description` lines — no component `name`, `files`, or dependency entries change. That is the proof no identifier moved. `registry:drift` alone proves only that generated output is fresh, which is a different property.
- Edge case: `bun scripts/generate-pi-subagents-personas.ts --check` passes, and the regenerated fixture diff changes only description text and the manifest's content hashes — no generated filename changes, which would signal an identifier moved in the Pi export namespace.
- Integration: `bun test tests/unit` passes with unchanged agent-discovery counts.

**Verification:**
- Reading any of the three agent files reveals which workflow dispatches it.
- No identifier in any of the five namespaces changed.

- [x] **Unit 2: Tighten the findings schema and add its regression test**

**Goal:** Make the schema express the contract Unit 3 will enforce, and guard it with the executable test `ce:review` never had.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `skills/ce-review/references/findings-schema.json`
- Modify: `skills/ce-review/references/subagent-template.md`
- Create/Test: `tests/unit/ce-review-findings-schema.test.ts`

**Approach:**
- Require non-empty `why_it_matters` and `evidence[]` on detail-tier findings.
- Bound evidence: cap entry count and per-entry length in the schema, and require repo-relative paths. Define an explicit overflow policy — a finding whose evidence exceeds the cap splits into multiple entries or records a bounded excerpt plus an overflow marker. Never silently truncate: truncation preserves the appearance of complete evidence while corrupting the trail the measurement depends on.
- Absolute-path rejection is schema-expressible; "no environment values" is not, since JSON Schema cannot infer a string's origin. Implement that as detection logic in Unit 3's validation step and describe it there, not as a schema constraint the schema cannot enforce.
- Bounds limit size and shape, not sensitivity. A compliant `evidence[]` entry can still contain a secret quoted from the diff. The plan accepts verbatim excerpts as necessary for review to function and does not claim they are scrubbed.
- Require `file` and `line` on findings naming a location, including from personas currently reporting in prose.
- Add fields for the provenance and disposition Units 3 and 4 record, so the schema is ready before the tool enforces it.
- Compile the real schema with AJV and validate representative objects, mirroring `tests/unit/document-review-findings-schema.test.ts`. Validate data, not schema descriptions or guidance prose.
- Keep canonical values owned by the JSON Schema. No TypeScript findings model, no second contract representation.

**Execution note:** Test-first for the executable contract, per PR #679 — add failing AJV cases before tightening the schema. Characterization-first for deciding what to tighten: the 24 existing runs show real drift, and enforcement should be shaped by what artifacts contain rather than what the schema already claims.

**Patterns to follow:**
- `tests/unit/document-review-findings-schema.test.ts` — compile the real schema, use representative object fixtures, assert nothing about Markdown or file contents.

**Test scenarios:**
- Happy path: a well-formed finding with populated bounded reasoning and evidence validates.
- Edge case: empty `why_it_matters` is rejected.
- Edge case: empty `evidence[]` is rejected.
- Edge case: evidence exceeding the length or count cap is rejected.
- Edge case: an absolute path in `file` is rejected; the repo-relative equivalent validates.
- Edge case: a finding naming a location without `line` is rejected.
- Error path: validation failure names the offending field.

**Verification:**
- The real schema compiles and representative objects validate.
- Every schema-expressible bound in R4 is expressed in the schema; the rest is named as Unit 3 validation logic rather than assumed.

- [x] **Unit 3: Move artifact persistence to the parent orchestrator**

**Goal:** Make non-conforming artifacts impossible to persist, on every harness, by removing sub-agent disk access from the design entirely.

**Requirements:** R2, R4

**Dependencies:** Unit 2

**Files:**
- Modify: `skills/ce-review/SKILL.md` (Stage 4 dispatch and return contract)
- Modify: `skills/ce-review/references/subagent-template.md` (output contract)

**Approach:**

Sub-agents stop writing files. They return the detail tier alongside the merge tier, and the parent validates and writes once. This is the plan's narrowing slice: an entire write path is deleted rather than guarded.

The design follows from what the current one cannot do:

- **A sub-agent-callable validating tool cannot work.** On Pi, `resolveToolAllowlist` (`src/lib/agent-resolver.ts:174-199`) maps persona `tools:` declarations against a fixed built-in table and throws `UnknownDeclaredToolError` on anything unrecognized, so a custom tool fails at catalog-build time. On OpenCode, a registered tool cannot be made mandatory — nothing prevents a sub-agent from writing directly instead.
- **Sub-agent writes are already broken on Pi.** All 18 review personas declare `tools: Read, Grep, Glob, Bash`. Pi parses that into `['read', 'grep', 'find', 'bash']` — no write capability — while the subagent template instructs them to write an artifact and calls it "the ONE write operation you are permitted to make." Pi review runs have never been able to produce artifacts.
- **The parent already has what it needs.** It generates the run id, creates the directory (`skills/ce-review/SKILL.md:390`), and receives every persona's return. Moving persistence there requires no new tool, no registration, and no harness-specific code.

Concretely:
- Delete the artifact-write instruction and file path from the subagent template's output contract. Sub-agents return one JSON payload containing both tiers.
- Have the parent validate each return against the Unit 2 schema before writing, rejecting non-conforming payloads with a message naming the persona and field, and never echoing the offending value.
- Record the harness that produced the run in the synthesis artifact, so later analysis can tell which guarantees applied.
- Keep `mode:report-only` exempt — no run id, no directory, no write.

**Execution note:** Returning the detail tier increases parent context per persona, which the current split was designed to avoid. Verify against a real multi-persona run that this does not degrade synthesis; if it does, the fallback is parent-side writes driven by a second targeted request per persona rather than restoring sub-agent disk access.

**Patterns to follow:**
- Stage 4's existing dispatch and compact-return contract, extended rather than replaced.
- `mode:report-only`'s no-write contract, which already proves the parent can run the pipeline without any artifact write.

**Test scenarios:**
- Happy path: a conforming return is validated and persisted by the parent.
- Edge case: a return with empty `evidence[]` is rejected and nothing is written for that persona.
- Edge case: a return with an absolute path in `file` is rejected and nothing is written.
- Edge case: evidence exceeding bounds triggers the Unit 2 overflow policy rather than silent truncation.
- Edge case: a malformed payload that is not valid JSON is rejected without partial write.
- Edge case: a rejected persona is recorded in the synthesis artifact as a dispatch outcome, not silently dropped.
- Error path: rejection names the persona and failing field and omits the offending value.
- Error path: `mode:report-only` writes nothing.

**Verification:**
- No sub-agent writes to `.context/` on any harness.
- No non-conforming artifact reaches disk.
- Enforcement is uniform across OpenCode, Pi, and Claude Code, because it no longer depends on a plugin runtime.

- [x] **Unit 4: Require synthesis artifacts with provenance and disposition**

**Goal:** Every run records what was dispatched, who contributed to each merged finding, and what happened to every input finding.

**Requirements:** R3, R6

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/ce-review/SKILL.md` (Stages 5, 5b, 6)
- Modify: `skills/ce-review/references/review-output-template.md`

**Approach:**
- Make the synthesis artifact unconditional. A zero-finding run is a data point; its absence is ambiguous between "clean" and "never ran." Keep `mode:report-only` exempt — its no-write contract is deliberate and other workflows depend on it.
- Record dispatch outcome per persona: returned with findings, returned empty, returned malformed, or never returned. `20260714`'s summary records `malformed_returns` incidentally; make it contractual.
- Record contributing personas on every merged finding, distinguishing independent submission from agreement credit. Preserve the dedup fingerprint that produced each merge so a later analysis can tell a fingerprint match from a judgment call.
- Reconcile inputs against outputs: every finding is surviving, merged, suppressed, filtered, or rejected, with a reason. Record rejection reasons as stated rather than bucketed — validation observed at least six distinct causes, and the difference between "premise disproven" and "team declined on scope" is the difference between a wrong persona and a correct one.
- Record runs that end abnormally. Every count in this plan's evidence came from runs that successfully wrote artifacts; crashed and interrupted runs are missing by construction, and any future rate computed without them repeats that bias.
- Record the harness that produced the run (R6), since sub-agent write capability and tool semantics differ across the three.

**Patterns to follow:**
- `.context/systematic/ce-review/20260729-060016-e24c854b/merged-findings.json` — the most complete existing artifact and the closest target shape.
- `.context/systematic/ce-review/20260528-233035-5e3b4743/run-summary.md` — records a rejection with its actual reasoning rather than a category.
- Stage 5's cross-reviewer agreement rule, which already computes the submission-vs-agreement distinction internally and discards it.

**Test scenarios:**
- Happy path: a run producing findings writes a synthesis artifact listing dispatched personas and surviving findings.
- Happy path: two personas independently submitting the same finding produce one merged entry crediting both as submitters.
- Edge case: a persona credited only via the agreement boost is recorded as agreement, not submission.
- Edge case: a persona submitting zero findings never appears as a submitter.
- Edge case: a run where every persona returns empty still writes an artifact recording that.
- Edge case: input finding count reconciles exactly against recorded dispositions.
- Edge case: a finding suppressed below the 0.60 gate records its confidence; a P0 retained at 0.50+ records as surviving.
- Error path: `mode:report-only` writes nothing, unchanged.

**Verification:**
- Per-persona submission counts are derivable from the synthesis artifact alone.
- Agreement credit can never be mistaken for an independent finding.
- Input findings reconcile exactly against recorded dispositions.

## Release Slicing

Units 2, 3, and 4 change the producer contract, the write path, and the consumer together. They ship as **one release slice** — no mergeable state may carry a mixed contract, because a persona dispatched under the old contract returning to a new consumer is precisely the failure being fixed. A temporary failing state during local work is expected.

Unit 1 is documentation-only, shares no file with the others, and may ship separately or alongside.

## Behavioral Verification

Schema tests prove the contract is expressible; the tool proves conforming writes are enforceable. Neither proves personas produce useful output or that synthesis consumes it. After Units 2-4 converge:

- Dispatch a real multi-persona `ce:review` against a diff that elicits findings from several personas, including at least one defect two would both surface.
- Confirm the synthesis artifact exists, records dispatch outcome per persona, credits submitters distinctly from agreement, and reconciles every input finding to a disposition.
- Deliberately emit one non-conforming artifact and confirm the tool rejects it without writing.
- Confirm `mode:report-only` still writes nothing.
- Confirm Pi registration works, and that Claude Code's documented limitation matches its actual behavior.
- Run existing unit and integration suites as regression checks. Add no assertions about Markdown, file contents, or generated text.

## System-Wide Impact

- **Interaction graph:** `ce:review` is invoked directly and by `ce:work`'s shipping workflow; contract changes affect both. `ce-compound`, `deepen-plan`, and `ce-plan` dispatch the Unit 1 personas but consume no review artifacts.
- **Error propagation:** Unit 3 introduces a rejection path where none existed. It must name the persona and field, or it converts a silent data gap into an opaque failure.
- **State lifecycle risks:** Artifacts accumulate under `.context/systematic/ce-review/`, gitignored at `.gitignore:49` with no tracked files — ephemeral local output, never committed, invisible to CI unless a job generates them. The duplicate-timestamp directory pair from July 6 suggests run-id collision is possible and worth handling in Unit 4.
- **API surface parity:** New tool registration on two harnesses. `src/index.ts` must continue to export only `default`.
- **Cost:** Every review gains parent-side validation and larger sub-agent returns. That is real overhead in the hot path of a workflow users run often, accepted because the alternative is continuing to record data that cannot answer questions asked of it. If the measurement question is abandoned, this overhead should be revisited rather than kept by inertia.
- **Who benefits:** This is maintainer-first instrumentation. The direct beneficiary is whoever analyzes review behavior, which today means this repository's maintainers. The user-facing effects are indirect and worth stating plainly rather than inflating: Pi users gain artifacts that currently cannot be written at all, and all users gain a synthesis record explaining why a finding did not reach their report. The larger payoff is downstream and speculative — a review workflow whose personas can be justified by evidence rather than retained by default.
- **Unchanged invariants:** Persona identifiers across all five namespaces, agent frontmatter contracts, the model-free bundled-markdown rule, config precedence and trust boundaries, and `mode:report-only`'s no-write guarantee.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Rejection breaks reviews mid-run | Unit 3's deferred question decides fail-vs-degrade before implementation. Characterization against the 24 existing runs shapes what is rejected, so the bar matches real output rather than an aspirational schema. |
| Producer and consumer ship out of step | Units 2-4 land as one release slice, per PR #679. |
| Claude Code silently lacks enforcement | Stated in the skill where a Claude Code reader will see it, and recorded as deferred work rather than implied parity. |
| Evidence bounds are too tight and personas lose the ability to justify findings | Bounds are schema-expressed and adjustable; behavioral verification uses a real multi-persona run to check that findings remain justifiable under them. |
| The unblocked question is never revisited | Recorded in Deferred with a concrete signal — co-occurrence denominators leaving single digits — rather than a run count that would be arbitrary. |
| Scope creeps into persona collapse | R5 forbids identifier changes, and Scope Boundaries names the five-namespace consequence. |

## Terminology

One canonical term per outcome, to keep implementation and test names aligned:

| Term | Meaning |
|---|---|
| **Dispatch outcome** | What a persona returned: findings, empty, malformed, or never returned |
| **Disposition** | What happened to an input finding: surviving, merged, suppressed, filtered, or rejected |
| **Suppressed** | Dropped by the confidence gate |
| **Filtered** | Dropped by the Stage 5b validation pass |
| **Rejected** | Refused at the write boundary for contract violation |

"Disposition" is the umbrella term; suppressed, filtered, and rejected are its subcases.

## Documentation / Operational Notes

- The three personas in Unit 1 keep their names, categories, files, and dispatch behavior. Only documented ownership changes.
- Conventional type at merge: this touches `skills/`, `agents/`, and `src/`, and adds a user-visible tool. `refactor` publishes nothing in this repository (see `docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md`); a releasing type is required for the tool to reach users.
- Existing run directories are untouched, and analyses citing them must state that they predate this contract.
- Artifacts have no retention policy today and 24 runs have accumulated since May. This plan does not add one, and that is a deliberate deferral rather than an oversight: verbatim excerpts from private repositories accumulating indefinitely on local disk is a data-minimization gap worth its own decision.
- Unit 1 is documentation-only and should ship independently by default, ahead of the contract slice.

## Sources & References

- **Origin document:** [`docs/plans/2026-08-13-001-refactor-bitter-lesson-harness-plan.md`](2026-08-13-001-refactor-bitter-lesson-harness-plan.md) — Phase 1 "Measure and expose"; initiative I4 stays blocked on this work
- Direct precedent: [`docs/plans/2026-07-21-001-fix-document-review-findings-contract-plan.md`](2026-07-21-001-fix-document-review-findings-contract-plan.md) — the same contract fix for `document-review`, shipped as PR #679 → v3.2.4
- Prior wedge: [`docs/plans/2026-08-16-001-refactor-retire-source-model-defaults-plan.md`](2026-08-16-001-refactor-retire-source-model-defaults-plan.md) — merged as PR #790
- Evidence corpus: `.context/systematic/ce-review/` — 24 runs, 2026-05-10 through 2026-08-16
- Contract surface: `skills/ce-review/SKILL.md` (Stages 4-6) and `skills/ce-review/references/`
- Tool-registration precedent: `src/lib/skill-tool.ts`, `src/index.ts`, `src/pi.ts`
- Executable-contract seam to mirror: `tests/unit/document-review-findings-schema.test.ts`
