---
title: "fix: Align document-review findings contract"
type: fix
status: active
date: 2026-07-21
origin: docs/brainstorms/2026-07-21-document-review-findings-contract-alignment-requirements.md
---

# fix: Align document-review findings contract

## Overview

Align the shipped document-review contract surfaces to the existing anchor-based synthesis behavior, then extend the content-integrity gate with an explicit, schema-driven drift check. Add representative npm-packed and generated Claude Code sentinels after the source migration is complete.

---

## Problem Frame

Issue #677 is a reproducible producer/consumer contract failure: the shipped schema and producer guidance emit continuous confidence values and `auto` / `present`, while synthesis accepts discrete anchors and `safe_auto` / `gated_auto` / `manual`. The formal dogfood reproduction produced five legacy-shaped findings from three personas, all of which synthesis correctly dropped as malformed. The mismatch also exists in headless wording, persona calibration, and the full review-output example, so correcting only the originally named files would leave shipped guidance contradictory.

---

## Requirements Trace

### Canonical contract and producers

| Requirement | Planned coverage |
|---|---|
| R1 | U1 changes `findings-schema.json` to the canonical integer confidence enum. |
| R2 | U1 changes the schema autofix enum and descriptions to `safe_auto`, `gated_auto`, and `manual`. |
| R3 | U1 records the five anchor meanings in the schema and shared producer guidance. |
| R4 | U1 preserves strict malformed-output rejection with no legacy remapping; tests cover decimal and legacy values. |
| R5 | U1 aligns the subagent template with exact enums, anchor selection, evidence, and the one-clear-fix classification test. |
| R6 | U1 aligns suggested-fix obligations with synthesis: required for `safe_auto` and `gated_auto`, optional for `manual` when no obvious fix exists. |
| R7 | U3 updates all seven persona calibrations to shared anchors while preserving concise role-specific examples and boundaries. |
| R8 | U1 removes active legacy `auto` / `present` assignments from `SKILL.md`, including headless-mode wording, and aligns user-facing terms. |

### Consumer, presentation, and integrity

| Requirement | Planned coverage |
|---|---|
| R9 | U2 inspects transitional and legacy synthesis references, retaining only clearly non-normative historical mentions. |
| R10 | U2 keeps current anchor gates, strict validation, class routing, and user-facing fixes/proposed fixes/decisions/FYI behavior unchanged. |
| R11 | U2 fully converges the review-output example and rules, not just vocabulary. |
| R12 | U2 updates coverage columns and examples to current post-synthesis route semantics without redesigning coverage. |
| R13 | U4 adds a hard guard over an explicit manifest of the schema, skill, templates, synthesis, output template, and seven personas. |
| R14 | U4 drives the guard from parsed schema values and context-aware contract sections rather than globally banning common English words. |
| R15 | U4 reports actionable violations for schema drift, missing canonical guidance, active legacy assignments, and decimal examples. |

### Delivery and carrying cost

| Requirement | Planned coverage |
|---|---|
| R16 | U5 inspects an npm tarball for the shipped skill/reference and persona content, using representative canonical sentinels. |
| R17 | U5 generates and inspects the ephemeral Claude Code bundle for copied references and flattened persona content. |
| R18 | U5 retains source-to-artifact and source-unchanged assertions; the generated bundle remains uncommitted. |
| R19 | U4 extends `scripts/content-integrity.ts` and does not introduce a TypeScript contract or code-generation layer. |

---

## Scope Boundaries

- Included: canonical schema values and descriptions; producer template; main skill and headless wording; synthesis references and examples; review-output template; all seven persona prompts; explicit-surface content-integrity coverage; npm-packed sentinels; generated Claude Code sentinels.
- Included: strict rejection of continuous confidence and `auto | present` output without compatibility remapping. The corrected schema, producer prompts, persona guidance, synthesis, and presentation assets are delivered together as one package/plugin release unit for newly dispatched reviews. Older or in-flight dispatches remain under the contract they were dispatched with and are not mixed into a newly dispatched review; compatibility remapping for their findings is not a target.
- Excluded: synthesis retry policy, contradiction deduplication or recommended-action tie-break redesign, coverage redesign beyond vocabulary alignment, section normalization, runtime behavior changes, tolerant compatibility modes, unrelated content-integrity rules, and a new TypeScript/codegen contract abstraction.
- Excluded: updating a committed generated `dist` or Claude Code copy. Claude Code output remains an ephemeral build artifact.
- Bundled agents remain model-free; no frontmatter `model` changes are part of this work.

