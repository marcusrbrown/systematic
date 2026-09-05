---
title: 'fix: Give the review run artifact an executable contract'
type: fix
status: completed
date: 2026-08-21
---

# fix: Give the review run artifact an executable contract

## Overview

`ce:review` writes two kinds of artifact. Per-persona records are validated by the
parent before persistence. The run-level `review-summary.json` is validated by
nothing. The consequence is measurable on disk, and it is the whole problem.

| Path | Files | Distinct shapes | Shapes per file |
| --- | --- | --- | --- |
| Per-persona, parent-validated | 138 | 21 | 0.15 |
| Run-level, unvalidated | 7 | 7 | 1.00 |

111 of 138 per-persona files share one shape. No two run-level artifacts have ever
shared a shape — and the seven are split across two different filenames,
`review-summary.json` and `summary.json`, so even the name drifted.

The two paths are not a clean experiment. Per-persona files are written many per
run, the run-level shape was redesigned twice in the last week, and the per-persona
schema only recently became strict. The measurement establishes a strong
correlation between an unchecked write path and shape divergence; it does not
isolate validation as the sole cause. It is enough to act on and not enough to
claim proof.

This plan gives the run artifact an executable schema, gives the parent a validator
it must invoke rather than instructions it must follow, and reconciles the prose
contract with what will actually be enforced.

## Problem Frame

Issue #793 asked for `schema_version` on ce:review's persisted artifacts, framing
the problem as version drift breaking in-flight reviewers and the historical corpus.
Measurement inverted that premise on both counts.

**There is no producer to version.** The prose contract in
`skills/ce-review/references/synthesis-artifact-contract.md` documents `run_status`,
`dispatches`, `input_findings`, and `disposition_counts`. Across 26 run directories,
`input_findings`, `disposition_counts`, and `run_status` appear in zero artifacts.
`verdict` appears in all four `review-summary.json` files and is absent from the
contract. The sibling `metadata.json` the contract also specifies has never been
written either, though only about four runs postdate its specification, so that
says less than the rest. A version field describes a shape; there is no stable
shape here to describe.

**Version skew is not the failure mode.** The parent inlines the schema into each
persona's dispatch prompt through `{schema}` in
`skills/ce-review/references/subagent-template.md`, then validates returns against
that same bundled file. Producer and consumer are one version by construction within
a run. The reachable failure is a model ignoring the contract, which a version field
cannot detect — a noncompliant model will happily echo whatever version string the
prompt showed it.

The real defect is an unchecked write path. Everything the parent validates
converges; everything it does not validate diverges. Versioning is the last step of
this work, not the first.

## Requirements Trace

- R1. `review-summary.json` has an executable schema that a machine can validate a
  real artifact against, with Zod as its source of truth and a generated JSON
  Schema for consumers that need that format.
- R2. Any written artifact can be checked against that schema by the
  `systematic validate-review-artifact <path>` command the contract requires the
  parent to run, and which a human or CI can run independently of the parent.
- R3. The `input_findings` ledger is machine-parseable without shape inference,
  including rejected-payload summary rows.
- R4. The persisted artifact carries a version discriminator.
- R5. The prose contract describes the shape that is actually enforced, in one
  canonical location.
- R6. The historical corpus is excluded from quantitative analysis by explicit
  statement, with no v1 parser written.

## Scope Boundaries

- No change to `findings-schema.json`'s per-persona definitions. That contract works;
  the measurement above is its evidence.
- No change to reviewer persona behavior, selection, dispatch, or the synthesis
  algorithm.
- No backfill, migration, or repair of existing artifacts under
  `.context/systematic/ce-review/`.
- No runtime dependency added. Validation runs on the existing runtime `zod`
  dependency; AJV stays a dev dependency.

### Deferred to Separate Tasks

- Defining surface coverage deterministically for the risk-aware degraded verdict:
  issue #819.
- Fingerprint dedup missing duplicate findings in prose files: issue #820.
- Applying the same run-level validation to `document-review`, which has the same
  structural gap: future iteration once this pattern proves out.
- Consolidating `metadata.json` into the run artifact is deferred to its own issue.
  The evidence is weaker than it first appeared because most runs predate the
  specification, and the change would need to prove it preserves dispatch-time
  capture semantics for `branch` and `head_sha` rather than capturing them at
  finalize time.

