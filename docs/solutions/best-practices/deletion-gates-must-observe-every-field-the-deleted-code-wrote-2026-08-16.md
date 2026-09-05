---
title: A deletion gate must observe every field the deleted code could write
module: evals/cases/opencode/model-inheritance.json + src/lib/config-handler.ts
date: 2026-08-16
last_updated: 2026-09-05
problem_type: best_practice
component: testing_framework
severity: medium
tags:
  - evals
  - regression-gate
  - deletion-verification
  - assertion-coverage
  - adversarial-review
  - compatibility-corpus
  - byte-identical
applies_when:
  - Building a test whose purpose is to prove deleted behavior stays deleted
  - The deleted mechanism wrote more than one field
  - A gate's headline assertion names one symptom of a broader capability
  - Replacing a heuristic, refinement, or schema post-processor with a rewrite that must preserve its behavior
  - Seeding a compatibility corpus for a byte-identical output check
---

# A deletion gate must observe every field the deleted code could write

## Context

Retiring a mechanism is only half the work. The other half is a gate that fails if someone reintroduces it. That gate is easy to write and easy to write narrowly, because you naturally reach for the field that motivated the deletion.

Systematic removed a table that pinned each bundled agent category to a provider/model pair. A new eval case was built for exactly one purpose, stated in its own commit message: fail if source-owned defaulting returns. It observed whether an agent's emitted config carried a `model` key and what value it held, across all 37 bundled agents and all five categories.

The retired table also set variants:

```ts
{ provider: 'openai',    models: [{ model: 'gpt-5.5', variant: 'high' }] }
{ provider: 'anthropic', models: [{ model: 'claude-opus-4-7', variant: 'max' }] }
```

And `variant` was still a live emitted field — `applyOverlayObjectWithVariantClearing` in `src/lib/config-handler.ts` continued to manage it. So a regression that reintroduced source-owned *variant* pinning without touching `model` would have passed the gate clean. The gate watched half of what the deleted code wrote.

An adversarial reviewer found it. The confirmation was one command:

```bash
grep -c variant scripts/eval-cases/opencode.ts   # 0
```

## Guidance

Before writing the gate, enumerate every field the deleted mechanism could write. Assert on all of them, not on the one that motivated the deletion.

For an absence gate, require absence of the whole set:

```ts
// Narrow: catches the headline case only
expect(agent.model).toBeUndefined()

// Complete: catches any field the retired mechanism controlled
expect(agent.model).toBeUndefined()
expect(agent.variant).toBeUndefined()
```

Two sources make the enumeration cheap and non-speculative:

1. **The deleted code itself.** Read what it assigned, from git if it is already gone. `git show <commit-before-deletion>:<path>` gives you the exact write set.
2. **What still consumes those fields.** If a field survives the deletion with live handling elsewhere, it is reachable, and reachable means a regression can target it.

### Preservation gates need the deleted code's branches, not only its fields

The same rule applies with the sign flipped. An absence gate proves a deleted mechanism stays gone; a preservation gate proves a rewrite still does what the deleted code did. Both are only as complete as the enumeration they are built from, and for a preservation gate the enumeration is the deleted code's **branches**: every condition it checked becomes one input, with the expected output captured from the pre-change build.

The tempting shortcut is to seed the corpus from fixtures that already exist in the test suite. Those fixtures were written to exercise the code that existed, not the behaviors the deleted code enforced, so a corpus built from them reaches the happy path and skips exactly the cases the heuristic was there for. A zero-difference diff against the pre-change build then proves only that the corpus never entered a deleted branch.

The variant-clearing heuristic this doc already names is the case in point. It had three branches:

```ts
// src/lib/config-handler.ts before the routing resolver replaced it
const overlayHasModel = Object.hasOwn(overlay, 'model')
const overlayHasVariant = Object.hasOwn(overlay, 'variant')

if (overlayHasModel && !overlayHasVariant) {
  delete target.variant
  // A more specific model clears a less specific variant.
}
// `model: null` counts as present, so it clears too.
// No model anywhere: nothing to clear; the schema refinement rejects it.
```

The resolver that replaced it was checked against a twelve-entry corpus (entries 001-012) copied from existing fixtures. None of the twelve set a category `variant` and then overrode `model` at the agent level, so the rewrite dropped the first two branches, emitted a category variant alongside an agent model, and passed byte-for-byte. Two corpus rows built from the heuristic's own conditions caught it immediately.

Procedure for a preservation gate:

1. From the recovered source, list each condition it branched on, including the `null` and absent cases it treated specially.
2. Write one corpus input per condition, named after the behavior rather than the fixture it came from. Copied fixtures may widen coverage afterwards but cannot substitute for branch-derived inputs.
3. Capture the expected output by running each input through the pre-change build, and assert on a canonical serialization, not deep equality, so key order and absent-versus-`undefined` drift also fail.

## Why This Matters

A gate's value is entirely in what it would catch. A gate that catches the obvious reintroduction and misses the adjacent one is worse than no gate, because the commit message, the PR, and the next reader all treat it as proof. This one was described as "fails if a source-owned default reappears" — true for `model`, false for `variant`, and nothing in the artifact disclosed the difference.

The failure mode is not carelessness. It is that the field which motivated the deletion crowds out the fields that merely came along with it.

## When to Apply

- Any test written to prove a deletion stays deleted
- Any assertion phrased as an absence, where the thing being absent had more than one observable
- Retiring a config layer, a defaulting mechanism, an injection point, or a middleware that set multiple keys

## Examples

**Enumerating from the deleted source.** The write set is recoverable even after deletion:

```bash
# The last commit before the file was removed
git show 8d61cf4:src/lib/source-model-defaults.ts | grep -E "model:|variant:"
```

**Checking for survivors that make a field reachable:**

```bash
# variant still handled in the config hook → still a regression target
rg 'variant' src/lib/config-handler.ts
```

**The resulting assertion shape.** Inheritance scenarios require both absent; overlay scenarios assert the expected value, so the gate distinguishes "user asked for this variant" from "something pinned it."

**A preservation corpus seeded from the deleted branches.** Each row is one condition the heuristic checked, with output captured from the pre-change build:

| Input | Pre-change output | Rewrite before the corpus rows existed |
|---|---|---|
| `categories.review = {model, variant}` + `agents.x = {model}` | agent model, no variant | agent model **with** the category variant |
| `categories.review = {model, variant}` + `agents.x = {model: null}` | neither | category variant alone |

These live at `tests/fixtures/config-corpus/013-agent-model-clears-category-variant/` and `014-agent-model-null-clears-category-routing/`. The heuristic's third branch, a variant with no model anywhere, is a rejection rather than an output shape, so it is pinned by a loader test instead of a corpus row.

## Related

- [`docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md`](provider-availability-source-defaults-2026-05-12.md) — the mechanism this gate guards, now retired
- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](../workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md) — the other half of trusting a gate: its evidence expires when the pinned runtime moves
- [`docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`](a-perfect-measurement-means-a-broken-instrument-2026-08-16.md) — a zero-difference result is evidence about the corpus before it is evidence about the rewrite
- `tests/fixtures/config-corpus/README.md` — the corpus, its canonical-serialization assertion, and the pre-change reconstruction method
- PR #790 — where the absence-gate gap was found and closed
- PR #903 — where the preservation-gate gap was found and closed
