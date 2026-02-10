---
module: Systematic
date: 2026-02-09
problem_type: best_practice
component: tooling
symptoms:
  - "CEP frontmatter fields silently dropped during conversion to OpenCode format"
  - "tools array not mapped to OpenCode tool ID format"
  - "maxSteps field stripped instead of renamed to steps"
  - "permissionMode string lost instead of mapped to PermissionConfig object"
  - "Converter cache not invalidated when mapping logic changes"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [converter, frontmatter, map-and-preserve, non-destructive, cep-to-opencode]
---

# Map-and-Preserve Strategy for CEP-to-OpenCode Conversion

## Problem

The Systematic plugin's converter (`src/lib/converter.ts`) used a destructive "strip-all" approach when converting CEP (Compound Engineering Plugin) frontmatter to OpenCode format. Fields that had direct OpenCode equivalents were silently removed instead of being mapped, causing data loss during conversion. Unknown fields that should have passed through were also stripped.

## Environment

- Module: Systematic plugin (`@fro.bot/systematic`)
- Runtime: Bun / TypeScript 5.7+ strict mode
- Affected Component: `src/lib/converter.ts` (core conversion pipeline)
- Date: 2026-02-09

## Symptoms

- `tools: [Read, Write, Bash]` arrays silently dropped instead of mapped to OpenCode tool IDs (`read`, `write`, `bash`)
- `maxSteps: 25` stripped instead of renamed to `steps: 25`
- `permissionMode: "full"` lost instead of mapped to `{ allow: ["*"] }`
- `hidden: true` on agents silently removed
- `disallowedTools` not merged with `tools` array to produce a unified tool permissions map
- Custom/unknown frontmatter fields silently stripped instead of preserved for downstream consumers
- No cache invalidation when converter mapping logic changed (stale conversions served from cache)

## What Didn't Work

**Direct solution:** The problem was identified during a brainstorming session analyzing the converter's field handling. The root cause was immediately clear from the code: explicit deletion lists (`CC_ONLY_SKILL_FIELDS`, `CC_ONLY_COMMAND_FIELDS`) combined with `removeFields()` and `addOptionalFields()` functions that operated destructively.

## Solution

Replaced the destructive strip-all approach with a non-destructive map-and-preserve strategy:

**Core pattern change:**

```typescript
// Before (destructive): explicit deletion lists
const CC_ONLY_SKILL_FIELDS = ['tools', 'maxSteps', 'permissionMode', ...]
function removeFields(data: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    delete data[field]  // Silent data loss
  }
}

// After (non-destructive): copy-then-transform
function convertFrontmatter(original: Record<string, unknown>): Record<string, unknown> {
  const data = { ...original }  // Shallow copy, never mutate input

  // Map known fields to OpenCode equivalents
  mapToolsField(data)          // tools[] -> tool permissions map
  mapStepsField(data)          // maxSteps -> steps
  mapPermissionMode(data)      // permissionMode -> PermissionConfig
  mapHiddenField(data)         // hidden -> hidden (pass-through with validation)
  normalizeModelField(data)    // model normalization

  // Unknown fields pass through untouched
  return data
}
```

**Key mapping functions added:**

| Function | CEP Input | OpenCode Output |
|----------|-----------|-----------------|
| `canonicalizeToolName()` | `"Read"`, `"TodoWrite"` | `"read"`, `"todowrite"` |
| `mapToolsField()` | `tools: ["Read", "Bash"]` | `{ tool: { read: { }, bash: { } } }` |
| `mergeDisallowedTools()` | `disallowedTools: ["Write"]` | merged into tool map with `disabled: true` |
| `mapStepsField()` | `maxSteps: 25` | `steps: 25` |
| `mapPermissionMode()` | `permissionMode: "full"` | `{ permission: { allow: ["*"] } }` |
| `mapHiddenField()` | `hidden: true` | `hidden: true` (validated boolean) |

**Lookup tables:**

```typescript
const TOOL_NAME_MAP: Record<string, string> = {
  todowrite: 'todowrite',
  bash: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webfetch',
  task: 'task',
  skill: 'systematic_skill',
  // ... 12 total entries
}

const PERMISSION_MODE_MAP: Record<string, PermissionConfig> = {
  full:              { allow: ['*'] },
  default:           {},
  plan:              { allow: ['read', 'glob', 'grep'] },
  bypasspermissions: { allow: ['*'] },
}
```

**Cache invalidation:** Added `CONVERTER_VERSION = 2` to the cache key computation so any change to mapping logic invalidates stale cached conversions.

**Files changed:**
- `src/lib/converter.ts` — Core rewrite (removed `removeFields`, `addOptionalFields`, `CC_ONLY_*` constants; added 6 mapping functions + 2 lookup tables)
- `src/lib/validation.ts` — Extended `PermissionConfig` with `task` and `skill` fields
- `src/lib/agents.ts` — Renamed `maxSteps` to `steps` in `AgentFrontmatter`, added `hidden`
- `src/lib/config-handler.ts` — Updated `loadAgentAsConfig()` to use `steps`/`hidden`
- `src/lib/bootstrap.ts` — Fixed `TodoWrite` tool mapping (was `update_plan`, corrected to `todowrite`)

## Why This Works

1. **Root cause:** The converter treated CEP-specific fields as garbage to be discarded, rather than as data with equivalent OpenCode representations. The deletion-list pattern made it impossible to add new field mappings without modifying two places (the delete list AND a separate add function).

2. **Why map-and-preserve solves it:** By copying input data and transforming known fields in-place, unknown fields naturally pass through. New mappings require adding only a single mapping function. The shallow copy ensures the original data is never mutated (important for caching correctness).

3. **Underlying design principle:** The converter now follows "parse, don't validate" — it transforms data it understands and preserves data it doesn't, rather than asserting a closed-world assumption about which fields are valid.

## Prevention

- **Design pattern:** When converting between formats, default to preserving unknown fields. Only strip fields that are proven to cause problems in the target format.
- **Cache versioning:** Any converter that caches results must include a version number in the cache key. Bump the version when mapping logic changes.
- **Test coverage:** The 41 new unit tests + 7 idempotency tests ensure each mapping is verified independently. Future field additions should include corresponding test cases.
- **Lookup table sync:** `TOOL_NAME_MAP` must stay synchronized with the `TOOL_MAPPINGS` constant used in bootstrap.ts. A code comment marks this coupling.

## Related Issues

No related issues documented yet.
