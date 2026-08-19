# AGENTS.md - Coding Agent Guidelines for Systematic

**Generated:** 2026-05-01 | **Commit:** 2e9453a | **Branch:** main

## Overview

Systematic is a plugin providing compound-engineering loops (brainstorm, plan, work, review) for OpenCode, Pi, and Claude Code. It ships as an npm package with two distinct parts: TypeScript source (`src/`) for plugin logic and bundled Markdown assets (`skills/`, `agents/`) for content. Full architectural detail lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); directory layout and where to add new code lives in [`STRUCTURE.md`](STRUCTURE.md). This file covers contributor conventions, commands, and anti-patterns.

## For Architecture Questions

| Question | Go to |
|----------|-------|
| How does the plugin work? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Which plugin hooks are registered? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What invariants must hold? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What is the config priority order? | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Where do I put new code? | [`STRUCTURE.md`](STRUCTURE.md) |
| What does each directory contain? | [`STRUCTURE.md`](STRUCTURE.md) |
| What are the naming conventions? | [`STRUCTURE.md`](STRUCTURE.md) |
| What harnesses and compatibility evidence are verified? | [`HARNESSES.md`](HARNESSES.md) |
| What conventions apply to my code? | This file (Conventions section below) |
| What patterns should I follow? | This file (Conventions + Anti-Patterns below) |

Before implementing features or diagnosing failures, search `docs/solutions/` for related past solutions by frontmatter metadata and reuse verified patterns where they still apply.

## Commands

```bash
bun install              # Install deps
bun run build            # Build to dist/
bun run typecheck        # Type check (strict)
bun run lint             # Biome linter
bun test tests/unit      # Unit tests (20 files)
bun test tests/integration  # Integration tests (2 files)
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
bun run docs:dev         # Local docs site
bun run docs:build       # Build docs (generates reference + builds Starlight)
bun run docs:generate    # Sync reference content from bundled assets
bun run docs:verify      # Run docs build the same way CI does (use before approving docs-framework dep bumps)
bun run registry:build   # Build OCX registry
bun run registry:drift   # Check registry source drift vs generated assets
bun run registry:validate  # Validate registry without building
```

## Conventions

- **Formatting (Biome):** 2 spaces, single quotes, semicolons as-needed. Warns: `noExcessiveCognitiveComplexity`, `noNonNullAssertion`
- **Imports:** `node:` protocol for builtins, `.js` extension for internal, `import type` for types
- **TypeScript:** Functions over classes (zero classes). Explicit return types on exports. `unknown` + type guards, never `any`. Interfaces for data, union types + const enums for constraints
- **Error handling:** Return null/empty for non-critical, throw with context for critical, early return guards
- **Naming:** Files: kebab-case | Functions: camelCase | Types: PascalCase | Tests: `*.test.ts`
- **Testing:** `bun:test` with `describe`/`it`. Real temp dirs for FS isolation, no mocking libraries. Integration tests skip if deps unavailable
- **Bundled agents:** MUST omit the `model` field in frontmatter. OpenCode subagents inherit the invoking primary agent's model when `model` is unset (see https://opencode.ai/docs/agents/). The literal value `model: inherit` is NOT supported — it crashed subagent dispatch on OpenCode versions prior to [sst/opencode#17888](https://github.com/sst/opencode/pull/17888) (March 2026), and is undocumented in OpenCode. The content-integrity gate enforces this.

  Bundled agent markdown and the runtime config emitted by the plain npm plugin stay model-free unless user-owned config supplies an explicit model overlay. OpenCode subagents inherit the invoking model. OCX/OMO installers may provide curated category routing through their registry profile; plain npm consumers lose category-aware routing unless they opt in.

  **Generated surfaces:** Editing an `agents/` frontmatter `description` updates `registry/registry.jsonc`; if the persona is in `CURATED_PERSONAS`, it also updates `tests/fixtures/pi-subagents-personas/`. Editing any agent body updates the Pi fixture too. Adding, removing, or renaming a file under a skill's `references/` updates the registry's per-component file list. Regenerate and check both surfaces:

  ```bash
  bun scripts/generate-registry.ts
  bun scripts/generate-pi-subagents-personas.ts
  bun run registry:drift
  bun scripts/generate-pi-subagents-personas.ts --check
  ```

  See [`docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`](docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md) for prior art.

## Anti-Patterns

- `require()` — use ESM imports
- Omitting `.js` extension in relative imports
- Classes when functions suffice
- `any` — use `unknown` with type guards
- `@ts-ignore` or `@ts-expect-error`
- Non-null assertions (`!`) — Biome warns

## Cloned Dependency Source

Read-only dependency source repositories are available under `.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/anomalyco__opencode/` — `anomalyco/opencode` at `v1.17.6`; OpenCode monorepo containing `packages/sdk/js` (the `OpencodeClient` runtime that `client.provider.list()` and `client.model.list()` are dispatched through) and `packages/plugin` (the `PluginInput` type definitions and the plugin loader/hook iteration semantics — useful for verifying the FIFO assumption and `output` reference-sharing contract from PR #352).
- `.slim/clonedeps/repos/obra__superpowers/` — `obra/superpowers` at `v5.1.0`; MIT-licensed agentic skills framework. Source of the `test-driven-development` and `writing-skills` skills being imported into Systematic's bundle. Useful for verifying exact upstream content during the adaptation pass and tracking future upstream drift.