### Deferred to Separate Tasks

- Synthesis retry policy and handling for failed or timed-out reviewer dispatches.
- Contradiction handling and deterministic recommended-action tie-break redesign.
- Coverage calculation or attribution redesign beyond aligning the output vocabulary with existing semantics.
- Section normalization or changes to finding fingerprints.

---

## Context & Research

### Relevant Code and Patterns

- `scripts/content-integrity.ts` has a violation-or-nothing enforcement model: checks add result data, are included in the aggregate count, and are printed by the CLI. The new check must follow that hard-gate shape rather than inventing a warning channel.
- `scripts/content-integrity.ts` already provides bounded patterns for allowlist parsing, scan-target collection, migrated-skill identifiers, and banned-pattern checks. The new check should use an explicit contract-surface manifest and section-aware inspection rather than widening the global scan.
- `tests/unit/content-integrity.test.ts` uses isolated fixture repositories, focused check tests, top-level wiring tests, and a real-tree clean assertion. The new seam should preserve those patterns.
- `package.json` lists `skills` and `agents` in `files`, so npm consumers receive those source assets directly.
- `scripts/build-claude-code-plugin.ts` copies skill files, flattens agents, translates only identifiers, and emits an ephemeral self-contained bundle. It does not generate a second findings contract.
- `tests/unit/package-exports.test.ts` already packs the package and verifies tarball entries; its package sentinels can extend that evidence without duplicating the full integrity suite.
- `tests/unit/build-claude-code-plugin.test.ts` already tests generated file maps, flattened agents, and real-repository generation into temporary output. Its unit-level generated-content sentinel is the narrowest Claude Code evidence.
- `tests/integration/claude-code.test.ts` already verifies generated/source fidelity, self-containment, and source immutability in temporary output. No change is needed unless U5's unit generation seam cannot prove a required sentinel; existing integration coverage is otherwise sufficient.
- Bundled agent frontmatter must continue omitting `model`; the existing integrity check and Claude Code flattening behavior are preserved.

### Institutional Learnings

- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`: content-integrity checks are hard violations unless a separate warning system is justified; wire the result, aggregate count, printer, and real-tree assertion together.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`: a gate must mirror the contract it protects instead of checking a weaker or unrelated representation.
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md`: when meaning cannot be inferred safely, use a bounded explicit rule and document its scope rather than guessing from arbitrary prose.
- `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`: inspect emitted and packed artifacts in their delivery shape; a successful build is not artifact evidence.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`: strict contracts should derive from the canonical source and avoid duplicated producer/check inputs; parity between write and check paths matters.

---

## Key Technical Decisions

- Parse `findings-schema.json` at test and gate time. The schema supplies canonical enum values and descriptions; hard-coded values are limited to minimum diagnostic or sentinel expectations needed to detect schema drift itself.
- Maintain an explicit manifest of contract-bearing files and the sections or contexts that carry normative assignments/examples. The guard will permit ordinary English `auto` or `present` outside those contexts and permit a clearly non-normative historical synthesis note.
- Migrate U1-U3 as one content release slice before enabling or shipping U4. Test-first work may leave a temporary red branch while content is being corrected, but no shipped or mergeable state may contain a mixed producer/consumer contract.
- Keep the existing synthesis lifecycle intact. U2 changes misleading live definitions and examples to describe the already-established behavior; it does not redesign routing, deduplication, retries, coverage computation, or section matching.
- Use representative artifact sentinels rather than copying the entire integrity gate into npm or Claude Code outputs. Source-side integrity remains the complete contract check; delivery tests prove that corrected content survives packaging and generation.
- Do not add a TypeScript contract model, generated findings constants, or another code-generation layer. The JSON Schema is the single contract source.

