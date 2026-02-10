# Claude Code to OpenCode Conversion Guide

**Purpose:** Guide for converting Claude Code (CC) definitions (skills, commands, agents) to OpenCode (OC) format for use in the Systematic plugin.

**Audience:** Humans and AI agents lifting definitions from CEP or other CC plugins/configurations.

---

## Quick Reference Table

| Aspect | Claude Code | OpenCode / Systematic |
|--------|-------------|----------------------|
| **Skills directory** | `.claude/skills/<name>/SKILL.md` | `.opencode/skills/<name>/SKILL.md` |
| **Commands directory** | `.claude/commands/<name>.md` | `.opencode/commands/<name>.md` |
| **Agents directory** | `.claude/agents/<name>.md` | `.opencode/agents/<name>.md` |
| **Global skills** | `~/.claude/skills/` | `~/.config/opencode/skills/` |
| **Global commands** | N/A | `~/.config/opencode/commands/` |
| **Global agents** | N/A | `~/.config/opencode/agents/` |
| **Config file** | `.claude/settings.json` | `opencode.json` or `opencode.jsonc` |
| **Skill tool** | `Skill` | `skill` (native) or `systematic_skill` (bundled) |
| **Task/subagent tool** | `Task` | `@mention` or `delegate_task` |
| **Todo tool** | `TodoWrite` | `todowrite` |
| **Question tool** | `AskUserQuestion` | `question` |
| **Command prefix** | `/compound-engineering:` | `/systematic:` |
| **Plugin prefix** | `compound-engineering:` | `systematic:` |

---

## Frontmatter Conversion

### Skills

#### CC Fields → OC Handling

| CC Field | OC Field | Conversion Action |
|----------|----------|-------------------|
| `name` | `name` | **Keep** - lowercase, hyphens, max 64 chars |
| `description` | `description` | **Keep** - critical for trigger matching |
| `model` | `model` | **Normalize** - adds provider prefix (e.g., `sonnet` → `anthropic/sonnet`), removes `inherit` |
| `allowed-tools` | — | **Pass through** - stored but not enforced by OC |
| `argument-hint` | `argument-hint` | **Keep** (used for autocomplete hints) |
| `disable-model-invocation` | `hidden` | **Map** - `true` → `hidden: true` |
| `user-invocable` | — | **Pass through** - used by skills-as-commands |
| `context: fork` | `subtask` | **Map** - `fork` → `subtask: true` |
| `agent` | `agent` | **Pass through** - routed through for skills-as-commands |
| `license` | `license` | **Keep** (optional) |
| `compatibility` | `compatibility` | **Keep** (optional) |
| `metadata` | `metadata` | **Keep** (optional) |

**Map-and-preserve strategy:** The converter uses a non-destructive approach — known CC fields are mapped to OC equivalents, and unknown fields pass through untouched. No fields are silently dropped.

**Systematic compatibility note:** Systematic reads skill frontmatter directly for its own tooling. CC fields are preserved for bundled skills to power **systematic_skill** and **skills-as-commands** behavior.

- `disable-model-invocation`: maps to `hidden: true` (hides from skill tool list).
- `user-invocable`: controls whether a skill is exposed as a command (skills-as-commands only).
- `context: fork`: maps to `subtask: true` when a skill is exposed as a command.
- `agent` / `model`: routed through when a skill is exposed as a command.
- `allowed-tools`: stored but not enforced by OC runtime.

#### Example Transformation

**Before (Claude Code):**
```yaml
---
name: brainstorming
description: Collaborative design workflow for exploring ideas
model: sonnet
allowed-tools: Read, Grep, WebSearch
disable-model-invocation: false
---

# Brainstorming

When brainstorming, use the Task tool to spawn research agents...
```

**After (OpenCode):**
```yaml
---
name: brainstorming
description: This skill should be used before implementing features, building components, or making changes. It guides exploring user intent, approaches, and design decisions before planning. Triggers on "let's brainstorm", "help me think through", "what should we build", "explore approaches", ambiguous feature requests, or when the user's request has multiple valid interpretations that need clarification.
---

# Brainstorming

When brainstorming, use delegate_task to spawn research agents...
```

**Key changes:**
1. `model` normalized (adds provider prefix) or removed if `inherit`
2. `allowed-tools` and `disable-model-invocation` passed through or mapped
3. Enhanced `description` to include **trigger conditions** (critical for auto-invocation)
4. Updated tool references in content

### Commands

#### CC Fields → OC Handling

