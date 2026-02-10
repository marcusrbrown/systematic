---
title: "feat: Frontmatter Conversion Improvements & Upstream Tracking"
type: feat
date: 2026-02-09
---

# Frontmatter Conversion Improvements & Upstream Tracking

## Overview

Transform the Systematic plugin's CEP-to-OpenCode converter from a destructive field-stripping approach to a **map-and-preserve** strategy. Add a provenance manifest (`sync-manifest.json`) for tracking upstream definition sources. Prepare for a future `sync-definitions` project skill.

Three phases:
1. **Converter changes** — Map CC fields to OC equivalents, preserve unmapped fields, migrate `maxSteps` → `steps`
2. **Manifest system** — TypeScript types, JSON schema, read/write/validate module for `sync-manifest.json`
3. **`sync-definitions` skill** — Deferred to follow-up (captured here for context only)

**Brainstorm reference:** `docs/brainstorms/2026-02-09-frontmatter-conversion-and-upstream-tracking-brainstorm.md`

## Problem Statement

The converter currently **strips** CC-specific frontmatter fields during conversion, losing information that could be preserved harmlessly (OC ignores unknown keys via `[key: string]: unknown` in AgentConfig). This means:

- Imported CEP definitions lose metadata (hooks, skills, memory, mcpServers) that may be useful for documentation or tooling
- Agent transforms are destructive — `transformAgentFrontmatter()` rebuilds from scratch, dropping anything not explicitly handled
- No field mapping exists for `tools` (array → map), `disallowedTools`, `maxTurns` → `steps`, or `permissionMode` → `permission`
- `maxSteps` is deprecated in OC SDK v2 in favor of `steps` — Systematic still uses the old name
- There's no way to track where bundled definitions came from or what upstream commit they were based on

## Proposed Solution

### Converter: Map-and-Preserve Strategy

Replace field stripping with targeted mapping. For each content type:

- **Map** CC fields to OC equivalents where a mapping exists
- **Preserve** unmapped CC fields in output frontmatter (pass-through)
- **Remove** only fields that would cause OC runtime errors (none identified — OC ignores unknowns)

### Manifest: Provenance Metadata

A `sync-manifest.json` at repo root tracks which upstream source/commit each bundled definition came from. This is provenance for AI agents — not sync state.

## Conversion Behavior Spec

Explicit answers to edge cases and ambiguities surfaced by SpecFlow analysis.

### Agent `name` Field Handling

**Decision: Preserve `name` in converter output.** Do NOT delete it.

Rationale: `extractAgentFrontmatter()` (`src/lib/agents.ts:69`) reads `name` from converted frontmatter. Deleting it during conversion would produce `name: ''`, breaking description generation and temperature inference that depend on the name string. The current `transformAgentFrontmatter()` uses `name` for description/temperature then drops it from output — the new non-destructive approach should keep it. OC agents are keyed by filename (not frontmatter `name`), so preserving `name` in frontmatter is harmless.

### Tool Name Canonicalization

**Decision: Reuse TOOL_MAPPINGS rename table for frontmatter `tools` mapping, not just lowercase.**

The body transform already renames CC tool names to OC equivalents (`WebSearch→google_search`, `Task→delegate_task`, `TodoWrite→todowrite`, etc.) via `TOOL_MAPPINGS` (`src/lib/converter.ts:36-61`). Frontmatter `tools` arrays must use the same renames or tool permissions won't match actual OC tool IDs.

```typescript
// Extract a tool-name-only mapping from TOOL_MAPPINGS for frontmatter use
const TOOL_NAME_MAP: Record<string, string> = {
  'task': 'delegate_task',
  'todowrite': 'todowrite',    // already lowercase
  'askuserquestion': 'question',
  'websearch': 'google_search',
  'webfetch': 'webfetch',
  'skill': 'skill',
  // PascalCase CC names → lowercase OC names (1:1 when no rename)
  'read': 'read', 'write': 'write', 'edit': 'edit',
  'bash': 'bash', 'grep': 'grep', 'glob': 'glob',
}

function canonicalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase()
  return TOOL_NAME_MAP[lower] ?? lower
}
```

### YAML Parse Error Behavior