---

## Open Questions

### Resolved During Planning

- The exact validation implementation remains owned by the existing schema/gate seams: the schema is embedded into reviewer prompts and read by synthesis as the contract, while the content-integrity guard parses the schema and checks explicit source surfaces. No runtime validator dependency is assumed by this plan.
- `tests/integration/claude-code.test.ts` requires no change under the current evidence: its existing temporary generated-bundle assertions already cover source fidelity, self-containment, and source immutability; U5 adds only focused unit-generation sentinels.

---

## Implementation Units

- [ ] **U1. Canonical producer contract**

Goal: Make the schema, producer template, and main skill teach exactly the contract that synthesis currently consumes, including anchor meanings, autofix semantics, suggested-fix obligations, and corrected headless wording.

Requirements R-IDs: R1, R2, R3, R4, R5, R6, R8.

Dependencies: None. U1 is the first content slice and establishes the source values used by later checks.

Files:

- Modify: `skills/document-review/references/findings-schema.json`
- Modify: `skills/document-review/references/subagent-template.md`
- Modify: `skills/document-review/SKILL.md`
- Test: `tests/unit/content-integrity.test.ts`

Approach:

- Change the schema to integer confidence anchors `0`, `25`, `50`, `75`, `100` and autofix classes `safe_auto`, `gated_auto`, `manual`.
- Rewrite schema and template descriptions to carry the existing synthesis meanings, including evidence and suggested-fix rules.
- Replace active `auto` / `present` headless assignments and wording in `SKILL.md` with canonical classes and user-facing presentation terms.
- Add focused source-contract assertions in the existing content-integrity test seam where they establish behavior not covered by the later full gate.

Execution note: Use the test-first posture for feature-bearing assertions: add failing canonical/legacy and guidance assertions before changing the content, then make them pass. Do not split this into RED/GREEN microsteps in the plan.

Patterns to follow: Parse structured JSON rather than matching a copied schema string; use isolated fixtures and real-tree assertions from `tests/unit/content-integrity.test.ts`; preserve model-free bundled-agent conventions.

Test scenarios:

- Happy path: all five anchors and all three classes are represented as canonical and accepted by focused contract assertions.
- Failure path: decimal confidence and legacy `auto` / `present` values are rejected as malformed; no remapping is described or asserted.
- Failure path: missing or changed schema enum values fail the contract assertion.
- Happy path: producer guidance contains anchor meanings and canonical classes.
- Failure path: headless producer text contains no active legacy assignment.
- Happy path: `safe_auto` and `gated_auto` guidance requires `suggested_fix`; `manual` guidance permits omission when no obvious fix exists.

Verification: The three live producer surfaces agree with synthesis terminology and semantics; focused assertions fail on the old contract and pass only on the canonical contract. No unrelated files or agent frontmatter are changed.

- [ ] **U2. Consumer and presentation convergence**

Goal: Align synthesis references and the complete review-output template with existing anchor routing, user-facing buckets, and post-synthesis coverage semantics without changing the lifecycle.

Requirements R-IDs: R9, R10, R11, R12.

Dependencies: U1 establishes canonical values and suggested-fix semantics.

Files:

- Modify: `skills/document-review/references/synthesis-and-presentation.md`
- Modify: `skills/document-review/references/review-output-template.md`
- Test: `tests/unit/content-integrity.test.ts`

Approach:

- Inspect transitional references and examples in synthesis, changing active contract instructions while retaining historical rejection notes only where their non-normative context is unmistakable.
- Update the output template's example, summary, applied-fixes language, actionable buckets, FYI section, confidence display, and coverage table/rules to reflect the existing synthesis route semantics.
- Preserve the current anchor gates, class routing, deduplication attribution, residual-count meaning, and presentation ordering.

Execution note: Add failing assertions for canonical examples, route vocabulary, coverage columns, and disallowed active legacy examples before editing the two references; then make the assertions pass. This is content alignment, not a synthesis redesign.