| CC Field | OC Field | Conversion Action |
|----------|----------|-------------------|
| `name` | `name` | **Keep** or derive from filename |
| `description` | `description` | **Keep** |
| `argument-hint` | ❌ | **REMOVE** - use `$ARGUMENTS` in template |
| `model` | `model` | **Keep** if provider-qualified (e.g., `anthropic/claude-3-5-sonnet`) |
| `agent` | `agent` | **Keep** - specifies which agent executes |
| `subtask` | `subtask` | **Keep** - forces subagent invocation |

#### Template Syntax

| CC Syntax | OC Syntax | Notes |
|-----------|-----------|-------|
| `$ARGUMENTS` | `$ARGUMENTS` | Same - all args as string |
| `$0`, `$1`, `$2` | `$1`, `$2`, `$3` | **Shift by 1** - OC is 1-indexed |
| `$ARGUMENTS[0]` | `$1` | Use positional instead |
| `` !`command` `` | `` !`command` `` | Same - shell output injection |
| `@filename` | `@filename` | Same - file content injection |

### Agents

#### CC Fields → OC Handling

| CC Field | OC Field | Conversion Action |
|----------|----------|-------------------|
| `name` | — | **Pass through** (OC derives from filename but field is preserved) |
| `description` | `description` | **Keep** - required |
| `model: inherit` | ❌ | **Remove** - OC inherits by default |
| `model: sonnet` | `model: anthropic/claude-3-5-sonnet` | **Normalize** - add provider prefix |
| `model: opus` | `model: anthropic/claude-3-opus` | **Normalize** |
| `model: haiku` | `model: anthropic/claude-3-haiku` | **Normalize** |
| `tools` (array) | `tools` (map) | **Map** - `["Read", "Bash"]` → `{ read: true, bash: true }` |
| `disallowedTools` | merged into `tools` | **Merge** - `["Write"]` → adds `{ write: false }` to tools map |
| `maxSteps` / `maxTurns` | `steps` | **Rename** - takes `min(maxTurns, maxSteps)` if both present |
| `permissionMode` | `permission` | **Map** - `"full"` → `{ edit: "allow", bash: "allow", webfetch: "allow" }` |
| `disable-model-invocation` | `hidden` | **Map** - `true` → `hidden: true` |
| `skills` | — | **Pass through** - skills load via tool calls at runtime |
| `hooks` | — | **Pass through** - hooks configured separately in OC |
| N/A | `mode` | **ADD** - `primary`, `subagent`, or `all` |
| N/A | `temperature` | **ADD** - inferred from agent purpose |

#### Permission Mode Mapping

| CC `permissionMode` | OC `permission` |
|---------------------|-----------------|
| `full` | `{ edit: "allow", bash: "allow", webfetch: "allow" }` |
| `default` | `{ edit: "ask", bash: "ask", webfetch: "ask" }` |
| `plan` | `{ edit: "deny", bash: "deny", webfetch: "ask" }` |
| `bypassPermissions` | `{ edit: "allow", bash: "allow", webfetch: "allow" }` |
| (unknown) | `{ edit: "ask", bash: "ask", webfetch: "ask" }` (secure default) |

#### Tools Array → Map Conversion

The converter transforms CC `tools` arrays into OC tool permission maps:

```yaml
# Before (Claude Code):
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit

# After (OpenCode):
tools:
  read: true
  grep: true
  glob: true
  bash: true
  write: false
  edit: false
```

Tool names are canonicalized using `TOOL_NAME_MAP` (e.g., `TodoWrite` → `todowrite`, `Task` → `delegate_task`).

#### Model Normalization Rules

```
claude-*     → anthropic/claude-*
gpt-*        → openai/gpt-*
o1-*         → openai/o1-*
o3-*         → openai/o3-*
gemini-*     → google/gemini-*
inherit      → (remove field)
<other>      → anthropic/<other>
```

#### Temperature Inference

| Agent Keywords | Temperature |
|----------------|-------------|
| review, audit, security, sentinel, oracle, lint, verification, guardian | 0.1 |
| plan, planning, architecture, strategist, analysis, research | 0.2 |
| doc, readme, changelog, editor, writer | 0.3 |
| brainstorm, creative, ideate, design, concept | 0.6 |
| (default) | 0.3 |

#### Example Transformation

**Before (Claude Code):**
```yaml
---
name: code-simplicity-reviewer
description: Reviews code for unnecessary complexity and suggests simplifications
model: inherit
tools: Read, Grep, Glob
permissionMode: default
maxSteps: 20
---

You are a code simplicity expert...
```

**After (OpenCode):**
```yaml
---
name: code-simplicity-reviewer
description: Reviews code for unnecessary complexity and suggests simplifications
tools:
  read: true
  grep: true
  glob: true
permission:
  edit: ask
  bash: ask
  webfetch: ask
steps: 20
mode: subagent
temperature: 0.1
---

You are a code simplicity expert...
```

