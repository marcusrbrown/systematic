# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-02-08 | **Commit:** 38e69f0 | **Branch:** main

## Overview

OpenCode plugin providing systematic engineering workflows. Converts Claude Code (CEP) agents, skills, and commands to OpenCode format.

**Two distinct parts:**
1. **TypeScript source** (`src/`) — Plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`, `commands/`) — Markdown content shipped with npm package

## Commands

```bash
bun install              # Install deps
bun run build            # Build to dist/
bun run typecheck        # Type check (strict)
bun run lint             # Biome linter
bun test tests/unit      # Unit tests
bun test tests/integration  # Integration tests
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
```

## Stack

- **Runtime:** Bun (Node.js API compatible)
- **Language:** TypeScript 5.7+ strict mode
- **Modules:** ESM (`"type": "module"`)
- **Linter:** Biome (not ESLint/Prettier)
- **Tests:** `bun:test`
- **CI:** GitHub Actions (semantic-release, OSSF Scorecard, CodeQL)

## Structure

```
systematic/
├── src/
│   ├── index.ts          # Plugin entry (SystematicPlugin)
│   ├── cli.ts            # CLI entry (list/convert/config commands)
│   └── lib/              # Core implementation (see src/lib/AGENTS.md)
├── skills/               # 8 bundled skills (SKILL.md format)
├── agents/               # 11 bundled agents (4 categories)
├── commands/             # 9 bundled commands (with workflows/ subdir)
├── tests/
│   ├── unit/             # 10 test files
│   └── integration/      # 2 test files
└── dist/                 # Build output
```

## Where to Look

| Task | Location |
|------|----------|
| Plugin hooks (config, tool, system.transform) | `src/index.ts` |
| Config merging logic | `src/lib/config-handler.ts` |
| Skill tool implementation | `src/lib/skill-tool.ts` |
| Skill loading + formatting | `src/lib/skill-loader.ts` |
| Bootstrap injection | `src/lib/bootstrap.ts` |
| CEP→OpenCode conversion | `src/lib/converter.ts` |
| YAML frontmatter parsing | `src/lib/frontmatter.ts` |
| Agent config validation | `src/lib/validation.ts` |
| Asset discovery | `src/lib/skills.ts`, `agents.ts`, `commands.ts` |
| Directory walking | `src/lib/walk-dir.ts` |
| Config loading (JSONC) | `src/lib/config.ts` |
| CLI commands | `src/cli.ts` |
| Add new skill | `skills/<name>/SKILL.md` |
| Add new agent | `agents/<category>/<name>.md` |
| Add new command | `commands/<name>.md` |

## Code Map

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `SystematicPlugin` | export | src/index.ts:30 | 2 | Main plugin factory |
| `createConfigHandler` | fn | src/lib/config-handler.ts:182 | 3 | Config hook impl |
| `createSkillTool` | fn | src/lib/skill-tool.ts:87 | 2 | systematic_skill tool factory |
| `getBootstrapContent` | fn | src/lib/bootstrap.ts:32 | 2 | System prompt injection |
| `convertContent` | fn | src/lib/converter.ts:234 | 4 | CEP→OpenCode conversion |
| `findSkillsInDir` | fn | src/lib/skills.ts:90 | 6 | Skill discovery (highest centrality) |
| `findAgentsInDir` | fn | src/lib/agents.ts:47 | — | Agent discovery |
| `findCommandsInDir` | fn | src/lib/commands.ts:27 | — | Command discovery |
| `loadConfig` | fn | src/lib/config.ts:47 | — | JSONC config loading |
| `parseFrontmatter` | fn | src/lib/frontmatter.ts | — | YAML frontmatter extraction |
| `walkDir` | fn | src/lib/walk-dir.ts | — | Recursive dir walker |
| `loadSkill` | fn | src/lib/skill-loader.ts | — | Skill content loading + wrapping |

## Conventions

### Formatting (Biome)
- 2 spaces, single quotes, semicolons as-needed
- Biome warns on: `noExcessiveCognitiveComplexity`, `noNonNullAssertion`

### Imports
```typescript
import fs from 'node:fs'              // Node built-ins with node: protocol
import type { Plugin } from '@opencode-ai/plugin'  // External deps
import { loadConfig } from './lib/config.js'  // Internal with .js extension
```

### TypeScript
- Function declarations over classes (zero classes in codebase)
- Explicit return types on exported functions
- Interfaces for data structures (SkillInfo, AgentInfo, etc.)
- Union types + const enums for constrained values
- `unknown` with type guards instead of `any`

### Error Handling
- Return null/empty for non-critical failures
- Early return for guard clauses
- Throw with context for critical errors

### Naming
- Files: kebab-case
- Functions: camelCase
- Types/Interfaces: PascalCase
- Tests: `*.test.ts`

### Testing
- Bun built-in test runner (`bun:test`)
- `describe`/`it` nesting with `beforeEach`/`afterEach`
- Real temp directories for FS isolation (`mkdtempSync`/`rmSync`)
- No mocking libraries — creates real temp files
- Integration tests gracefully skip if external deps unavailable

## Anti-Patterns

- `require()` — use ESM imports
- Omitting `.js` extension in relative imports
- Classes when functions suffice
- `any` — use `unknown` with type guards
- `@ts-ignore` or `@ts-expect-error`
- Non-null assertions (`!`) — Biome warns

## Plugin Architecture

```
OpenCode loads plugin
       ↓
SystematicPlugin({ client, directory })
       ↓
┌──────────────────────────────────────────┐
│ config hook: createConfigHandler()       │
│   → Merges bundled agents/commands/skills│
├──────────────────────────────────────────┤
│ tool hook: systematic_skill              │
│   → Loads bundled skills on demand       │
├──────────────────────────────────────────┤
│ system.transform hook                    │
│   → Injects using-systematic bootstrap   │
└──────────────────────────────────────────┘
```

## Skill Format

```markdown
---
name: skill-name
description: Use when [condition] — [what it does]
---

# Skill Content
```

Skills are registered as commands with `systematic:` prefix.

## Config Priority

project `.opencode/systematic.json` > user `~/.config/opencode/systematic.json` > defaults

## Notes

- Bootstrap injection is opt-out via `bootstrap.enabled: false`
- Converter caches results using file mtime
- CLI commands: `list` (skills/agents/commands), `convert` (file conversion), `config show/path`
- Experimental hook: `experimental.chat.system.transform`
