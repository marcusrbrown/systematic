---
title: Behavior-first AJV contract verification for agent outputs
date: 2026-07-21
category: best-practices
module: document-review-contract
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Aligning a schema, producer guidance, and agent-generated JSON
  - Verifying whether emitted objects are accepted at a producer-consumer boundary
  - Static prompt or artifact assertions would not prove the contract behavior
tags:
  - ajv
  - json-schema
  - agent-contract
  - contract-testing
  - persona-output
  - verification
---

# Behavior-first AJV contract verification for agent outputs

## Context

Issue [#677](https://github.com/marcusrbrown/systematic/issues/677) exposed a contract split in
the document-review workflow. The schema and reviewer guidance still taught continuous confidence
values and legacy autofix classes, while synthesis accepted discrete confidence anchors and newer
classes. A valid-looking reviewer response was therefore dropped as malformed.

The fix in [#679](https://github.com/marcusrbrown/systematic/pull/679) aligned the bundled
guidance, but verification focused on the contract objects rather than the surrounding Markdown.

## Guidance

Treat the schema that consumes agent output as the executable contract.

1. Compile the real schema in a focused test. Do not duplicate its values in a second model.
2. Validate representative accepted and rejected objects:
   - every supported enum or anchor value passes;
   - legacy, out-of-set, and structurally incomplete values fail;
   - empty-but-valid reports remain valid where the contract permits them.
3. Exercise real producers against a pressure scenario after the schema and guidance converge.
   Accept their first response only when the existing consumer accepts the emitted objects; do not
   re-prompt or normalize an invalid response into apparent success.
4. Keep static assertions scoped to what they can actually prove. Prompt wording, file layout, and
   generated text are not substitutes for validating emitted data at the consumer boundary.

Use live producer verification for behavioral obligations the schema cannot express, such as
whether an agent supplies a concrete remediation before assigning an auto-applicable class.

## Why This Matters

Prompt and artifact checks can prove that text changed while leaving the data contract broken. An
agent may still emit an obsolete enum, choose a decimal where only anchors are allowed, or omit a
field that synthesis needs. Compiling the real schema proves acceptance and rejection semantics;
running real producers proves that the guidance produces objects the consumer can use.

This creates a narrow, durable boundary: schema tests protect the executable vocabulary, and
pressure scenarios protect the producer-to-consumer handoff.

## When to Apply

- Multiple agents or templates produce structured output consumed by a schema-aware workflow.
- A defect is caused by producer/consumer disagreement rather than ordinary prose quality.
- The important question is whether emitted objects are accepted, not whether a prompt contains a
  particular phrase.
- A schema has intentional limits that cannot express every behavioral obligation by itself.

## Examples

Compile the shipped schema and validate actual report objects:

```ts
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>
const validate = new Ajv({ strict: false }).compile(schema)

expect(validate(reportWithFinding({ confidence: 75 }))).toBe(true)
expect(validate(reportWithFinding({ confidence: 0.9 }))).toBe(false)
expect(validate(reportWithFinding({ autofix_class: 'auto' }))).toBe(false)
```

Then run the real producers without corrective prompting. In the document-review repair, all seven
personas emitted first-pass reports accepted by the schema, using only the canonical classes. The
existing synthesis boundary accepted those reports instead of classifying them as malformed.

## Related

- [Pin cross-harness adapter contracts at the boundary](cross-harness-adapter-parity-contract-tests-2026-07-14.md) — adapter-level version of testing observable boundary behavior rather than shared implementation details.
- [Build-time codegen for typed config validation: four traps to avoid](typed-config-validation-build-time-codegen-2026-05-16.md) — schema-authoritative validation and producer/consumer drift prevention.
- [Content-integrity gate should mirror runtime drop rules, not check raw YAML](content-integrity-mirror-runtime-drop-rules-2026-05-17.md) — verify the semantics a consumer actually enforces.
- [Issue #677](https://github.com/marcusrbrown/systematic/issues/677) and [PR #679](https://github.com/marcusrbrown/systematic/pull/679).
