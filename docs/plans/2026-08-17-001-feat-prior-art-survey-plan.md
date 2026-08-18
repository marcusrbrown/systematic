---
title: Prior-art survey in planning, and source-checked orientation documents
type: feat
status: active
date: 2026-08-17
origin: docs/brainstorms/2026-08-17-grounding-planning-in-existing-code-requirements.md
---

# Prior-art survey in planning, and source-checked orientation documents

## Overview

Planning gains a prior-art survey that runs inside the research it already performs. The survey asks what currently handles a concern, answers from source rather than documentation, and returns a verdict that later stages can check. Separately, the content-integrity gate widens to cover root documentation and gains two checks that fail when those documents disagree with source.

## Problem Frame

An agent planning new work answers "does this already exist?" from orientation prose, because reading prose is cheaper than searching source. When generated code outpaces hand-maintained documentation, that prose describes a smaller system than the one that exists.

Four contributor-facing documents in this repository each stated the plugin registers three hooks. It registers six, and the three unmentioned ones are the observation hooks a 14,000-line subsystem runs on. That subsystem appeared in no orientation document. An agent that read any of them concluded no such subsystem existed and began planning one. A directory listing naming the subsystem's files was already in context — the concern was named in accounting vocabulary while the request was framed in enforcement vocabulary, and the match never fired.

Nothing in the workflow would have caught it. `ce:brainstorm` asks whether work duplicates something that exists, but that workflow is optional and work arriving pre-framed routes straight to planning. Every check that could have caught the documentation drift compares prose against prose. (see origin: `docs/brainstorms/2026-08-17-grounding-planning-in-existing-code-requirements.md`)

## Requirements Trace

- R1. Survey runs inside the existing research step — no new phase, no additional dispatch.
- R2. Survey receives the concern, not the proposed solution.
- R3. Source establishes existence; documentation informs interpretation but never establishes absence.
- R4. Candidates derive from the concern's trigger, effect, and state; each is described in the code's own vocabulary.
- R5. Survey bounds itself to a workspace or subtree and a stated budget, reporting both.
- R6. Depth scales with plan depth; existence does not, except for non-software and mechanical work.
- R7. Candidates are collected before any is dispositioned.
- R8. Exactly one verdict: reuse, extend, build-new within surveyed scope, unscoped, or unresolved.
- R9. Absence claims are scoped to what was searched.
- R10. No defensible scope returns unscoped, naming the scopes considered.
- R11. Budget exhaustion returns unresolved, naming undispositioned candidates and preserving any disposition reached.
- R12. Build-new states why the strongest candidates were insufficient.
- R13. Unscoped or unresolved stops planning; acceptance is recorded; a run with no user fails.
- R14. The result occupies a named, addressable plan section.
- R15. Plan review checks the survey's claims against source.
- R16. Work execution does not begin on an empty section, an unaccepted unscoped or unresolved verdict, or a survey whose scope has since changed.
- R17. A found equivalent changes the plan and the plan names what changed.
- R18. Facts derivable from source are generated from it or verified against it.
- R19. A contributor-facing document cannot assert an inventory or count that source contradicts.

## Scope Boundaries

- Runtime interception that blocks planning at the tool layer. Every enforcement point here is a workflow step, because one supported harness ships no runtime.
- Semantic indexes, embeddings, or repository-wide knowledge graphs.
- A session-start map of any repository's structure.
- An optional tool agents may call to check for overlap.
- Automatic remediation of drifted documents. The gate reports; correcting stays a human or planned change.
- Retroactive enforcement on plans authored before this contract. A missing survey section reads as predating adoption.

### Deferred to Separate Tasks

- Survey budget calibration by plan depth: needs measurement across real repositories of varying size, which this plan cannot produce.
- Guard-epoch mapping for the deferred runtime enforcement: unresolved and gating work that is out of scope here.

## Context & Research

### Relevant Code and Patterns

