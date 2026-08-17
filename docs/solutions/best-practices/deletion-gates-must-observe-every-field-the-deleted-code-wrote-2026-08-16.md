---
title: A deletion gate must observe every field the deleted code could write
module: evals/cases/opencode/model-inheritance.json + src/lib/config-handler.ts
date: 2026-08-16
problem_type: best_practice
component: testing_framework
severity: medium
tags:
  - evals
  - regression-gate
  - deletion-verification
  - assertion-coverage
  - adversarial-review
applies_when:
  - Building a test whose purpose is to prove deleted behavior stays deleted
  - The deleted mechanism wrote more than one field
  - A gate's headline assertion names one symptom of a broader capability
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

## Related

- [`docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md`](provider-availability-source-defaults-2026-05-12.md) — the mechanism this gate guards, now retired
- [`docs/solutions/workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md`](../workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md) — the other half of trusting a gate: its evidence expires when the pinned runtime moves
- PR #790 — where the gap was found and closed