**Decision: On frontmatter parse error, still transform the body, but do not touch frontmatter.**

Current behavior (`src/lib/converter.ts:248-250`) returns content completely unchanged on parse error — this skips body transforms too (tool name renames, path replacements). This is a silent failure that can cause `Task(...)` invocations to remain unconverted.

New behavior:
- If `parseError` is true: apply `transformBody()` to the full content string (treating it all as body), return the result
- Optionally: if running via CLI, emit a warning to stderr about the parse error

```typescript
if (parseError) {
  return options.skipBodyTransform ? content : transformBody(content)
}
```

### `steps` Numeric Validation

**Decision: Accept only finite positive integers. Otherwise omit `steps` and preserve original fields.**

```typescript
function isValidSteps(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}
```

If `maxTurns` or `maxSteps` values fail validation, they are preserved as-is in output (not mapped to `steps`). This prevents nonsense values like `steps: 0` or `steps: -1` from entering configs.

### `permissionMode` Unknown Default

**Decision: Default to `{ edit: 'ask', bash: 'ask', webfetch: 'ask' }` (ask, not deny).**

Rationale: `deny` would make converted agents non-functional (can't edit, can't run commands, can't fetch). `ask` is the most restrictive *usable* default — the user still gets prompted before any action. This matches OC's own default behavior for agents without explicit permission config.

### Invalid `permission` + `permissionMode` Precedence

**Decision: Prefer `permission` only if it passes `normalizePermission()`. Otherwise fall back to `permissionMode` mapping.**

```typescript
function mapPermissionMode(data: Record<string, unknown>): void {
  if (data.permission !== undefined) {
    const normalized = normalizePermission(data.permission)
    if (normalized) {
      data.permission = normalized
      delete data.permissionMode
      return
    }
    // Invalid permission object — preserve original, fall through to permissionMode
  }
  // ... rest of permissionMode mapping
}
```

### `isToolsMap` Non-Boolean Values

**Decision: If `tools` is an object but not all-boolean (e.g., `{ bash: 'allow' }`), preserve as-is. Do not overwrite.**

The converter should only apply array→map conversion when `tools` is actually an array. Object-shaped `tools` that fail `isToolsMap()` are left untouched — they may be user edits or OC-future formats.

### Manifest Key Format

**Decision: Use repo-relative paths without file extension for agents/commands. Use `skills/<name>` for skills (not `skills/<name>/SKILL.md`).**

Examples:
- `agents/review/security-sentinel` (not `agents/review/security-sentinel.md`)
- `skills/brainstorming` (not `skills/brainstorming/SKILL.md`)
- `commands/workflows/review` (not `commands/workflows/review.md`)

This matches how Systematic names definitions internally (filename without extension, path relative to category root).

### Manifest Failure Modes

| Scenario | Behavior |
|----------|----------|
| `sync-manifest.json` missing | `readManifest()` returns `null` (not an error — manifest is optional until Phase 3) |
| Invalid JSON | `readManifest()` returns `null` + logs warning |
| Schema validation fails | `readManifest()` returns `null` + logs warning |
| Stale entry (definition deleted) | `findStaleEntries()` reports it; no auto-removal |
| `$schema` reference missing | Non-fatal; schema is for tooling convenience |

## Technical Approach

### Architecture

No new modules required. Changes are localized to:

| File | Change |
|------|--------|
| `src/lib/converter.ts` | Refactor transforms, add field mappers |
| `src/lib/validation.ts` | Add type guards for CC tool arrays, permission modes; add `task`/`skill` permission keys |
| `src/lib/agents.ts` | Rename `maxSteps` → `steps` in `AgentFrontmatter` |
| `src/lib/config-handler.ts` | Rename `maxSteps` → `steps` in `loadAgentAsConfig` |
| `src/lib/manifest.ts` | **New** — manifest read/write/validate |
| `sync-manifest.json` | **New** — provenance data at repo root |
| `sync-manifest.schema.json` | **New** — JSON Schema for manifest |

### Implementation Phases

#### Phase 1: Converter Changes

**1a. Make agent transform non-destructive** (`src/lib/converter.ts:203-232`)

The current `transformAgentFrontmatter()` builds a new object with only known fields. Refactor to:

```typescript
// src/lib/converter.ts — new approach
function transformAgentFrontmatter(
  data: Record<string, unknown>,
  agentMode: AgentMode,
): Record<string, unknown> {
  // Start with ALL fields (non-destructive)
  const result = { ...data }

  // Set mode (default or from data)
  result.mode = isAgentMode(data.mode) ? data.mode : agentMode

  // Normalize description
  const name = typeof data.name === 'string' ? data.name : ''
  const description = typeof data.description === 'string' ? data.description : ''
  if (description) {
    result.description = description
  } else if (name) {
    result.description = `${name} agent`
  }

  // Keep 'name' — extractAgentFrontmatter reads it from converted output (agents.ts:69)
  // OC agents are keyed by filename; 'name' in frontmatter is harmless and needed internally

  // Normalize model
  if (typeof data.model === 'string' && data.model !== 'inherit') {
    result.model = normalizeModel(data.model)
  } else if (data.model === 'inherit') {
    delete result.model
  }

  // Infer temperature if not set
  result.temperature = typeof data.temperature === 'number'
    ? data.temperature
    : inferTemperature(name, description)

  // Map CC maxTurns → OC steps (see 1c)
  mapStepsField(result)

  // Map CC tools array → OC tools map (see 1d)
  mapToolsField(result)

  // Map CC permissionMode → OC permission (see 1e)
  mapPermissionMode(result)

  return result
}
```

- **Success criteria:** Unknown CC fields (hooks, skills, memory, mcpServers) survive conversion
- **Estimated effort:** Small (core refactor is ~30 lines)

**1b. Reduce CC_ONLY field lists** (`src/lib/converter.ts:79-94`)

Shrink `CC_ONLY_SKILL_FIELDS` — stop stripping fields that should be mapped or preserved:

| Field | Current | New |
|-------|---------|-----|
| `model` | Stripped | **Preserve** (normalize with provider prefix) |
| `allowed-tools` / `allowedTools` | Stripped | **Preserve** (no OC equivalent for skills-as-commands, harmless) |
| `disable-model-invocation` / `disableModelInvocation` | Stripped (read into SkillInfo) | **Preserve** (continue driving visibility) |
| `user-invocable` / `userInvocable` | Stripped (read into SkillInfo) | **Preserve** (continue driving visibility) |
| `context` | Stripped (mapped to subtask) | **Preserve** + map `fork` → `subtask: true` |
| `agent` | Stripped | **Preserve** (pass through to command config) |
| `hooks` | Not handled | **Preserve** |

After this change, `CC_ONLY_SKILL_FIELDS` may be empty or eliminated entirely. The `transformSkillFrontmatter()` function changes from `removeFields()` to targeted mapping:

```typescript
function transformSkillFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data }

  // Normalize model if present
  if (typeof result.model === 'string' && result.model !== 'inherit') {
    result.model = normalizeModel(result.model)
  } else if (result.model === 'inherit') {
    delete result.model
  }

  // Map context: fork → subtask: true
  if (result.context === 'fork') {
    result.subtask = true
  }

  return result
}
```

Similarly for `CC_ONLY_COMMAND_FIELDS` — `argument-hint` should be preserved (OC ignores it).

```typescript
function transformCommandFrontmatter(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data }

  // Normalize model
  if (typeof result.model === 'string' && result.model !== 'inherit') {
    result.model = normalizeModel(result.model)
  } else if (result.model === 'inherit') {
    delete result.model
  }

  return result
}
```

- **Success criteria:** No fields stripped; CC_ONLY constants removed or emptied
- **Estimated effort:** Small

**1c. `maxTurns` / `maxSteps` → `steps` migration**

Three-part rename:

1. **Converter mapping** — New `mapStepsField()` function:

```typescript
// Precedence: steps > maxTurns > maxSteps
// If multiple exist, use steps if present, else min(maxTurns, maxSteps) to avoid widening limits
function mapStepsField(data: Record<string, unknown>): void {
  if (typeof data.steps === 'number') {
    // Already OC format — keep it, clean up CC fields
    delete data.maxTurns
    delete data.maxSteps
    return
  }

  const maxTurns = typeof data.maxTurns === 'number' ? data.maxTurns : undefined
  const maxSteps = typeof data.maxSteps === 'number' ? data.maxSteps : undefined

  if (maxTurns !== undefined || maxSteps !== undefined) {
    const candidates = [maxTurns, maxSteps].filter((v): v is number => v !== undefined)
    data.steps = Math.min(...candidates)
    delete data.maxTurns
    delete data.maxSteps
  }
}
```

2. **Type/interface rename** — All 21 occurrences across 7 files:

| File | Line | Change |
|------|------|--------|
| `src/lib/agents.ts` | 36 | `maxSteps?: number` → `steps?: number` |
| `src/lib/agents.ts` | 79 | `maxSteps: extractNumber(data, 'maxSteps')` → `steps: extractNumber(data, 'steps')` |
| `src/lib/converter.ts` | 197 | `if (typeof data.maxSteps === 'number') target.maxSteps = data.maxSteps` → use `steps` |
| `src/lib/config-handler.ts` | 62 | Destructure `steps` instead of `maxSteps` |
| `src/lib/config-handler.ts` | 78 | `config.maxSteps = maxSteps` → `config.steps = steps` |
| Tests (6 files) | Multiple | Update assertions and fixtures |

3. **SDK compatibility** — The v1 SDK (`@opencode-ai/sdk ^1.1.30`) only has `maxSteps` on `AgentConfig`. The v2 types have both `steps` (preferred) and `maxSteps` (deprecated). Since AgentConfig has `[key: string]: unknown`, setting `steps` won't cause a type error even on v1. But for type safety:

   - Check if SDK needs bumping to v2 for native `steps` typing
   - If not bumping SDK: cast or augment the type locally

- **Success criteria:** `maxSteps` no longer appears in source code; `steps` used everywhere; both `maxTurns` and `maxSteps` accepted on input and mapped to `steps`
- **Estimated effort:** Medium (touches 7 files + tests)

**1d. CC `tools` array → OC `tools` map** (agent conversion only)

```typescript
// Map CC tools array to OC tools map
// CC: ["Read", "Grep", "Bash"] → OC: { read: true, grep: true, bash: true }
// CC: disallowedTools: ["Write"] → OC: { write: false }
// Merge: tools + disallowedTools into single map; disallowed wins on conflict
function mapToolsField(data: Record<string, unknown>): void {
  // If tools is already a map (OC format), leave it
  if (isToolsMap(data.tools)) {
    mergeDisallowedTools(data)
    return
  }

  const toolsMap: Record<string, boolean> = {}

  // Map CC tools array
  if (Array.isArray(data.tools)) {
    for (const tool of data.tools) {
      if (typeof tool === 'string') {
        toolsMap[canonicalizeToolName(tool)] = true
      }
    }
    data.tools = toolsMap
  }

  mergeDisallowedTools(data)
}

function mergeDisallowedTools(data: Record<string, unknown>): void {
  if (!Array.isArray(data.disallowedTools)) return

  const existing = isToolsMap(data.tools) ? data.tools : {}
  for (const tool of data.disallowedTools) {
    if (typeof tool === 'string') {
      existing[canonicalizeToolName(tool)] = false  // disallowed wins
    }
  }
  data.tools = existing
  delete data.disallowedTools
}

function canonicalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase()
  return TOOL_NAME_MAP[lower] ?? lower  // See "Tool Name Canonicalization" in Conversion Behavior Spec
}
```

**Edge cases:**
- **Unknown tool names** — OC ignores unknown keys in the tools map, so pass-through after rename lookup is safe. No need to validate against a closed tool list.
- **Tool renames** — `canonicalizeToolName()` reuses `TOOL_NAME_MAP` (derived from `TOOL_MAPPINGS`) to ensure frontmatter tool keys match OC IDs (e.g., `WebSearch` → `google_search`, not `websearch`).
- **Non-boolean tools map** — If `tools` is an object but not all-boolean (fails `isToolsMap()`), preserve as-is. Don't overwrite user edits.

- **Success criteria:** CC tools arrays converted to OC maps; disallowedTools merged; conflicts resolved (disallowed wins)
- **Estimated effort:** Small

**1e. CC `permissionMode` → OC `permission`**

```typescript
// CC permissionMode values and their OC permission equivalents
// This is security-sensitive — unknown modes default to MOST RESTRICTIVE
const PERMISSION_MODE_MAP: Record<string, PermissionConfig> = {
  'full': {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
  },
  'default': {
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
  },
  'plan': {
    edit: 'deny',
    bash: 'deny',
    webfetch: 'ask',
  },
  'bypassPermissions': {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
  },
}

function mapPermissionMode(data: Record<string, unknown>): void {
  // OC permission takes precedence if already set
  if (data.permission !== undefined) {
    delete data.permissionMode
    return
  }

  if (typeof data.permissionMode !== 'string') return

  const mapped = PERMISSION_MODE_MAP[data.permissionMode]
  if (mapped) {
    data.permission = mapped
  } else {
    // Unknown mode → most restrictive default (security)
    data.permission = { edit: 'ask', bash: 'ask', webfetch: 'ask' }
    // Preserve original for debugging/docs
  }
  delete data.permissionMode
}
```

**Security note:** Unknown `permissionMode` values default to `ask` (most restrictive usable default). The original value is removed from frontmatter after mapping since `permission` is the canonical OC field.

- **Success criteria:** All known CC permission modes mapped; unknown modes → restrictive default; OC `permission` takes precedence over CC `permissionMode`
- **Estimated effort:** Small

**1f. Add `hidden` field support** (agent conversion)

OC SDK v2 adds `hidden?: boolean` for subagents. Map from CC's `disable-model-invocation`:

```typescript
// In transformAgentFrontmatter, after other mappings:
if (data['disable-model-invocation'] === true || data.disableModelInvocation === true) {
  result.hidden = true
  delete result['disable-model-invocation']
  delete result.disableModelInvocation
}
```

Update `AgentFrontmatter` in `src/lib/agents.ts` to include `hidden?: boolean`.

- **Success criteria:** CC `disable-model-invocation` maps to OC `hidden: true`
- **Estimated effort:** Tiny

**1g. Converter cache versioning** (`src/lib/converter.ts:282`)

Add a converter version to the cache key so logic changes invalidate cached results:

```typescript
const CONVERTER_VERSION = 2  // Bump when mapping logic changes

const cacheKey = `${CONVERTER_VERSION}:${filePath}:${type}:${options.source ?? 'bundled'}:${options.agentMode ?? 'subagent'}:${options.skipBodyTransform ?? false}`
```

- **Success criteria:** Changing CONVERTER_VERSION invalidates all cached conversions
- **Estimated effort:** Tiny

**1h. Idempotency guarantees**

Conversion must be safe to run multiple times on the same content:

- `normalizeModel()` already handles prefixed models (`model.includes('/')` → return as-is) ✅
- `mapStepsField()` checks for `steps` first before mapping from `maxTurns`/`maxSteps` ✅
- `mapToolsField()` checks `isToolsMap()` before array conversion ✅
- `mapPermissionMode()` checks for existing `permission` before mapping ✅
- Tool name canonicalization is deterministic (lowercase + trim) ✅

Add explicit idempotency tests (see Phase 1 testing).

**1i. Update `PermissionConfig`** (`src/lib/validation.ts:9-15`)

OC docs show `task` and `skill` as new permission keys. Add them:

```typescript
export interface PermissionConfig {
  edit?: PermissionSetting
  bash?: PermissionSetting | Record<string, PermissionSetting>
  webfetch?: PermissionSetting
  doom_loop?: PermissionSetting
  external_directory?: PermissionSetting
  task?: PermissionSetting      // New
  skill?: PermissionSetting     // New
}
```

Update `normalizePermission()` to extract these new keys.

**1j. Integration test update** (`tests/integration/converter-validation.test.ts:112-124`)

The integration test duplicates CC_ONLY constants. After this change, either:
- Export the constants from converter.ts and import in tests, OR
- Remove the CC_ONLY-based assertions (since we're no longer stripping) and replace with "field mapping correctness" assertions

Recommended: Remove the CC_ONLY duplication entirely. Replace with tests that verify:
- Known CC fields are mapped to OC equivalents
- Unknown fields pass through unchanged
- Output is valid OC frontmatter

#### Phase 1 Testing

New test cases needed (in `tests/unit/converter.test.ts`):

```typescript
describe('field mapping', () => {
  // tools array → map
  test('converts CC tools array to OC tools map', ...)
  test('handles empty tools array', ...)
  test('canonicalizes tool names to lowercase', ...)
  test('applies tool renames (WebSearch → google_search)', ...)
  test('leaves non-boolean tools object untouched', ...)

  // disallowedTools
  test('converts disallowedTools to false entries in tools map', ...)
  test('disallowed overrides allowed on conflict', ...)
  test('merges disallowedTools into existing tools map', ...)

  // steps migration
  test('maps maxTurns to steps', ...)
  test('maps maxSteps to steps', ...)
  test('prefers steps over maxTurns/maxSteps', ...)
  test('uses minimum when both maxTurns and maxSteps present', ...)
  test('cleans up maxTurns/maxSteps after mapping', ...)
  test('rejects non-positive-integer steps values', ...)
  test('preserves original fields when steps value invalid', ...)

  // permissionMode
  test('maps full permissionMode to allow permissions', ...)
  test('maps default permissionMode to ask permissions', ...)
  test('maps plan permissionMode to deny/ask permissions', ...)
  test('unknown permissionMode defaults to ask', ...)
  test('existing valid permission takes precedence over permissionMode', ...)
  test('falls back to permissionMode when permission is invalid', ...)

  // hidden
  test('maps disable-model-invocation to hidden', ...)

  // agent name
  test('preserves agent name in converted output', ...)

  // pass-through
  test('preserves unknown CC fields on agents', ...)
  test('preserves unknown CC fields on skills', ...)
  test('preserves unknown CC fields on commands', ...)
  test('preserves hooks field', ...)
  test('preserves mcpServers field', ...)

  // parse error handling
  test('transforms body even when frontmatter has parse error', ...)

  // idempotency
  test('converting already-converted content is idempotent', ...)
  test('model normalization is idempotent', ...)
  test('tools map conversion is idempotent', ...)
  test('steps mapping is idempotent', ...)
})
```

#### Phase 2: Manifest System

**2a. TypeScript types** (`src/lib/manifest.ts` — new file)

```typescript
// src/lib/manifest.ts

export interface ManifestSource {
  repo: string          // GitHub owner/repo
  branch: string        // Default branch
  url: string           // Full repo URL
}

export interface ManifestDefinition {
  source: string        // Key into sources map
  upstream_path: string // File path within source repo
  upstream_commit: string // Commit SHA
  synced_at: string     // ISO 8601 timestamp
  notes: string         // What was changed/adapted
}

export interface SyncManifest {
  $schema?: string
  sources: Record<string, ManifestSource>
  definitions: Record<string, ManifestDefinition>
}
```

**2b. Read/write/validate functions** (`src/lib/manifest.ts`)

```typescript
export function readManifest(filePath: string): SyncManifest | null
export function writeManifest(filePath: string, manifest: SyncManifest): void
export function validateManifest(data: unknown): data is SyncManifest
export function findStaleEntries(manifest: SyncManifest, existingPaths: string[]): string[]
```

- Read uses `JSON.parse` with type guard validation
- Write uses `JSON.stringify(manifest, null, 2)` with trailing newline for stable formatting
- Validate checks structure with type guards (no external schema lib needed)
- `findStaleEntries` detects manifest entries whose local files no longer exist

**2c. JSON Schema** (`sync-manifest.schema.json` at repo root)

Standard JSON Schema for editor autocomplete and CI validation. Defines the structure from the brainstorm document.

**2d. Initial manifest population** (`sync-manifest.json` at repo root)

Populate entries for all existing bundled definitions. This requires identifying upstream sources for each file — may need manual research for initial population.

**2e. Manifest location decision**

**Recommendation:** Repo root (`sync-manifest.json`).

Rationale:
- Clear ownership — it's a project-level concern
- Easy CI access for validation
- Alongside `sync-manifest.schema.json` for `$schema` reference
- Not in `dist/` (it's source metadata, not build output)
- Not in `src/` (it's data, not code)

#### Phase 2 Testing

```typescript
describe('manifest', () => {
  test('reads valid manifest', ...)
  test('returns null for missing file', ...)
  test('returns null for invalid JSON', ...)
  test('validates manifest structure', ...)
  test('rejects manifest with missing required fields', ...)
  test('writes manifest with stable formatting', ...)
  test('detects stale entries', ...)
})
```

#### Phase 3: `sync-definitions` Project Skill (Deferred)

Captured here for context. Implementation details will be planned separately after Phases 1-2 are complete and real usage informs the design.

- Create `.opencode/skills/sync-definitions/SKILL.md`
- Skill covers: git operations, file targeting, conversion workflow, intelligent rewriting, manifest updates
- Skill reads manifest for provenance context
- Skill uses `gh` CLI for fetching upstream content

## Alternative Approaches Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Strip-all** (current) | Simple, predictable | Loses data, prevents portability | Rejected — brainstorm |
| **Pass-through-all** (no mapping) | Zero logic, maximum preservation | No active field mapping, CC definitions unusable without manual editing | Rejected — brainstorm |
| **Map-and-preserve** (chosen) | Best of both — maps where possible, preserves everything else | Slightly more complex converter | **Chosen** |
| **Frontmatter-embedded tracking** | Self-contained definitions | Pollutes frontmatter, harder to query across definitions | Rejected — brainstorm |
| **Separate manifest** (chosen) | Clean separation, machine-readable, AI-agent-friendly | Extra file to maintain | **Chosen** |

## Acceptance Criteria

### Functional Requirements

- [x] CC `tools` arrays converted to OC `tools` maps with canonical lowercase names
- [x] CC `disallowedTools` merged into `tools` map with `false` values; disallowed wins on conflict
- [x] CC `maxTurns` mapped to OC `steps`; `maxSteps` also mapped to `steps`
- [x] Precedence: `steps` > `maxTurns` (min with `maxSteps` if both present)
- [x] CC `permissionMode` mapped to OC `permission` via explicit mapping table
- [x] Unknown `permissionMode` defaults to `{ edit: 'ask', bash: 'ask', webfetch: 'ask' }`
- [x] Existing OC `permission` takes precedence over CC `permissionMode`
- [x] CC `disable-model-invocation` mapped to OC `hidden: true`
- [x] `model` field normalized with provider prefix on skills (not just agents/commands)
- [x] All unmapped CC fields preserved in output frontmatter (hooks, skills, memory, mcpServers, etc.)
- [x] Agent transform no longer destructive — unknown fields survive
- [x] `CC_ONLY_SKILL_FIELDS` and `CC_ONLY_COMMAND_FIELDS` eliminated or emptied
- [x] `maxSteps` renamed to `steps` in all source files (AgentFrontmatter, extractAgentFrontmatter, loadAgentAsConfig, addOptionalFields)
- [x] `PermissionConfig` includes `task` and `skill` keys
- [x] Converter cache includes version for invalidation
- [x] `sync-manifest.json` exists at repo root with schema reference
- [x] `SyncManifest` TypeScript types defined with read/write/validate functions
- [ ] Manifest entries populated for existing bundled definitions (deferred — empty manifest with schema)

### Non-Functional Requirements

- [x] Conversion is idempotent (running twice produces identical output)
- [x] No regression in existing test suite
- [x] Build passes (`bun run build`)
- [x] Type checks pass (`bun run typecheck`)
- [x] Lint passes (`bun run lint`)

### Quality Gates

- [x] All new field mappings have unit tests
- [x] Idempotency tests for each mapping function
- [x] Unknown field pass-through tests for all three content types
- [x] `permissionMode` mapping tested for all known modes + unknown mode
- [x] `tools`/`disallowedTools` conflict resolution tested
- [x] Integration tests updated (CC_ONLY constant duplication removed)
- [x] Manifest read/write/validate tested

## Success Metrics

- All existing bundled definitions convert cleanly with new logic
- No field data loss during conversion (verifiable by comparing input/output field counts)
- `maxSteps` grep returns zero results in source code after migration

## Dependencies & Prerequisites

- OC SDK `AgentConfig` accepts `[key: string]: unknown` — confirmed ✅
- OC SDK v2 types include `steps` and `hidden` — confirmed ✅ (v2 path: `dist/v2/gen/types.gen.d.ts`)
- SDK version may need bumping from `^1.1.30` to v2 for native `steps`/`hidden` typing — **decision needed**
- No OC runtime validation rejects unknown frontmatter keys — confirmed via brainstorm research ✅

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| OC runtime rejects unknown keys in agent config | Medium | Confirmed `[key: string]: unknown` in AgentConfig; test with real OC instance |
| `permissionMode` mapping is incomplete/wrong | High (security) | Explicit mapping table with unknown → restrictive default; comprehensive tests |
| Breaking existing user configs that depend on stripping | Low | Preserving extra fields is additive, not breaking; stripping was never documented as a feature |
| Cache serves stale conversions after logic change | Medium | CONVERTER_VERSION in cache key; bump on any mapping change |
| Manifest grows stale (references deleted files) | Low | `findStaleEntries()` function; optional CI validation |
| SDK v1 type mismatch when using `steps` | Low | `[key: string]: unknown` makes it safe at runtime; type augmentation or SDK bump resolves compile-time |

## Future Considerations

- Phase 3 `sync-definitions` skill will automate upstream fetching and conversion
- Model shorthand normalization (e.g., `sonnet` → `anthropic/claude-sonnet-4-...`) may need a lookup table as model naming evolves
- If OC adds native support for more CC fields (hooks, mcpServers), update mappings accordingly
- CLI `convert` command may be moved to scripts or replaced by the sync skill

## Documentation Plan

- Update `docs/src/content/docs/guides/conversion-guide/` with new field mapping table
- Update AGENTS.md code map if new modules added
- Add inline code comments explaining `permissionMode` mapping rationale (security)

## References

### Internal References

- Converter core: `src/lib/converter.ts:79-272`
- Agent transform (destructive, needs refactor): `src/lib/converter.ts:203-232`
- Skill transform: `src/lib/converter.ts:160-164`
- Command transform: `src/lib/converter.ts:166-178`
- CC_ONLY skill fields: `src/lib/converter.ts:79-89`
- CC_ONLY command fields: `src/lib/converter.ts:94`
- Agent frontmatter type: `src/lib/agents.ts:14-39`
- Agent extraction: `src/lib/agents.ts:60-82`
- Config handler (maxSteps usage): `src/lib/config-handler.ts:62,78`
- Validation/permissions: `src/lib/validation.ts:1-155`
- Converter cache: `src/lib/converter.ts:274-297`
- Integration test CC_ONLY duplication: `tests/integration/converter-validation.test.ts:112-124`
- Brainstorm: `docs/brainstorms/2026-02-09-frontmatter-conversion-and-upstream-tracking-brainstorm.md`

### External References

- OC Agents docs: [opencode.ai/docs/agents](https://opencode.ai/docs/agents)
- OC Commands docs: [opencode.ai/docs/commands](https://opencode.ai/docs/commands)
- OC Skills docs: [opencode.ai/docs/skills](https://opencode.ai/docs/skills)
- CC Skills docs: [docs.anthropic.com/en/docs/claude-code/skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- CC Sub-agents docs: [docs.anthropic.com/en/docs/claude-code/sub-agents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- SDK v2 AgentConfig (local): `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`

### SpecFlow Analysis

Key gaps identified and addressed in this plan (see "Conversion Behavior Spec" section for full details):
- Agent `name` contradiction → preserve in output (extractAgentFrontmatter reads it)
- Tool name canonicalization → reuse TOOL_MAPPINGS rename table, not just lowercase
- YAML parse error behavior → still transform body, skip frontmatter
- `tools` + `disallowedTools` conflict resolution → disallowed wins
- `maxTurns` + `maxSteps` precedence → min() strategy with positive integer validation
- `permissionMode` unknown values → `ask` default (most restrictive usable)
- Invalid `permission` + `permissionMode` → validate before preferring, fall back to mapping
- Non-boolean `tools` map → preserve as-is, don't overwrite
- Agent transform destructiveness → copy-all-then-transform
- Converter cache invalidation → version in cache key
- Idempotency → explicit checks at each mapping step
- Manifest key format → repo-relative paths without extension
- Manifest failure modes → null returns with warnings, no auto-removal of stale entries
