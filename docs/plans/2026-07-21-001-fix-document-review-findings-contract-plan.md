---
title: "fix: Align document-review findings contract"
type: fix
status: active
date: 2026-07-21
origin: docs/brainstorms/2026-07-21-document-review-findings-contract-alignment-requirements.md
---

# fix: Align document-review findings contract

## Overview

Align the document-review producer, consumer, and persona guidance to the existing anchor-based contract. Validate the executable JSON Schema with AJV, then verify the migrated guidance through real persona pressure scenarios and the existing reviewer-to-synthesis boundary.

---

## Problem Frame

Issue #677 is a reproducible producer/consumer contract failure: the shipped schema and producer guidance emit continuous confidence values and `auto` / `present`, while synthesis accepts discrete anchors and `safe_auto` / `gated_auto` / `manual`. The formal dogfood reproduction produced five legacy-shaped findings from three personas, all of which synthesis correctly dropped as malformed. The mismatch also exists in headless wording, persona calibration, and the full review-output example, so correcting only the originally named surfaces would leave the workflow contradictory.

---

## Requirements Trace

### Canonical contract and producers

| Requirement | Planned coverage |
|---|---|
| R1 | U1 updates the canonical JSON Schema to the integer confidence enum `0 | 25 | 50 | 75 | 100`. |
| R2 | U1 updates the schema autofix enum to `safe_auto | gated_auto | manual` and preserves the synthesis meanings. |
| R3 | U1 aligns schema and producer guidance with the five existing anchor meanings; behavioral validation exercises the anchor values. |
| R4 | U1 validates that decimal and legacy values are rejected without compatibility remapping. |
| R5 | U1 aligns the subagent template with canonical enums, anchor selection, evidence, and the one-clear-fix classification test. U3 verifies the resulting persona behavior. |
| R6 | U1 aligns suggested-fix guidance with synthesis; U3 verifies persona output behavior where conditionality is not structurally expressible in the schema. |
| R7 | U3 updates all seven personas with shared anchor calibration and role-specific examples. |
| R8 | U1 aligns interactive and headless guidance with canonical classes and user-facing vocabulary. |

### Consumer and behavioral verification

| Requirement | Planned coverage |
|---|---|
| R9 | U2 aligns live synthesis guidance while retaining clearly non-normative historical references where needed. |
| R10 | U2 preserves current anchor gates, strict validation, class routing, and fixes/proposed fixes/decisions/FYI behavior; U3 exercises that behavior end to end. |
| R11 | U2 brings the review-output template to full contract convergence; human review and U3 pressure scenarios verify the result. |
| R12 | U2 preserves current post-synthesis coverage semantics while aligning its vocabulary; U3 verifies route outcomes rather than presentation text. |
| R13 | U1 adds AJV contract tests that compile the real canonical schema and validate representative reports and findings. |
| R14 | U1 covers canonical acceptance, decimal/out-of-set rejection, legacy rejection, and schema-expressed required fields. |
| R15 | U3 reruns all seven personas against representative requirements/plan pressure scenarios after U1-U3 converge. |
| R16 | U3's behavioral verification demonstrates canonical reviewer JSON reaches synthesis without malformed classification for confidence/autofix vocabulary. |

### Delivery invariants and carrying cost

| Requirement | Planned coverage |
|---|---|
| R17 | Behavioral Verification records existing npm/package and Claude Code build/integration suites as unchanged regression checks; no new content assertions are added. |
| R18 | U3 and Behavioral Verification preserve no-committed-generated-output and source-immutability/build invariants without adding content sentinels. |
| R19 | U1 uses the JSON Schema as the canonical contract and introduces no TypeScript contract or code-generation layer. |

---

## Scope Boundaries

- Included: the canonical schema, producer template, main skill and headless guidance, synthesis guidance, review-output template, all seven persona prompts, AJV behavioral contract tests, real persona pressure scenarios, and reviewer-to-synthesis verification.
- Included: strict rejection of continuous confidence and `auto | present` output without compatibility remapping. The corrected producer and consumer assets are delivered together as one release unit for newly dispatched reviews. Older or in-flight dispatches remain under the contract they were dispatched with and are not mixed into a newly dispatched review.
- Excluded: prose or structure tests, Markdown or file-content assertions, a new content-integrity contract gate, package-content or generated-content sentinels, and any inspection of text or file structure in delivered artifacts.
- Excluded: synthesis retry policy, contradiction deduplication or recommended-action tie-break redesign, coverage redesign beyond vocabulary alignment, section normalization, runtime behavior changes, tolerant compatibility modes, unrelated skills or agents, committed generated output, and host behavior changes.
- Bundled agents remain model-free; no frontmatter `model` changes are part of this work.