- `agents/research/repo-research-analyst.md:16-25` — the scope table. Six scopes, each mapping to a phase and a named output section. The extension point for the survey.
- `agents/research/repo-research-analyst.md:72-91` — workspace and monorepo detection. Reusable for bounding, but does no concern-based selection and imposes no budget.
- `agents/research/repo-research-analyst.md:187-194` — research methodology, including the authority ordering that prioritizes documentation over inferred patterns.
- `skills/ce-plan/SKILL.md:221-236` — Phase 1.1, the only research point that always runs.
- `skills/ce-plan/SKILL.md:518-644` — the Core Plan Template, canonical for which sections exist.
- `skills/ce-plan/SKILL.md:696-703` — the hard floor and include-when-material catalog.
- `skills/ce-work/SKILL.md:45-59` — Phase 1 plan intake. No structural validation exists today.
- `agents/document-review/feasibility-reviewer.md:11-15` — already asks whether an equivalent exists, at review time.
- `scripts/content-integrity.ts:284-308` — `CheckResult`, one field per violation category.
- `scripts/content-integrity.ts:1711-1797` — `checkContentIntegrity`, where checks are registered manually.
- `scripts/content-integrity.ts:1820-1855` — `printResult` and the clean-path determination.
- `skills/ce-review/references/findings-schema.json` with `tests/unit/ce-review-findings-schema.test.ts` — the established pattern for a schema-backed agent output contract in this repository.

### Institutional Learnings

- `docs/solutions/best-practices/behavior-first-ajv-contract-verification-2026-07-21.md` — verify the real consumer schema against actual producer output. Prose changes alone do not prove contract correctness. Drives the schema in Unit 2.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md` — the gate fails or does nothing. Both new checks must be fatal with an exemption list.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` — frontmatter description edits cascade into the registry and Pi export fixtures.
- `docs/solutions/best-practices/cross-harness-adapter-parity-contract-tests-2026-07-14.md` — shared-core tests do not prove adapter parity.
- `docs/solutions/developer-experience/typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md` — `scripts/` is outside the typecheck boundary, so changes there are proven by tests alone.

## Key Technical Decisions

- The survey extends the research agent's existing scope vocabulary rather than adding an agent or a phase: that agent already supports scoped invocation with a scope-to-output-section mapping, and Phase 1.1 already dispatches it on every planning run.
- The survey emits a structured block inside its plan section, not prose alone: three consumers must check the result, and a prose section cannot be validated at a consumer boundary. This follows the schema-backed pattern already used for review findings.
- The survey section joins the plan template's hard floor: a section that may be omitted cannot be checked for absence, which removes the basis for the execution check.
- The authority-ordering correction applies to the whole research agent, not only the survey: the inversion misleads every caller, and scoping the fix to one path would leave the same defect live everywhere else.
- The content-integrity scan widens to named root documents rather than all markdown: the existing scope comment calls the narrowness deliberate, so the change names which documents and why rather than dropping the constraint.
- Checks are fatal with an explicit exemption list: the gate has no warning channel, so an advisory check would be theater.

## Open Questions

### Resolved During Planning

- Where does the survey attach? Phase 1.1's existing dispatch, as a seventh scope on the research agent.
- Where does the execution check live? `ce:work` Phase 1, after the plan is read and before environment setup.
- Which reviewer validates the survey? The always-on feasibility reviewer, which already checks for existing equivalents.
- Can the gate check root documents today? No — its scan targets exclude them, so the target set widens first.

### Deferred to Implementation

