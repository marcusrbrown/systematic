# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-04-25 | **Commit:** 7a64113 | **Branch:** main

## Overview

OpenCode plugin providing structured engineering workflows for AI-powered development. Originally adapted from the [Compound Engineering Plugin (CEP)](https://github.com/EveryInc/compound-engineering-plugin) for Claude Code, Systematic now evolves independently with its own direction for advanced AI workflows. The CLI retains CC-format conversion capabilities for ad-hoc imports.

**Two distinct parts:**
1. **TypeScript source** (`src/`) — Plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`) — Markdown content shipped with npm package

## Commands

```bash
bun install              # Install deps
bun run build            # Build to dist/
bun run typecheck        # Type check (strict)
bun run lint             # Biome linter
bun test tests/unit      # Unit tests (14 files)
bun test tests/integration  # Integration tests (2 files)
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
bun run docs:dev         # Local docs site
bun run docs:build       # Build docs (generates reference + builds Starlight)
bun run docs:generate    # Sync reference content from bundled assets
bun run registry:build   # Build OCX registry
bun run registry:validate  # Validate registry without building
```

## Stack

- **Runtime:** Bun (Node.js API compatible)
- **Language:** TypeScript 6.x strict mode
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
├── skills/               # 46 bundled skills (SKILL.md format)
├── agents/               # 50 bundled agents (6 categories: design/docs/document-review/research/review/workflow)
├── commands/             # Empty (.gitkeep) — commands converted to skills; dir kept for backward compat
├── docs/                 # Starlight docs workspace (see docs/AGENTS.md)
│   ├── scripts/          # Content generation from bundled assets
│   └── src/content/      # Manual guides + generated reference
├── registry/             # OCX registry config + profiles (omo, standalone)
├── scripts/              # Build + integrity scripts
├── assets/               # Static assets (banner SVG)
├── tests/
│   ├── unit/             # 14 test files
│   └── integration/      # 2 test files
├── .opencode/            # Project-specific OC config + commands
│   └── commands/         # Project-only commands (generate-readme)
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
| CC→OpenCode conversion (CLI) | `src/lib/converter.ts` |
| YAML frontmatter parsing | `src/lib/frontmatter.ts` |
| Agent config validation + type guards | `src/lib/validation.ts` |
| Asset discovery | `src/lib/skills.ts`, `agents.ts`, `commands.ts` |
| Directory walking | `src/lib/walk-dir.ts` |
| Config loading (JSONC) | `src/lib/config.ts` |
| CLI commands | `src/cli.ts` |
| Add new skill | `skills/<name>/SKILL.md` |
| Add new agent | `agents/<category>/<name>.md` |
| OCX registry building | `scripts/build-registry.ts` |
| Content integrity gate | `scripts/content-integrity.ts` |
| Docs content generation | `docs/scripts/transform-content.ts` |
| Docs site config | `docs/astro.config.mjs` |

## Code Map

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `SystematicPlugin` | export | src/index.ts:44 | 2 | Main plugin factory |
| `createConfigHandler` | fn | src/lib/config-handler.ts:221 | 3 | Config hook — merges bundled assets |
| `createSkillTool` | fn | src/lib/skill-tool.ts:88 | 3 | systematic_skill tool factory |
| `getBootstrapContent` | fn | src/lib/bootstrap.ts:43 | 3 | System prompt injection |
| `INTERNAL_AGENT_SIGNATURES` | const | src/lib/bootstrap.ts:12 | 2 | Skip heuristic for internal agents |
| `convertContent` | fn | src/lib/converter.ts:373 | 4 | CC→OpenCode body conversion |
| `convertFileWithCache` | fn | src/lib/converter.ts:413 | 6 | Cached file conversion (mtime invalidation) |
| `TOOL_NAME_MAP` | const | src/lib/converter.ts:85 | 2 | CC→OC tool name lookup |
| `findSkillsInDir` | fn | src/lib/skills.ts:90 | 6 | Skill discovery (highest centrality) |
| `findAgentsInDir` | fn | src/lib/agents.ts:49 | 4 | Agent discovery (category from subdir) |
| `findCommandsInDir` | fn | src/lib/commands.ts:27 | 4 | Command discovery |
| `loadConfig` | fn | src/lib/config.ts:47 | 5 | JSONC config loading + 3-source merge |
| `parseFrontmatter` | fn | src/lib/frontmatter.ts:19 | 16 | YAML frontmatter extraction — most-imported function |
| `walkDir` | fn | src/lib/walk-dir.ts:17 | 7 | Recursive dir walker (foundation layer) |
| `loadSkill` | fn | src/lib/skill-loader.ts:63 | 2 | Skill content loading + XML wrapping |


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

## Independence from CEP

Systematic evolves fully independently. No upstream sync path exists — the automated sync workflow, `/sync-cep` command, `convert-cc-defs` skill, and `sync-manifest.json` have all been removed. The CLI `convert` command remains available for ad-hoc CC → OpenCode format conversions.

The `commands/` directory contains only `.gitkeep` (all commands converted to skills in a past cycle). Command code paths (`findCommandsInDir`, `loadCommandAsConfig`) remain for backward compatibility and project-specific commands under `.opencode/commands/`.

## Notes

- Content-integrity gate runs in CI (build job) — catches phantom `systematic:*` refs and banned CC/CEP patterns
- Bootstrap injection is opt-out via `bootstrap.enabled: false`
- Converter caches results using file mtime
- CLI commands: `list` (skills/agents/commands), `convert` (file conversion), `config show/path`
- Experimental hook: `experimental.chat.system.transform`
- `docs/` is a separate workspace — run `bun run docs:generate` to sync reference content from bundled assets
- Use `bun src/cli.ts` for local dev instead of `bunx systematic` to avoid slow resolution
- `commands/` dir retained (with `.gitkeep`) for backward compatibility — code paths still support commands
- `registry/` provides OCX component-level installation with omo and standalone profiles
- `.opencode/commands/` has project-only commands: `generate-readme` (README generation)