Patterns to follow: Treat synthesis as the consumer source of behavioral truth; distinguish normative assignments from historical prose; use the existing explicit-scope and real-tree test styles rather than a global token ban.

Test scenarios:

- Happy path: synthesis and output-template examples show canonical anchors and fixes/proposed fixes/decisions/FYI sections.
- Happy path: coverage examples and rules account for canonical route classes plus FYI observations and retain current post-synthesis totals.
- Failure path: active legacy assignments or decimal confidence examples fail the focused content-integrity assertions.
- Allowed historical case: the synthesis note explaining that `auto` / `present` are malformed remains accepted when clearly non-normative.
- Failure path: changing a route bucket or removing a canonical presentation term produces a contract-surface diagnostic.

Verification: A reviewer output that conforms to the canonical schema is described as accepted and routed by the same synthesis lifecycle, while the template no longer teaches a competing shape. No retry, contradiction, deduplication, coverage-calculation, or section-normalization behavior changes.

- [ ] **U3. Persona anchor calibration**

Goal: Replace continuous confidence ranges in all seven document-review personas with shared behavioral anchors and concise role-specific examples, without changing each persona's remit.

Requirements R-IDs: R7, R13, R14, R15.

Dependencies: U1 defines the shared anchor meanings; U2 defines the consumer-facing terminology. U3 must complete before U4 is enabled.

Files:

- Modify: `agents/document-review/coherence-reviewer.md`
- Modify: `agents/document-review/feasibility-reviewer.md`
- Modify: `agents/document-review/product-lens-reviewer.md`
- Modify: `agents/document-review/design-lens-reviewer.md`
- Modify: `agents/document-review/security-lens-reviewer.md`
- Modify: `agents/document-review/scope-guardian-reviewer.md`
- Modify: `agents/document-review/adversarial-document-reviewer.md`
- Test: `tests/unit/content-integrity.test.ts`

Approach:

- Update each confidence-calibration section to use the shared anchor behavior while retaining the persona's distinct evidence threshold and suppression boundary.
- Keep examples concise and role-specific; do not mechanically turn `0.80+` into a numeric label that implies false precision.
- Preserve every agent's existing frontmatter, including omission of `model`, and avoid changing role descriptions or tool declarations.

Execution note: Add failing assertions that discover all seven calibration sections, reject decimal threshold prose, and require anchor behavior before changing persona files; then migrate all seven together as the content release slice.

Patterns to follow: Use explicit agent-path enumeration for the seven contract surfaces; preserve the existing model-free bundled-agent invariant; allow qualitative personas to cap below `100` unless direct textual or quantitative evidence supports the highest anchor.

Test scenarios:

- Happy path: all seven calibration sections are found and represent the canonical anchors and behavioral meanings.
- Failure path: any decimal confidence threshold or continuous range in a calibration section is reported.
- Failure path: a persona file regressed to a legacy class assignment or omitted shared anchor behavior is reported.
- Role-boundary case: product-lens and scope-guardian qualitative findings do not claim `100` without direct textual or quantitative proof.
- Portability case: no persona frontmatter gains a `model` field or otherwise changes bundled-agent portability metadata.

Verification: All seven personas emit guidance compatible with U1 and U2, preserve their role boundaries, and pass the explicit-surface checks. No generated agent artifact is edited.

- [ ] **U4. Schema-driven explicit-surface integrity gate**

Goal: Extend `scripts/content-integrity.ts` with a hard, actionable drift guard driven by the parsed schema and an explicit contract-surface manifest, with no global ban on ordinary prose.

Requirements R-IDs: R13, R14, R15, R19.

Dependencies: U1-U3. These three units are one content-migration release slice and must be complete before this gate is enabled or shipped; a partial branch may be temporarily red only during test-first work.

Files:

- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`

Approach:

- Add a structured result category and hard-violation wiring consistent with existing content-integrity checks: collection, aggregate count, diagnostic printing, and real-tree clean verification.
- Parse the findings schema at check time to obtain canonical enum values and anchor descriptions, then inspect an explicit manifest covering the schema, main skill, subagent template, synthesis reference, output template, and all seven persona prompts.
- Associate each manifest entry with bounded normative sections or contexts. Detect missing/changed canonical values and active legacy assignments/examples without treating ordinary English `auto` or `present` elsewhere as contract drift.
- Permit only clearly non-normative historical synthesis mentions, and report missing explicit surfaces or sections as actionable violations.
- Keep the check source-side and independent of package generation; do not introduce a duplicate contract model or codegen output.

Execution note: Add failing fixture and real-tree assertions before wiring the gate into the aggregate result, then make the corrected U1-U3 corpus pass. Keep the test-first posture at the unit level rather than documenting RED/GREEN microsteps.

Patterns to follow: Mirror the existing allowlist/parser and migrated-identifier bounded checks; use explicit scan targets and path manifests; follow the violation-or-nothing rule; prefer parsed schema data over duplicated canonical lists; use context-aware checks instead of global lexical bans.

Test scenarios:

- Happy path: the corrected real corpus produces no contract violations.
- Failure path: schema confidence or autofix enums drift, or a canonical anchor/class is removed from a required surface.
- Failure path: an explicit surface reintroduces `autofix_class: auto`, `autofix_class: present`, or a decimal confidence example.
- Failure path: one persona loses its calibration section or regresses to continuous thresholds.
- Allowed prose case: ordinary English uses of “auto” or “present” outside contract contexts do not fail.
- Allowed historical case: the synthesis historical rejection note is accepted when marked non-normative.
- Failure path: a manifest surface or required section is missing and the diagnostic identifies it.
- Wiring case: the new violation appears in the aggregate result, hard-fails the CLI path, and prints an actionable location.

Verification: The gate fails closed on explicit contract drift, passes the fully migrated source corpus, and leaves unrelated prose and existing integrity categories unchanged. It is not enabled against a mixed U1-U3 corpus.

- [ ] **U5. Delivered-artifact sentinels**

Goal: Prove that the canonical source contract survives npm packing and Claude Code generation using minimal representative sentinels rather than duplicating the full integrity suite in each artifact.

Requirements R-IDs: R16, R17, R18.

Dependencies: U4 must pass against the complete source corpus. The npm and Claude Code delivery paths consume the same corrected `skills/` and `agents/` assets.

Files:

- Modify: `tests/unit/package-exports.test.ts`
- Modify: `tests/unit/build-claude-code-plugin.test.ts`
- Test (no change needed unless unit generation cannot provide the required evidence): `tests/integration/claude-code.test.ts`

Approach:

- Extend the existing npm pack/extract seam to assert that document-review references and all seven persona files are present, with representative schema, template, synthesis/output, main-skill, and persona text sentinels using canonical values and no active legacy assignment or decimal example.
- Extend the generated Claude Code file-map or temporary-output seam to inspect the copied schema/template content and a flattened representative persona agent, while retaining existing namespace and self-containment checks.
- Assert that generation uses source content and does not modify source runtime files; do not add or commit a generated bundle.
- Do not duplicate every source-side contract assertion in artifacts; representative sentinels prove delivery, while U4 proves the complete explicit-surface corpus.

Execution note: Add failing packed and generated-output sentinels before the content migration is considered complete, then make them pass after U1-U4 converge. Use the existing isolated temporary artifact patterns.

Patterns to follow: `tests/unit/package-exports.test.ts` tarball listing and extraction patterns; `tests/unit/build-claude-code-plugin.test.ts` `generatePluginFiles` and temporary output patterns; existing generated namespace and source-immutability assertions. Keep `tests/integration/claude-code.test.ts` unchanged because its current assertions already cover generated fidelity and source immutability, unless the unit seam demonstrably lacks one required sentinel.

Test scenarios:

- Happy path: the npm tarball contains document-review references, all seven personas, and representative canonical schema/template/persona text.
- Failure path: a packed file contains an active legacy assignment or decimal confidence sentinel.
- Happy path: the generated Claude Code bundle contains the corrected schema/template and a flattened representative persona with no active legacy assignment or decimal sentinel.
- Failure path: a generated bundle omits or regresses representative contract content.
- Invariant case: source files remain unchanged after generation and generated output is temporary/uncommitted.
- Regression case: existing namespace, flattening, and self-containment gates remain green.

Verification: Both delivery paths contain the corrected contract as consumed by their target packaging shape; artifact checks remain complementary to, not replacements for, the source-side integrity gate.

---

## System-Wide Impact

- Reviewer producers will emit discrete anchors and canonical autofix classes, allowing newly dispatched reviews to reach synthesis instead of being discarded for schema drift.
- Synthesis and presentation behavior remains operationally unchanged; only misleading producer/consumer documentation and examples are aligned with the existing lifecycle.
- `scripts/content-integrity.ts` gains one hard violation category over a narrow, explicit set of contract surfaces. Its existing scan targets, allowlist behavior, agent portability checks, and unrelated banned-pattern rules remain unchanged.
- npm package contents continue to ship `skills/` and `agents/` directly, now with contract evidence in the packed artifact.
- Claude Code continues to generate an ephemeral self-contained bundle from source, now with representative contract evidence in the generated output.
- No runtime TypeScript or host behavior changes; no committed generated `dist` or Claude Code directory is introduced.

---

## Risks & Dependencies

| Risk or dependency | Mitigation / verification |
|---|---|
| U1-U3 leave one live surface on the legacy contract. | Use the explicit U4 manifest, seven-persona enumeration, and real-tree clean assertion; do not enable U4 until the content slice converges. |
| Context-aware drift detection becomes a global token ban. | Scope checks to named files and normative sections; include ordinary-English and historical-note fixtures that must pass. |
| Schema values become duplicated in gate code and drift independently. | Parse the JSON schema at gate/test time; hard-code only diagnostic or sentinel expectations needed to detect schema changes. |
| The content-integrity check is wired as a non-failing warning. | Follow the existing violation result, aggregate count, printer, and CLI exit model; test each wiring boundary. |
| Output-template edits accidentally change synthesis behavior. | Limit U2 to vocabulary, examples, and documented coverage semantics; explicitly exclude lifecycle redesigns and assert canonical route examples. |
| npm packing omits a reference or persona despite source tests passing. | Inspect the actual tarball and extracted paths in `package-exports.test.ts`; rely on `package.json`'s direct `skills`/`agents` entries. |
| Claude Code generation transforms or drops contract content. | Inspect generated file-map/temp output sentinels and retain existing namespace/self-containment/source-immutability gates. |
| A representative sentinel passes while another source surface drifts. | Keep U4 as the complete source-side gate; U5 is intentionally complementary, not exhaustive. |
| Older or in-flight findings are interpreted as requiring compatibility remapping. | Treat contract versions as release-unit boundaries; do not mix older dispatch output into newly dispatched reviews and do not add remapping. |

---

## Documentation / Operational Notes

- The explicit contract-surface manifest and its scope rationale belong with the content-integrity implementation and tests so future edits have a discoverable drift boundary.
- Diagnostics should identify the repo-relative surface and missing or conflicting contract context, following existing content-integrity diagnostic conventions.
- The package and Claude Code checks should document that they inspect delivered artifacts, not merely source files or build success.
- No new user-facing workflow documentation is needed beyond correcting the bundled document-review sources; the existing synthesis lifecycle remains authoritative.

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
- Gate implementation and tests: `scripts/content-integrity.ts`, `tests/unit/content-integrity.test.ts`
- npm packaging tests: `tests/unit/package-exports.test.ts`
- Claude Code build tests: `tests/unit/build-claude-code-plugin.test.ts`, `tests/integration/claude-code.test.ts`
- Packaging manifest: `package.json`
- Claude Code generator: `scripts/build-claude-code-plugin.ts`
- Institutional learning: `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`
- Institutional learning: `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`
- Institutional learning: `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md`
- Institutional learning: `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`
- Institutional learning: `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