## Context & Research

### Relevant Code and Patterns

- `skills/ce-review/references/findings-schema.json` — 338 lines, 11.4 KB. Root
  `$ref` is `#/definitions/parentRecord`. Defines `subAgentReturn` and
  `parentRecord`, both per-persona. Inlined verbatim into every persona prompt.
- `skills/ce-review/references/synthesis-artifact-contract.md` — canonical prose
  contract. Run-level shape at lines 30-94, ledger semantics at 96-135, metadata at
  137-143.
- `skills/ce-review/SKILL.md` — write instruction at lines 703-719. Restates the
  artifact lifecycle and specifies `metadata.json`.
- `skills/ce-review/references/review-output-template.md` lines 145-160 — restates
  artifact existence and linkage.
- `tests/unit/ce-review-findings-schema.test.ts` — 26 tests. Loads the real schema
  from disk, compiles with AJV `{strict: false}`, compiles a second validator against
  `#/definitions/subAgentReturn`. Fixture helpers `artifactWithFinding()` and
  `subAgentWithFinding()`; error helpers `errorMentions()`, `hasKeyword()`,
  `hasAdditionalProperty()`. This is the structural template to follow.
- `skills/document-review/references/findings-schema.json` — precedent that a skill
  ships its own schema file, included independently via `@./references/`.
- `scripts/generate-config-schema.ts` and `scripts/build-registry.ts` — existing
  precedent for generating a committed JSON Schema from a Zod source of truth,
  with a `--check` drift gate and a `bun run` entry.
- `docs/public/schemas/v3/systematic-config.schema.json` — committed generated
  JSON Schema artifact produced by the config-schema generator.
- `src/lib/config-schema.ts` — Zod source of truth for the config schema,
  including `SystematicConfigSchema` at line 530.
- `src/cli.ts` — existing subcommand dispatch for `capabilities` and
  `pi-subagents`; the artifact validator follows this dispatch surface.

### Institutional Learnings

- `docs/solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md`
  — this repository already tried to enforce a contract through agent-facing
  instructions and a validating tool the sub-agent could decline to call. It failed.
  The fix was architectural: delete the sub-agent write path, return data inline, let
  the parent validate and persist. **Directly constrains this plan.** "Make the parent
  validate at the write boundary" is the same mistake one level up, because the parent
  is also an agent. Enforcement must be something invoked, whose failure is visible,
  not something the agent is asked to perform internally.
- `docs/solutions/best-practices/behavior-first-ajv-contract-verification-2026-07-21.md`
  — issue #677 / PR #679. Prose guidance and consumer schema diverged and valid output
  was dropped as malformed. The lesson: the schema that consumes agent output is the
  executable contract, and it must be verified by compiling the real schema and
  validating real emitted objects, not fixtures alone.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`
  — a CI gate that validates a prettier subset than the runtime accepts is worse than
  no gate. The validator here must model what the contract actually requires.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`
  — generated surfaces drift silently when bundled content changes. Adding a reference
  file to a skill updates the registry's per-component file list.
- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
  — generator self-reads can observe stale ESM-cached output, and drift checks misfire
  when their producer options differ from the write path. Both lessons apply directly
  to the generated review-artifact schema and its drift gate.