- Exact wording of the survey's search-strategy guidance: needs iteration against the agent's existing phase prose.
- Whether the codemap check needs an exemption list on first run: depends on how many modules are currently unlisted.
- Whether Pi export fixtures change: depends on whether the edited sections participate in the generated surface.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
ce:plan Phase 1.1  ──dispatch──▶  repo-research-analyst
                                   scope: technology, architecture,
                                          patterns, prior-art
                                          │
                                          ▼
                            concern (trigger / effect / state)
                                          │
                            bound scope + budget
                                          │
                            search source, registrations,
                            tests, schemas, config
                                          │
                            collect candidates ──▶ describe what each owns
                                          │              (code's vocabulary)
                            disposition strongest
                                          │
                                          ▼
                              verdict + structured block
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
  plan section                    feasibility review              ce:work Phase 1
  (hard floor)                    (claims vs source)              (empty / unaccepted
                                                                   / stale → stop)
```

Verdict shape:

```
verdict:  reuse | extend | build-new-within-scope | unscoped | unresolved
scope:    <workspace or subtree searched>
budget:   <bound applied, and whether exhausted>
candidates:
  - <path or symbol> — <what it owns, in the code's vocabulary> — <disposition>
accepted_by_user:  <present only when an unscoped/unresolved verdict was accepted>
```

## Implementation Units

- [ ] **Unit 1: Add the prior-art scope to the research agent**

**Goal:** The research agent gains a seventh scope that performs a concern-anchored prior-art survey, and its authority ordering stops preferring documentation over source.

**Requirements:** R2, R3, R4, R5, R6, R7

**Dependencies:** None

**Files:**
- Modify: `agents/research/repo-research-analyst.md`

**Approach:**
- Add a `prior-art` row to the scope table with its own named output section, matching the existing row shape.
- Define the survey phase: accept a concern stated as trigger, effect, state, and integration boundary; bound to a workspace using the existing detection; search source, registrations, tests, schemas, and configuration for what currently handles that concern; describe what each candidate owns in the code's vocabulary; collect before dispositioning.
- Replace the single authority-ordering line with authority split by claim type: source, tests, registrations, and schemas establish what exists; documentation and history explain why it exists and what constrains it; orientation prose is a lead requiring verification.
- Leave frontmatter `description` untouched to avoid the registry and Pi-fixture cascade.

**Patterns to follow:**
- The existing scope table at `agents/research/repo-research-analyst.md:16-25`.
- Workspace detection at `agents/research/repo-research-analyst.md:72-91`.

**Test scenarios:**
- Happy path: content-integrity passes with the modified agent file.
- Edge case: frontmatter is byte-identical before and after, so registry drift and Pi fixture drift both report clean.
- Integration: `bun run registry:drift` and the Pi persona fixture drift test both pass without regeneration.

**Verification:**
- The scope table lists seven scopes, each with a distinct output section.
- No occurrence of an authority rule preferring documentation over source remains in the file.
- Registry and fixture drift gates are clean.

---

- [ ] **Unit 2: Define the survey output contract and its schema**

**Goal:** The survey's verdict is machine-checkable at the consumer boundary rather than described only in prose.

**Requirements:** R8, R9, R10, R11, R12, R13

**Dependencies:** Unit 1

**Files:**
- Create: `skills/ce-plan/references/prior-art-survey-schema.json`
- Create: `tests/unit/prior-art-survey-schema.test.ts`
- Modify: `agents/research/repo-research-analyst.md`

**Approach:**
- Schema covers the five verdicts as an enum, the surveyed scope, the budget and whether it was exhausted, the candidate list with per-candidate ownership description and disposition, and an optional acceptance record.
- Constrain by construction where the requirements demand it: a build-new verdict requires a non-empty candidate list with reasons; unscoped requires the scopes considered; unresolved requires at least one undispositioned candidate and preserves any disposition reached.
- Forbid unscoped absence language by having no field that can express it — absence is representable only as a scope plus a budget plus an empty candidate list.
- Bound string lengths and array sizes so a survey cannot persist an unbounded payload.
- Extend the research agent's prior-art output section to emit a conforming verdict. Unit 1 established the survey procedure but no verdict vocabulary; a schema with no producer is an unenforceable contract.

**Execution note:** Write the schema tests first, including the rejection cases, before the schema itself. The contract is the deliverable; the file is its expression.

**Patterns to follow:**
- `skills/ce-review/references/findings-schema.json` and `tests/unit/ce-review-findings-schema.test.ts` — the established schema-plus-test pairing.

**Test scenarios:**
- Happy path: a reuse verdict naming one candidate with a disposition validates.
- Happy path: an unresolved verdict carrying one disposition and two undispositioned candidates validates.
- Error path: a build-new verdict with an empty candidate list is rejected, and the rejection names the failing constraint.
- Error path: an unscoped verdict with no scopes-considered entry is rejected.
- Error path: an unresolved verdict with no undispositioned candidate is rejected.
- Edge case: a verdict outside the five-value enum is rejected.
- Edge case: an over-long ownership description is rejected at its bound.
- Edge case: an unknown top-level field is rejected rather than silently accepted.

**Verification:**
- Every rejection case fails for the specific constraint intended, not incidentally.
- A valid survey for each of the five verdicts round-trips.

---

- [ ] **Unit 3: Wire the survey into planning and the plan document**

**Goal:** Planning dispatches the survey on every qualifying run, and its result lands in a required plan section.

**Requirements:** R1, R6, R14

**Dependencies:** Units 1, 2

**Files:**
- Modify: `skills/ce-plan/SKILL.md`
- Modify: `skills/ce-plan/references/plan-sections.md`

**Approach:**
- Extend the Phase 1.1 dispatch scope string to include prior-art, and add the survey to what the phase collects.
- Pass the concern rather than the planning context summary for this scope, so the survey does not inherit the planner's framing.
- Add the survey section to the Core Plan Template and to the hard-floor list, with the structured block inside it.
- Add its ordering and rendering to the section reference.
- Add the exemption for non-software and mechanical work at the dispatch site, so the skip is a planning decision rather than an agent decision.

**Patterns to follow:**
- The existing Phase 1.1 dispatch lines at `skills/ce-plan/SKILL.md:229-230`.
- Hard-floor and catalog wording at `skills/ce-plan/SKILL.md:696-703`.

**Test scenarios:**
- Happy path: content-integrity passes with the modified skill.
- Edge case: the skill's frontmatter description is unchanged, so registry drift stays clean.
- Integration: the Claude Code plugin build copies the modified skill byte-identically and its test passes.
- Integration: Pi adapter tests that consume shared skill content still pass.

**Verification:**
- The dispatch names four scopes.
- The hard floor names the survey section.
- All generated-surface tests pass without regeneration, or the regenerated artifacts are committed.

---

- [ ] **Unit 4: Plan review validates the survey against source**

**Goal:** The reviewer that already asks whether an equivalent exists now checks the survey's specific claims rather than accepting them.

**Requirements:** R15, R17

**Dependencies:** Unit 3

**Files:**
- Modify: `agents/document-review/feasibility-reviewer.md`

**Approach:**
- Extend the existing "what already exists" check: when the plan carries a survey, verify the named candidates resolve, spot-check that the stated ownership matches what the code does, and confirm a build-new verdict's rejection reasons hold.
- Add the R17 check: a survey reporting an equivalent must correspond to a named requirement or unit change, and citing without changing is a finding.
- Leave frontmatter `description` untouched.

**Patterns to follow:**
- The existing check wording at `agents/document-review/feasibility-reviewer.md:11-15`.

**Test scenarios:**
- Happy path: content-integrity passes with the modified agent.
- Edge case: frontmatter unchanged, so registry and Pi fixture drift stay clean.

**Verification:**
- The reviewer's checks name the survey explicitly.
- Drift gates clean.

---

- [ ] **Unit 5: Work execution refuses an unsatisfied survey**

**Goal:** Work does not begin on a plan whose survey is empty, carries an unaccepted failure verdict, or has gone stale.

**Requirements:** R16

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/ce-work/SKILL.md`

**Approach:**
- Add the check to Phase 1, after the plan is read and before environment setup.
- Three stop conditions: the section exists but is empty; the verdict is unscoped or unresolved with no recorded acceptance; the surveyed scope has changed since the survey ran.
- A missing section means the plan predates the contract and execution proceeds — this keeps existing plans executable.
- Staleness is checked against the surveyed scope, not the whole repository, so the check stays cheap.

**Patterns to follow:**
- Phase 1 intake steps at `skills/ce-work/SKILL.md:45-59`.

**Test scenarios:**
- Happy path: content-integrity passes with the modified skill.
- Integration: the Claude Code plugin build copies the modified skill byte-identically.
- Integration: Pi adapter tests consuming shared skill content pass.

**Verification:**
- The three stop conditions and the predates-adoption exemption are all stated.
- Generated-surface tests pass.

---

- [ ] **Unit 6: Widen the integrity gate and check hook parity**

**Goal:** The gate covers named root documents and fails when their claimed plugin hook set disagrees with source.

**Requirements:** R18, R19

**Dependencies:** None

**Files:**
- Modify: `scripts/content-integrity.ts`
- Modify: `tests/unit/content-integrity.test.ts`

**Approach:**
- Widen scan-target collection to named root documents rather than all markdown, and update the scope comment to say which documents and why — the existing comment calls the narrowness deliberate, so the change amends the stated design rather than silently contradicting it.
- Add a check that extracts the hook names each covered document claims and compares them to the hook keys the plugin entry point returns.
- Register it as its own violation category, include it in the total, and give it a fatal printer naming the document, the claimed set, and the actual set.
- Provide an exemption list for documents that legitimately discuss hooks without asserting the registered set.

**Execution note:** Add the failing test against the pre-fix document state first — restore a document's wrong hook claim in a fixture and confirm the check fires before wiring the real scan.

**Patterns to follow:**
- Check function shape and violation typing at `scripts/content-integrity.ts:1320-1359`.
- Registration at `scripts/content-integrity.ts:1711-1797` and reporting at `:1820-1845`.

**Test scenarios:**
- Happy path: a document naming exactly the registered hooks passes.
- Error path: a document naming a subset fails, and the message names the missing hooks.
- Error path: a document naming a hook that is not registered fails.
- Edge case: a document discussing hooks without asserting the set is not flagged.
- Edge case: an exempted document is skipped.
- Integration: the check participates in the aggregate total, so a violation fails the gate.

**Verification:**
- Restoring any of the four documents to their pre-correction state fails the gate.
- The current tree passes.

---

- [ ] **Unit 7: Check codemap completeness**

**Goal:** A module cannot land in the library without appearing in the architecture document's codemap or an explicit exclusion.

**Requirements:** R18, R19

**Dependencies:** Unit 6

**Files:**
- Modify: `scripts/content-integrity.ts`
- Modify: `tests/unit/content-integrity.test.ts`
- Modify: `ARCHITECTURE.md`

**Approach:**
- Compare the library module inventory on disk against the modules the codemap names.
- Report both directions: a module absent from the codemap, and a codemap entry naming a module that no longer exists.
- Bring the codemap current as part of this unit, since the check cannot land green otherwise.
- Use an explicit exclusion list for modules deliberately not surfaced, with the exclusion itself visible in the document.

**Patterns to follow:**
- The check, registration, and printer shape established in Unit 6.

**Test scenarios:**
- Happy path: a codemap naming every module passes.
- Error path: a module on disk and absent from the codemap fails, and the message names it.
- Error path: a codemap entry with no corresponding module fails.
- Edge case: an excluded module is skipped and its exclusion is visible.
- Integration: the check participates in the aggregate total.

**Verification:**
- Removing any codemap entry fails the gate.
- The current tree passes with the codemap brought current.

## System-Wide Impact

- **Interaction graph:** The research agent is dispatched by planning, ideation, and the deepening workflow. The authority-ordering correction reaches all of them; the new scope only fires where requested.
- **Error propagation:** Both gate checks are fatal by construction, because the gate has no warning channel. A false positive breaks every build until fixed, which is why each carries an exemption list.
- **State lifecycle risks:** A survey verdict can go stale between planning and execution. Unit 5 checks the surveyed scope rather than the whole repository so the check stays cheap enough to always run.
- **API surface parity:** The survey is prose plus a schema, so it reaches all three harnesses. No part depends on runtime interception.
- **Integration coverage:** Skill body edits flow into the Claude Code bundle and Pi adapter output. Those generated surfaces have their own tests and must pass without regeneration, or the regenerated artifacts ship in the same change.
- **Unchanged invariants:** Frontmatter descriptions stay untouched across every edited agent and skill, so the registry and Pi persona fixtures do not move. Plans without a survey section stay executable.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The survey becomes ceremonial — filled in without changing anything | R17 requires naming what changed; Unit 4 makes citing-without-changing a review finding |
| A widened gate flags legitimate prose and blocks every build | Both checks carry exemption lists; Unit 6 restricts scanning to named documents rather than all markdown |
| Skill body edits silently change generated Pi or Claude Code output | Each affected unit verifies the generated-surface tests explicitly rather than assuming |
| An agent escapes a hard scope by declaring it unsurveyable | Unscoped must name the scopes considered; unresolved must name undispositioned candidates. Both are harder to fabricate than a bare claim |
| The survey's value is unproven | The origin document records what would falsify it: no reuse or extend verdict across a meaningful sample of real runs |
| `scripts/` is outside the typecheck boundary | Units 6 and 7 are proven by tests alone, and both write failing tests before implementation |

## Documentation / Operational Notes

- `ARCHITECTURE.md` gains codemap entries in Unit 7 and its scan-coverage description changes in Unit 6.
- The survey section becomes part of every new plan. Existing plans are unaffected.
- Nothing here changes runtime behavior of the plugin; all changes are bundled content, one CI script, and tests.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-08-17-grounding-planning-in-existing-code-requirements.md`
- Related code: `agents/research/repo-research-analyst.md`, `skills/ce-plan/SKILL.md`, `skills/ce-work/SKILL.md`, `scripts/content-integrity.ts`
- Related PRs: #805 corrected the four documents whose drift motivated this plan
