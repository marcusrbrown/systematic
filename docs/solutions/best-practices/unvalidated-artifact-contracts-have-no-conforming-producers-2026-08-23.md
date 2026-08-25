---
title: An artifact contract with no validated write path has no conforming producers
date: 2026-08-23
last_updated: 2026-08-24
category: best-practices
module: ce-review
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - A persisted artifact crosses an agent, process, or package boundary
  - An issue proposes versioning or a compatibility window for a documented contract
  - The producer is a model that can ignore instructions rather than a deterministic writer
  - A validator must reach consumers, not just the development checkout
  - Validation errors could echo user or artifact content
tags:
  - contract-enforcement
  - artifact-validation
  - schema-drift
  - zod
  - codegen
  - agent-boundary
---

# An artifact contract with no validated write path has no conforming producers

## Context

Issue #793 asked for a `schema_version` field on `ce:review`'s persisted artifacts,
plus an in-flight compatibility window, on the premise that version drift breaks
reviewers mid-run and leaves the historical corpus unreadable.

Measuring the artifacts before scoping the work inverted that premise. Across 26 run
directories there were seven synthesis artifacts, written under two different filenames
(`review-summary.json` and `summary.json`), and no two shared a shape. The three ledger
fields the contract documented — `input_findings`, `disposition_counts`, `run_status` —
appeared in zero of them. `verdict`, which the contract never mentioned, appeared in all
four `review-summary.json` files.

The contract had not drifted; it had never been honored. Adding `schema_version` would
have stamped a version onto a shape no producer emitted.

A second measurement, taken inside the same system, pointed at the cause:

| Path | Files | Distinct shapes | Shapes per file |
| --- | --- | --- | --- |
| Per-persona, parent-validated | 138 | 21 | 0.15 |
| Run-level, unvalidated | 7 | 7 | 1.00 |

111 of the 138 per-persona files shared a single shape. No two run-level artifacts
ever shared one. Same repository, same authors, same period.

Treat that as correlation, not proof. The two surfaces differ in cardinality — many
persona files per run against one run-level file — and the run-level shape had been
redesigned shortly before the measurement. The direction is still stark enough to act
on, and the honest framing matters: the evidence supports "validated paths converge"
as a working hypothesis, not as a demonstrated causal law.

## Guidance

### Measure what producers emit before accepting a contract issue's framing

An issue describing a contract problem states a premise. Check it against the artifacts
on disk before scoping any work. Count how many producers exist, how many distinct
shapes they emit, and which documented fields actually appear. That measurement is
cheap and it can invert the entire request — here it turned "add versioning and a
compatibility window" into "there is nothing conforming to version yet."

The same discipline applies to your own evidence. An early claim in this work stated
that "0 of 26 runs wrote `metadata.json`." Twenty of those runs predated the field's
specification and could never have written it. The honest figure was roughly 0 of 4,
which is weak evidence rather than a verdict. Always check that the denominator could
have produced the thing you are counting.

### Verify the failure mode is reachable before designing for it

The issue assumed producer/consumer version skew. Tracing the dispatch path showed it
was unreachable in the ordinary case: the parent inlines
`skills/ce-review/references/findings-schema.json` into every persona prompt through
`{schema}` in `skills/ce-review/references/subagent-template.md`, then validates the
return against that same bundled file. Producer and consumer are the same version by
construction within a run.

The reachable failure was a model ignoring the contract — which a version field cannot
detect, because a noncompliant model will happily echo whatever version string the
prompt showed it. Designing a compatibility window would have addressed a failure that
does not occur while leaving the one that does.

### An agent cannot enforce a contract on itself

This repository already learned that enforcing a contract through agent-facing
instruction text does not work; see
[cross-harness tools frontmatter divergence](../integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md),
where the fix was architectural rather than instructional.

The first version of this plan said "make the parent validate at the write boundary."
That repeats the same mistake one level up, because the parent is also an agent and can
skip its own validation step silently. The shipped design has the parent *invoke* a
command whose failure is visible, rather than perform validation internally.

State the limit honestly rather than implying a guarantee. The shipped contract in
`skills/ce-review/references/synthesis-artifact-contract.md` says:

> This is enforcement by visible failure, not by containment.

An agent that never runs the command produces no evidence in either direction. The
durable value is that the command is independently runnable — a human or a CI job can
check any artifact without the producing agent's cooperation.

That honesty has a sharp edge, found the following day. If an agent *cannot* run the
command, its silence is identical to the silence of an agent that chose not to. The
contract now requires the two to be recorded differently, because "no evidence" is only
an acceptable outcome when running the check was actually possible.

### Packaging determines where a validator can live — and where it can be invoked

A validator in `scripts/` cannot reach a single consumer. `package.json`'s `files`
array ships only `dist`, `skills`, `agents`, and two markdown files. AJV is a
development dependency and is absent at runtime.

Check the publish surface before choosing a home for enforcement code. Here the CLI
ships through `bin` into `dist/`, and `zod` was already a runtime dependency, so
validation went into `src/cli.ts` at zero dependency cost.

The second half of that rule cost a follow-up fix. Placing the validator correctly does
not mean every reader of the contract can run it. Bundled instruction prose is copied
into all three harness packages, but the npm `bin` entry only reaches the ones that install
the npm package — the Claude Code bundle is built deliberately without npm coupling but
ships its own validator executable. A contract sentence naming a command therefore has a
reach the contract file itself does not.

Write the instruction as a condition the agent can check at runtime rather than an
unconditional command, and say what to record when the condition fails. A list of
harness names would go stale; an availability check does not.

### Generate the schema from one runtime source and gate the drift