- No learning exists on prompt-token cost of schema size. That reasoning is original
  to this plan and rests on the measured 11.4 KB figure.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "skills/ce-review and tests/unit/ce-review-findings-schema.test.ts",
  "freshness": {
    "vcs_reference": "b562a69cd4753f2d327b1f3e9b9f38fdff0ad903"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": true
  },
  "candidates": [
    {
      "path_or_symbol": "skills/ce-review/references/findings-schema.json",
      "description": "Executable JSON Schema for sub-agent returns and parent-persisted per-persona records; its root dispatches to parentRecord.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/ce-review/references/synthesis-artifact-contract.md",
      "description": "Canonical prose contract for parent-owned review-summary.json lifecycle, dispatches, input_findings ledger, synthesized findings, and disposition_counts.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "tests/unit/ce-review-findings-schema.test.ts",
      "description": "AJV regression suite that compiles the real ce-review findings schema and validates parent and sub-agent fixtures.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "skills/document-review/references/findings-schema.json",
      "description": "Separate bundled skill schema for document-review persona returns; it establishes a second schema-file precedent but does not define run-level artifacts.",
      "disposition": "insufficient",
      "insufficiency_reason": "It covers a different producer contract and has no parent-owned run-level artifact shape."
    },
    {
      "path_or_symbol": "docs/plans/2026-08-16-002-refactor-review-artifact-contract-plan.md",
      "description": "Prior ce-review contract plan covering parent-owned persistence and persona findings validation, while explicitly leaving emitted-artifact conformance outside its AJV test.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "docs/plans/2026-07-21-001-fix-document-review-findings-contract-plan.md",
      "description": "Completed document-review producer/consumer vocabulary alignment using AJV schema tests and real persona verification.",
      "disposition": "insufficient",
      "insufficiency_reason": "Its validation target is the document-review findings contract, not ce-review's heterogeneous run artifact."
    }
  ],
  "excluded_scopes": [
    {
      "scope": "src/",
      "reason": "The concern is implemented as bundled skill prose and test-time schema validation; no runtime artifact writer or validator exists there."
    }
  ]
}
```

The 2026-08-16 plan committed to parent-owned persistence and per-persona schema
coverage, and explicitly recorded that its AJV test validates the schema contract
rather than emitted artifact conformance. That gap is what this plan closes. It is an
extension of unfinished scope, not a repeat of dropped work.

## Key Technical Decisions

- **Zod is the source of truth, with a separate generated schema artifact.** Zod
  4.4.3 is already a runtime dependency, so this adds zero dependencies. The
  runtime validator ships in `dist/`, and the generated JSON Schema ships in
  `skills/`, whereas `scripts/` does not ship to consumers. This follows the
  established `SystematicConfigSchema` and `scripts/generate-config-schema.ts`
  pattern. Shared vocabulary is composed from one set of Zod schemas rather
  than copied between files, removing the duplicated-vocabulary drift risk of
  the earlier JSON-Schema-first design. The run-level schema remains a
  separate artifact because `findings-schema.json` is 11.4 KB and is inlined
  into every persona dispatch prompt; a typical run dispatches around ten
  personas, while run-level definitions are parent-only. The generated
  `review-summary-schema.json` is deliberately not added to any
  `@./references/` include directive in `SKILL.md`, so it costs zero dispatch
  tokens. This supersedes the earlier decision about which file should contain
  the schema.

- **The parent invokes a validator; it does not act as one.** The
  `systematic validate-review-artifact <path>` subcommand validates a written
  artifact and exits nonzero on failure. The contract requires the parent to
  run it before finalizing. This is the architectural lesson from the
  cross-harness divergence learning: an agent asked to validate its own output
  can skip the step silently, but an invoked command that fails produces
  evidence. This improves observability rather than guaranteeing execution: a
  parent that never runs the command produces no evidence in either direction.
  The durable value is that the validator is independently runnable, so a
  human, a CI job, or a later audit can check any artifact without the
  producing agent's cooperation. It does not close the enforcement gap.

- **`schema_version: 1` from birth.** Versioning normally carries a migration burden,
  which is why #793's original framing felt heavy. Here there is no conforming corpus
  to migrate — zero artifacts match the documented shape. Stamping version 1 onto a
  schema at the moment it is created is free, and it means the next change to this
  contract has a discriminator to bump. This satisfies R4 without the compatibility
  window the issue originally requested.

- **`input_findings` rows carry an explicit `record_type` discriminator.** After PR
  #818, the ledger holds admitted rows carrying `input_id` and rejected-summary rows
  carrying `rejected_finding_count` and `rejected_severities`. A schema can express
  that as a discriminated union, but not as shape inference. This was a P1 in #818's
  review, routed here.

- **The prose contract keeps the semantics; the schema takes the shape.** The schema
  cannot express reconciliation arithmetic or the risk-aware verdict rule, so the
  contract file remains canonical for those. It stops restating field lists that the
  schema now owns, so the two cannot disagree.

**Landing order:** The unit that adds the CLI subcommand must land in the same release
as, or before, the unit that adds the contract and skill prose requiring it. Prose that
names a command must never ship ahead of the command. Until the subcommand is
published, the contract must not instruct the parent to run it. Because this plan
modifies `ce:review` itself, each unit must leave the repository in a state where
`ce:review` still runs; this is an explicit sequencing constraint.

## Open Questions

### Resolved During Planning

- Extend the existing schema or add a new file: new file, on measured prompt cost.
- Does `schema_version` belong in this pass: yes, because there is no migration cost
  at creation time.
- Is the ledger discriminator in scope: yes, a schema cannot describe the array
  without it.
- Keep or drop `metadata.json`: defer consolidation to a separate issue until the
  evidence and dispatch-time capture semantics are established.
- What is the schema source of truth: a Zod schema in
  `src/lib/review-artifact-schema.ts`, with JSON Schema generated from it.
- Where should the generated schema and runtime validator ship: the generated
  schema is committed at `skills/ce-review/references/review-summary-schema.json`,
  and validation is a `dist/`-shipped CLI subcommand. Neither depends on a
  `scripts/` file at consumer runtime.
- Should the generated schema be included in `SKILL.md`: no. It is deliberately
  excluded from every `@./references/` include directive, so it is linkable
  contract material without dispatch-token cost.
- How should shared vocabulary be kept consistent: define it once as Zod schemas
  and compose it into the artifact schema, rather than copying definitions.
- How should unknown top-level keys be handled: reject them with strict Zod
  objects, preserving the contract's closed-shape behavior.
- How should validation errors avoid echoing findings: project each Zod issue to an
  allowlist containing exactly `path` and `code`, and emit nothing else from the issue.

### Deferred to Implementation

- Exact `run_status` enum membership beyond the four documented values, pending the
  same evidence.
- What happens when a review run begins under one contract version and finishes under
  another. Contract content is read once at dispatch, so this is not reachable within
  a single run. The case worth defining is a validator from one installed version
  meeting an artifact written by another; the version discriminator makes that case
  detectable, and the response is decided when a second version exists.

## Implementation Units

- [x] **Unit 1: Define the Zod source of truth for the run-level artifact**

**Goal:** A Zod source schema defining `review-summary.json`, including the
discriminated ledger and a version discriminator, from which the committed JSON
Schema is generated.

**Requirements:** R1, R3, R4

**Dependencies:** None

**Files:**
- Create: `src/lib/review-artifact-schema.ts`
- Create: `skills/ce-review/references/review-summary-schema.json`
- Test: `tests/unit/review-artifact-schema.test.ts`

**Approach:**
- Define the run-level shape documented in `synthesis-artifact-contract.md` lines
  30-94, plus `verdict` and `schema_version` as the literal `1`.
- Define `input_findings` as a Zod discriminated union on `record_type`, with
  `"admitted"` requiring `input_id` and an admitted disposition, and
  `"rejected_summary"` requiring `rejected_finding_count` and
  `rejected_severities`. The discriminator makes the heterogeneous ledger
  machine-parseable without shape inference.
- Define the shared dispatch outcome, disposition, harness, and repo-relative
  path vocabulary once as Zod schemas and compose them into the artifact
  schema. Composition replaces copy-paste and removes the duplicated-vocabulary
  drift risk carried by the earlier JSON-Schema-first design.
- Use strict Zod objects so unknown fields are rejected. Give every
  user-influenced string an explicit maximum length and every array an explicit
  maximum item count, mirroring the per-persona evidence caps. An unbounded
  persisted artifact can grow without limit and retain more quoted source than
  necessary.
- Generate JSON Schema from the Zod source and commit it at
  `skills/ce-review/references/review-summary-schema.json`. Do not add it to any
  `@./references/` include directive in `SKILL.md`; it is shipped with
  `skills/` for linking and inspection, but is never inlined into a persona
  prompt and costs zero dispatch tokens. This supersedes the earlier decision
  about which file should contain the schema.

**Patterns to follow:**
- `src/lib/config-schema.ts` and `scripts/generate-config-schema.ts` for the Zod
  source-of-truth and generated JSON Schema pattern.
- `skills/ce-review/references/findings-schema.json` for bounded-string and
  bounded-array conventions.

**Test scenarios:**
- Happy path: a fully populated artifact with both ledger row types is accepted
  by the Zod source.
- Happy path: an artifact with an empty `input_findings` array is accepted.
- Edge case: a `rejected_summary` row with `rejected_finding_count: 0` is
  rejected, since a rejection summary with nothing rejected is meaningless.
- Edge case: `rejected_severities` length disagreeing with
  `rejected_finding_count` is rejected.
- Error path: an admitted row carrying `rejected_finding_count` is rejected by
  the strict object.
- Error path: a row with no `record_type` is rejected by the discriminated
  union.
- Error path: `schema_version: 2` is rejected against the literal `1`.
- Error path: a missing `verdict` is rejected.
- Error path: an unknown top-level key is rejected by the strict object.
- Error path: a string field exceeding its bound is rejected.
- Integration: committed fixtures capture the distinct historical shapes in the
  repository's normal test-data location, and each fails the Zod source with a
  named reason. These fixtures pin the measured non-conformance without
  depending on gitignored local state.
- Integration: a hand-written conforming fixture is accepted, proving the Zod
  source accepts a valid artifact and is not vacuously strict.
- Integration: the committed JSON Schema matches the JSON Schema produced from
  the Zod source, so the generated artifact cannot drift from its source.

**Verification:**
- The Zod source parses valid fixtures and rejects invalid fixtures with named
  paths and issue codes.
- The committed JSON Schema is valid generated output from the Zod source.
- Every scenario above has a test and the suite passes.
- The historical fixtures are a snapshot of pre-contract shapes and are never
  updated to conform; they document what the contract rejects.

- [x] **Unit 2: Generate the committed artifact schema and add its drift gate**

**Goal:** A generator and CI drift gate that keep the committed JSON Schema in
lockstep with the Unit 1 Zod source.

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/generate-review-artifact-schema.ts`
- Modify: `package.json`
- Modify: `.github/workflows/main.yaml`
- Test: `tests/unit/generate-review-artifact-schema.test.ts`

