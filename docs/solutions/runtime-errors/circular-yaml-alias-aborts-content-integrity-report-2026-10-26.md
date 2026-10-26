---
title: JSON.stringify on a parsed frontmatter value aborts the whole content-integrity report
date: 2026-10-26
category: runtime-errors
module: content-integrity
problem_type: runtime_error
component: tooling
symptoms:
  - content-integrity throws instead of reporting violations when a frontmatter value is a YAML anchor that refers to itself
  - one malformed solution doc hides every other violation in the run
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags:
  - yaml
  - frontmatter
  - json-stringify
  - anchors
  - content-integrity
---

# JSON.stringify on a parsed frontmatter value aborts the whole content-integrity report

## Problem

YAML anchors and aliases can make a value that contains itself. `superseded_by: &loop [*loop]` is valid YAML, and it parses to an array whose only element is that same array. The solution-doc checks in `scripts/content-integrity.ts` echoed a bad value into the violation message with `JSON.stringify`, which throws on a circular structure. The throw aborted the whole report instead of reporting the one bad field.

## Symptoms

- Under Bun, the run ends with `JSON.stringify cannot serialize cyclic structures.` and lists no violations. Node reports `Converting circular structure to JSON`.
- Every other violation in the corpus is hidden behind the one malformed doc.

## What Didn't Work

- Wrapping each call site in `try`/`catch` fixes the messages that exist today and leaves the next new message open to the same failure.
- Truncating or escaping the serialized output still serializes first, so it still throws.

## Solution

Two helpers describe a parsed value without recursing into it. Every message that echoes a parsed value whose type is not yet known goes through them (`scripts/content-integrity.ts:1587-1604`):

```ts
function describeYamlValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'number') return 'a number'
  if (typeof value === 'boolean') return 'a boolean'
  return typeof value
}

function describeYamlValue(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value)
    : describeYamlValueType(value)
}
```

Strings are still quoted, with JSON escaping, so an author sees the value they wrote. Every other value is named by its type. The required-field, enum and date messages use `describeYamlValue`. The lifecycle check's not-a-string message for `superseded_by` uses `describeYamlValueType`, because it is only reached for a non-string value (`scripts/content-integrity.ts:1955-1960`).

## Why This Works

The helpers branch on the top-level type and never recurse, so they always finish. A non-string value gets a fixed phrase, and a string, which cannot be cyclic, is quoted in full. For the same reason, the `JSON.stringify(target)` calls that remain in `classifySupersededBy` are safe: they run only after the `typeof target !== 'string'` branch has returned.

## Prevention

- Pass every parsed value whose type is not yet narrowed through `describeYamlValue`. `JSON.stringify` is safe only after a `typeof value === 'string'` check.
- Feed a self-referencing anchor (`&a [*a]` or `&loop [*loop]`) through every check that echoes a value, and assert that the check reports that field and does not throw. `tests/unit/content-integrity.test.ts` does this for the required-field, enum and lifecycle checks.
- Pin the message wording for strings, `null` and mappings, so a later change cannot quietly go back to serializing.

## Related

- `docs/solutions/best-practices/lifecycle-validator-runs-only-in-ci-so-agent-prose-must-enforce-it-2026-10-26.md`: the agent-prose side of the lifecycle rules that `checkSolutionLifecycle` enforces in CI.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`: how the gate reports violations.
