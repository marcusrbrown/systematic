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
| **AskUserQuestion tool** | `AskUserQuestion` | `question` |
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
| `model` | ❌ | **REMOVE** - OC uses global/agent-level model selection |
| `allowed-tools` | ❌ | **REMOVE** - OC handles permissions via config |
| `argument-hint` | `argument-hint` | **Keep** (used for autocomplete hints) |
| `disable-model-invocation` | ❌ | **REMOVE** - not supported in OC |
| `user-invocable` | ❌ | **REMOVE** - not supported in OC |
| `context: fork` | ❌ | **REMOVE** - subagent execution not automatic |
| `agent` | ❌ | **REMOVE** - use explicit delegation in content |
| `license` | `license` | **Keep** (optional) |
| `compatibility` | `compatibility` | **Keep** (optional) |
| `metadata` | `metadata` | **Keep** (optional) |

**Systematic compatibility note:** Systematic reads skill frontmatter directly for its own tooling. CC-only fields are still accepted for bundled skills to power **systematic_skill** and **skills-as-commands** behavior, but they are not emitted into OpenCode's native skill definitions.

- `disable-model-invocation`: hides skills from the Systematic skill tool list.
- `user-invocable`: controls whether a skill is exposed as a command (skills-as-commands only).
- `context: fork`: maps to `subtask` when a skill is exposed as a command.
- `agent` / `model`: routed through when a skill is exposed as a command.
- `allowed-tools`: reserved for future use (stored but not enforced).

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
1. Removed `model`, `allowed-tools`, `disable-model-invocation`
2. Enhanced `description` to include **trigger conditions** (critical for auto-invocation)
3. Updated tool references in content

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
| `name` | ❌ | **REMOVE** - derived from filename |
| `description` | `description` | **Keep** - required |
| `model: inherit` | ❌ | **REMOVE** - OC inherits by default |
| `model: sonnet` | `model: anthropic/claude-3-5-sonnet` | **Normalize** - add provider prefix |
| `model: opus` | `model: anthropic/claude-3-opus` | **Normalize** |
| `model: haiku` | `model: anthropic/claude-3-haiku` | **Normalize** |
| `tools` | `tools` | **Keep** - array of allowed tools |
| `disallowedTools` | ❌ | **REMOVE** - use OC permission system |
| `permissionMode` | ❌ | **REMOVE** - use OC permission config |
| `skills` | ❌ | **REMOVE** - skills load via tool calls |
| `hooks` | ❌ | **REMOVE** - hooks configured separately |
| N/A | `mode` | **ADD** - `primary`, `subagent`, or `all` |
| N/A | `temperature` | **ADD** - inferred from agent purpose |

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
| review, audit, security, sentinel, oracle, lint, verification | 0.1 |
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
---

You are a code simplicity expert...
```

**After (OpenCode):**
```yaml
---
description: Reviews code for unnecessary complexity and suggests simplifications
mode: subagent
temperature: 0.1
---