**Approach:**
- Follow `scripts/generate-config-schema.ts`: import the Unit 1 Zod source, call
  `z.toJSONSchema()`, format the result, and write
  `skills/ce-review/references/review-summary-schema.json`.
- Require the `--check` path and the write path to derive their options from one
  shared helper rather than assembling them independently. The generator must not
  read its own output through a static import, because ESM module caches can retain
  stale content after a write.
- Support `--check` to compare generated output with the committed artifact and
  exit nonzero on drift. The normal mode regenerates the committed artifact.
- Add `review-schema:generate` and `review-schema:drift` package scripts,
  following the existing `schema:generate` and `schema:drift` naming.
- Add a CI drift-gate step alongside the existing registry and config-schema
  drift checks.

**Patterns to follow:**
- `scripts/generate-config-schema.ts` for generator structure, `--check` drift
  detection, formatting, and output comparison.

**Test scenarios:**
- Happy path: generation produces the committed schema at the declared path.
- Happy path: `--check` exits 0 when the committed schema matches the Zod source.
- Error path: `--check` exits nonzero and names the committed schema when the
  generated output has drifted.
- Integration: running the generator twice in succession produces no drift on the
  second `--check`, proving the write and check paths agree.
- Integration: the CI workflow invokes the drift gate alongside the existing
  schema and registry gates.

