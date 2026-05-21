---
title: SUBAGENT-STOP prose behavioral probe returned a null result — 0 invocations in both conditions
module: tests/manual (behavioral probes)
date: 2026-05-20
problem_type: best_practice
component: tooling
category: best-practices
severity: low
tags:
  - opencode-plugin
  - behavioral-probe
  - subagent-stop
  - manual-probes
  - prose-control
symptoms: []
root_cause: inconclusive_measurement
resolution_type: documentation
related_components:
  - manual-probes
  - plugin-runtime
---

# SUBAGENT-STOP prose behavioral probe returned a null result — 0 invocations in both conditions

## What I Measured

I ran a two-condition behavioral probe against `opencode/big-pickle` to determine whether the `SUBAGENT-STOP` prose block in the `using-systematic` skill suppresses reflexive `systematic_skill` invocations when the plugin is loaded in a subagent context.

The probe dispatched sessions through `task({ subagent_type: 'systematic-implementer' })` under two conditions:

- **Control**: a neutral, bounded implementation task with no skill-triggering framing in the prompt
- **Treatment**: a prompt that included skill-invocation-triggering language (referencing the 1% rule and asking the agent to consider whether any skill applied before acting)

A counter plugin registered a `tool.execute.before` hook that wrote a JSONL entry for every `systematic_skill` call observed in child sessions. I filtered the JSONL by child session ID to isolate subagent invocations from any top-level orchestrator calls. The probe ran across 8 included sessions total (4 per condition).

## Result

Both conditions produced **0 `systematic_skill` invocations** across all 8 sessions. The JSONL log was non-empty — the hook infrastructure was working correctly after the fix documented in the hook-silent-defect-swallow solution — but no `systematic_skill` entries appeared in either condition.

This is a **null result**, not a FAIL. A null result means the probe cannot distinguish between two explanations:

1. The `SUBAGENT-STOP` prose successfully suppressed invocations that would otherwise have occurred.
2. The behavior never would have occurred regardless of the prose, so there was nothing to suppress.

Both explanations are consistent with 0 invocations in both conditions. The probe design cannot separate them at N=4 per condition.

## What This Means

The null result does not invalidate the prose change. The `SUBAGENT-STOP` block ships for two independent reasons that hold regardless of behavioral effect:

1. **Upstream parity**: the block aligns Systematic's `using-systematic` skill with the instruction-priority framing used in the upstream Compound Engineering Plugin, making the two easier to compare and diff.
2. **Multi-harness instruction-precedence value**: the block provides explicit guidance to any agent runtime that does interpret prose hints as behavioral constraints. Some harnesses (non-OpenCode, future OpenCode versions, or agents with different system-prompt assembly) may respond to it even if the current `systematic-implementer` agent does not.

The prose change is not contingent on the probe passing. It was always a low-cost, low-risk addition. The probe was designed to detect a behavioral effect if one existed — and it found none, which is useful information.

## Why This Happens

`systematic_skill` is an effortful action with no immediate value to a subagent completing a focused, bounded task. Reflexive invocation — the problem the `SUBAGENT-STOP` block was designed to prevent — only manifests when two conditions are both true:

1. The subagent's system prompt includes the `using-systematic` skill content with the 1% rule framing ("even a 1% chance a skill might apply means you MUST invoke the skill").
2. The subagent actively interprets that framing as a pre-task obligation rather than as guidance for the primary orchestrator session.

The `systematic-implementer` agent receives a focused brief from the orchestrator. Its system prompt is assembled from the agent's own markdown config, not from the full `using-systematic` skill content. The 1% rule framing may not be present in the subagent's context at all, which means there is no trigger for the reflexive behavior in the first place. Stronger prose in `using-systematic` cannot suppress a behavior that the subagent's context never activates.

N=4 per condition is also a smoke-probe scale. Detecting a small behavioral shift (e.g., 20% suppression rate) with statistical confidence requires N≥20 per condition. The probe was designed as a quick signal check, not a rigorous behavioral study.

## Prevention and Follow-Up

If behavioral suppression of `systematic_skill` in subagent contexts is a real operational concern, prose is the wrong lever. The right structural intervention is to detect the subagent context at bootstrap time and skip the `using-systematic` skill injection entirely. The `mode: subagent` field in agent config (or an equivalent signal from the OpenCode runtime) would let `getBootstrapContent` return an empty or minimal system prompt for subagent sessions, eliminating the trigger rather than trying to suppress the response.

Concretely:

- **If suppression matters**: add `mode: subagent` detection to `src/lib/bootstrap.ts` and skip bootstrap injection when the flag is set. This is a structural fix that works regardless of how the agent interprets prose.
- **If a future probe is needed**: run N≥20 per condition, use a Treatment prompt that directly includes the `using-systematic` skill content verbatim (to guarantee the trigger is present), and add a RED-gate sanity check before the full run to confirm the hook infrastructure is producing JSONL entries.
- **Do not rely on prose alone** to suppress behaviors that depend on system-prompt assembly. Prose hints are advisory; system-prompt structure is deterministic.

## Related

- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — the probe infrastructure issue that had to be resolved before this probe could produce valid results. The `try/catch` fix and RED-gate sanity pattern documented there are prerequisites for any future behavioral probe that depends on `tool.execute.before` hook side effects.
- `docs/solutions/workflow-issues/risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md` — the planning analog: mitigations identified in a Risks table that are not enumerated in the Unit spec silently drop during subagent implementation. The same structural gap (information present in one layer, absent in the layer the agent actually reads) explains why prose in `using-systematic` may not reach the `systematic-implementer` agent's effective context.
