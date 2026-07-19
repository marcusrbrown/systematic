# Architecture

> Systematic provides structured engineering workflows for AI-powered development, delivered natively
> to three harnesses — OpenCode, Pi, and Claude Code — from one source tree.
> This document describes the high-level structure; for file locations and naming conventions see `STRUCTURE.md`,
> and for contributor guidelines see `AGENTS.md`.

## Bird's Eye Overview

Systematic ships as an npm package with two distinct parts:

1. **TypeScript source** (`src/`) — plugin logic, tools, config handling
2. **Bundled assets** (`skills/`, `agents/`) — Markdown content shipped alongside the compiled code

At runtime, OpenCode loads the plugin via its default export (`src/index.ts`). The plugin registers
three hooks:

- **`config`** — discovers bundled agents, skills, and commands, then merges them into the OpenCode
  config. Existing user config wins; Systematic fills in what's missing.
- **`tool`** — registers the `systematic_skill` tool, which lets agents load skill content on demand.
- **`experimental.chat.system.transform`** — injects a bootstrap prompt into the system message and
  suppresses title generation for internal agents.

The CLI (`src/cli.ts`) is a separate entry point exposing `list`, `config`, and `setup --harness`
subcommands. It does not participate in the plugin hook lifecycle. `setup --harness opencode|pi`
performs project-local, atomic, idempotent config writes for those two harnesses; Claude Code has no
equivalent CLI setup step because it is delivered as a prebuilt plugin (see below), not a runtime
config write.

Systematic is delivered to three harnesses from this same source tree, with different packaging per
harness:

- **OpenCode** — the npm package itself is the OpenCode plugin, loaded directly via its default export.
- **Pi** — the same npm package, loaded as a Pi extension via `setup --harness pi`, which writes an
  entry into `.pi/settings.json`.
- **Claude Code** — a separate, self-contained plugin bundle built in CI from `skills/` and `agents/`
  by `scripts/build-claude-code-plugin.ts`. The build flattens agent personas, composes an output
  style from the using-systematic skill body, emits a declarative `SessionStart` hook, and translates
  internal identifiers (`ce:<name>`, `systematic:<category>:<name>`) into Claude Code's
  plugin-namespaced form. The generated bundle is never committed to `main` — CI publishes it to the
  orphan `claude-code-plugin` branch on every push to `main`. Users install it through Claude Code's
  plugin marketplace, pointed at `.claude-plugin/marketplace.json`.

## Codemap

Coarse module pipeline, roughly in dependency order:

```
Config loading
  src/lib/config.ts          — loadConfig: JSONC loading, 3-source merge (env > project > user)
  src/lib/config-schema.ts   — SystematicConfigSchema (Zod), validateConfig, SECURITY_OVERLAY_FIELDS

Asset discovery
  src/lib/walk-dir.ts        — walkDir: recursive directory walker (foundation for all discovery)
  src/lib/skills.ts          — findSkillsInDir, SKILL_FRONTMATTER_FIELDS
  src/lib/agents.ts          — findAgentsInDir (category derived from subdirectory name)
  src/lib/commands.ts        — findCommandsInDir (backward-compat; project .opencode/commands/ only)

Supporting utilities
  src/lib/frontmatter.ts     — parseFrontmatter: YAML extraction (most-imported function)
  src/lib/agent-colors.ts    — isValidAgentColor, OPENCODE_AGENT_COLOR_TOKENS
  src/lib/validation.ts      — agent config validation + type guards

Config handling (plugin config hook)
  src/lib/config-handler.ts  — createConfigHandler: merges discovered assets into OpenCode config

Skill tool (plugin tool hook)
  src/lib/skill-loader.ts    — loadSkill: content loading + XML wrapping
  src/lib/skill-tool.ts      — createSkillTool: systematic_skill tool factory

Bootstrap injection (plugin transform hook)
  src/lib/bootstrap.ts       — getBootstrapContent, INTERNAL_AGENT_SIGNATURES
```

Key symbols:

| Symbol | Location | Role |
|--------|----------|------|
| `SystematicPlugin` | `src/index.ts` | Main plugin factory — the default export |
| `createConfigHandler` | `src/lib/config-handler.ts` | Config hook implementation |
| `createSkillTool` | `src/lib/skill-tool.ts` | `systematic_skill` tool factory |
| `getBootstrapContent` | `src/lib/bootstrap.ts` | System prompt injection |
| `loadConfig` | `src/lib/config.ts` | JSONC config loading + 3-source merge |
| `SystematicConfigSchema` | `src/lib/config-schema.ts` | Canonical Zod schema for user config |
| `validateConfig` | `src/lib/config-schema.ts` | Safe parse wrapper returning `ValidationResult` |
| `SECURITY_OVERLAY_FIELDS` | `src/lib/config-schema.ts` | Trust-protected field names |
| `parseFrontmatter` | `src/lib/frontmatter.ts` | YAML frontmatter extraction |
| `findSkillsInDir` | `src/lib/skills.ts` | Skill discovery (highest call centrality) |
| `findAgentsInDir` | `src/lib/agents.ts` | Agent discovery |
| `walkDir` | `src/lib/walk-dir.ts` | Recursive dir walker (foundation layer) |
| `loadSkill` | `src/lib/skill-loader.ts` | Skill content loading + XML wrapping |

## Invariants

These must hold at all times. CI enforces them via the content-integrity gate.

1. **Single default export.** `src/index.ts` exports only `default`. Named exports break OpenCode's
   plugin loader.

2. **Bundled agent markdown omits `model`.** Agent `.md` files in `agents/` must not set `model` in
   frontmatter. OpenCode subagents inherit the invoking agent's model when `model` is absent. The
   literal value `model: inherit` is not supported and has caused crashes in older OpenCode versions.
   TypeScript code (not markdown) owns any opinionated model defaults emitted at runtime.

3. **Trust boundary on project config.** Project-level `systematic.json` cannot set `model`,
   `variant`, `permission`, or `skills`. These fields are listed in `SECURITY_OVERLAY_FIELDS` and
   are stripped during config merging.

4. **No phantom skill references.** Any `systematic:*` name referenced in skill or agent content
   must correspond to a real bundled skill. The content-integrity gate catches dangling references.

## Data Flow

```
OpenCode loads plugin
  └─ SystematicPlugin (src/index.ts)
       │
       ├─ config hook fires
       │    └─ createConfigHandler
       │         ├─ loadConfig          — reads systematic.json from 3 sources
       │         ├─ findSkillsInDir     — discovers skills/
       │         ├─ findAgentsInDir     — discovers agents/
       │         ├─ findCommandsInDir   — discovers .opencode/commands/
       │         └─ emits merged OpenCode config (agents + skill commands)
       │
       ├─ tool hook fires
       │    └─ createSkillTool          — registers systematic_skill tool
       │         └─ loadSkill           — loads + XML-wraps skill content on demand
       │
       └─ experimental.chat.system.transform hook fires
            └─ getBootstrapContent      — injects bootstrap prompt
                 └─ INTERNAL_AGENT_SIGNATURES — skip heuristic for internal agents
```

## Cross-Cutting Concerns

**Content-integrity gate** (`scripts/content-integrity.ts`) — runs in the CI build job. Catches
phantom `systematic:*` references, frontmatter/model contract violations, and banned CC/CEP
patterns. Must pass before any release.

**Registry drift detection** (`scripts/build-registry.ts --check`) — verifies that the OCX registry
config stays in sync with the generated bundled assets. Run via `bun run registry:drift`.

**Claude Code plugin build** (`scripts/build-claude-code-plugin.ts`) — generates the CC bundle from
`skills/` and `agents/` on every CI run; the build fails on any leftover source-namespace identifier
or unresolved bare reference. Output is gitignored build staging (`claude-code/`), never committed.

**Typed config validation** (`src/lib/config-schema.ts`) — all user-supplied config passes through
`validateConfig` before use. `SECURITY_OVERLAY_FIELDS` are stripped from project-level config
regardless of what the user writes.

**Model availability memoization** (`src/lib/model-availability.ts`) — caches provider/model
availability checks to avoid redundant API calls during a single plugin load cycle.

**Config priority** — `$OPENCODE_CONFIG_DIR/systematic.json` > project `.opencode/systematic.json`
> user `~/.config/opencode/systematic.json` > defaults. Disabled lists union-merge across all
sources; bootstrap config shallow-merges.
