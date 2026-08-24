# Structure

> This document describes where things live and why. For architectural decisions and data flow see
> `ARCHITECTURE.md`. For contributor conventions and anti-patterns see `AGENTS.md`.

## Directory Layout

```
systematic/
├── src/              # TypeScript plugin + CLI source
│   ├── index.ts      # OpenCode plugin entry — default export only
│   ├── pi.ts         # Pi extension entry — default export only
│   ├── cli.ts        # CLI entry (list / capabilities / validate-review-artifact / config / setup --harness / pi-subagents)
│   └── lib/          # Core modules
├── skills/           # 31 bundled skills (one directory per skill, SKILL.md format)
├── agents/           # 37 bundled agents (5 category subdirectories)
├── docs/             # Starlight/Astro docs workspace (separate bun workspace)
│   ├── scripts/      # Content generation from bundled assets
│   ├── src/content/  # Manual guides + generated reference pages
│   └── solutions/    # Documented solutions to past problems
├── evals/            # Local OpenCode eval cases + runner output (source/installed mode harness checks)
├── registry/         # OCX registry config + omo/standalone profiles
├── scripts/          # Build-time + CI scripts (integrity, schema codegen, registry, CC plugin build, evals)
├── assets/           # Static assets (banner SVG)
├── tests/
│   ├── unit/         # 60 unit test files
│   └── integration/  # 11 integration test files
├── .opencode/        # Project-specific OpenCode config (theme, TUI)
├── .claude-plugin/   # marketplace.json — Claude Code marketplace catalog entry
└── dist/             # Compiled output (generated, not committed)
```

## Directory Purposes

### `src/`

**Purpose:** All TypeScript source for the npm package.

**Contains:** OpenCode plugin entry point, Pi extension entry point, CLI entry point, and the `lib/`
subdirectory of core modules.

**Key files:**
- `src/index.ts` — plugin factory (`SystematicPlugin`), registers every OpenCode hook Systematic
  provides (config, tool, the workflow-guard observation hooks, and the system transform)
- `src/pi.ts` — Pi extension factory (`systematicPiExtension`), registers `before_agent_start` for
  bootstrap injection plus the `systematic_skill` and `systematic_delegate` tools. No workflow guard.
- `src/cli.ts` — CLI commands: `list`, `capabilities`, `validate-review-artifact <path>`,
  `config show/path`, `setup --harness opencode|pi`, `pi-subagents <subcommand>` (Claude Code has no
  CLI setup step — it installs as a prebuilt plugin via marketplace, see `scripts/`)
- `src/lib/setup.ts` — `setupHarness`: atomic/backed-up/idempotent, project-local-only harness config writes
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

### `skills/`

**Purpose:** Bundled skill content shipped with the npm package.

**Contains:** One subdirectory per skill. Each subdirectory contains a `SKILL.md` file with YAML
frontmatter (`name`, `description`) and the skill body.

**Key files:** `skills/<name>/SKILL.md` — the skill definition. The `name` field determines the
`systematic:` prefixed command name registered in OpenCode.

### `agents/`

**Purpose:** Bundled agent definitions shipped with the npm package.

**Contains:** Five category subdirectories — `design/`, `document-review/`, `research/`,
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
- `scripts/generate-registry.ts` — regenerates `registry/registry.jsonc` from skill/agent frontmatter
  (source of truth); pass `--check` for drift detection (`bun run registry:drift`)
- `scripts/build-registry.ts` — builds the OCX registry output packument from `registry/registry.jsonc`;
  pass `--validate-only` to validate without writing (`bun run registry:validate`)
- `scripts/generate-pi-subagents-personas.ts` — curates and writes the Pi-subagents persona fixture;
  pass `--check` for drift detection
- `scripts/generate-agent-browser-skill.ts` — generates the agent-browser skill content; pass
  `--check` for drift detection
- `scripts/generate-config-schema.ts` — JSON Schema codegen + drift check
- `scripts/generate-review-artifact-schema.ts` — regenerates
  `skills/ce-review/references/review-summary-schema.json` from the Zod schema in
  `src/lib/review-artifact-schema.ts`; pass `--check` for drift detection (`bun run review-schema:drift`)
- `scripts/build-claude-code-plugin.ts` — generates the self-contained Claude Code plugin bundle
  (`claude-code/`, gitignored staging) from `skills/` and `agents/`; CI publishes the output to the
  orphan `claude-code-plugin` branch, never committed to `main`
- `scripts/run-evals.ts` — local eval CLI: creates isolated source/installed-mode fixtures, executes
  eval cases from `evals/cases/`, and persists privacy-checked results to `evals/runs/<runId>/`
- `scripts/dispatch-release-notes.sh` — invoked by the semantic-release `successCmd`; dispatches the
  release-notes narrative-rewrite workflow