**Key changes:**
1. `model: inherit` removed (OC inherits by default)
2. `tools` array mapped to `tools` map with canonicalized names
3. `permissionMode: default` mapped to `permission` object
4. `maxSteps: 20` renamed to `steps: 20`
5. `mode` and `temperature` added by converter

---

## Content Transformations

### Tool Name Mappings

Update references in markdown content:

| CC Tool | OC Tool | Notes |
|---------|---------|-------|
| `Task` | `delegate_task` / `@mention` | Use delegate_task for programmatic, @agent for inline |
| `Skill` | `skill` (native) or `systematic_skill` | Systematic bundled skills use `systematic_skill` |
| `TodoWrite` | `todowrite` | Direct mapping |
| `AskUserQuestion` | `question` | Direct mapping |
| `Read` | `read` | Lowercase |
| `Write` | `write` | Lowercase |
| `Edit` | `edit` | Lowercase |
| `Bash` | `bash` | Lowercase |
| `Grep` | `grep` | Lowercase |
| `Glob` | `glob` | Lowercase |
| `WebFetch` | `webfetch` | Lowercase |
| `WebSearch` | `google_search` | Different name |

### Prefix Conversions

| CC Pattern | OC Pattern |
|------------|------------|
| `/compound-engineering:` | `/systematic:` |
| `/workflows:` | `/workflows:` | (keep if present) |
| `compound-engineering:` | `systematic:` |

### CC-Specific Syntax Handling

These CC-specific patterns are mapped or removed by the converter:

| Pattern | Action |
|---------|--------|
| `context: fork` in frontmatter | **Mapped** to `subtask: true` |
| `${CLAUDE_SESSION_ID}` | **Remove** - not available in OC |
| `CLAUDE.md` references | **Converted** to `AGENTS.md` by body transformer |

### Reference Updates

| CC Reference | OC Reference |
|--------------|--------------|
| `.claude/skills/` | `.opencode/skills/` |
| `.claude/commands/` | `.opencode/commands/` |
| `.claude/agents/` | `.opencode/agents/` |
| `~/.claude/` | `~/.config/opencode/` |
| `CLAUDE.md` | `AGENTS.md` |

---

## Systematic Plugin Specifics

### Bundled Content Organization

```
systematic/
├── skills/              # Bundled skills (SKILL.md format)
│   └── <skill-name>/
│       └── SKILL.md
├── agents/              # Bundled agents (Markdown format)
│   └── <agent-name>.md
└── commands/            # Bundled commands (Markdown format)
    └── <command-name>.md
```

### Skill Resolution Priority

1. **Project skills**: `.opencode/skills/` in current project
2. **User skills**: `~/.config/opencode/skills/`
3. **Bundled skills**: Provided by systematic plugin

### Tool Mapping Instruction

Include this instruction in skills that reference tools:

```markdown
**Tool Mapping for OpenCode:**
When skills reference tools you don't have, substitute OpenCode equivalents:
- `TodoWrite` → `todowrite`
- `Task` tool with subagents → Use OpenCode's subagent system (@mention)
- `Skill` tool → OpenCode's native `skill` tool
- `SystematicSkill` tool → `systematic_skill` (Systematic plugin skills)
- `Read`, `Write`, `Edit`, `Bash` → Your native tools
- `AskUserQuestion` tool → Use OpenCode's native `question` tool
```

### Bootstrap Skill Pattern

The `using-systematic` skill is injected into the system prompt and teaches the agent:
- How to discover available skills
- When to use `systematic_skill` vs native `skill` tool
- Skill invocation discipline (invoke BEFORE any response)

---

## Conversion Checklist

### Skills (automated by converter)

- [x] `model` normalized (provider prefix added) or removed if `inherit`
- [x] `disable-model-invocation` mapped to `hidden: true`
- [x] `context: fork` mapped to `subtask: true`
- [ ] `allowed-tools`, `user-invocable`, `agent` — pass through (used by skills-as-commands)
- [ ] Enhance `description` with trigger conditions (manual — requires understanding of skill purpose)
- [x] Tool references updated in content (Task → delegate_task, etc.)
- [x] Directory references updated (.claude → .opencode)
- [ ] Convert dynamic injection syntax if present (manual)
- [ ] Add tool mapping instruction if skill references CC tools (manual)

### Commands (automated by converter)

- [x] `model` normalized (provider prefix added) or removed if `inherit`
- [ ] Shift positional argument indices ($0 → $1) (manual)
- [ ] Convert bash injection syntax (manual)
- [x] Prefix updated from `/compound-engineering:` to `/systematic:`

