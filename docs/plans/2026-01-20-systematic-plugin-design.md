# @fro.bot/systematic — OpenCode Plugin Design

**Date:** 2026-01-20
**Updated:** 2026-01-21
**Status:** Implemented
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
│   ├── cli.ts                     # CLI entry point
│   └── lib/
│       ├── skills-core.ts         # Skill discovery + parsing
│       └── config.ts              # Config loading + merging
├── skills/                        # Bundled skills (11)
│   ├── using-systematic/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── test-driven-development/
│   ├── systematic-debugging/
│   ├── verification-before-completion/
│   ├── executing-plans/
│   ├── using-git-worktrees/
│   ├── writing-skills/
│   ├── compound-docs/
│   └── agent-native-architecture/
├── agents/                        # Bundled agents (6)
│   ├── architecture-strategist.md
│   ├── security-sentinel.md
│   ├── code-simplicity-reviewer.md
│   ├── framework-docs-researcher.md
│   ├── pattern-recognition-specialist.md
│   └── performance-oracle.md
├── commands/                      # Bundled commands (9)
│   ├── sys-plan.md
│   ├── sys-work.md
│   ├── sys-review.md
│   ├── sys-debug.md
│   ├── sys-tdd.md
│   ├── sys-worktree.md
│   ├── sys-compound.md
│   ├── sys-deepen.md
│   └── sys-lfg.md
├── bootstrap.md                   # Default bootstrap prompt
├── tests/
│   ├── unit/                      # Unit tests (Bun)
│   └── integration/               # Integration tests (Bun)
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
```

### Build Output

```
dist/
├── index.js           # Plugin entry (ESM)
├── cli.js             # CLI entry (ESM)
└── chunk-*.js         # Shared code (ESM)
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
| project | `.opencode/skills/` etc.            |
| user    | `~/.config/opencode/skills/` etc.   |
| bundled | `node_modules/@fro.bot/systematic/` |

---

## Plugin Architecture

### Entry Point

```typescript
// src/index.ts
import { tool } from "@opencode-ai/plugin/tool"

export const SystematicPlugin = async ({ client, directory }) => {
  const config = await loadConfig(directory)

  return {
    tool: {
      systematic_skill: tool({...}),
    },

    // Workaround for session.prompt() model reset issue
    // See: https://github.com/obra/superpowers/pull/228
    experimental: {
      chat: {
        system: {
          transform: async ({ output }) => {
            if (!config.bootstrap.enabled) return

            const content = await getBootstrapContent(config)
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
| `systematic_skill`         | Load Systematic bundled skills    |

Use the native `skill` tool for non-Systematic skills.

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

## Curated Content (v1) — IMPLEMENTED

### Commands (9)

| Command         | Source                    | Purpose                                              |
| --------------- | ------------------------- | ---------------------------------------------------- |
| `/sys:plan`     | CEP `/workflows:plan`     | Transform ideas into structured implementation plans |
| `/sys:work`     | CEP `/workflows:work`     | Execute work items with tracking                     |
| `/sys:review`   | Superpowers               | Verification before completion                       |
| `/sys:debug`    | Superpowers               | Systematic debugging                                 |
| `/sys:tdd`      | Superpowers               | Test-driven development                              |
| `/sys:worktree` | Superpowers               | Git worktree creation                                |
| `/sys:compound` | CEP `/workflows:compound` | Document solved problems for future leverage         |
| `/sys:deepen`   | CEP `/deepen-plan`        | Enhance plans with parallel research                 |
| `/sys:lfg`      | CEP `/lfg`                | Full autonomous workflow (plan → work → review)      |

### Skills (11)

| Skill                         | Source            | Purpose                                         |
| ----------------------------- | ----------------- | ----------------------------------------------- |
| `using-systematic`            | Superpowers       | Bootstrap skill discovery                       |
| `brainstorming`               | Superpowers       | Requirements exploration                        |
| `writing-plans`               | Superpowers       | Structured plan creation                        |
| `test-driven-development`     | Superpowers       | TDD workflow                                    |
| `systematic-debugging`        | Superpowers       | Root-cause analysis                             |
| `verification-before-completion` | Superpowers    | Evidence-before-assertions                      |
| `executing-plans`             | Superpowers       | Plan execution with checkpoints                 |
| `using-git-worktrees`         | Superpowers       | Isolated workspace management                   |
| `writing-skills`              | Superpowers       | Create and edit skills                          |
| `compound-docs`               | CEP               | Knowledge capture patterns                      |
| `agent-native-architecture`   | CEP               | Build AI agents with prompt-native architecture |

### Agents (6)

| Agent                            | Source | Purpose                       |
| -------------------------------- | ------ | ----------------------------- |
| `architecture-strategist`        | CEP    | System design decisions       |
| `security-sentinel`              | CEP    | Security review               |
| `code-simplicity-reviewer`       | CEP    | Complexity reduction          |
| `framework-docs-researcher`      | CEP    | External documentation lookup |
| `pattern-recognition-specialist` | CEP    | Codebase pattern analysis     |
| `performance-oracle`             | CEP    | Performance review            |

### Not Included (v1)

- **Platform-specific:** Xcode, iOS simulator, Figma sync
- **Ruby/Rails-specific:** DHH style, Rails reviewers, gem writers
- **CEP-specific:** Plugin commands, marketplace tooling
- **Heavy dependencies:** Browser automation, image generation

---

## Testing

### Test Suite (42 tests)

```bash
# Unit tests only
bun run test

# Integration tests (includes OpenCode if installed)
bun run test:integration

# All tests
bun run test:all
```

**Unit Tests:**
- skills-core: frontmatter parsing, skill discovery, priority resolution
- plugin: file existence, JavaScript validity, CLI functionality

**Integration Tests:**
- priority: project > user > bundled resolution
- opencode: tool discovery, skill loading (runs automatically if OpenCode installed)

---

## Implementation Status

| Phase | Component | Status |
|-------|-----------|--------|
| 1 | npm package + build | ✅ |
| 1 | Config loading + merging | ✅ |
| 1 | Path resolution | ✅ |
| 2 | Plugin entry point | ✅ |
| 2 | Bootstrap injection | ✅ |
| 2 | Skill discovery | ✅ |
| 2 | Tools (use_skill, find_*) | ✅ |
| 3 | CLI (init, config, list) | ✅ |
| 4 | Commands (9) | ✅ |
| 4 | Skills (11) | ✅ |
| 4 | Agents (6) | ✅ |
| 5 | README | ✅ |
| 5 | Tests (42) | ✅ |
| 5 | npm publish | 🔲 |

---

## References

- [Compound Engineering Plugin (CEP)](https://github.com/EveryInc/compound-engineering-plugin)
- [Superpowers](https://github.com/obra/superpowers)
- [oh-my-openagent (oMo)](https://github.com/code-yeongyu/oh-my-openagent)
- [Superpowers PR #228 — Bootstrap injection fix](https://github.com/obra/superpowers/pull/228)
