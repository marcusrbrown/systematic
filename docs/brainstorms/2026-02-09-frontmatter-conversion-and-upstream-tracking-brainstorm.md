---
date: 2026-02-09
topic: frontmatter-conversion-and-upstream-tracking
---

# Frontmatter Conversion Improvements & Upstream Tracking

## What We're Building

Two related capabilities for the Systematic plugin, with a project skill as the end goal:

1. **Improved frontmatter conversion** — Stop stripping Claude Code (CC) frontmatter fields during CEP-to-OpenCode conversion. Instead, map fields where OC equivalents exist and preserve the rest as pass-through. This lets CEP `.md` definitions be dropped in with minimal manual editing.

2. **Upstream provenance manifest** — A separate manifest file (`sync-manifest.json`) that records which upstream source repo/commit each bundled definition originated from. Supports multiple upstream sources (CEP, `anthropics/skills`, etc.). This is provenance metadata for AI agents — not sync state, since all imported definitions will diverge after manual editing.

3. **`sync-definitions` project skill** (end goal) — A project skill in `.opencode/skills/sync-definitions/` that an AI agent invokes in a session to: fetch upstream content, run conversion, intelligently rewrite definitions for OC compatibility and Systematic's style preferences, and update the manifest. The skill includes instructions and reference for git operations, file copying, and the existing conversion workflow.

## Why This Approach

**Converter-first (Approach A)** was chosen over manifest-first or big-bang because:
- The converter is the immediate bottleneck — CEP definitions can't be imported cleanly without fixing field handling
- The manifest schema is cheap to define alongside converter work
- The sync skill is deferred to a follow-up, informed by real usage of manual imports
- Small, testable changes with clear verification

**Map-and-preserve** field strategy was chosen over strip-all or pass-through-all because:
- Preserves information from upstream (no data loss)
- Actively maps fields where OC equivalents exist (not just ignoring them)
- Unmapped CC fields are harmlessly ignored by OC (AgentConfig has `[key: string]: unknown`)
- Definitions remain portable — could round-trip back to CC if needed

**Separate manifest** was chosen over frontmatter-embedded tracking because:
- Clean separation of concerns — definitions stay portable, tracking is machine metadata
- The manifest is for AI agents, not humans — it provides context for the `sync-definitions` skill
- No frontmatter pollution or stripping needed during conversion
- Manifest is provenance (where did this come from?), not sync state (everything will be modified)