### Agents (automated by converter)

- [x] `model` normalized (provider prefix) or removed if `inherit`
- [x] `tools` array mapped to tools permission map (canonicalized names)
- [x] `disallowedTools` merged into tools map as `false` entries
- [x] `maxSteps`/`maxTurns` renamed to `steps`
- [x] `permissionMode` mapped to `permission` object
- [x] `disable-model-invocation` mapped to `hidden: true`
- [x] `mode` field added (`primary`, `subagent`, or `all`)
- [x] `temperature` field inferred from agent purpose
- [x] Tool references updated in content
- [ ] `skills`, `hooks` — pass through (not enforced by OC runtime)

---

## Features Not Supported in OpenCode

These CC features have no direct OC equivalent and require manual handling:

| CC Feature | Status |
|------------|--------|
| Dynamic injection `` !`command` `` | Not converted — pre-compute or use tool calls |
| `${CLAUDE_SESSION_ID}` | Not available in OC — remove |
| `user-invocable: false` | Passed through but not enforced by OC — use naming conventions |

### Previously Unsupported, Now Mapped

These features were previously stripped but are now automatically mapped by the converter:

| CC Feature | Converter Action |
|------------|-----------------|
| `model` in skill/agent/command | Normalized with provider prefix (or removed if `inherit`) |
| `disable-model-invocation` | Mapped to `hidden: true` |
| `context: fork` | Mapped to `subtask: true` |
| `permissionMode` in agents | Mapped to `permission` object |
| `tools` array in agents | Mapped to tools permission map |
| `disallowedTools` in agents | Merged into tools map as `false` entries |
| `maxSteps`/`maxTurns` in agents | Renamed to `steps` |

---

## OpenCode-Only Features to Leverage

When converting, consider using these OC-specific capabilities:

| Feature | Usage |
|---------|-------|
| `mode: all` in agents | Single definition for both primary and subagent use |
| `temperature` per agent | Fine-tune creativity (0.1 for review, 0.6 for brainstorm) |
| Per-agent model selection | Cost optimization (cheap for tests, premium for architecture) |
| `hidden: true` in agents | Internal-only subagents |
| JSONC config | Add comments to configuration |
| Granular bash permissions | Glob patterns for command-level control |

---

## Example: Full Skill Conversion

### Original (CEP/Claude Code)

**File:** `compound-engineering/skills/brainstorming/SKILL.md`

```yaml
---
name: brainstorming
description: Collaborative design workflow for exploring ideas
model: sonnet
allowed-tools: Read, Grep, WebSearch, Task
---

# Brainstorming

This skill provides a systematic approach to brainstorming.

## Usage
When invoked, use the Task tool to spawn research agents...

## Process
1. Understand requirements
2. Explore approaches
3. Document decisions

Reference `.claude/skills/` for related skills.
```

### Converted (Systematic/OpenCode)

**File:** `systematic/skills/brainstorming/SKILL.md`

```yaml
---
name: brainstorming
description: This skill should be used before implementing features, building components, or making changes. It guides exploring user intent, approaches, and design decisions before planning. Triggers on "let's brainstorm", "help me think through", "what should we build", "explore approaches", ambiguous feature requests, or when the user's request has multiple valid interpretations that need clarification.
---

# Brainstorming

This skill provides a systematic approach to brainstorming.

## Usage
When invoked, use delegate_task or @mention to spawn research agents...

## Process
1. Understand requirements
2. Explore approaches
3. Document decisions

Reference `.opencode/skills/` or use `systematic_skill` for bundled skills.
```

**Changes made:**
1. ✅ `model: sonnet` normalized to `model: anthropic/sonnet` (or removed if `inherit`)
2. ✅ `allowed-tools` passed through (not stripped)
3. ✅ Enhanced `description` with trigger conditions (manual step)
4. ✅ Changed `Task tool` → `delegate_task or @mention`
5. ✅ Changed `.claude/skills/` → `.opencode/skills/` + systematic_skill reference

---

## Automated Conversion Pipeline

The Systematic plugin includes a converter at `src/lib/converter.ts`:

### Current Capabilities

The converter uses a **map-and-preserve strategy** — known CC fields are transformed to OC equivalents, and unknown fields pass through untouched. No fields are silently dropped.