**Verification:**
- Generation and `--check` both pass, and the committed file is the only output
  modified by the generator.

- [x] **Unit 3: Expose artifact validation through the CLI**

**Goal:** `systematic validate-review-artifact <path>` validates a written
artifact with the Unit 1 Zod source and exposes distinct failure statuses to
every shipped consumer.

**Requirements:** R2

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/unit/validate-review-artifact.test.ts`

**Approach:**
- Add `validate-review-artifact <path>` to the existing subcommand switch in
  `src/cli.ts`; the command ships in `dist/` and therefore reaches OpenCode,
  Pi, and Claude Code consumers. Validate with the Unit 1 Zod schema directly.
- Require an artifact path argument. Invoking the command without a path is an
  operational failure with exit 2 and a usage message; it never guesses a target.
- Bound path resolution: canonicalize the supplied target with `realpath`, require
  it to remain inside `.context/systematic/ce-review/`, and reject symlinks,
  parent-directory traversal, and non-regular-file targets before opening the file.
  A path that escapes that root is an operational failure, not a validation failure.
- Print each validation error using its JSON path and issue code, one per line,
  then a summary count. Exit 0 on success, 1 on validation failure, 2 on
  operational failure such as a missing or unreadable file, and 3 for a legacy
  artifact without a `schema_version` field. An artifact without
  `schema_version` is outside the contract and is reported as legacy, not as a
  validation failure.
- Never print artifact content in error output. Project each Zod issue to an
  allowlist of exactly `path` and `code`, and emit nothing else from the issue.
  Never print `message`, `expected`, `received`, `origin`, `maximum`, `keys`, or
  `input`. Never enable `reportInput`. This is an implementation requirement,
  not a property of the Zod library or an automatic guarantee. It resolves the
  security concern that AJV error objects can carry `data` and `params`.

**Patterns to follow:**
- `src/cli.ts`'s `capabilities` and `pi-subagents` subcommand dispatch.
- `src/lib/review-artifact-schema.ts` for direct Zod validation.

**Test scenarios:**
- Happy path: a conforming artifact fixture exits 0.
- Error path: a nonconforming fixture exits 1 and names the offending JSON
  path.
- Error path: a missing file exits 2, distinctly from a validation failure.
- Error path: malformed JSON exits 2 with a parse error, not a stack trace.
- Error path: a symlink pointing outside `.context/systematic/ce-review/` is
  rejected before the file is read.
- Error path: a path argument containing parent-directory traversal that
  escapes the artifact root is rejected as an operational failure rather than
  validated.
- Error path: an artifact lacking `schema_version` exits 3 with the legacy
  status and is not reported as a validation failure.
- Error path: invoking the command with no path exits 2 with a usage message
  rather than guessing a target.
- Integration: a validation failure on a field containing a distinctive string
  emits neither that string nor any Zod-supplied descriptive message; each issue
  emits only its JSON path and issue code.

**Verification:**
- All scenarios pass.
- Running the CLI against a real artifact under `.context/` reports the
  specific non-conformances rather than a generic failure.

- [x] **Unit 4: Require the parent to run the validator**

**Goal:** The contract makes running the validator a condition of finalizing a run,
and the failure path is defined.

**Requirements:** R2, R4, R5

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/ce-review/references/synthesis-artifact-contract.md`
- Modify: `skills/ce-review/SKILL.md`