### Deferred to Separate Tasks

- Synthesis retry policy and handling for failed or timed-out reviewer dispatches.
- Contradiction handling and deterministic recommended-action tie-break redesign.
- Coverage calculation or attribution redesign beyond aligning the output vocabulary with existing semantics.
- Section normalization or changes to finding fingerprints.

---

## Context & Research

### Relevant Code and Patterns

- `skills/document-review/references/findings-schema.json` is the executable contract input for AJV; the new focused test must compile this real schema rather than reproduce its values in a second contract model.
- `skills/document-review/references/subagent-template.md`, `skills/document-review/SKILL.md`, `skills/document-review/references/synthesis-and-presentation.md`, and `skills/document-review/references/review-output-template.md` are the live guidance surfaces to align. They are changed as bundled workflow assets, not treated as test fixtures.
- The seven files under `agents/document-review/` define role-specific calibration. Their behavior is verified by dispatching the real personas after the guidance migration, not by adding Markdown assertions.
- `tests/unit/document-review-findings-schema.test.ts` is the focused executable-contract seam proposed for U1. AJV is already available in the repository's development dependencies.
- Existing document-review orchestration and synthesis behavior remain the consumer boundary. No executable synthesis runtime is invented by this plan.
- `package.json` keeps `skills/` and `agents/` in npm packaging. Existing package and Claude Code suites remain regression checks only; they receive no new content or structure assertions for this change.
- `scripts/build-claude-code-plugin.ts` continues to generate the ephemeral Claude Code bundle from source. Its existing source-immutability and build invariants remain unchanged.
- Bundled agents continue to omit `model` so they inherit the invoking model as currently configured.

### Institutional Learnings

- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`: strict validation should derive from one canonical source and avoid parallel contract representations.
- The issue's Fro Bot triage and formal dogfood evidence establish that the failure is a producer/consumer contract mismatch, not a reviewer-quality edge case.

---

## Key Technical Decisions

- Compile the real `findings-schema.json` with AJV in the focused unit test. Validate representative data objects and reports, not schema descriptions or guidance prose.
- Keep canonical values in the JSON Schema. Do not introduce a TypeScript findings model, generated constants, or code-generation layer.
- Treat suggested-fix conditionality according to the schema's structural capabilities. If the schema does not encode a conditional requirement, do not fake one with a prose assertion; verify it through real persona behavior instead.
- Migrate U1-U3 as one content release slice before behavioral verification or shipping. A temporary test-first failure is acceptable during local work, but no shipped or mergeable state may contain a mixed producer/consumer contract.
- Preserve synthesis behavior and use U3 pressure scenarios as the integration boundary. Do not convert prose synthesis into executable runtime code.
- Keep existing npm/package and Claude Code build/integration checks as regression evidence without adding assertions about Markdown, file contents, package contents, generated text, or structure.

---

## Open Questions

### Resolved During Planning

- AJV is the appropriate executable-schema test boundary and is already available to the repository's tests; no separate runtime validation dependency is required by this plan.
- The existing reviewer-to-synthesis boundary is sufficient for end-to-end verification; no new synthesis runtime or content-integrity gate is needed.

### Deferred to Implementation

- The representative requirements/plan pressure document used for the seven-persona run can be selected during implementation, provided it elicits role-relevant findings and exercises canonical anchors, classes, evidence, and suggested-fix behavior.

---

## Implementation Units

- [x] **U1. Canonical producer contract**

Goal: Make the schema, producer template, and main skill teach exactly the contract that synthesis currently consumes, including anchor meanings, autofix semantics, suggested-fix obligations, and corrected headless wording.

Requirements R-IDs: R1, R2, R3, R4, R5, R6, R8, R13, R14, R19.

Dependencies: None. U1 establishes the executable contract used by behavioral verification.

Files:

- Modify: `skills/document-review/references/findings-schema.json`
- Modify: `skills/document-review/references/subagent-template.md`
- Modify: `skills/document-review/SKILL.md`
- Create/Test: `tests/unit/document-review-findings-schema.test.ts`

Approach:

- Update the schema to integer confidence anchors `0`, `25`, `50`, `75`, `100` and autofix classes `safe_auto`, `gated_auto`, `manual`.
- Align schema and producer guidance with the existing synthesis meanings, evidence requirements, classification test, and suggested-fix obligations.
- Align interactive and headless wording without changing the underlying synthesis lifecycle.
- Compile the real schema with AJV in the focused test and validate representative data objects; do not assert descriptions, Markdown, section names, token presence, or file contents.

Execution note: Use the test-first posture for the executable contract: add failing AJV cases before changing the schema, then make them pass. Do not split this into RED/GREEN microsteps.

Patterns to follow: Compile the real JSON Schema; use representative object fixtures; keep canonical values owned by the schema; avoid a parallel TypeScript or prose-derived contract.

Test scenarios:

- Happy path: a valid report/finding for every confidence anchor and every autofix class is accepted by AJV.
- Failure path: decimal confidence, out-of-set numbers, and legacy `auto` / `present` classes are rejected.
- Failure path: missing schema-required report fields, finding fields, or evidence are rejected.
- Conditionality boundary: test `suggested_fix` only if the schema encodes its conditional requiredness; otherwise leave that obligation to U3 persona behavior verification.

Verification: The real schema compiles, canonical representative objects pass, malformed legacy/decimal objects fail, and no new contract abstraction is introduced.

- [x] **U2. Consumer and presentation convergence**

Goal: Align synthesis guidance and the complete review-output template with existing anchor routing, user-facing buckets, and post-synthesis coverage semantics without changing the lifecycle.

Requirements R-IDs: R9, R10, R11, R12.

Dependencies: U1 establishes the canonical values and executable validation boundary.

Files:

- Modify: `skills/document-review/references/synthesis-and-presentation.md`
- Modify: `skills/document-review/references/review-output-template.md`

Approach:

- Align active synthesis guidance and examples with canonical anchors, strict malformed rejection, canonical classes, and existing fixes/proposed fixes/decisions/FYI routes.
- Bring the output template to full convergence, including its coverage semantics, while preserving the existing synthesis lifecycle.
- Retain historical references only when clearly non-normative and non-misleading.

Execution note: No automated content test is added for U2. Review the two updated assets with human document-review expertise, then rely on U3's real reviewer-to-synthesis pressure verification for behavioral evidence.

Patterns to follow: Treat current synthesis behavior as authoritative; preserve route, deduplication, coverage, retry, contradiction, and section-matching behavior; do not turn guidance into executable code.

Test scenarios:

- Human review confirms the output template communicates the existing canonical anchor routes and user-facing buckets.
- Behavioral follow-through in U3 confirms canonical reviewer findings are consumed by existing synthesis routes.
- Human review confirms no lifecycle redesign is hidden in vocabulary or example alignment.

Verification: The two consumer/presentation assets align with existing behavior, and U3 demonstrates that valid canonical output is not classified malformed.

- [ ] **U3. Persona anchor calibration**

Goal: Replace continuous confidence ranges in all seven document-review personas with shared behavioral anchors and concise role-specific examples, preserving each persona's remit and verifying the live reviewer-to-synthesis path.

Requirements R-IDs: R7, R15, R16, R17, R18.

Dependencies: U1 and U2. U1-U3 must converge before behavioral verification and shipping.

Files:

- Modify: `agents/document-review/coherence-reviewer.md`
- Modify: `agents/document-review/feasibility-reviewer.md`
- Modify: `agents/document-review/product-lens-reviewer.md`
- Modify: `agents/document-review/design-lens-reviewer.md`
- Modify: `agents/document-review/security-lens-reviewer.md`
- Modify: `agents/document-review/scope-guardian-reviewer.md`
- Modify: `agents/document-review/adversarial-document-reviewer.md`

Approach:

- Update each persona's calibration to use shared anchor behavior while retaining role-specific evidence thresholds and suppression boundaries.
- Preserve concise examples and avoid false-precision substitutions.
- Preserve model-free agent frontmatter and all unrelated role/tool behavior.
- After all three units converge, dispatch all seven real reviewers against the representative pressure document, validate each returned JSON report with AJV, and send the canonical reports through existing synthesis.

Execution note: Use writing-skills behavior verification after the content migration. Do not add Markdown tests or ad hoc re-prompts to make malformed outputs pass.

Patterns to follow: Use real persona dispatch with the updated schema/template; validate data behaviorally; allow qualitative personas to remain below the highest anchor absent direct evidence; preserve each persona's remit.

Test scenarios:

- Happy path: all seven reviewers return JSON reports accepted by AJV using only canonical anchors and classes.
- Behavior case: the pressure document elicits role-relevant findings, evidence, and suggested-fix behavior without ad hoc re-prompting or correction.
- Integration case: canonical reports reach synthesis and are routed by existing confidence/autofix behavior rather than classified malformed.
- Role-boundary case: product-lens and scope-guardian outputs do not claim the highest anchor without direct textual or quantitative proof.
- Regression case: existing npm/package and Claude Code build/integration suites remain green; no generated output is committed and source-immutability/build invariants remain unchanged.

Verification: Seven real persona outputs compile against the canonical schema, synthesis consumes them without vocabulary-related malformed classification, and existing delivery regressions remain green.

---

## Behavioral Verification

After U1-U3 converge as one release slice:

- Dispatch all seven document-review personas against one representative requirements or plan document that exercises role-specific findings, multiple confidence anchors, all autofix classes, evidence, and suggested-fix decisions.
- Compile and validate each returned report with the real JSON Schema through AJV. Record failures by behavioral category: invalid confidence, invalid class, missing required field/evidence, or conditional suggested-fix behavior when structurally encoded.
- Pass the canonical reports through the existing synthesis boundary and observe that valid confidence/autofix vocabulary is accepted and routed, not classified malformed.
- Run existing npm/package and Claude Code build/integration suites as regression checks only. Add no assertions about Markdown, file contents, package contents, generated text, file structure, or snapshots.
- Confirm no generated output is committed and existing source-immutability/build invariants remain unchanged.

---

## System-Wide Impact

- Newly dispatched reviewers will be guided toward discrete anchors and canonical autofix classes, allowing valid reports to reach synthesis.
- Synthesis and presentation behavior remains operationally unchanged; only the guidance assets are aligned with that behavior.
- AJV tests validate the executable findings contract without adding a parallel TypeScript model or a prose/file-content gate.
- Real persona pressure verification covers the producer-to-consumer boundary that static prose checks cannot establish.
- Existing npm/package and Claude Code delivery behavior remains covered by existing regression suites, with no new content or structure assertions.
- No generated output, runtime TypeScript behavior, or host behavior changes are introduced.

---

## Risks & Dependencies

| Risk or dependency | Mitigation / verification |
|---|---|
| U1-U3 leave producer guidance and consumer behavior mismatched. | Treat U1-U3 as one release slice; run the seven-persona pressure scenario and synthesis boundary only after all three converge. |
| The schema cannot express suggested-fix conditionality. | Test only structural schema constraints with AJV; verify conditional suggested-fix behavior through real persona output instead of inventing a prose assertion. |
| Persona outputs still use legacy or decimal values. | Validate every real report with AJV and require canonical output without ad hoc re-prompting. |
| U2 example edits accidentally redesign synthesis. | Human review and U3 route outcomes must confirm existing gates, routing, deduplication, coverage, retry, contradiction, and section behavior remain unchanged. |
| The pressure document fails to exercise all role boundaries. | Select a representative requirements/plan document that produces role-relevant findings and covers the required behavioral cases; the exact fixture remains an implementation-time choice. |
| Existing package/plugin regressions are missed. | Keep existing npm/package and Claude Code build/integration suites green as unchanged regression checks. |
| Older or in-flight findings are interpreted as requiring compatibility remapping. | Keep release-unit boundaries explicit; do not mix older dispatch output into newly dispatched reviews and do not add remapping. |

---

## Documentation / Operational Notes

- Keep the updated schema, templates, and persona guidance as the bundled source contract; do not add a second contract representation.
- Record the pressure-scenario verification outcome and AJV behavioral categories in the normal engineering verification record, without adding prose/file-content test machinery.
- Existing package/plugin build documentation remains authoritative for delivery invariants; this change does not add artifact-content inspection.
- No new user-facing workflow documentation is needed beyond correcting the bundled document-review guidance.

---

## Sources & References

- Origin requirements: `docs/brainstorms/2026-07-21-document-review-findings-contract-alignment-requirements.md`
- Issue and triage: `https://github.com/marcusrbrown/systematic/issues/677`
- Canonical schema: `skills/document-review/references/findings-schema.json`
- Producer template: `skills/document-review/references/subagent-template.md`
- Main workflow: `skills/document-review/SKILL.md`
- Synthesis rules: `skills/document-review/references/synthesis-and-presentation.md`
- Review output contract: `skills/document-review/references/review-output-template.md`
- Persona prompts: `agents/document-review/coherence-reviewer.md`, `agents/document-review/feasibility-reviewer.md`, `agents/document-review/product-lens-reviewer.md`, `agents/document-review/design-lens-reviewer.md`, `agents/document-review/security-lens-reviewer.md`, `agents/document-review/scope-guardian-reviewer.md`, `agents/document-review/adversarial-document-reviewer.md`
- Focused executable-schema test seam: `tests/unit/document-review-findings-schema.test.ts`
- Existing package regression test: `tests/unit/package-exports.test.ts`
- Existing Claude Code regression tests: `tests/unit/build-claude-code-plugin.test.ts`, `tests/integration/claude-code.test.ts`
- Packaging manifest: `package.json`
- Claude Code generator: `scripts/build-claude-code-plugin.ts`
- Strict-validation context: `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