| Capability | Details |
|------------|---------|
| **Agent frontmatter transformation** | Maps tools→map, maxSteps→steps, permissionMode→permission, disable-model-invocation→hidden; normalizes model; infers temperature; adds mode |
| **Skill frontmatter transformation** | Normalizes model, maps context:fork→subtask, maps disable-model-invocation→hidden; unknown fields preserved |
| **Command frontmatter transformation** | Normalizes model (adds provider prefix), removes `inherit` models |
| **Body content transformation** | Tool name mappings, path replacements, prefix conversions |
| **Model normalization** | Adds provider prefix (claude-*→ anthropic/claude-*) |
| **Caching** | Avoids redundant processing via file mtime + converter version key (`CONVERTER_VERSION`) |

### Tool Name Transformations (Automated)

| CC Tool | OC Tool | Pattern |
|---------|---------|---------|
| `Task` | `delegate_task` | Context-aware (avoids "Task tool" false positives) |
| `TodoWrite` | `todowrite` | Direct replacement |
| `AskUserQuestion` | `question` | Direct replacement |
| `WebSearch` | `google_search` | Direct replacement |
| `WebFetch` | `webfetch` | Direct replacement |
| `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob` | lowercase | Context-aware (requires "tool" or "to" context) |
| `Skill` | `skill` | Only when followed by "tool" |

### Path Transformations (Automated)

| CC Path | OC Path |
|---------|---------|
| `.claude/skills/` | `.opencode/skills/` |
| `.claude/commands/` | `.opencode/commands/` |
| `.claude/agents/` | `.opencode/agents/` |
| `~/.claude/` | `~/.config/opencode/` |
| `CLAUDE.md` | `AGENTS.md` |
| `/compound-engineering:` | `/systematic:` |
| `compound-engineering:` | `systematic:` |

### Remaining Gaps (Manual Attention Required)

| Gap | Workaround |
|-----|------------|
| `${CLAUDE_SESSION_ID}` | Remove - not available in OC |
| Description enhancement with trigger conditions | Manual - requires understanding of skill purpose |
| Complex tool contexts | May require manual review for false positives/negatives |

### Usage Options

The converter supports a `skipBodyTransform` option to disable body content transformations:

```typescript
import { convertContent } from './lib/converter.js'

// Full transformation (default)
const converted = convertContent(content, 'skill')

// Skip body transformations (frontmatter only)
const convertedFrontmatterOnly = convertContent(content, 'skill', { 
  skipBodyTransform: true 
})
```

### Extending the Converter

To add new transformations, modify the constants and mapping functions in `src/lib/converter.ts`:

```typescript
// Add new body tool mappings (regex pattern → replacement string)
const TOOL_MAPPINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNewTool\b/g, 'new_tool'],
  // ...existing mappings
]

// Add new frontmatter tool name mappings (for tools arrays)
const TOOL_NAME_MAP: Record<string, string> = {
  newtool: 'new_tool',
  // ...existing mappings (must stay in sync with TOOL_MAPPINGS)
}

// Add new path replacements
const PATH_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/new-path/g, 'replacement-path'],
  // ...existing replacements
]

// Add new permission mode mappings
const PERMISSION_MODE_MAP: Record<string, PermissionConfig> = {
  newmode: { edit: 'ask', bash: 'deny', webfetch: 'ask' },
  // ...existing mappings
}
```

**Important:** After changing mapping logic, bump `CONVERTER_VERSION` to invalidate cached conversions.

---

## Testing Conversions

After converting, verify:

1. **Skill loads correctly**: `systematic_skill` or `skill` tool returns content
2. **Frontmatter parses**: No YAML errors
3. **Description triggers**: Model auto-invokes skill when appropriate
4. **Tool references work**: Referenced tools exist in environment
5. **Directory references valid**: Paths point to correct locations
6. **Body transformations applied**: Tool names and paths converted correctly
7. **Frontmatter fields mapped**: tools→map, maxSteps→steps, permissionMode→permission
8. **Idempotency**: Running the converter twice produces the same output

Run the converter tests to validate:

```bash
# Unit tests (86 tests including idempotency checks)
bun test tests/unit/converter.test.ts

# Integration tests (validates real bundled asset conversion)
bun test tests/integration/converter-validation.test.ts
```

---

## Related Resources

- [CEP Source](https://github.com/EveryInc/compound-engineering-plugin)
- [Oh My OpenCode Loader](https://github.com/code-yeongyu/oh-my-opencode)
- [Superpowers Plugin](https://github.com/obra/superpowers)
- [OpenCode Docs - Skills](https://opencode.ai/docs/skills/)
- [OpenCode Docs - Commands](https://opencode.ai/docs/commands/)
- [OpenCode Docs - Agents](https://opencode.ai/docs/agents/)
- [Claude Code Docs - Skills](https://code.claude.com/docs/en/skills)
- [Migration Article](https://www.devashish.me/p/migrating-from-claude-code-to-opencode)