**Approach:**
- In the contract, add a validation section stating that after writing
  `review-summary.json` the parent runs `systematic validate-review-artifact
  <path>`, and that a nonzero exit means the run is not complete.
- In the same change, instruct the parent to write `schema_version: 1` into the
  artifact. The parent must emit the version field before the validator can report
  anything other than legacy.
- Define the failure path explicitly: on validation failure the parent repairs the
  artifact and re-runs the validator. It does not report a verdict over an artifact
  that failed validation, and it does not delete the artifact to escape the check —
  a failing artifact is evidence and stays on disk.
- In `SKILL.md` Stage 6 step 4, add the validator invocation to the write
  instruction as a pointer to the contract, consistent with the linking discipline
  established in PR #818.
- Note honestly in the contract that this is enforcement by visible failure rather
  than by containment: an agent that never runs the command produces no evidence
  either way, which is exactly why the command exists and why its output belongs in
  the run record.

**Patterns to follow:**
- `SKILL.md` Stage 6 item 12's pointer to the contract, added in PR #818 — link,
  never restate.

**Test scenarios:**
- Test expectation: none — instruction prose with no executable surface. Unit 3 owns
  the executable behavior this prose points at.

**Verification:**
- `bun scripts/content-integrity.ts` clean.
- The contract states the validator requirement exactly once, and `SKILL.md` links
  rather than restates it.
- The first review run after this lands produces an artifact carrying
  `schema_version: 1`, and the validator reports on it rather than classifying it as
  legacy.

- [x] **Unit 5: Record the corpus exclusion**

**Goal:** State that only versioned artifacts are machine-readable, so the historical
corpus is excluded rather than silently mistrusted.

**Requirements:** R6

**Dependencies:** Unit 3

**Files:**
- Modify: `skills/ce-review/references/synthesis-artifact-contract.md`

**Approach:**
- State that artifacts without `schema_version` predate this contract and are
  excluded from quantitative analysis, and that no legacy reader will be written.
  This prose exclusion is backed by the validator's exit 3 legacy status rather than
  standing alone.