**User overrides via existing opencode.json** — No new override mechanism needed. OpenCode's existing config precedence already handles this:
- Systematic spreads bundled content first, then existing user config on top (`{ ...bundled, ...existing }`)
- User-defined agents/commands in `opencode.json` fully replace bundled ones with the same name
- This is full-object replacement (not field-level merge) — intentional and documented by OpenCode
- Verified: [opencode.ai/docs/agents](https://opencode.ai/docs/agents) confirms agents are complete definitions, not partial patches

## Key Decisions

- **Field handling strategy**: Map CC fields to OC equivalents where possible, preserve unmapped fields in output frontmatter (don't strip)
- **Tracking location**: Separate `sync-manifest.json` file, not embedded in definition frontmatter
- **Manifest purpose**: Provenance for AI agents — attribute upstream source and locate content for diffing, not sync state tracking
- **Manifest scope**: Multi-source — supports arbitrary git repo upstreams, not just CEP
- **Execution order**: Converter changes first, manifest schema alongside, sync skill later
- **Content divergence expected**: Every imported definition will be manually modified — the `modified` field is dropped in favor of `notes` describing what changed
- **User overrides**: No new mechanism — existing `opencode.json` agent/command config takes precedence over bundled content (verified against OC docs)
- **CLI convert command**: Can be moved to scripts since it's a project-specific task, not user-facing
- **`maxSteps` → `steps`**: OpenCode deprecated `maxSteps` in favor of `steps` — Systematic should migrate

## Verified Field Reference

Sources: [opencode.ai/docs/agents](https://opencode.ai/docs/agents), [opencode.ai/docs/commands](https://opencode.ai/docs/commands), [opencode.ai/docs/skills](https://opencode.ai/docs/skills), [docs.anthropic.com/en/docs/claude-code/skills](https://docs.anthropic.com/en/docs/claude-code/skills), [docs.anthropic.com/en/docs/claude-code/sub-agents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)

### Skills: CC Fields to OC Behavior

| CC Field | Type | Current Behavior | New Behavior |
|----------|------|-----------------|--------------|
| `name` | string | Kept | Kept (no change) |
| `description` | string | Kept | Kept (no change) |
| `license` | string | Kept | Kept (no change) |
| `compatibility` | string | Kept | Kept (no change) |
| `metadata` | map | Kept | Kept (no change) |
| `model` | string | **Stripped** | Normalize (add provider prefix), preserve in frontmatter |
| `allowed-tools` | string | **Stripped** | Preserve as-is (no OC equivalent for skills-as-commands) |
| `disable-model-invocation` | boolean | **Stripped** (but read into `SkillInfo`) | Preserve; continue using to drive `userInvocable`/visibility behavior |
| `user-invocable` | boolean | **Stripped** (but read into `SkillInfo`) | Preserve; continue driving visibility filtering |
| `context` | string | **Stripped** (mapped to `subtask`) | Preserve; continue mapping `fork` to `subtask: true` |
| `agent` | string | **Stripped** | Preserve; pass through to command config `agent` field |
| `argument-hint` | string | **Stripped** from commands | Preserve in frontmatter (OC ignores it, useful for docs/tooling) |
| `hooks` | object | **Not handled** | Preserve as-is (no OC skill equivalent, but don't lose data) |

### Agents: CC Fields to OC Mapping

| CC Field | OC Equivalent | Mapping | Status |
|----------|--------------|---------|--------|
| `name` | `name` | Direct | Done |
| `description` | `description` | Direct (with Systematic suffix) | Done |
| `model` | `model` | Normalize provider prefix; CC uses `sonnet`/`opus`/`haiku`/`inherit`, OC uses `provider/model-id` | Done |
| `temperature` | `temperature` | Direct (infer if missing) | Done |
| `maxTurns` | `steps` | Rename (**`maxSteps` deprecated by OC, use `steps`**) | **Needs update** |
| `tools` (array) | `tools` (map) | Convert CC array `["Read", "Grep"]` to OC map `{ read: true, grep: true }` | **New** |
| `disallowedTools` (array) | `tools` (map) | Convert to `{ tool: false }` map | **New** |
| `permissionMode` | `permission` | Map CC modes to OC permission config where possible | **New** |
| `skills` (array) | — | Preserve (no OC equivalent) | **New** |
| `memory` (string) | — | Preserve (no OC equivalent) | **New** |
| `hooks` (object) | — | Preserve (no OC equivalent) | **New** |
| `mcpServers` (object) | — | Preserve (no OC equivalent) | **New** |

### OC-Only Fields (additive, not from CC)

These can be added to definitions IN ADDITION to CC fields:

| OC Field | Purpose | Status |
|----------|---------|--------|
| `mode` | `subagent` / `primary` / `all` (defaults to `all` if omitted per OC docs) | Done |
| `top_p` | Top-p sampling | Done |
| `color` | Hex color or theme color for UI | Done |
| `steps` | Max agentic iterations (**replaces deprecated `maxSteps`**) | **Needs update** |
| `hidden` | Hide subagent from `@` autocomplete (subagent-only) | **New — maps to `disable-model-invocation` concept** |
| `permission` | Granular permission ruleset (edit, bash, webfetch, doom_loop, external_directory, task, skill) | Done (partial — `task` and `skill` permissions are new) |
| `tools` (map) | Tool whitelist/blacklist with wildcard support | Done |
| `disable` | Disable agent | Done |
| `subtask` | Command runs as subtask | Done |
| `agent` | Command delegates to agent | Done |

### OC Command Fields (verified from [opencode.ai/docs/commands](https://opencode.ai/docs/commands))

| Field | Required | Description |
|-------|----------|-------------|
| `template` | Yes | Prompt content (body in markdown files) |
| `description` | No | Description shown in TUI |
| `agent` | No | Agent to execute with |
| `model` | No | Model override |
| `subtask` | No | Force subagent invocation |

### OC Skill Fields (verified from [opencode.ai/docs/skills](https://opencode.ai/docs/skills))

Only these fields are recognized by OpenCode's native skill system:
- `name` (required)
- `description` (required)
- `license` (optional)
- `compatibility` (optional)
- `metadata` (optional, string-to-string map)

**Unknown frontmatter fields are ignored** — this confirms our pass-through strategy is safe.

## Manifest Schema

```jsonc
// sync-manifest.json — provenance metadata for AI agents
{
  "$schema": "./sync-manifest.schema.json",
  "sources": {
    "cep": {
      "repo": "EveryInc/compound-engineering-plugin",
      "branch": "main",
      "url": "https://github.com/EveryInc/compound-engineering-plugin"
    },
    "anthropic-skills": {
      "repo": "anthropics/skills",
      "branch": "main",
      "url": "https://github.com/anthropics/skills"
    }
  },
  "definitions": {
    "agents/review/security-sentinel": {
      "source": "cep",
      "upstream_path": "agents/security-sentinel.md",
      "upstream_commit": "abc1234",
      "synced_at": "2026-02-09T00:00:00Z",
      "notes": "Adapted prompt for OC tool names, added permission config, rewrote for Systematic style"
    },
    "skills/brainstorming": {
      "source": "cep",
      "upstream_path": "skills/brainstorming/SKILL.md",
      "upstream_commit": "def5678",
      "synced_at": "2026-02-09T00:00:00Z",
      "notes": "Restructured phases, added YAGNI section, tuned question flow"
    }
  }
}
```

### Manifest Fields

**Source entry:**
- `repo` — GitHub `owner/repo` identifier
- `branch` — Default branch to track
- `url` — Full repo URL

**Definition entry:**
- `source` — Key into `sources` map
- `upstream_path` — File path within the source repo
- `upstream_commit` — Commit SHA when content was last pulled
- `synced_at` — ISO 8601 timestamp of last pull
- `notes` — What was changed/adapted (for AI agent context)

## Open Questions

- Should `sync-manifest.json` live at repo root or in a dedicated directory?
- For the `sync-definitions` skill: should it use `gh` CLI, raw git, or GitHub API for fetching upstream?
- Should we validate the manifest schema at build time or just when the skill runs?
- Should the `convert` CLI command be moved to a script immediately, or left in place until the skill replaces it?
- What style preferences should the `sync-definitions` skill encode for rewriting? (e.g., tool name casing, prompt structure, description format)

## Next Steps

-> `/workflows:plan` for implementation details when ready.

### Phase 1: Converter Changes
- Refactor `CC_ONLY_SKILL_FIELDS` and `CC_ONLY_COMMAND_FIELDS` — stop bulk-stripping, replace with targeted mapping
- Add CC-to-OC field mappers: `tools` array→map, `disallowedTools`→map, `maxTurns`→`steps`, `permissionMode`→`permission`
- Preserve unmapped CC fields (`hooks`, `skills`, `memory`, `mcpServers`) in output frontmatter
- Add `hidden` as a recognized OC agent field
- Migrate `maxSteps` to `steps` throughout codebase
- Update tests to verify new field handling

### Phase 2: Manifest System
- Define `SyncManifest` TypeScript types
- Create `src/lib/manifest.ts` — read/write/validate manifest (or put in scripts if project-only)
- Define JSON schema for `sync-manifest.json`
- Populate initial manifest entries for existing bundled definitions
- Optional: add manifest read to CLI for inspection

### Phase 3: `sync-definitions` Project Skill
- Create `.opencode/skills/sync-definitions/SKILL.md`
- Skill instructions cover: git operations for fetching upstream, file targeting/copying, conversion workflow, intelligent rewriting for OC compatibility and Systematic style
- Skill reads manifest for provenance context
- Skill updates manifest after successful import
- Skill is invoked in development sessions (like this one)
