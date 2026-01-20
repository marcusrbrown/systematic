# @fro.bot/systematic — OpenCode Plugin Design

**Date:** 2026-01-20  
**Status:** Draft  
**Author:** Marcus R. Brown + Claude

---

## Overview

**`@fro.bot/systematic`** is an OpenCode plugin that brings structured engineering workflows to AI-assisted development.

**Tagline:** *"Compound your engineering — each unit of work makes subsequent work easier"*

### Core Value Proposition

Port CEP's "compounding engineering" philosophy to OpenCode:

1. **Plan** → structured implementation plans before coding
2. **Work** → execute with tracking and isolation (worktrees)
3. **Review** → multi-perspective code review
4. **Compound** → document learnings for future leverage

### Technical Identity

| Aspect        | Decision                                          |
| ------------- | ------------------------------------------------- |
| Package       | `@fro.bot/systematic` on npm                      |
| Namespace     | `/sys:*` prefix (e.g., `/sys:plan`, `/sys:review`) |
| Development   | Bun                                               |
| Production    | Node-compatible (works with npm/npx)              |
| Config format | `systematic.json` (JSONC supported)               |

### Relationship to Source Projects

| Project     | What We Take                                       |
| ----------- | -------------------------------------------------- |
| CEP         | Content — curated skills, agents, commands         |
| Superpowers | Injection pattern — event hooks, system transform  |
| oMo         | Customization model — config merging, overrides    |

### Non-Goals (v1)