- Include the measurement that justifies it: 7 synthesis artifacts across 26 runs,
  written under two different filenames, no two sharing a shape. The number is the
  argument — a parser would need seven special cases to recover data that still
  could not answer cross-reviewer agreement questions, because 19 of the 26 runs
  have no synthesis artifact to reconcile against at all.
- Keep it short. This is a decision record, not an essay.

**Test scenarios:**
- Test expectation: none — decision record in prose.

**Verification:**
- `bun scripts/content-integrity.ts` clean.
- The statement is specific enough that a future reader does not re-litigate it.

## System-Wide Impact

- **Interaction graph:** `ce:review` runs in `mode:headless` inside `ce:work`, `lfg`,
  and `slfg`. Those callers read the text envelope, not the artifact, so the schema
  change does not reach them. The CLI validator adds one command to the run's tail.
- **Error propagation:** A validation failure must surface as an incomplete run, not
  a swallowed warning. Unit 4 defines the path.
- **State lifecycle risks:** A failing artifact stays on disk deliberately. Deleting
  it to pass the check would recreate the "absent artifact means clean run" inference
  the contract already forbids.
- **API surface parity:** `document-review` has the same run-level gap. Deferred, but
  this plan's pattern should transfer.
- **Generated surfaces:** Adding a file under a skill's `references/` updates the
  registry's per-component file list. This applies to
  `skills/ce-review/references/review-summary-schema.json`. Run
  `bun scripts/generate-registry.ts` and `bun run registry:drift`. Frontmatter is
  untouched, so the Pi persona fixtures are not affected. The new review-schema
  drift-gate step joins the existing registry and config-schema drift checks in CI.
- **Unchanged invariants:** `findings-schema.json`'s per-persona definitions,
  reviewer dispatch, persona selection, and the synthesis algorithm are unchanged.
  `mode:report-only` remains the no-write exception and therefore also the
  no-validation exception.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Contract prose requires a CLI subcommand that has not landed yet, leaving `ce:review` with a broken intermediate state. | The CLI unit lands in the same release as, or before, the contract and skill-prose unit. Until then, the contract does not instruct the parent to run the command; every unit must leave `ce:review` runnable. |
| The parent skips the validator, making it decorative — the exact failure recorded in the cross-harness divergence learning. | Cannot be fully prevented while the parent is an agent. The invoked command improves observability, but a parent that never runs it produces no evidence in either direction. Reduced by making the command cheap and independently runnable so a human, CI job, or later audit can check any artifact without the agent's cooperation. |
| The schema is written from prose that no producer follows, so the first real run fails validation everywhere. | That is the intended outcome and the point of Unit 1's integration test asserting current non-conformance. The first conforming run is the acceptance criterion for this work. |
| Schema and prose contract drift again, in the opposite direction. | Unit 4 removes the restated field lists so there is one owner per fact: shape in the schema, semantics in the contract. |
| A Zod refinement or transformation is not representable in generated JSON Schema, so the committed artifact under-specifies runtime validation. | The CLI validates directly with Zod, while the generated JSON Schema is checked against the source and the prose contract remains canonical for semantics that JSON Schema cannot express. |

## Documentation / Operational Notes

- `ARCHITECTURE.md` needs no change; the new source module and CLI subcommand
  follow existing runtime patterns.
- Adding a `package.json` script is a contributor-facing change worth a line in
  `AGENTS.md`'s command list.
- Release classification: `fix` scoped to `skill`/`skills` publishes a patch. The
  user-visible change is that reviews now validate their own output.

## Sources & References

- Issue: [#793](https://github.com/marcusrbrown/systematic/issues/793)
- Related issues: [#819](https://github.com/marcusrbrown/systematic/issues/819),
  [#820](https://github.com/marcusrbrown/systematic/issues/820)
- Prior PR: [#818](https://github.com/marcusrbrown/systematic/pull/818), which
  introduced the heterogeneous ledger this plan gives a discriminator
- Prior plans: `docs/plans/2026-08-16-002-refactor-review-artifact-contract-plan.md`,
  `docs/plans/2026-07-21-001-fix-document-review-findings-contract-plan.md`
- Learnings:
  `docs/solutions/integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md`,
  `docs/solutions/best-practices/behavior-first-ajv-contract-verification-2026-07-21.md`,
  `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`,
  `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
