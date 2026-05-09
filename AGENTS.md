# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-05-01 | **Commit:** 2e9453a | **Branch:** main

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
bun test tests/unit      # Unit tests (15 files)
bun test tests/integration  # Integration tests (2 files)
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
bun run docs:dev         # Local docs site
bun run docs:build       # Build docs (generates reference + builds Starlight)
bun run docs:generate    # Sync reference content from bundled assets
bun run registry:build   # Build OCX registry
bun run registry:drift   # Check registry source drift vs generated assets
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
│   ├── index.ts          # Plugin entry (default export)
│   ├── cli.ts            # CLI entry (list/convert/config commands)
│   └── lib/              # 12 core modules (see src/lib/AGENTS.md)
├── skills/               # 45 bundled skills (SKILL.md format)
├── agents/               # 51 bundled agents (6 categories: design/docs/document-review/research/review/workflow)
├── docs/                 # Starlight docs workspace (see docs/AGENTS.md)
│   ├── scripts/          # Content generation from bundled assets
│   ├── src/content/      # Manual guides + generated reference
│   └── solutions/        # Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (module, tags, problem_type)
├── registry/             # OCX registry config + profiles (omo, standalone)
├── scripts/              # Build + integrity scripts
├── assets/               # Static assets (banner SVG)
├── tests/
│   ├── unit/             # 15 test files
│   └── integration/      # 2 test files
├── .opencode/            # Project-specific OC config + commands
│   └── commands/         # Project-only commands (generate-readme)
└── dist/                 # Build output
```

## Where to Look

| Task | Location |
|------|----------|
| Plugin hooks (config, tool, experimental.chat.system.transform) | `src/index.ts` |
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
| `SystematicPlugin` | const | src/index.ts:44 | 1 | Main plugin factory (default export) |
| `createConfigHandler` | fn | src/lib/config-handler.ts:221 | 3 | Config hook — merges bundled assets |
| `createSkillTool` | fn | src/lib/skill-tool.ts:88 | 3 | systematic_skill tool factory |
| `getBootstrapContent` | fn | src/lib/bootstrap.ts:43 | 3 | System prompt injection |
| `INTERNAL_AGENT_SIGNATURES` | const | src/lib/bootstrap.ts:12 | 2 | Skip heuristic for internal agents |
| `convertContent` | fn | src/lib/converter.ts:373 | 4 | CC→OpenCode body conversion |
| `convertFileWithCache` | fn | src/lib/converter.ts:413 | 6 | Cached file conversion (mtime invalidation) |
| `TOOL_NAME_MAP` | const | src/lib/converter.ts:85 | 2 | CC→OC tool name lookup |
| `findSkillsInDir` | fn | src/lib/skills.ts:90 | 6 | Skill discovery (highest centrality) |
| `findAgentsInDir` | fn | src/lib/agents.ts:49 | 4 | Agent discovery (category from subdir) |
| `findCommandsInDir` | fn | src/lib/commands.ts:27 | 4 | Backward-compat command discovery |
| `loadConfig` | fn | src/lib/config.ts:47 | 5 | JSONC config loading + 3-source merge |
| `parseFrontmatter` | fn | src/lib/frontmatter.ts:19 | 16 | YAML frontmatter extraction — most-imported function |
| `SKILL_FRONTMATTER_FIELDS` | const | src/lib/skills.ts:48 | 1 | Runtime skill frontmatter allow-list |
| `walkDir` | fn | src/lib/walk-dir.ts:17 | 7 | Recursive dir walker (foundation layer) |
| `loadSkill` | fn | src/lib/skill-loader.ts:63 | 2 | Skill content loading + XML wrapping |


## Conventions

- **Formatting (Biome):** 2 spaces, single quotes, semicolons as-needed. Warns: `noExcessiveCognitiveComplexity`, `noNonNullAssertion`
- **Imports:** `node:` protocol for builtins, `.js` extension for internal, `import type` for types
- **TypeScript:** Functions over classes (zero classes). Explicit return types on exports. `unknown` + type guards, never `any`. Interfaces for data, union types + const enums for constraints
- **Error handling:** Return null/empty for non-critical, throw with context for critical, early return guards
- **Naming:** Files: kebab-case | Functions: camelCase | Types: PascalCase | Tests: `*.test.ts`
- **Testing:** `bun:test` with `describe`/`it`. Real temp dirs for FS isolation, no mocking libraries. Integration tests skip if deps unavailable
- **Bundled agents:** MUST omit the `model` field in frontmatter. OpenCode subagents inherit the invoking primary agent's model when `model` is unset (see https://opencode.ai/docs/agents/). The literal value `model: inherit` is NOT supported — it crashed subagent dispatch on OpenCode versions prior to [sst/opencode#17888](https://github.com/sst/opencode/pull/17888) (March 2026), and is undocumented in OpenCode. The content-integrity gate enforces this.

  This rule applies to **bundled agent markdown/frontmatter only**. The runtime config emitted for categorized bundled agents may include source-owned `model` defaults from TypeScript code (see Configuration section). These are two separate layers: portable markdown stays model-free, while TypeScript code owns opinionated defaults that are emitted during config handling.

## Anti-Patterns

- `require()` — use ESM imports
- Omitting `.js` extension in relative imports
- Classes when functions suffice
- `any` — use `unknown` with type guards
- `@ts-ignore` or `@ts-expect-error`
- Non-null assertions (`!`) — Biome warns

## Plugin Architecture

Three hooks: `config` (merges bundled assets, existing config wins), `tool` (registers `systematic_skill`), `experimental.chat.system.transform` (injects bootstrap prompt, skips title generation).

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

The top-level `commands/` directory has been removed (all bundled commands were converted to skills). Command code paths (`findCommandsInDir`, `loadCommandAsConfig`) remain for backward compatibility and for project-specific commands under `.opencode/commands/`.

## Notes

- Content-integrity gate runs in CI (build job) — catches phantom `systematic:*` refs, frontmatter/model contract violations, and banned CC/CEP patterns
- Bootstrap injection is opt-out via `bootstrap.enabled: false`
- Converter caches results using file mtime
- CLI commands: `list` (skills/agents/commands), `convert` (file conversion), `config show/path`
- Experimental hook: `experimental.chat.system.transform`
- `docs/` is a separate workspace — run `bun run docs:generate` to sync reference content from bundled assets
- Use `bun src/cli.ts` for local dev instead of `bunx systematic` to avoid slow resolution
- No bundled `commands/` dir ships anymore — backward-compatible command code paths remain for `.opencode/commands/`
- `registry/` provides OCX component-level installation with omo and standalone profiles
- `.opencode/commands/` has project-only commands: `generate-readme` (README generation)