- Full CEP parity (we're curating)
- Claude Code compatibility (OpenCode only)
- MCP server bundling (users configure separately)

---

## Package Structure

```
systematic/
├── src/
│   ├── index.ts                   # Plugin export
│   ├── cli/
│   │   ├── index.ts               # CLI entry point
│   │   ├── init.ts                # Init command
│   │   ├── config.ts              # Config subcommands
│   │   └── list.ts                # List command
│   ├── bootstrap.ts               # Session injection logic
│   ├── config.ts                  # Config loading + merging
│   ├── tools/
│   │   ├── use-skill.ts           # use_skill tool
│   │   ├── find-skills.ts         # find_skills tool
│   │   └── index.ts
│   └── lib/
│       ├── skills-core.ts         # Skill discovery + parsing
│       ├── deep-merge.ts          # Config merge logic
│       └── paths.ts               # Path resolution utilities
├── skills/                        # Bundled skills
│   ├── planning/
│   │   └── SKILL.md
│   ├── code-review/
│   │   └── SKILL.md
│   └── ...
├── agents/                        # Bundled agents
│   ├── architecture-strategist.md
│   └── ...
├── commands/                      # Bundled commands
│   ├── sys-plan.md
│   └── ...
├── defaults/
│   └── bootstrap.md               # Default bootstrap prompt
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
```

### Build Output

```
dist/
├── index.js                       # Plugin entry (ESM)
├── cli.js                         # CLI entry
└── ...
```

---

## Installation

### npm Package

```bash
npm install @fro.bot/systematic
```

### Initialize

**Global install** — adds to `~/.config/opencode/opencode.json`:

```bash
npx @fro.bot/systematic init
```

```jsonc
{
  "plugins": [
    "@fro.bot/systematic"
  ]
}
```

**Project install** — adds to `./opencode.json`:

```bash
npx @fro.bot/systematic init --project
```

### User Customization Directory

Created via `npx @fro.bot/systematic config scaffold`:

```
~/.config/opencode/
├── systematic.json                # User config
└── systematic/                    # User overrides
    ├── skills/
    ├── agents/
    └── commands/
```

### Project Overrides

Highest priority — placed in project root:

```
.opencode/
└── systematic/
    ├── skills/
    ├── agents/
    └── commands/
```

---

## Configuration

### Config File

**Location:** `~/.config/opencode/systematic.json` (JSONC supported)

```jsonc
{
  // Disable bundled components
  "disabled_skills": ["git-worktree"],
  "disabled_agents": ["security-sentinel"],
  "disabled_commands": ["sys:compound"],

  // Bootstrap customization
  "bootstrap": {
    "enabled": true,                    // false to disable injection entirely
    "file": "~/.config/opencode/systematic/bootstrap.md"  // custom bootstrap
  },

  // Directory overrides (defaults shown)
  "paths": {
    "user_skills": "~/.config/opencode/systematic/skills",
    "user_agents": "~/.config/opencode/systematic/agents",
    "user_commands": "~/.config/opencode/systematic/commands"
  }
}
```

### Project-Level Override

**Location:** `.opencode/systematic.json`

Same schema — project config merges over user config.

### Merge Behavior

| Property          | Merge Strategy                        |
| ----------------- | ------------------------------------- |
| `disabled_*`      | Deduplicated union (user + project)   |
| `bootstrap`       | Object merge (project overrides user) |
| `paths`           | Object merge (project overrides user) |

### Priority Order

| Tier    | Scope                               |
| ------- | ----------------------------------- |
| project | `.opencode/systematic/`             |
| user    | `~/.config/opencode/systematic/`    |
| bundled | `node_modules/@fro.bot/systematic/` |

---

## Plugin Architecture

### Entry Point

```typescript
// src/index.ts
import { tool } from "@opencode-ai/plugin/tool"

export const SystematicPlugin = async ({ client, directory }) => {
  const config = await loadConfig(directory)
  const skillsManager = new SkillsManager(config, directory)

  return {
    tool: {
      systematic_use_skill: createUseSkillTool(client, skillsManager),
      systematic_find_skills: createFindSkillsTool(skillsManager),
      systematic_find_agents: createFindAgentsTool(config, directory),
      systematic_find_commands: createFindCommandsTool(config, directory),
    },

    event: async ({ event }) => {
      // Placeholder for future event handling
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/228
    experimental: {
      chat: {
        system: {
          transform: async ({ output }) => {
            if (!config.bootstrap.enabled) return

            const content = await getBootstrapContent(config, skillsManager)
            output.system ||= ""
            output.system += `\n\n${content}`
          }
        }
      }
    }
  }
}

export default SystematicPlugin
```

### Tools Provided

| Tool                       | Purpose                           |
| -------------------------- | --------------------------------- |
| `systematic_use_skill`     | Load a skill into context         |
| `systematic_find_skills`   | List available skills (all tiers) |
| `systematic_find_agents`   | List available agents             |
| `systematic_find_commands` | List available commands           |

### Bootstrap Injection

Uses `experimental.chat.system.transform` hook instead of `session.prompt()` to avoid model reset issue.

**Trade-offs:**
- ✅ Fixes model reset to "build" agent
- ⚠️ Cannot detect compact mode (no session ID in hook)
- Decision: Always inject full bootstrap for now

---

## CLI

### Commands

```bash
# Initialize globally
npx @fro.bot/systematic init

# Initialize for project only
npx @fro.bot/systematic init --project

# Config subcommands
npx @fro.bot/systematic config show        # Show merged config
npx @fro.bot/systematic config scaffold    # Create user override directories
npx @fro.bot/systematic config path        # Print config file location

# List bundled content
npx @fro.bot/systematic list [skills|agents|commands]
```

---

## Curated Content (v1)

### Commands (6)

| Command       | Source                  | Purpose                                              |
| ------------- | ----------------------- | ---------------------------------------------------- |
| `/sys:plan`   | CEP `/workflows:plan`   | Transform ideas into structured implementation plans |
| `/sys:work`   | CEP `/workflows:work`   | Execute work items with tracking                     |
| `/sys:review` | CEP `/workflows:review` | Multi-perspective code review                        |
| `/sys:compound` | CEP `/workflows:compound` | Document solved problems for future leverage       |
| `/sys:deepen` | CEP `/deepen-plan`      | Enhance plans with parallel research                 |
| `/sys:lfg`    | CEP `/lfg`              | Full autonomous workflow (plan → work → review)      |

### Skills (10)

| Skill            | Source            | Purpose                                         |
| ---------------- | ----------------- | ----------------------------------------------- |
| `planning`       | CEP + Superpowers | Structured plan creation                        |
| `code-review`    | CEP               | Multi-agent review patterns                     |
| `git-worktree`   | Superpowers       | Isolated workspace management                   |
| `tdd`            | Superpowers       | Test-driven development workflow                |
| `debugging`      | Superpowers       | Systematic root-cause analysis                  |
| `verification`   | Superpowers       | Evidence-before-assertions                      |
| `brainstorming`  | Superpowers       | Requirements exploration                        |
| `compound-docs`  | CEP               | Knowledge capture patterns                      |
| `agent-native`   | CEP               | Build AI agents with prompt-native architecture |
| `writing-skills` | Superpowers       | Create and edit skills                          |

### Agents (6)

| Agent                          | Source | Purpose                       |
| ------------------------------ | ------ | ----------------------------- |
| `architecture-strategist`      | CEP    | System design decisions       |
| `security-sentinel`            | CEP    | Security review               |
| `code-simplicity-reviewer`     | CEP    | Complexity reduction          |
| `framework-docs-researcher`    | CEP    | External documentation lookup |
| `pattern-recognition-specialist` | CEP  | Codebase pattern analysis     |
| `performance-oracle`           | CEP    | Performance review            |

### Not Included (v1)

- **Platform-specific:** Xcode, iOS simulator, Figma sync
- **Ruby/Rails-specific:** DHH style, Rails reviewers, gem writers
- **CEP-specific:** Plugin commands, marketplace tooling
- **Heavy dependencies:** Browser automation, image generation

---

## Implementation Plan

### Phase 1: Foundation
1. Initialize npm package with Bun
2. Set up TypeScript + build pipeline
3. Implement config loading + merging
4. Implement path resolution utilities

### Phase 2: Plugin Core
1. Create plugin entry point
2. Implement bootstrap injection (system transform hook)
3. Implement skill discovery + resolution
4. Create `systematic_use_skill` tool
5. Create `systematic_find_*` tools

### Phase 3: CLI
1. Create CLI entry point
2. Implement `init` command
3. Implement `config` subcommands
4. Implement `list` command

### Phase 4: Content
1. Port curated commands (6)
2. Port curated skills (10)
3. Port curated agents (6)
4. Write default bootstrap prompt

### Phase 5: Polish
1. Write README
2. Add tests
3. Publish to npm

---

## References

- [Compound Engineering Plugin (CEP)](https://github.com/EveryInc/compound-engineering-plugin)
- [Superpowers](https://github.com/obra/superpowers)
- [Oh My OpenCode (oMo)](https://github.com/code-yeongyu/oh-my-opencode)
- [Superpowers PR #228 — Bootstrap injection fix](https://github.com/obra/superpowers/pull/228)
