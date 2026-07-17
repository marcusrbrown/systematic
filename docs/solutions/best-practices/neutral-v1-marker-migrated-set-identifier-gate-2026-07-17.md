---
title: neutral-v1 marker + migrated-set identifier gate
date: 2026-07-17
category: best-practices
module: content-integrity
problem_type: best_practice
component: tooling
severity: medium
tags:
  - content-integrity
  - harness-portability
  - bundled-skills
  - gate-discipline
  - lexical-ban
applies_when:
  - Migrating bundled skill prose to harness-neutral capability language
  - Adding a CI gate over a subset of assets marked via frontmatter metadata
  - Designing a lexical (non-semantic) ban with sanctioned exemption zones
---

# neutral-v1 marker + migrated-set identifier gate

## Context

The harness-portability increment (PR #653, v3.1.0) rewrote a migrated set of
bundled skills to neutral capability language: skill bodies must not teach
harness-specific tool syntax (that belongs to the capability profiles inlined
by each harness's bootstrap). The gate enforcing this is content-integrity
check #13 (`scripts/content-integrity.ts`), scoped to skills marked with:

```yaml
metadata:
  harness-portability: neutral-v1
```

## Guidance

- **Marker-only predicate.** A skill is migrated iff `metadata` is a record
  and `metadata['harness-portability'] === 'neutral-v1'` — nothing else
  (`scripts/content-integrity.ts:1208-1213`). This deliberately does NOT
  mirror the runtime `parseMetadata` drop rules (which drop the whole map if
  any value is non-string): the marker's only consumer is this gate, so there
  is no runtime protection to mirror, and requiring all-string siblings would
  let one unrelated `enabled: true` key silently disable the gate. The
  divergence is commented in-gate. (A 4-reviewer P1 in the ce:review round
  caught the original all-string predicate as a bypass.)
- **Bounded lexical vocabulary.** Exactly nine identifier patterns:
  `task(`, `subagent_type`, `todowrite`, `TodoWrite`, `request_user_input`,
  `ask_user`, `AskUserQuestion`, `update_plan`, and backtick-wrapped
  `` `question` `` (`scripts/content-integrity.ts:1135-1169`). Word-boundary
  regexes prevent prose false positives ("task" as an English word passes;
  `task(` fails). The scope is intentionally lexical — paraphrases are not
  detected, and the gate says so in its doc comment (honest-ban rule).
- **Zones, not blanket rules:**
  - Harness profile files (`skills/using-systematic/references/*-profile.md`)
    are fully exempt — they are the designated home for exact syntax.
  - Migrated skill bodies are scanned INCLUDING fenced code blocks — a
    migrated body has no legitimate use for harness syntax, even in examples.
  - The sanctioned interaction idiom line (contains both `in OpenCode` and
    `in Pi`) exempts only the blocking-question identifiers; every other
    banned identifier is still scanned on that line
    (`scripts/content-integrity.ts:1215-1279`). An earlier whole-line skip
    was a bypass (3 reviewers converged on it).
  - Frontmatter `description` and `argument-hint` are scanned too — they
    render into the bootstrap catalog in every harness.
- **Real file line numbers.** Violations add the frontmatter offset so
  reported lines match the file, not the parsed body.

## Why This Matters

A subset-gate keyed off frontmatter is only as strong as its predicate and
its exemptions. The review round demonstrated both failure classes on first
implementation: an over-strict predicate that unrelated metadata could turn
off, and an over-broad exemption that let any identifier ride a sanctioned
line. Keying off the single marker and making exemptions identifier-aware
closes both while keeping the gate honestly lexical.

## When to Apply

- Any future migrated-set expansion (marking more skills `neutral-v1`).
- Any gate that applies stricter rules to a frontmatter-marked subset of
  files: derive the predicate from what the marker's consumer needs, not
  from unrelated parser semantics.
- When adding exemption zones to a lexical ban: exempt the narrowest thing
  (specific identifiers in a specific context), never whole lines or files
  unless the file is the designated syntax home.

## Examples

```ts
// scripts/content-integrity.ts:1208-1213 — marker-only predicate
function isMigratedSkill(data: Record<string, unknown>): boolean {
  const metadata = data.metadata
  if (!isRecord(metadata)) return false
  // This marker is consumed only by this gate; there is no runtime
  // protection to mirror.
  return metadata['harness-portability'] === 'neutral-v1'
}
```

Regression fixtures cover: marker + boolean sibling still scans; every one
of the nine identifiers has a positive body fixture; `` `question` `` on the
sanctioned idiom line passes while `todowrite` on the same line fails;
`task(` in a migrated fence fails; `task(` in a profile fence passes;
`task(` in a migrated `description` fails.

## Related

- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md`
  — check #13 is wired violation-or-nothing per this doc's contract.
- `docs/solutions/best-practices/undecidable-detection-honest-ban-rule-2026-06-04.md`
  — the lexical-ban + honest-scope-statement discipline this gate follows.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`
  — historical contrast: mirror runtime drop rules when the gate protects a
  runtime behavior; this gate deliberately diverges because the marker has
  no runtime consumer.
- `docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md`
  — the bootstrap/profile composition layer this gate protects.
