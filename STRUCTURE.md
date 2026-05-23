# Structure

> This document describes where things live and why. For architectural decisions and data flow see
> `ARCHITECTURE.md`. For contributor conventions and anti-patterns see `AGENTS.md`.

## Directory Layout

```
systematic/
├── src/              # TypeScript plugin + CLI source
│   ├── index.ts      # Plugin entry — default export only
│   ├── cli.ts        # CLI entry (list / convert / config)
│   └── lib/          # 15 core modules
├── skills/           # 45 bundled skills (one directory per skill, SKILL.md format)
├── agents/           # 51 bundled agents (6 category subdirectories)
├── docs/             # Starlight/Astro docs workspace (separate bun workspace)
│   ├── scripts/      # Content generation from bundled assets
│   ├── src/content/  # Manual guides + generated reference pages
│   └── solutions/    # Documented solutions to past problems
├── registry/         # OCX registry config + omo/standalone profiles
├── scripts/          # Build-time + CI scripts (integrity, schema codegen, registry)
├── assets/           # Static assets (banner SVG)
├── tests/
│   ├── unit/         # 20 unit test files
│   └── integration/  # 2 integration test files
├── .opencode/        # Project-specific OpenCode config + commands
│   └── commands/     # Project-only commands (not shipped in npm package)
└── dist/             # Compiled output (generated, not committed)
```

## Directory Purposes

### `src/`

**Purpose:** All TypeScript source for the npm package.

**Contains:** Plugin entry point, CLI entry point, and the `lib/` subdirectory of core modules.

**Key files:**
- `src/index.ts` — plugin factory (`SystematicPlugin`), registers all three OpenCode hooks
- `src/cli.ts` — CLI commands: `list`, `convert`, `config show/path`
- `src/lib/config.ts` — JSONC config loading, 3-source merge
- `src/lib/config-schema.ts` — canonical Zod schema, `validateConfig`, `SECURITY_OVERLAY_FIELDS`
- `src/lib/config-handler.ts` — `createConfigHandler`: merges bundled assets into OpenCode config
- `src/lib/skill-tool.ts` — `createSkillTool`: `systematic_skill` tool factory
- `src/lib/skill-loader.ts` — `loadSkill`: content loading + XML wrapping
- `src/lib/bootstrap.ts` — `getBootstrapContent`, `INTERNAL_AGENT_SIGNATURES`
- `src/lib/skills.ts` — `findSkillsInDir`, `SKILL_FRONTMATTER_FIELDS`
- `src/lib/agents.ts` — `findAgentsInDir` (category from subdirectory name)
- `src/lib/commands.ts` — `findCommandsInDir` (backward-compat; project commands only)
- `src/lib/frontmatter.ts` — `parseFrontmatter` (most-imported function in the codebase)
- `src/lib/walk-dir.ts` — `walkDir` (foundation for all asset discovery)
- `src/lib/validation.ts` — agent config validation + type guards
- `src/lib/agent-colors.ts` — `isValidAgentColor`, `OPENCODE_AGENT_COLOR_TOKENS`
- `src/lib/converter.ts` — CC→OpenCode conversion (CLI only)

### `skills/`

**Purpose:** Bundled skill content shipped with the npm package.

**Contains:** One subdirectory per skill. Each subdirectory contains a `SKILL.md` file with YAML
frontmatter (`name`, `description`) and the skill body.

**Key files:** `skills/<name>/SKILL.md` — the skill definition. The `name` field determines the
`systematic:` prefixed command name registered in OpenCode.

### `agents/`

**Purpose:** Bundled agent definitions shipped with the npm package.

**Contains:** Six category subdirectories — `design/`, `docs/`, `document-review/`, `research/`,
`review/`, `workflow/`. Each agent is a single `.md` file with YAML frontmatter.

**Key constraint:** Agent frontmatter must NOT include a `model` field. The content-integrity gate
enforces this.

### `docs/`

**Purpose:** Starlight/Astro documentation site. Separate bun workspace — run commands from this
directory or via the root `bun run docs:*` scripts.

**Contains:**
- `docs/scripts/` — content generation scripts (`transform-content.ts`, `generate-config-reference.ts`)
- `docs/src/content/` — manual guides and generated reference pages
- `docs/solutions/` — documented solutions to past problems, organized by category with YAML
  frontmatter (`module`, `tags`, `problem_type`)
- `docs/astro.config.mjs` — Starlight site config

**Key workflow:** Run `bun run docs:generate` from the repo root to sync reference content from
bundled assets before editing or building the docs site.

### `registry/`

**Purpose:** OCX component-level installation config.

**Contains:** Registry config and two profiles — `omo` (full) and `standalone` (minimal). Used by
`bun run registry:build` / `registry:drift` / `registry:validate`.

### `scripts/`