- `scripts/lib/`, `scripts/eval-cases/` — shared helpers and eval case definitions consumed by
  `run-evals.ts`

### `evals/`

**Purpose:** Local eval harness for verifying host behavior (bootstrap loading, skill discovery
coverage, model inheritance) against a real OpenCode runtime, in both source and npm-installed mode.

**Contains:**
- `evals/cases/opencode/*.json` — eval case manifests (`bootstrap-loading`, `fixture-local-write`,
  `host-skill-coverage`, `model-inheritance`)
- `evals/runs/` — persisted run output, one directory per `runId`; `manifest.json` is the completion
  marker. Gitignored.
- `evals/README.md` — CLI invocation contract for `scripts/run-evals.ts`

**Key workflow:** Run via `bun scripts/run-evals.ts --case <id> --mode <source|installed> --seed <seed> --clock <ISO-timestamp>`. Persisted output is allowlisted and privacy-checked — no raw stdout/stderr, secrets, or absolute paths.

### `tests/`

**Purpose:** Test suite for the TypeScript source.

**Contains:**
- `tests/unit/` — 60 unit test files covering `src/lib/` modules, `scripts/` build/codegen scripts,
  and `docs/scripts/` generation scripts
- `tests/integration/` — 11 integration test files (skip automatically if deps unavailable)

**Pattern:** Tests use `bun:test` with `describe`/`it`. Filesystem tests use real temp directories;
no mocking libraries.

### `.opencode/`

**Purpose:** Project-specific OpenCode configuration. Not shipped in the npm package.

**Contains:** `themes/systematic.json` and `tui.json`. Everything else under this directory
is local tooling state and is gitignored.

`findCommandsInDir` (`src/lib/commands.ts`) still discovers `.opencode/commands/` for
backward compatibility, but this repository ships no project commands of its own — the
directory is absent.

### `.claude-plugin/`

**Purpose:** Claude Code marketplace catalog, committed to `main`.

**Contains:** `marketplace.json` — points the `systematic` plugin entry at the `claude-code-plugin`
branch ref. Users install via `claude plugin marketplace add marcusrbrown/systematic` then
`claude plugin install systematic@systematic`.

## Key File Locations

### Entry Points

| File | Role |
|------|------|
| `src/index.ts` | OpenCode plugin entry — `SystematicPlugin` default export |
| `src/pi.ts` | Pi extension entry — `systematicPiExtension` default export |
| `src/cli.ts` | CLI entry — `list`, `capabilities`, `validate-review-artifact`, `config`, `setup --harness`, `pi-subagents` commands |

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
| `scripts/generate-registry.ts` | Registry generation from frontmatter + drift check |
| `scripts/build-registry.ts` | OCX registry output packument builder |
| `scripts/generate-config-schema.ts` | JSON Schema codegen |
| `scripts/build-claude-code-plugin.ts` | Claude Code plugin bundle builder |
| `scripts/run-evals.ts` | Local eval CLI + fixture lifecycle |
| `.claude-plugin/marketplace.json` | Claude Code marketplace catalog entry |
| `docs/scripts/transform-content.ts` | Docs reference content generation |
| `docs/scripts/generate-config-reference.ts` | Docs config reference page codegen |

### Tests

| Path | Role |
|------|------|
| `tests/unit/` | Unit tests (60 files) |
| `tests/integration/` | Integration tests (11 files) |

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
  (`design`, `document-review`, `research`, `review`, `workflow`). Do NOT add a `model`
  field to frontmatter.

- **New config field** → add to `src/lib/config-schema.ts` (`SystematicConfigSchema`). If the field
  must be trust-protected (blocked from project-level config), add its name to `SECURITY_OVERLAY_FIELDS`.

- **New core module** → add `src/lib/<name>.ts`. Export only what other modules need. Add a
  corresponding `tests/unit/<name>.test.ts`, and register it on both gate-enforced surfaces: the
  `ARCHITECTURE.md` codemap and the matching module-table row in `src/lib/AGENTS.md`. If it is
  intentionally omitted from either, record it in that document's visible exclusions section
  instead. Verify both with `bun scripts/content-integrity.ts`.

- **New test** → `tests/unit/<module>.test.ts` for unit tests, `tests/integration/<name>.test.ts`
  for integration tests. Use real temp directories for filesystem isolation.

- **New docs page** → `docs/src/content/docs/<section>/<name>.md` (or `.mdx`). Run
  `bun run docs:generate` first to ensure generated reference content is up to date.

- **New build/CI script** → `scripts/<name>.ts`. Wire it up in `package.json` scripts if it needs
  a named command.

- **New project-only command** (not shipped) → `.opencode/commands/<name>.md`.
