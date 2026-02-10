---
module: Systematic
date: 2026-02-10
problem_type: best_practice
component: tooling
symptoms:
  - "Manual overrides to imported definitions lost on re-sync because tracking was flat string array with no metadata"
  - "Agents editing imported files had no workflow for recording what they changed and why"
  - "Re-sync workflow had no conflict detection when upstream changes overlap with local overrides"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: medium
tags: [sync-manifest, manual-overrides, agent-workflow, conflict-detection, re-sync, convert-cc-defs]
---

# Structured Manual Override Tracking for Sync Manifest

## Problem

After importing definitions from upstream (CEP) into Systematic via the `convert-cc-defs` skill, post-import customizations had no structured tracking mechanism. The `manual_overrides` field was a flat `string[]` — just field names with no context about why an override existed, what the original value was, or when it was made. This made re-sync workflows fragile: agents couldn't distinguish between stale overrides and critical customizations, and had no way to detect conflicts when upstream changed the same field.

## Environment

- Module: Systematic plugin (`@fro.bot/systematic`)
- Runtime: Bun / TypeScript 5.7+ strict mode
- Affected Components: `src/lib/manifest.ts`, `sync-manifest.schema.json`, `.opencode/skills/convert-cc-defs/SKILL.md`
- Date: 2026-02-10

## Symptoms

- `manual_overrides: ["description"]` provided no context about WHY the override existed — future agents couldn't make informed decisions about keeping or removing it
- No workflow for agents to follow when making post-import edits — the skill only had a jq one-liner for humans
- Re-sync had a single instruction ("Preserve manual_overrides — Merge from current bundled file") with no strategy for handling conflicts between upstream changes and local overrides
- No `original` value stored, making conflict detection and rollback impossible without re-fetching upstream

## What Didn't Work

**Direct solution:** The design problem was identified during a Metis consultation analyzing the task analysis from the first commit. The flat `string[]` type was clearly insufficient once we considered the agent-driven workflow where post-import edits need provenance tracking.

## Solution

Upgraded `manual_overrides` from `string[]` to structured `ManualOverride[]` objects and added a dedicated agent workflow for recording edits.

**Type change:**

```typescript
// Before (flat, no metadata):
manual_overrides?: string[]  // e.g., ["description"]

// After (structured, with provenance):
interface ManualOverride {
  field: string         // Same naming as rewrites[].field
  reason: string        // WHY the override exists
  original?: string     // Pre-override value (for conflict detection)
  overridden_at: string // ISO 8601 UTC timestamp
}
manual_overrides?: ManualOverride[]
```

**Type guard added:**

```typescript
function isManualOverride(value: unknown): value is ManualOverride {
  if (!isRecord(value)) return false
  return (
    typeof value.field === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.overridden_at === 'string'
  )
}
```

**JSON Schema updated:** `manual_overrides.items` changed from `{"type": "string"}` to a structured object with `field`, `reason`, `original`, and `overridden_at` properties.

**Skill Phase 4e "Record Manual Edit" added** — 4-step workflow for agents:

1. Before editing: capture current value of field(s) being changed
2. Make the edit to the bundled definition file
3. Update `sync-manifest.json` with structured override entry
4. Validate JSON output

With idempotency rules: no duplicate entries (check field name), don't overwrite first override's `original`, don't change `overridden_at` if already overridden.

**Re-Sync merge matrix added** — 4 deterministic cases:

| Scenario | Agent Behavior |
|----------|----------------|
| Upstream unchanged + override exists | Preserve override |
| Upstream changed + override on SAME field | Flag conflict to user |
| Upstream changed + override on DIFFERENT field | Apply upstream, preserve override |
| Override is `"*"` (full local ownership) | Skip re-sync entirely |

**Conflict presentation template** added for agents to follow when presenting conflicts to users.

**Precedence rule documented:** If a field appears in both `rewrites[]` and `manual_overrides[]`, the override wins. Rewrite kept for history but not re-applied.

**Files changed:**

- `src/lib/manifest.ts` — Added `ManualOverride` interface, `isManualOverride` type guard, replaced `isStringArray` usage
- `sync-manifest.schema.json` — Structured override object schema with descriptions
- `.opencode/skills/convert-cc-defs/SKILL.md` — Phase 4d rewritten, Phase 4e added, Re-Sync Workflow expanded with merge matrix + conflict presentation
- `tests/unit/manifest.test.ts` — 5 new tests: structured validation, empty arrays, string rejection, missing fields, optional `original`

## Why This Works

1. **Root cause:** The tracking mechanism had no metadata — just field names. Agents operating on these definitions need context (why, when, what was before) to make informed decisions about preserving or reconsidering overrides during re-sync.

2. **Why structured overrides solve it:** Each override entry is self-documenting. A future agent encountering `{"field": "description", "reason": "Customized triggers for auth-heavy codebase", "original": "...", "overridden_at": "..."}` has everything it needs to decide whether to keep the override or accept upstream changes. The `original` field enables conflict detection without re-fetching upstream history.

3. **Why a dedicated agent workflow:** The skill is invoked by AI agents, not humans. A jq one-liner doesn't give agents the structured steps they need. Phase 4e provides unambiguous instructions with idempotency guarantees, matching the skill's existing pattern of numbered phases with checklists and red-flag tables.

4. **Why skip-and-warn over three-way merge:** The constraint is "tracking mechanism, not a full VCS." Conflicts in definition files are rare but high-stakes — wrong auto-merges could corrupt agent/skill definitions. Human judgment is the correct resolution strategy, and the conflict presentation template gives users clear options.

## Prevention

- **Always use structured tracking for sync metadata.** Flat string arrays are insufficient when multiple actors (agents, humans) edit synced content at different times. Metadata (reason, timestamp, original value) is essential for informed decision-making.
- **Design agent workflows as explicit phases, not one-liners.** Agents follow structured instructions better than ad-hoc commands. Include idempotency rules and red-flag tables.
- **Separate "re-apply" data from "preserve" data.** Rewrites and overrides look similar but have opposite semantics during re-sync. Keeping them as separate arrays prevents confusion.
- **Test type guard changes against both old and new formats.** When upgrading a schema, verify that the old format is explicitly rejected (the string array test) and the new format validates correctly.

## Related Issues

- See also: [Map-and-Preserve Strategy for CEP-to-OpenCode Conversion](./destructive-to-nondestructive-converter-Systematic-20260209.md) — the converter infrastructure that this override tracking builds upon