You are a code simplicity expert...
```

---

## Content Transformations

### Tool Name Mappings

Update references in markdown content:

| CC Tool | OC Tool | Notes |
|---------|---------|-------|
| `Task` | `delegate_task` / `@mention` | Use delegate_task for programmatic, @agent for inline |
| `Skill` | `skill` (native) or `systematic_skill` | Systematic bundled skills use `systematic_skill` |
| `TodoWrite` | `update_plan` or `todowrite` | Depends on environment |
| `Read` | `read` | Lowercase |
| `Write` | `write` | Lowercase |
| `Edit` | `edit` | Lowercase |
| `Bash` | `bash` | Lowercase |
| `Grep` | `grep` | Lowercase |
| `Glob` | `glob` | Lowercase |
| `WebFetch` | `webfetch` | Lowercase |
| `WebSearch` | `google_search` | Different name - depends on environment |

### Prefix Conversions

| CC Pattern | OC Pattern |
|------------|------------|
| `/compound-engineering:` | `/systematic:` |
| `/workflows:` | `/workflows:` | (keep if present) |
| `compound-engineering:` | `systematic:` |

### CC-Specific Syntax Removal

Remove or adapt these CC-specific patterns:

| Pattern | Action |
|---------|--------|
| `context: fork` in frontmatter | Remove - use explicit delegation |
| `${CLAUDE_SESSION_ID}` | Remove - not available in OC |
| `CLAUDE.md` references | Convert to `AGENTS.md` or skill references |

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
- `TodoWrite` → `update_plan`
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

### Skills

- [ ] Remove `model` field from frontmatter
- [ ] Remove `allowed-tools` field from frontmatter
- [ ] Remove `disable-model-invocation` field
- [ ] Remove `user-invocable` field
- [ ] Remove `context: fork` field
- [ ] Remove `agent` field (handle delegation in content)
- [ ] Enhance `description` with trigger conditions
- [ ] Update tool references in content (Task → delegate_task, etc.)
- [ ] Update directory references (.claude → .opencode)
- [ ] Convert dynamic injection syntax if present
- [ ] Add tool mapping instruction if skill references CC tools

### Commands

- [ ] Remove unsupported frontmatter fields
- [ ] Normalize model field if present (add provider prefix)
- [ ] Shift positional argument indices ($0 → $1)
- [ ] Convert bash injection syntax
- [ ] Update prefix from `/compound-engineering:` to `/systematic:`

### Agents

- [ ] Remove `name` field (derived from filename)
- [ ] Normalize `model` field (add provider prefix) or remove if `inherit`
- [ ] Remove `permissionMode` field
- [ ] Remove `skills` field (load via tool calls instead)
- [ ] Remove `hooks` field (configure separately)
- [ ] Add `mode` field (`primary`, `subagent`, or `all`)
- [ ] Add `temperature` field (infer from purpose)
- [ ] Update tool references in content

---

## Features Not Supported in OpenCode

These CC features have no direct OC equivalent:

| CC Feature | Workaround |
|------------|------------|
| `model` in skill frontmatter | Use agent-level model selection |
| `allowed-tools` in skills | Configure via OC permissions |
| `disable-model-invocation` | No equivalent - all skills can be auto-invoked |
| `user-invocable: false` | No equivalent - use naming conventions |
| `context: fork` | Explicitly use subagent delegation |
| Dynamic injection `!`command`` | Pre-compute or use tool calls |
| `${CLAUDE_SESSION_ID}` | Not available |
| `permissionMode` in agents | Use OC permission config |
| Hooks in frontmatter | Configure in OC hooks system |
| `skills` preloading in agents | Load skills via tool calls |

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
1. ✅ Removed `model: sonnet`
2. ✅ Removed `allowed-tools`
3. ✅ Enhanced `description` with trigger conditions
4. ✅ Changed `Task tool` → `delegate_task or @mention`
5. ✅ Changed `.claude/skills/` → `.opencode/skills/` + systematic_skill reference

---

## Automated Conversion Pipeline

The Systematic plugin includes a converter at `src/lib/converter.ts`:

### Current Capabilities

| Capability | Details |
|------------|---------|
| **Agent frontmatter transformation** | Normalizes model, infers temperature, adds mode, removes `name` |
| **Skill frontmatter transformation** | Removes CC-only fields (`model`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `context`, `agent`) |
| **Command frontmatter transformation** | Normalizes model (adds provider prefix), removes `inherit` models, removes `argument-hint` |
| **Body content transformation** | Tool name mappings, path replacements, prefix conversions |
| **Model normalization** | Adds provider prefix (claude-*→ anthropic/claude-*) |
| **Caching** | Avoids redundant processing via file mtime checks |

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

To add new transformations, modify the constants in `src/lib/converter.ts`:

```typescript
// Add new tool mappings (regex pattern → replacement string)
const TOOL_MAPPINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNewTool\b/g, 'new_tool'],
  // ...existing mappings
]

// Add new path replacements
const PATH_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/new-path/g, 'replacement-path'],
  // ...existing replacements
]

// Add CC-only fields to strip from skills
const CC_ONLY_SKILL_FIELDS = [
  'new-cc-field',
  // ...existing fields
]
```

---

## Testing Conversions

After converting, verify:

1. **Skill loads correctly**: `systematic_skill` or `skill` tool returns content
2. **Frontmatter parses**: No YAML errors
3. **Description triggers**: Model auto-invokes skill when appropriate
4. **Tool references work**: Referenced tools exist in environment
5. **Directory references valid**: Paths point to correct locations
6. **Body transformations applied**: Tool names and paths converted correctly

Run the converter tests to validate:

```bash
bun test tests/unit/converter.test.ts
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
