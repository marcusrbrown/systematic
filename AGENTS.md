# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-02-09 | **Commit:** b00201d | **Branch:** main

## Overview

OpenCode plugin providing structured engineering workflows. Converts Claude Code (CEP) agents, skills, and commands to OpenCode format.

**Two distinct parts:**
1. **TypeScript source** (`src/`) — Plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`, `commands/`) — Markdown content shipped with npm package

## Commands

```bash
bun install              # Install deps
bun run build            # Build to dist/
bun run typecheck        # Type check (strict)
bun run lint             # Biome linter
bun test tests/unit      # Unit tests (10 files)
bun test tests/integration  # Integration tests (2 files)
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
bun run docs:dev         # Local docs site
bun run docs:build       # Build docs (generates reference + builds Starlight)
```

## Stack

- **Runtime:** Bun (Node.js API compatible)
- **Language:** TypeScript 5.7+ strict mode
- **Modules:** ESM (`"type": "module"`)
- **Linter:** Biome (not ESLint/Prettier)
- **Tests:** `bun:test`
- **Docs:** Starlight/Astro (`docs/` workspace)
- **CI:** GitHub Actions (semantic-release, OSSF Scorecard, CodeQL)

## Structure

```
systematic/
├── src/
│   ├── index.ts          # Plugin entry (SystematicPlugin)
│   ├── cli.ts            # CLI entry (list/convert/config commands)
│   └── lib/              # 12 core modules (see src/lib/AGENTS.md)
├── skills/               # 8 bundled skills (SKILL.md format)
├── agents/               # 11 bundled agents (4 categories: design/research/review/workflow)
├── commands/             # 9 bundled commands (with workflows/ subdir)
├── docs/                 # Starlight docs workspace (see docs/AGENTS.md)
│   ├── scripts/          # Content generation from bundled assets
│   └── src/content/      # Manual guides + generated reference
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
| Agent config validation + type guards | `src/lib/validation.ts` |
| Asset discovery | `src/lib/skills.ts`, `agents.ts`, `commands.ts` |
| Directory walking | `src/lib/walk-dir.ts` |
| Config loading (JSONC) | `src/lib/config.ts` |
| CLI commands | `src/cli.ts` |
| Add new skill | `skills/<name>/SKILL.md` |
| Add new agent | `agents/<category>/<name>.md` |
| Add new command | `commands/<name>.md` |
| Docs content generation | `docs/scripts/transform-content.ts` |
| Docs site config | `docs/astro.config.mjs` |

## Code Map

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `SystematicPlugin` | export | src/index.ts:30 | 2 | Main plugin factory |
| `createConfigHandler` | fn | src/lib/config-handler.ts:205 | 3 | Config hook — merges bundled assets |
| `createSkillTool` | fn | src/lib/skill-tool.ts:87 | 3 | systematic_skill tool factory |
| `getBootstrapContent` | fn | src/lib/bootstrap.ts:32 | 3 | System prompt injection |
| `convertContent` | fn | src/lib/converter.ts:234 | 4 | CEP→OpenCode body conversion |
| `convertFileWithCache` | fn | src/lib/converter.ts:274 | 6 | Cached file conversion (mtime invalidation) |
| `findSkillsInDir` | fn | src/lib/skills.ts:90 | 6 | Skill discovery (highest centrality) |
| `findAgentsInDir` | fn | src/lib/agents.ts:47 | 4 | Agent discovery (category from subdir) |
| `findCommandsInDir` | fn | src/lib/commands.ts:27 | 4 | Command discovery |
| `loadConfig` | fn | src/lib/config.ts:47 | 5 | JSONC config loading + 3-source merge |
| `parseFrontmatter` | fn | src/lib/frontmatter.ts:19 | 7 | YAML frontmatter extraction (regex-based) |
| `walkDir` | fn | src/lib/walk-dir.ts:17 | 3 | Recursive dir walker (foundation layer) |
| `loadSkill` | fn | src/lib/skill-loader.ts:31 | 2 | Skill content loading + XML wrapping |

## Conventions

- **Formatting (Biome):** 2 spaces, single quotes, semicolons as-needed. Warns: `noExcessiveCognitiveComplexity`, `noNonNullAssertion`
- **Imports:** `node:` protocol for builtins, `.js` extension for internal, `import type` for types
- **TypeScript:** Functions over classes (zero classes). Explicit return types on exports. `unknown` + type guards, never `any`. Interfaces for data, union types + const enums for constraints
- **Error handling:** Return null/empty for non-critical, throw with context for critical, early return guards
- **Naming:** Files: kebab-case | Functions: camelCase | Types: PascalCase | Tests: `*.test.ts`
- **Testing:** `bun:test` with `describe`/`it`. Real temp dirs for FS isolation, no mocking libraries. Integration tests skip if deps unavailable

## Anti-Patterns

- `require()` — use ESM imports
- Omitting `.js` extension in relative imports
- Classes when functions suffice
- `any` — use `unknown` with type guards
- `@ts-ignore` or `@ts-expect-error`
- Non-null assertions (`!`) — Biome warns

## Plugin Architecture

Three hooks: `config` (merges bundled assets, existing config wins), `tool` (registers `systematic_skill`), `system.transform` (injects bootstrap prompt, skips title generation).

## Skill Format

```markdown
---
name: skill-name
description: Use when [condition] — [what it does]
---
```

Skills registered as commands with `systematic:` prefix (auto-prepended if no colon in name).

## Config Priority

`$OPENCODE_CONFIG_DIR/systematic.json` > project `.opencode/systematic.json` > user `~/.config/opencode/systematic.json` > defaults

All disabled lists merge (union), bootstrap config shallow-merges.

## Notes

- Bootstrap injection is opt-out via `bootstrap.enabled: false`
- Converter caches results using file mtime
- CLI commands: `list` (skills/agents/commands), `convert` (file conversion), `config show/path`
- Experimental hook: `experimental.chat.system.transform`
- `docs/` is a separate workspace — run `bun run docs:generate` to sync reference content from bundled assets
