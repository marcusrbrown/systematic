---
title: Content-integrity gate should mirror runtime drop rules, not check raw YAML
module: scripts/content-integrity.ts
date: 2026-05-17
problem_type: best_practice
component: tooling
severity: medium
tags:
  - content-integrity
  - frontmatter-validation
  - skill-loader
  - gate-discipline
  - bundled-skills
applies_when:
  - Adding a new frontmatter field that the runtime parser handles permissively (silent drops on malformed values)
  - Extending content-integrity to validate that bundled assets are usable at runtime
  - Designing a CI gate that checks a subset of fields without modeling the runtime's full validation rules
---

# Content-integrity gate should mirror runtime drop rules, not check raw YAML

## Context

Systematic's runtime skill-frontmatter parser (`src/lib/skills.ts:extractFrontmatter`) is intentionally permissive: it parses YAML, validates each field against the allow-list, and silently drops malformed values rather than throwing. This protects third-party skill consumers from crashes when a user's hand-edited SKILL.md has a malformed sub-field.

The content-integrity gate (`scripts/content-integrity.ts`) runs in CI against bundled skills only (`skills/<name>/SKILL.md`) and enforces stricter contracts that the runtime parser does not.

When adding the new `deprecated: { since, removal, replacement?, reason? }` block (v2.19.0, PR #401), the first gate implementation only required `reason` to be a non-empty string on bundled skills. The runtime parser, in contrast, drops the **entire** `deprecated:` block if `since` or `removal` is missing or non-string — because a deprecation warning without a version reference is meaningless.

This created a silent disconnect: a bundled skill could be authored with `deprecated: { reason: "...some prose..." }` (no `since`, no `removal`), pass the CI gate cleanly, and emit **zero** runtime deprecation warning at all. The author would see a green CI build and assume the deprecation cycle was working. A future contributor adding a deprecated block would hit this trap silently.

Fro Bot's review on PR #401 caught the gap before merge.

## Scope limit (2026-07-17)

This rule applies when the gate protects a **runtime behavior** — the mirror
exists so CI-green implies the runtime effect actually happens. It does NOT
apply when a frontmatter marker's only consumer is the gate itself: check #13
(`harness-portability: neutral-v1`, PR #653) deliberately keys off the single
marker key instead of mirroring `parseMetadata`'s all-string drop rule,
because mirroring would let one unrelated non-string metadata key silently
disable the gate with no runtime signal to compensate. Derive the predicate
from what the marker's consumer needs. See
[neutral-v1 marker + migrated-set identifier gate](neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md).

## Guidance

**When a content-integrity gate validates a field that the runtime parser handles permissively, the gate must enforce the same minimum field set that the runtime requires to NOT silently drop the value. Otherwise the gate gives false confidence — CI passes but the runtime behavior the gate is meant to protect (here: emitting a deprecation warning) doesn't actually happen.**

Concretely: do not check the raw `data['field']` object for the gate-specific sub-field while ignoring whatever sub-fields the runtime requires for the block to survive parsing. Read the runtime parser's drop rules and mirror them at the gate.

Mechanics that made the fix clean:

1. Add a new violation rule alongside the original one (so the message is specific to "missing the runtime-required fields", not conflated with "missing the gate-specific field").
2. Run the runtime-required-field check first; continue to the gate-specific check after. An author with multiple gaps sees all of them in one CI run instead of having to fix them in sequence.
3. Use the existing bundled-skill predicate (here: `isSkillEntryFile`) so the rule scope stays bundled-only — third-party skills retain runtime-permissive behavior.

## Why This Matters

A gate that doesn't match the runtime's invariants is worse than no gate — it actively misleads. The author trusts the green CI and ships frontmatter that the runtime silently ignores. Two failure modes follow:

1. **Silent feature-non-delivery**: The deprecation warning never emits. Users of the deprecated skill never see the migration prompt. The deprecation cycle becomes a no-op.
2. **Compounding drift**: Future contributors copy the working-looking pattern. Each new "deprecated" block is dead code on the runtime side. By the time someone notices, fixing it means auditing every bundled deprecation back to v2.19.0.

The cost of mirroring runtime drop rules at the gate is small: a handful of lines that mirror the runtime's own `typeof === 'string' && .trim() !== ''` check. The cost of not mirroring is dressed-up dead code shipping in production.

## When to Apply

- Whenever a new frontmatter (or config) field is added to a runtime parser that uses **permissive drop-on-malformed** semantics, plan the matching gate rule before merging the runtime change.
- When extending an existing gate, audit the runtime parser for fields it now silently drops. If the gate doesn't catch those, write a regression test that fails the gate against a fixture with the dropped field omitted.
- When reviewing a PR that adds a frontmatter field, ask: "what does the runtime do with a malformed value here? what does the gate do? are they consistent for bundled skills?"

## Examples

### Wrong: gate checks raw YAML, ignores runtime requirements

```ts
function checkDeprecatedReasonForBundled(
  relPath: string,
  data: Record<string, unknown>,
  violations: FrontmatterViolation[],
): void {
  if (!isSkillEntryFile(relPath)) return
  if (!Object.hasOwn(data, 'deprecated')) return
  const deprecated = data['deprecated']
  if (!isRecord(deprecated)) return
  // Only checks reason. Runtime requires since + removal too.
  const reason = deprecated['reason']
  if (typeof reason === 'string' && reason.trim() !== '') return
  violations.push({
    file: relPath,
    rule: 'deprecated-reason-missing',
    field: 'deprecated.reason',
    message: 'Bundled skill deprecated block must include a non-empty reason string.',
    remediation: FRONTMATTER_REMEDIATION,
  })
}
```

A bundled skill with `deprecated: { reason: "Targets Claude Code." }` passes this gate but produces no runtime warning.

### Right: gate mirrors runtime drop rules

```ts
function checkDeprecatedBlockForBundled(
  relPath: string,
  data: Record<string, unknown>,
  violations: FrontmatterViolation[],
): void {
  if (!isSkillEntryFile(relPath)) return
  if (!Object.hasOwn(data, 'deprecated')) return
  const deprecated = data['deprecated']
  if (!isRecord(deprecated)) return

  // Mirror the runtime parser's drop rules (src/lib/skills.ts). The runtime
  // silently drops the entire deprecated block if since or removal is missing
  // or non-string. A bundled skill that passes the gate must produce a runtime
  // warning, so require the same minimum field set here.
  const since = deprecated['since']
  const removal = deprecated['removal']
  const sinceValid = typeof since === 'string' && since.trim() !== ''
  const removalValid = typeof removal === 'string' && removal.trim() !== ''
  if (!sinceValid || !removalValid) {
    const missing: string[] = []
    if (!sinceValid) missing.push('since')
    if (!removalValid) missing.push('removal')
    violations.push({
      file: relPath,
      rule: 'deprecated-missing-required-fields',
      field: `deprecated.${missing.join(', deprecated.')}`,
      message: `Bundled skill deprecated block must include non-empty string fields: ${missing.join(', ')}. Runtime would silently drop this block.`,
      remediation: FRONTMATTER_REMEDIATION,
    })
  }

  // Gate-specific check (reason is required for bundled even though runtime
  // accepts it as optional). Run after the runtime-mirror check so an author
  // with multiple gaps sees both in one pass.
  const reason = deprecated['reason']
  if (typeof reason === 'string' && reason.trim() !== '') return
  violations.push({
    file: relPath,
    rule: 'deprecated-reason-missing',
    field: 'deprecated.reason',
    message: 'Bundled skill deprecated block must include a non-empty reason string.',
    remediation: FRONTMATTER_REMEDIATION,
  })
}
```

The gate now catches both classes of gap. The error message explicitly names "Runtime would silently drop this block" so future authors can connect the gate failure to the runtime behavior.

### Regression test fixture

```ts
test('deprecated block missing since+removal triggers deprecated-missing-required-fields violation', () => {
  const fixture = makeBundledSkill({
    deprecated: { reason: 'Old API no longer supported.' },
  })
  const violations = runGate(fixture)
  expect(violations).toContainEqual(
    expect.objectContaining({ rule: 'deprecated-missing-required-fields' }),
  )
})
```

## Related

- `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md` — adjacent precedent for build-time codegen + runtime validation alignment
- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md` — moderate adjacency on the broader theme of CI catching post-write integrity gaps
- PR #401 — v2.19.0 deprecation surface where this lesson surfaced
