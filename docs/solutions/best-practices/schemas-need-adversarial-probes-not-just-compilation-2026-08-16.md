---
title: Compiling the real schema proves it parses, not that it rejects
date: 2026-08-16
category: best-practices
module: contract-validation
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - "A schema is treated as the write boundary for untrusted or agent-generated data"
  - "A contract claims bounds on size, path shape, or collection length"
  - "Required fields and enums are tested but unknown-field behavior is not"
  - "A document asserts a guarantee the schema is supposed to enforce"
root_cause: missing_validation
tags:
  - json-schema
  - ajv
  - contract-testing
  - adversarial-testing
  - validation
  - agent-output
---

# Compiling the real schema proves it parses, not that it rejects

## Context

A findings schema was written as the enforcement point for untrusted sub-agent output. It had required fields, enums, confidence ranges, a repo-relative path pattern, and explicit bounds on evidence entries. It was covered by a test that compiled the shipped file with AJV and validated representative objects. Every gate passed.

A single adversarial probe showed the enforcement was mostly imaginary:

```js
import Ajv from 'ajv'
import fs from 'node:fs'

const schema = JSON.parse(fs.readFileSync('path/to/schema.json', 'utf8'))
const validate = new Ajv({ strict: false }).compile(schema)

console.log('valid:', validate({
  reviewer: 'probe',
  findings: [{
    title: 't', severity: 'P2', file: 'src/a.ts', line: 1,
    why_it_matters: 'X'.repeat(50000),
    confidence: 0.9,
    evidence: ['/Users/someone/secret/absolute/path.ts'],
    autofix_class: 'manual', owner: 'human',
    requires_verification: false, pre_existing: false,
    EXTRA_INJECTED_FIELD: 'survives',
  }],
  residual_risks: Array(10000).fill('r'),
  testing_gaps: [],
  ROGUE_TOP_LEVEL: 'survives',
}))
```

Output: `valid: true`, no errors. Four distinct violations accepted at once.

The causes were all omissions rather than mistakes. No `additionalProperties: false` on the payload or finding objects, so injected fields passed through. `maxLength` on three strings out of many, so a 50,000-character field was in bounds. No `maxItems` anywhere, so a 10,000-entry array was fine. The repo-relative path pattern applied to `file` alone, so an absolute path travelled inside `evidence[]` untouched.

## Guidance

**Probe the schema with input that should fail.** Compiling the real schema and validating a good fixture proves the schema parses and accepts valid data. It cannot detect a constraint that was never written. Only a payload designed to violate the contract can.

Write the probe from the *claims*, not from the schema. Read what the surrounding documentation promises — bounded evidence, repo-relative paths, no unknown fields — and construct one payload violating each. If the schema accepts it, the claim is false no matter how strict the schema looks.

**Assert which constraint rejected, not merely that validation failed.** A test asserting `valid === false` passes for the wrong reason as easily as the right one.

```ts
expect(validate(payloadWithUnknownField())).toBe(false)
expect(validate.errors?.some((e) => e.keyword === 'additionalProperties')).toBe(true)
```

This caught a real error while fixing the schema above: an early probe rejected its own baseline case because it referenced the wrong schema definition. A bare `toBe(false)` would have reported success.

**Pin the accepting boundary too.** Bounds derived from observed maxima have no headroom by construction. If the cap is 5 entries and 500 characters, assert that exactly 5 and exactly 500 are accepted, not only that 6 and 501 are rejected.

**Separate the shapes that have different authority.** If a producer must not set a field and a consumer must, one schema cannot express both. Split it:

```text
subAgentReturn  — forbids harness, dispatch_outcome, disposition
parentRecord    — requires harness and dispatch_outcome
```

Sharing one permissive schema across both directions means a producer can forge provenance and a persisted record can omit it, with neither caught.

## Why This Matters

A schema that looks strict is worse than an obviously absent one, because it stops people looking. The surrounding documentation asserted "artifact writes are validated at the write boundary; non-conforming artifacts are rejected," and that sentence was false while every test was green.

The failure is asymmetric. Missing constraints never announce themselves — they cause acceptance, and acceptance is indistinguishable from correctness until something malformed reaches disk.

## When to Apply

- The schema is a trust boundary for output from an agent, plugin, or external service.
- Prose anywhere claims the schema enforces something. Every such claim is a probe case.
- A contract is being tightened. The change is only real if a previously accepted payload is now rejected.
- Bounds are derived from a corpus. Observed maxima leave no headroom, so both sides need pinning.

## Examples

**Insufficient:**

```ts
const validate = new Ajv({ strict: false }).compile(realSchema)
expect(validate(validFixture())).toBe(true)
expect(validate(missingRequiredField())).toBe(false)
```

Proves the schema parses and that `required` works. Says nothing about bounds, unknown fields, or path shape.

**Sufficient:**

```ts
// Accepting boundaries — pinned so a later edit cannot silently tighten them
expect(validate(withEvidenceCount(5))).toBe(true)
expect(validate(withEvidenceLength(500))).toBe(true)

// Each claimed constraint, asserted by the keyword that enforces it
for (const [payload, keyword] of [
  [withUnknownTopLevelField(), 'additionalProperties'],
  [withUnknownFindingField(), 'additionalProperties'],
  [withOversizedString(), 'maxLength'],
  [withEvidenceCount(6), 'maxItems'],
  [withAbsolutePathInEvidence(), 'pattern'],
] as const) {
  expect(validate(payload)).toBe(false)
  expect(validate.errors?.some((e) => e.keyword === keyword)).toBe(true)
}
```

## Related

- [`docs/solutions/best-practices/behavior-first-ajv-contract-verification-2026-07-21.md`](behavior-first-ajv-contract-verification-2026-07-21.md) — compile the real schema and test emitted objects at the producer/consumer boundary. This doc is the next step: necessary, but insufficient on its own.
- [`docs/solutions/best-practices/comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md`](comments-and-commit-messages-are-claims-not-evidence-2026-08-16.md) — the same shape one layer up: a written assertion that the code contradicts.
- [`docs/solutions/best-practices/deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md`](deletion-gates-must-observe-every-field-the-deleted-code-wrote-2026-08-16.md) — a gate that observes fewer fields than the contract covers.
