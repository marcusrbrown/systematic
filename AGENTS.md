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
| How do I run, hold, or recover a release? | [`RELEASING.md`](RELEASING.md) |
| What conventions apply to my code? | This file (Conventions section below) |
| What patterns should I follow? | This file (Conventions + Anti-Patterns below) |

Before implementing features or diagnosing failures, search `docs/solutions/` for related past solutions by frontmatter metadata and reuse verified patterns where they still apply.

## Commands

```bash
bun install              # Install deps
bun run build            # Build to dist/
bun run typecheck        # Type check (strict)
bun run typecheck:scripts  # Type check scripts + docs scripts too (required in CI)
bun run typecheck:all    # Type check tests + scripts too (required CI gate: tests + scripts + docs scripts)
bun run lint             # Biome linter
bun test tests/unit      # Unit tests
bun test tests/integration  # Integration tests
bun test                 # All tests
bun test --filter "pattern"  # Filter tests
bun run docs:dev         # Local docs site
bun run docs:build       # Build docs (generates reference + builds Starlight)
bun run docs:generate    # Sync reference content from bundled assets
bun run docs:verify      # Run docs build the same way CI does (use before approving docs-framework dep bumps)
bun run registry:build   # Build OCX registry
bun run registry:drift   # Check registry source drift vs generated assets
bun run registry:validate  # Validate registry without building
bun run registry:generate  # Regenerate registry/registry.jsonc
bun run pi-personas:generate  # Regenerate the Pi persona fixtures
bun run pi-personas:drift  # Check the Pi persona fixtures (write-free)
bun run config-reference:generate  # Regenerate the field reference in configuration.mdx
bun run config-reference:drift  # Check that field reference (write-free)
bun run surfaces:affected  # List the generated surfaces your changes touch (--run: regenerate them, then check)
bun run surfaces:regen   # Regenerate every committed generated surface
bun run surfaces:drift   # Check every surface and name each failure (CI runs this)
```

## Conventions

- **Formatting (Biome):** 2 spaces, single quotes, semicolons as-needed. Warns: `noExcessiveCognitiveComplexity`, `noNonNullAssertion`
- **Imports:** `node:` protocol for builtins, `.js` extension for internal, `import type` for types
- **TypeScript:** Functions over classes (zero classes). Explicit return types on exports, except Zod schema builders — annotating those erases the inferred shape. `unknown` + type guards, never `any`. Interfaces for data, union types + const enums for constraints
- **Error handling:** Return null/empty for non-critical, throw with context for critical, early return guards
- **Naming:** Files: kebab-case | Functions: camelCase | Types: PascalCase | Tests: `*.test.ts`
- **Testing:** `bun:test` with `describe`/`it`. Real temp dirs for FS isolation, no mocking libraries. Integration tests skip if deps unavailable
- **Tests must not modify tracked files:** guard script entry points with `if (import.meta.main)`, and pass a temp path to any test that reaches a writer. Check `git status` after `bun test tests/unit`. See [repo-file trap](docs/solutions/test-failures/unit-suite-rewrites-repo-file-trap-2026-07-17.md) and [unguarded generator](docs/solutions/test-failures/unguarded-generator-main-repairs-drift-when-imported-by-tests-2026-07-28.md).
- **A check that matches zero files proves nothing:** before trusting a batch rewrite or verification grep, confirm the count you expected ([source](docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md)).
- **Verify findings and absence claims against the exact checkout or ref that holds the code:** a worktree is not the primary checkout ([source](docs/solutions/workflow-issues/verify-reviewer-findings-against-the-real-checkout-2026-09-20.md)).
- **The PR title sets the release type:** the repo is squash-only, so the PR title becomes the commit subject semantic-release reads. The `.releaserc.yaml` rules apply first, and the analyzer defaults apply only when no custom rule matches.
  - Minor: `feat`.
  - Patch: `fix`, `perf`, `build` (any scope except `dev`), and `docs` scoped `readme`, `readme.md`, `skill`, `skills`, `agents` or `commands`. A breaking `build` or scoped `docs` commit still releases only a patch.
  - No release: `build(dev)`, and non-breaking `refactor`, `test`, `chore`, `style`, `ci` or other `docs`.
  - Major: any other breaking change.
  - See [`RELEASING.md`](RELEASING.md) and [source](docs/solutions/workflow-issues/pr-title-selects-release-type-under-squash-merge-2026-08-16.md).
- **Bundled agents:** MUST omit the `model` field in frontmatter. OpenCode subagents inherit the invoking primary agent's model when `model` is unset (see https://opencode.ai/docs/agents/). The literal value `model: inherit` is NOT supported — it crashed subagent dispatch on OpenCode versions prior to [sst/opencode#17888](https://github.com/sst/opencode/pull/17888) (March 2026), and is undocumented in OpenCode. The content-integrity gate enforces this.

  Bundled agent markdown and the runtime config emitted by the plain npm plugin stay model-free unless user-owned config supplies an explicit model overlay. OpenCode subagents inherit the invoking model. OCX/OMO installers may provide curated category routing through their registry profile; plain npm consumers lose category-aware routing unless they opt in.

  A flat `agents.<name>.model` overlay applies to both OpenCode agents and in-process Pi delegates, not just OpenCode.

  Creating a module under `src/lib/` also requires an `ARCHITECTURE.md` codemap entry and a `src/lib/AGENTS.md` module-table row; both registration surfaces are gate-enforced. Verify them with `bun scripts/content-integrity.ts`.
- **Generated surfaces:** Seven committed files are generated, and `scripts/lib/generated-surfaces.ts` is the one list of them (outputs, triggers, regenerate and check scripts). Before committing or opening a PR, run `bun run surfaces:affected --run` (regenerates only the surfaces your changes touch, plus those downstream, then checks them), then `bun run surfaces:drift` (checks all seven, the same as CI). If `affected` cannot resolve `origin/main`, run `bun run surfaces:regen`, then `drift`. After deleting an agent or skill, run `bun scripts/generate-config-schema.ts --allow-shrink` once (the schema generator refuses to drop names without it), then `bun run surfaces:regen`. After a `[FAIL]`, fix the named cause and rerun the same command; the generators are idempotent. The schema and config-reference surfaces read the version from git tags, so a clone without tags needs `git fetch --tags` first. `dist/pi-subagents/agents/` is build output, not a surface. See [`docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md`](docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md) for prior art.

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
