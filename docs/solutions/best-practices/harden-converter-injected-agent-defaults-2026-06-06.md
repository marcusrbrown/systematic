---
title: Harden converter-injected agent defaults before removing the converter
date: 2026-06-06
category: best-practices
module: agent-overlays
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - A runtime path secretly depends on a transform or heuristic that is going away
  - Making a runtime-injected default explicit and source-visible before deleting the inference layer
  - Adding a content-integrity gate that requires an explicit field value
tags:
  - converter-removal
  - agent-overlays
  - content-integrity
  - fill-if-absent
  - explicit-frontmatter
---

# Harden converter-injected agent defaults before removing the converter

## Context

Systematic's v3.0.0 plan removes a CLI converter that the **runtime** config hook still secretly depends on. The converter — and a parallel runtime function — inject defaults into bundled agents at load time. `temperature` was computed for every agent from a name/description regex (`inferBuiltInTemperature`) and the config hook (`applyAgentOverlays`) **unconditionally overwrote** any explicit `temperature:` in agent frontmatter with that inferred value.

Removing the converter (or the inference) without first making the resolved value explicit and source-visible would silently change agent behavior. The same shape applied earlier to agent `mode` (shipped v2.27.0); `temperature` is the second instance (v2.29.0). Both are v3.0.0 converter-removal prerequisites.

## Guidance

Harden each converter-injected default with the same four-step shape:

1. **Derive the resolved value mechanically** from the *actual* runtime function — not by hand, not from the converter's copy. Import the real function, compute the value per agent, and diff against what's on disk.
2. **Write the value explicitly** into each agent's frontmatter.
3. **Change the runtime override to fill-if-absent** — respect an explicit value, fall back to inference only when absent.
4. **Add a content-integrity gate** that requires the explicit value to be present *and usable*.

Two details that are easy to get wrong:

- **Precedence must be preserved:** `user overlay > explicit frontmatter > inferred fallback`. The fill-if-absent change only touches the *seed*; the overlay layer that lets user config override must stay untouched.
- **Use `??`, not `||`.** A legitimate falsy value (e.g. `0`) must survive. `||` would clobber it; `??` only fills `null`/`undefined`.

## Why This Matters

**Zero-behavior-change must be proven mechanically, not assumed.** The safe proof: import the real inference function, derive the expected value for every shipped agent, diff on-disk frontmatter against the derived values, and assert zero mismatches. For temperature this confirmed all 51 agents resolved identically before and after.

**A presence-only gate is a false lock.** A gate that checks only that a field *exists* lets present-but-invalid values through (`temperature: null`, `temperature: "0.3"`, empty `temperature:`). The runtime treats those as absent (its number extractor returns `undefined`) and falls back to inference anyway — so the gate reports "explicit" while the runtime is still inferring. The gate must verify the field is a *usable value* (a finite number), mirroring how the runtime actually consumes it. This exact gap was caught in review for temperature and is the same lesson as mirroring runtime drop rules in the gate.

## When to Apply

- Any time a runtime path secretly depends on a transform or heuristic that is being removed.
- Before deleting any inference/defaulting layer.
- When adding a "require explicit X" content-integrity gate — make it assert the value is usable, not merely present.

## Examples

### Runtime override: unconditional overwrite → fill-if-absent

`src/lib/config-handler.ts` (`applyAgentOverlays`):

```ts
// before — clobbers explicit frontmatter every load
result.temperature = inferBuiltInTemperature(agentInfo.name, result.description)

// after — respect explicit frontmatter, infer only when absent
result.temperature =
  result.temperature ??
  inferBuiltInTemperature(agentInfo.name, result.description)
```

The overlay layer that follows (user category/exact overlays) is left untouched, so a user setting `temperature` in their own config still overrides — preserving `user overlay > explicit frontmatter > inferred fallback`.

### Gate evolution: presence-only → finite-number

`scripts/content-integrity.ts` (`checkAgentTemperature`):

```ts
if (
  !isRecord(parsed.data) ||
  !Object.hasOwn(parsed.data, 'temperature') ||
  typeof parsed.data.temperature !== 'number' ||
  !Number.isFinite(parsed.data.temperature)
) {
  // violation — fails closed on malformed frontmatter too
}
```

Presence-only (`Object.hasOwn` alone) would pass `temperature: null`; the finite-number check closes the bypass.

### Mechanical derivation

Import the real runtime function (`inferBuiltInTemperature` in `src/lib/agent-overlays.ts`), compute each agent's value, and assert the on-disk explicit value matches — proving the hardening is value-preserving before it ships.

## Related

- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — the gate must model runtime behavior; this is the same lesson applied to a different field (the present-but-invalid bypass is a concrete instance of gate/runtime divergence).
- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — overlay precedence and which agent fields are project-tunable; the consolidation anchor if a separate `mode`-hardening doc is later created.