**Purpose:** Build-time and CI automation scripts. Not shipped in the npm package.

**Key files:**
- `scripts/content-integrity.ts` — CI gate: validates frontmatter contracts, catches phantom refs
- `scripts/build-registry.ts` — OCX registry builder (pass `--check` for drift detection)
- `scripts/generate-config-schema.ts` — JSON Schema codegen + drift check

### `tests/`

**Purpose:** Test suite for the TypeScript source.

**Contains:**
- `tests/unit/` — 20 unit test files, one per module under test
- `tests/integration/` — 2 integration test files (skip automatically if deps unavailable)

**Pattern:** Tests use `bun:test` with `describe`/`it`. Filesystem tests use real temp directories;
no mocking libraries.

### `.opencode/`

**Purpose:** Project-specific OpenCode configuration. Not shipped in the npm package.

**Contains:**
- `.opencode/commands/` — project-only commands (e.g., `generate-readme`). These are not bundled;
  they exist only for contributors working in this repo.

## Key File Locations

### Entry Points

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry — `SystematicPlugin` default export |
| `src/cli.ts` | CLI entry — `list`, `convert`, `config` commands |

### Configuration

| File | Role |
|------|------|
| `src/lib/config-schema.ts` | Canonical Zod schema for all user config |
| `src/lib/config.ts` | JSONC loading + 3-source merge |
| `src/lib/config-handler.ts` | Plugin config hook — merges bundled assets |
| `biome.json` | Linter + formatter config |
| `tsconfig.json` | TypeScript compiler config |
| `package.json` | Package metadata, scripts, dependencies |

### Core Logic

| File | Role |
|------|------|
| `src/lib/skill-tool.ts` | `systematic_skill` tool registration |
| `src/lib/skill-loader.ts` | Skill content loading + XML wrapping |
| `src/lib/bootstrap.ts` | Bootstrap prompt injection |
| `src/lib/frontmatter.ts` | YAML frontmatter parsing |
| `src/lib/walk-dir.ts` | Recursive directory walker |
| `src/lib/validation.ts` | Agent config validation |
| `src/lib/agent-colors.ts` | Color token validation |

### Build / CI Scripts

| File | Role |
|------|------|
| `scripts/content-integrity.ts` | CI content-integrity gate |
| `scripts/build-registry.ts` | OCX registry builder + drift check |
| `scripts/generate-config-schema.ts` | JSON Schema codegen |
| `docs/scripts/transform-content.ts` | Docs reference content generation |
| `docs/scripts/generate-config-reference.ts` | Docs config reference page codegen |

### Tests

| Path | Role |
|------|------|
| `tests/unit/` | Unit tests (20 files, one per module) |
| `tests/integration/` | Integration tests (2 files) |

## Naming Conventions

- **Source files:** `kebab-case.ts` — e.g., `config-handler.ts`, `skill-loader.ts`
- **Test files:** `<module>.test.ts` — co-located under `tests/unit/`, mirroring `src/lib/`
- **Skill directories:** `skills/<kebab-name>/SKILL.md` — one directory per skill, fixed filename
- **Agent files:** `agents/<category>/<kebab-name>.md` — category is the subdirectory name
- **Functions:** `camelCase` — e.g., `findSkillsInDir`, `loadConfig`
- **Types/interfaces:** `PascalCase` — e.g., `SystematicConfigSchema`, `ValidationResult`
- **Constants:** `SCREAMING_SNAKE_CASE` for module-level constants — e.g., `SECURITY_OVERLAY_FIELDS`

## Where to Add New Code

- **New skill** → create `skills/<name>/SKILL.md` with `name` and `description` frontmatter fields.
  The `systematic:` prefix is auto-prepended if the name contains no colon.

- **New agent** → create `agents/<category>/<name>.md`. Choose an existing category subdirectory
  (`design`, `docs`, `document-review`, `research`, `review`, `workflow`). Do NOT add a `model`
  field to frontmatter.

- **New config field** → add to `src/lib/config-schema.ts` (`SystematicConfigSchema`). If the field
  must be trust-protected (blocked from project-level config), add its name to `SECURITY_OVERLAY_FIELDS`.

- **New core module** → add `src/lib/<name>.ts`. Export only what other modules need. Add a
  corresponding `tests/unit/<name>.test.ts`.

- **New test** → `tests/unit/<module>.test.ts` for unit tests, `tests/integration/<name>.test.ts`
  for integration tests. Use real temp directories for filesystem isolation.

- **New docs page** → `docs/src/content/docs/<section>/<name>.md` (or `.mdx`). Run
  `bun run docs:generate` first to ensure generated reference content is up to date.

- **New build/CI script** → `scripts/<name>.ts`. Wire it up in `package.json` scripts if it needs
  a named command.

- **New project-only command** (not shipped) → `.opencode/commands/<name>.md`.