The repository already had the pattern, in `scripts/generate-config-schema.ts`: a Zod
source of truth, a `z.toJSONSchema()` generator supporting `--check`, a committed
generated schema, and a CI drift gate.

`src/lib/review-artifact-schema.ts` is the source:

```ts
export const ReviewArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: boundedText(MAX_RUN_ID_LENGTH),
    mode: z.enum(['interactive', 'autofix', 'headless'] as const),
    harness: HarnessSchema,
    run_status: z.enum([
```

`scripts/generate-review-artifact-schema.ts` emits the committed artifact from it:

```ts
const result = z.toJSONSchema(ReviewArtifactSchema, getGenerationOptions())
```

One consequence is easy to miss: because the generated schema is a parent-side artifact,
it is never inlined into a persona prompt and costs no dispatch tokens — unlike the
persona findings schema, which is.

Two traps documented in
[typed config validation build-time codegen](typed-config-validation-build-time-codegen-2026-05-16.md)
apply directly: the generator must not read its own previously-written output through a
cached import, and the `--check` path must build its options through the same helper as
the write path. Here both paths call `getGenerationOptions()`, and the checker reads
the committed file from disk.

### Project validation errors to an explicit allowlist

Zod's error output is **not** inherently safe to print. Verified on zod 4.4.3, a
`too_big` issue emits `{origin, code, maximum, inclusive, path, message}` and
`invalid_type` emits `{expected, code, path, message}`; `message` is descriptive prose,
and enabling `reportInput` adds the raw offending input.

An artifact containing review findings may quote source. A no-echo validator therefore
has to project each issue explicitly:

```ts
const authoredMessage =
  issue.code === 'custom' ? `: ${issue.message}` : ''
errorSink(`${issuePath} ${issue.code}${authoredMessage}`)
```

The `custom` exception is narrow and deliberate: custom refinement messages in this
repository are author-written constants containing no artifact data, and without the
exception every cross-field refinement collapses to an undiagnosable `custom`. The
residual risk is that a future refinement written with a template literal would widen
the leak path silently.

### Distinguish "legacy" from "malformed"

Excluding a historical corpus is reasonable. Excusing malformed content as merely old
is not. A code review caught this classifier admitting far more than intended:

```ts
// Wrong: a parsed array, string, or number is reported as legacy
value === null || typeof value !== 'object' || !Object.hasOwn(value, 'schema_version')
```

Legacy means *an object* that predates the contract. Everything else belongs in the
failure path:

```ts
function isLegacyReviewArtifact(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'schema_version')
  )
}
```

Give the exclusion its own exit status so a caller can tell "predates the contract"
from "this is broken" — here exit 3, distinct from 1 for a validation failure and 2 for
an operational failure. That turns a prose decision into an executable one.

## Why This Matters

Versioning an unenforced contract is worse than leaving it alone: the version field
implies a conformance guarantee that nothing checks, and a model will emit
`schema_version: 1` alongside any shape it likes.

The packaging constraint is the kind that wastes a full implementation cycle when found
late. A validator written into `scripts/` passes every local test and reaches no user.

## When to Apply

Apply this when:

- A persisted artifact crosses an agent, process, or package boundary, and its writer
  can ignore instructions — true of every model-backed producer.
- An issue proposes versioning, migration, or a compatibility window for a contract.
  Measure the producers first; the premise may not survive.
- Validation errors could contain user or artifact content.

Do **not** apply it when a deterministic code path is the only writer and a type already
constrains it, or when the mode writes no artifact at all — `mode:report-only` performs
no validation precisely because it persists nothing.

And never read a version field as evidence that a producer complied. It is not.

## Examples

**Before** — the parent is asked to validate its own output:

```text
After writing review-summary.json, validate it against the contract.
```

Nothing observes whether this happened.

**After** — the parent invokes a command whose failure is visible and whose result
belongs in the run record:

```text
1. Write review-summary.json with schema_version: 1.
2. If the systematic executable is on PATH, run
   systematic validate-review-artifact <path>.
   Otherwise record that validation was unavailable, and why.
3. If it fails, repair the artifact and re-run the command.
4. Do not report a verdict over a failing artifact.
5. Keep the failing artifact on disk as evidence.
```

Step 2 carries the availability branch because the instruction reaches harnesses the
executable does not. Unavailable and skipped must not record the same way.

The same shape applies to the schema itself: replace a hand-written JSON Schema kept
beside a runtime schema with one Zod source, a generated committed artifact, and
`--check` in CI, so the two cannot silently diverge.

## Related

- [The same tools frontmatter is permissive on OpenCode and restrictive on Pi](../integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md)
  — the architectural precedent this design follows: do not enforce a contract through
  instructions an agent can decline.
- [Behavior-first AJV contract verification](behavior-first-ajv-contract-verification-2026-07-21.md)
  — prove the producer/consumer boundary with real emissions rather than stated intent.
- [Typed config validation with build-time codegen](typed-config-validation-build-time-codegen-2026-05-16.md)
  — the generator parity and stale-self-read traps that apply to any committed
  generated schema.
- [Content integrity gates should mirror runtime drop rules](content-integrity-mirror-runtime-drop-rules-2026-05-17.md)
  — a gate that checks a prettier subset than the runtime accepts is worse than none.
- Issues: [#793](https://github.com/marcusrbrown/systematic/issues/793) (source),
  [#832](https://github.com/marcusrbrown/systematic/issues/832) (a second contract
  field with no producer), [#834](https://github.com/marcusrbrown/systematic/issues/834)
  (validator placement constraint), delivered in
  [PR #830](https://github.com/marcusrbrown/systematic/pull/830).
