---
title: feat: Typed config validation for bundled agent and skill names
type: feat
status: completed
shipped: PR #384 → v2.15.0
date: 2026-05-16
origin: docs/brainstorms/2026-05-16-typed-config-validation-requirements.md
---

# feat: Typed config validation for bundled agent and skill names

## Overview

`SystematicConfigSchema` currently accepts arbitrary strings for `agents.<key>`, `disabled_agents`, and `disabled_skills`. Typos silently produce no-op overlays. This plan introduces typed validation against the build-time-enumerated bundled-agent and bundled-skill name sets: typo'd keys become Zod parse errors with the full list of valid names, and the published JSON Schema gains per-property emission for IDE autocomplete.

Ships as v2.15.0 minor (`feat:` prefix per memory `#2734`).

## Problem Frame

Today, a user typo like `agents.correctness-reviwer` (missing 'e') stores an overlay under a key that never matches any real agent at runtime. The intended override silently does nothing — and if the typo lands on a security-relevant overlay (`model`, `permission`, per the `SECURITY_OVERLAY_FIELDS` trust boundary in `src/lib/config-schema.ts:330`), the user's intended tightening silently fails to a less-constrained config.

The brainstorm resolved the right shape after a round-1 + round-2.5 + round-2 review cycle: typed enums derived from the filesystem at codegen time, committed as `src/lib/bundled-names.ts`, consumed by both the runtime Zod schema and the published JSON Schema generator. Bundled-agent and bundled-skill names function as stable API today — renaming any bundled agent is already a breaking change for user configs that reference it (the runtime config-handler matches by exact name). Build-time enumeration formalizes that contract.

See origin: `docs/brainstorms/2026-05-16-typed-config-validation-requirements.md`.

## Requirements Trace

- R1. Codegen for bundled names — `scripts/generate-config-schema.ts` walks `agents/` and `skills/`, emits `src/lib/bundled-names.ts` and the published JSON Schema in one run, with a sanity check that aborts on empty discovery or any shrinkage from the previously committed count (override via `--allow-shrink` flag used by maintainers locally during intentional removals; CI never runs the generator with the override)
- R2. Typed runtime validation — `src/lib/config-schema.ts` constructs `agents` as `z.object({ literal keys }).strict()` and `disabled_agents` / `disabled_skills` as `z.array(z.enum(BUNDLED_*_NAMES))`
- R3. IDE autocomplete via published JSON Schema — per-property emission for `agents.<bundled-name>` and enum constraints on `disabled_*` array members (VS Code reference target)
- R4. Documentation — `docs/src/content/docs/getting-started/configuration.mdx` updates for strict-bundled semantics, v2.15.0 migration note (including pre-upgrade shadow audit recommendation), and IDE autocomplete via `$schema`. User-defined-agent relocation guide and shadowing-as-invalid-usage doc contract are deferred to a follow-up `docs(config):` PR (smart-note tracked)

## Scope Boundaries

- v2.15.0 minor release
- Single PR
- TDD execution discipline per memory `#2767`

### Deferred to Separate Tasks

- Levenshtein-based "did you mean" suggestions for typo'd names — follow-up polish PR; smart note will track
- User-defined-agent relocation guide (moving `agents.<custom-name>` overlays to `.opencode/opencode.json`) — follow-up `docs(config):` PR; smart note will track
- Shadowing-as-invalid-usage doc contract (`.opencode/agents/<bundled-name>.md` + Systematic `agents.<bundled-name>` overlay) — follow-up `docs(config):` PR; smart note will track
- `disabled_commands` enum — commands are dynamically registered, no canonical set
- `categories` map keys enum — separate codegen path, out of scope
- Runtime warn-emit when `.opencode/agents/` shadow is detected — explicitly NOT added; shadowing is doc-level "invalid" per brainstorm decision
- Soft-launch feature flag (`SYSTEMATIC_STRICT_VALIDATION` or similar) — explicitly rejected in favor of hard break with clear error

## Context & Research

### Relevant Code and Patterns

- `scripts/generate-config-schema.ts` — existing schema generator, target for codegen extension. Single-output check at `:412-463` needs to grow to multi-artifact.
- `scripts/generate-registry.ts` — existing build-time-codegen-of-source pattern that mirrors what we need (walks `agents/` and `skills/` filesystem, emits formatted committed file). Reuses `formatJsonWithBiome` pattern for consistent output.
- `src/lib/config-schema.ts:243-291` — current `SystematicConfigSchema` shape with `agents`, `disabled_agents`, `disabled_skills`, `disabled_commands` all using `z.string()` keys/values.
- `src/lib/agents.ts:51-62` (`findAgentsInDir`) — synchronous; produces `AgentInfo[]` with `name`, `file`, `category`.
- `src/lib/skills.ts:109-141` (`findSkillsInDir`) — synchronous; produces `SkillInfo[]`.
- `tests/unit/config-schema.test.ts` — existing test surface; extends with typed-validation coverage.
- `tests/unit/generate-config-schema.test.ts` — existing test surface; extends with sanity-check coverage.

### Institutional Learnings

- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` Pattern 5 (Generator-owned dual outputs) — exact pattern this plan reuses
- Memory `#2065` — scope-discipline split signal that produced this brainstorm's separation from memoization
- Memory `#2734` — semantic-release commit-type mapping (`feat:` → minor → v2.15.0)
- Memory `#2767` — TDD discipline for implementing agents
- Memory `#3062` — multi-PR dependency-ordering rule (relevant for any follow-up PRs)
- `SECURITY_OVERLAY_FIELDS` trust boundary (`src/lib/config-schema.ts:330`, mirrored in `src/lib/config.ts:72`) — preserved by typed validation rejecting typos at parse time, before any overlay-application phase

### External References

External research skipped — strong local patterns, empirical anchor already verified.

## Key Technical Decisions

- **Schema shape: literal-keyed `.strict()` objects over `z.record(z.enum)`** — Empirical probe (brainstorm "Empirical Anchor" section) confirmed `z.object({...}).strict()` emits per-property JSON Schema without the `required: [all]` bug that `z.record(z.enum)` introduces. No post-process pass needed.
- **Codegen surface: committed `src/lib/bundled-names.ts`** — Solves the `prepublishOnly` ordering gap (`build` runs before `schema:generate`). Imports resolve on fresh clone. Drift gate enforces filesystem-sync.
- **Sanity check: abort on empty OR any shrinkage** — Adversarial round-2 flagged that "abort on >1 shrink" still let a one-name corruption slip through. Tightened to "any shrinkage" with explicit `--allow-shrink` override for legitimate removals. First-run exemption when `bundled-names.ts` does not yet exist (only empty-discovery enforced there). Partial-discovery scenarios (filesystem permission issues, truncated walks, symlink edge cases) trip the shrink check because they manifest as a reduced count vs the committed baseline.
- **`--allow-shrink` is a maintainer-local flag, not a CI flag** — CI never runs the generator with `--allow-shrink`. The shrink check fires only when a maintainer regenerates locally during PR prep. For intentional bundled-agent removals, the maintainer runs `bun scripts/generate-config-schema.ts --allow-shrink` locally, commits the regenerated `bundled-names.ts`, and pushes. CI's `schema:drift` is version-agnostic for `bundled-names.ts` and simply verifies the committed file matches filesystem reality.
- **User-defined agent overlays excluded from `agents.<key>`** — Strict-bundled semantics. Users with custom agents move to OpenCode-native `.opencode/opencode.json` overlay path. Mechanical migration; documented in v2.15.0 release notes (relocation guide deferred to follow-up `docs(config):` PR).
- **Shadowing is invalid usage** — Schema accepts `agents.<bundled-name>` even when a user has `.opencode/agents/<bundled-name>.md` (schema cannot introspect runtime shadows at parse time). Doc-contract closure: documented as undefined behavior under future changes (in the follow-up `docs(config):` PR). Existing shadow users get no runtime signal; the v2.15.0 release notes include an explicit pre-upgrade shadow-audit recommendation.
- **Hard break in `feat:` minor (v2.15.0)** — Release notes call out the migration. Pin v2.14.x in CI for grace period. The breakage IS the warning system that surfaces previously-silent typos.

## Open Questions

### Resolved During Planning

- **Where does `bundled-names.ts` live?** — `src/lib/bundled-names.ts`. Top-of-file header marks it as generated; do not edit by hand. Both the runtime Zod schema and the schema generator import from this single source.
- **What's the shape of the `--allow-shrink` override?** — CLI flag on `scripts/generate-config-schema.ts`. Documented in the script's help output; mentioned in the bundled-agent-removal section of the migration docs. Used only when the maintainer intentionally removes a bundled agent.
- **Does committing `bundled-names.ts` actually unblock fresh-clone builds?** — Yes, per feasibility round-2: the file is committed, `bun install` then `bun run build` works without first running `schema:generate`. Subsequent agent additions/removals require re-running the generator.
- **Multi-artifact drift check shape?** — Grow `checkSchemaFiles` to iterate a `CheckArtifact[]` list with per-artifact: (a) expected-content computation, (b) on-disk path, (c) error message. The current single-artifact loop becomes a multi-artifact loop. First artifact: JSON Schema (existing); second artifact: `bundled-names.ts` (new).

### Deferred to Implementation

- **Exact migration-doc wording for v2.15.0** — Polished during Unit 4 with concrete before/after examples for the typo'd-bundled-overlay case. User-defined-agent relocation examples are deferred to the follow-up `docs(config):` PR.
- **Final test-isolation choice** — Unit 1's test seam is specified now (see Unit 1 approach): temp-root filesystem fixture with controllable `agents/` and `skills/` subdirectories. The exact helper API (function signature, returned cleanup) is designed during implementation, not in this plan.

## Implementation Units

- [ ] **Unit 1: Codegen for bundled-names.ts**

**Goal:** Extend `scripts/generate-config-schema.ts` to walk `agents/` and `skills/` filesystems, emit `src/lib/bundled-names.ts` as a committed source artifact, and include a sanity check that aborts on empty discovery or any shrinkage from the previously committed count.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `src/lib/bundled-names.ts` (generated; committed as the initial run output)
- Modify: `scripts/generate-config-schema.ts` — add filesystem walk + `bundled-names.ts` emission + sanity check + `--allow-shrink` flag
- Test: `tests/unit/generate-config-schema.test.ts` — extend with sanity-check coverage

**Approach:**
- Add a discovery step that calls `findAgentsInDir('agents')` and `findSkillsInDir('skills')` (both sync per `src/lib/agents.ts:51-62` and `src/lib/skills.ts:109-141`)
- Refactor the discovery step into a pure helper that takes a project root as a parameter (e.g., `discoverBundledNames(rootDir: string): { agents: string[]; skills: string[] }`) so tests can point it at temp-root fixtures without monkey-patching. This is the explicit test seam (resolves the brainstorm's deferred "test-helper for empty-discovery scenarios" question)
- Sort the names lexicographically and emit `export const BUNDLED_AGENT_NAMES = [...] as const` plus `export const BUNDLED_SKILL_NAMES = [...] as const`
- Top-of-file header marks the file as generated (do not edit by hand); reference `scripts/generate-config-schema.ts` as the regenerator
- Sanity check: if `newAgentCount === 0` OR `newAgentCount < currentAgentCount`, abort with clear error pointing at `--allow-shrink` override. Same for skills. The shrink check naturally catches partial-discovery failures (filesystem permission issues, truncated walks, symlink edge cases) because they manifest as a reduced count vs the committed baseline.
- First-run exemption: when `bundled-names.ts` does not yet exist on disk, skip the shrink check; only enforce empty-discovery
- Run the generated TS through `bun biome format --stdin-file-path=bundled-names.ts` (mirrors `formatJsonWithBiome` at `scripts/generate-config-schema.ts:40-52`) so the committed file matches `bun run lint` expectations from the first run. Generator test asserts the emitted content passes lint without follow-up formatting fixes.
- Mirror `scripts/generate-registry.ts` overall structure where applicable

**Execution note:** Test-first. Write the sanity-check tests (empty discovery, one-name shrink, first-run exemption) BEFORE implementing the generator extension.

**Patterns to follow:**
- `scripts/generate-registry.ts` (filesystem walk + biome-formatted output)
- `scripts/generate-config-schema.ts:412-463` (existing `checkSchemaFiles` structure, to be extended in Unit 3)
- `scripts/generate-config-schema.ts:40-52` (`formatJsonWithBiome` pattern)

**Test scenarios:**
- Happy path: generator runs against current `agents/` and `skills/` directories → emits `bundled-names.ts` containing all 51 agent names and 45 skill names sorted lexicographically
- Happy path: re-running the generator on unchanged filesystem produces byte-identical output
- Happy path: adding a new agent file then re-running adds the name to `BUNDLED_AGENT_NAMES`
- Edge case: empty `agents/` directory → generator aborts with clear error message (no silent emission of empty enum)
- Edge case: agents/ count drops by 1 from previous committed state → generator aborts with clear error pointing at `--allow-shrink` override
- Edge case: partial-discovery (only 25 of 51 agents visible due to a test-fixture restricted directory) → generator aborts with clear error; the message indicates the shrink check tripped without claiming the failure mode
- Edge case: `--allow-shrink` flag passes the shrink check; generator proceeds with the reduced set
- Edge case: first-run scenario (`src/lib/bundled-names.ts` does not exist) → shrink check skipped; only empty-discovery enforced
- Edge case: same scenarios for skills (empty `skills/`, shrink, partial-discovery, override)
- Integration: generated `bundled-names.ts` is importable as TypeScript with `as const` literal-tuple types intact (smoke-import in a test)
- Integration: generated `bundled-names.ts` passes `bun biome format --stdin-file-path=bundled-names.ts` byte-identically (lint-clean from first emission)

**Verification:**
- Running `bun scripts/generate-config-schema.ts` produces `src/lib/bundled-names.ts` with the current 51 agent names and 45 skill names
- `BUNDLED_AGENT_NAMES` and `BUNDLED_SKILL_NAMES` are `readonly` string-literal tuples (compile-time check via TypeScript)
- All sanity-check scenarios above pass in the test suite

- [ ] **Unit 2: Typed runtime validation in config-schema.ts**

**Goal:** Replace the permissive `z.record(z.string(), ...)` and `z.array(z.string())` shapes for `agents`, `disabled_agents`, and `disabled_skills` with typed enums built from `bundled-names.ts`.

**Requirements:** R2

**Dependencies:** Unit 1 (the import target must exist)

**Files:**
- Modify: `src/lib/config-schema.ts:243-291` — `agents`, `disabled_agents`, `disabled_skills` definitions
- Test: `tests/unit/config-schema.test.ts` — extend with typed-validation coverage

**Approach:**
- Import `BUNDLED_AGENT_NAMES` and `BUNDLED_SKILL_NAMES` from `src/lib/bundled-names.js`
- Build the agents object shape by reducing the bundled-name tuple into a record: `const agentShape = Object.fromEntries(BUNDLED_AGENT_NAMES.map(name => [name, AgentOverlaySchema.optional()])) as Record<(typeof BUNDLED_AGENT_NAMES)[number], typeof AgentOverlaySchema.optional()>`. Then `agents: z.object(agentShape).strict().default({}).meta({...})`
- Construct `disabled_agents` as `z.array(z.enum(BUNDLED_AGENT_NAMES)).default([])`
- Construct `disabled_skills` as `z.array(z.enum(BUNDLED_SKILL_NAMES)).default([])`
- Leave `disabled_commands` and `categories` unchanged
- Preserve `.meta({ description, examples })` annotations on each field; update examples to use real bundled names
- Type-level confirmation: `z.infer<typeof SystematicConfigSchema>['agents']` should be a `Partial<Record<(typeof BUNDLED_AGENT_NAMES)[number], ...>>` shape
- Import-time invariant: `src/lib/config-schema.ts` is loaded at plugin module-init time. If `bundled-names.ts` is stale, missing, or malformed, plugin load itself fails (before any config parsing). Unit 1's sanity check and Unit 3's drift gate are the two layers that defend against this; document the import-time invariant explicitly in Unit 3's verification

**Execution note:** Test-first. Write the typo-rejection tests BEFORE updating the schema definitions.

**Patterns to follow:**
- Existing `AgentOverlaySchema` and `CategoryOverlaySchema` shapes at `src/lib/config-schema.ts:171-186`
- Existing `.meta()` description/examples on every field

**Test scenarios:**
- Happy path: `{ agents: { 'correctness-reviewer': { model: 'anthropic/claude-sonnet-4-5' } } }` parses cleanly
- Happy path: `{ disabled_agents: ['oracle', 'correctness-reviewer'] }` parses cleanly
- Happy path: `{ disabled_skills: ['ce:plan', 'ce:review'] }` parses cleanly
- Edge case: empty `agents`, `disabled_agents`, `disabled_skills` parse cleanly via defaults
- Error path: `{ agents: { 'correctness-reviwer': { model: 'anthropic/claude-haiku-4-5' } } }` produces Zod error pointing at the misspelled key
- Error path: `{ disabled_agents: ['oraqle'] }` produces Zod error at `disabled_agents.0`
- Error path: `{ disabled_skills: ['nonexistent-skill'] }` produces Zod error at `disabled_skills.0`
- Error path: user-defined-agent overlay attempt `{ agents: { 'my-custom-agent': {...} } }` fails parse with the standard "Unrecognized key" error
- Integration: a valid `systematic.json` config that uses every supported field still parses end-to-end via `loadConfigSource`

**Verification:**
- All typo-rejection scenarios produce clear Zod errors with the misspelled key surfaced
- Schema's static type `z.infer<typeof SystematicConfigSchema>['agents']` is a `Partial<Record<BundledAgentName, ...>>` (TypeScript-level)
- No regressions in existing `config-schema.test.ts` tests

- [ ] **Unit 3: Extend schema:drift to cover bundled-names.ts**

**Goal:** Grow `checkSchemaFiles` to verify multiple generated artifacts. Add `bundled-names.ts` as the second artifact alongside the existing JSON Schema check.

**Requirements:** R1 (drift acceptance criterion)

**Dependencies:** Unit 1 (the artifact must exist for the check to verify)

**Files:**
- Modify: `scripts/generate-config-schema.ts:412-463` — refactor single-artifact check into multi-artifact iteration
- Test: `tests/unit/generate-config-schema.test.ts` — extend with drift-check coverage for the new artifact

**Approach:**
- Introduce a `CheckArtifact` shape carrying: (a) a `produce: () => string` callback for expected content, (b) `pathOnDisk: string` for the committed location, (c) `staleMessage: string` for the drift error
- Build two `CheckArtifact` entries: the existing JSON Schema check (refactored to fit the new shape; keeps its version-dependent `resolveVersion()` flow inside `produce`) and the new `bundled-names.ts` check (version-agnostic; just compares the file at `src/lib/bundled-names.ts` against the freshly generated content from the new `discoverBundledNames(rootDir)` helper introduced in Unit 1)
- The bundled-names check has NO dependency on `resolveVersion()` or on the schema's major-version flow. The two artifacts share the `CheckArtifact` shape but resolve content via independent pipelines.
- Loop over both; return on first failure
- Preserve existing error-message tone
- `--allow-shrink` flag has NO effect on drift checking; drift is purely "does committed file match filesystem now?" The shrink check only fires inside the generator's emit path

**Execution note:** Test-first. Write drift-detection tests (stale `bundled-names.ts`, missing `bundled-names.ts`, both up-to-date) BEFORE refactoring the check.

**Patterns to follow:**
- Existing `scripts/generate-config-schema.ts:412-463` single-artifact loop
- Existing `normalizeForCompare` helper for byte-comparison

**Test scenarios:**
- Happy path: both artifacts up-to-date → exit 0 with combined "Schema files are up to date" message
- Error path: stale `bundled-names.ts` (filesystem has agents not in the committed names list) → exit 1 with drift error pointing at `bundled-names.ts` and the regen command
- Error path: missing `bundled-names.ts` (file deleted) → exit 1 with does-not-exist error
- Error path: stale JSON Schema (existing behavior, regression-protected) → exit 1 with the existing message
- Integration: `bun run schema:drift` returns exit 0 against the current committed state after Unit 1 has produced `bundled-names.ts`
- Integration: bundled-names drift check is exercised independently of version resolution — a test that breaks `resolveVersion()` should still detect drift on `bundled-names.ts`

**Verification:**
- `bun run schema:drift` runs cleanly against the post-Unit-1 committed state
- Drift in either artifact independently fails the check
- All drift scenarios surface a clear actionable error (regen command)
- Import-time invariant verified: a test that corrupts `bundled-names.ts` (in-memory, not on disk) demonstrates that plugin module-init fails before any config parsing; documents the failure mode for future contributors

- [ ] **Unit 4: Documentation updates**

**Goal:** Document strict-bundled semantics, user-defined-agent migration path, shadowing-as-invalid, the v2.15.0 migration boundary, and IDE autocomplete via `$schema`. Surface the same content in the generated config-reference page.

**Requirements:** R4 (and indirectly R3 via the autocomplete narrative)

**Dependencies:** Units 1–3 (so the behaviors documented are real)

**Files:**
- Modify: `docs/src/content/docs/getting-started/configuration.mdx` — Availability-Aware Resolution section already touched in v2.14.5; add a new subsection covering typed validation
- Modify: `docs/scripts/generate-config-reference.ts` — if needed, surface the new field-level annotations in the generated reference (the `agents` description should reflect the new bundled-only semantics)

**Approach:**
- Add a "Typed Validation" subsection under the existing configuration guide covering only the V1 essentials:
  - Strict-bundled semantics for `agents.<key>`, `disabled_agents`, `disabled_skills`
  - Migration: typo'd configs fail with clear errors; pin v2.14.x in CI for grace period; recommend pre-upgrade shadow audit for users who have shadowed bundled agents in `.opencode/agents/`
  - IDE autocomplete: add `$schema` to `systematic.json` to enable autocomplete in VS Code; reference target with note that other editors may provide partial support
- Defer to a follow-up `docs(config):` PR (smart-note tracked): user-defined-agent relocation guide, shadowing-as-invalid-usage doc contract
- Add the same migration callout to the v2.15.0 release notes (handled at release time via semantic-release commit message, not in this PR's diff)

**Patterns to follow:**
- Existing structure of `docs/src/content/docs/getting-started/configuration.mdx`
- Memory `#2065` — keep doc scope tight to the behavior change; don't broaden into adjacent topics

**Test scenarios:**
- Test expectation: none — pure documentation change; covered by `bun run docs:build` validation

**Verification:**
- `bun run docs:build` succeeds with 110+ pages built
- Net new prose covers the 3 V1-essential documented behaviors (strict-bundled, migration with shadow-audit note, autocomplete)
- The two deferred doc behaviors (user-defined relocation, shadowing-invalid contract) are explicitly listed in the smart-note follow-up

## System-Wide Impact

- **Build pipeline**: `scripts/generate-config-schema.ts` gains filesystem walk responsibilities and a second generated output. `prepublishOnly` and `docs:generate` flows continue to invoke it as before; CI `schema:drift` check is extended in Unit 3 to cover `bundled-names.ts`. CI never runs the generator with `--allow-shrink`; that flag is maintainer-local.
- **Source tree**: `src/lib/bundled-names.ts` is a new committed-but-generated artifact. Header comment marks it generated; future contributors will see it in source review and the regen command on the header.
- **Runtime**: `src/lib/config-schema.ts` imports from `bundled-names.ts`. Existing config validation surface (single `SystematicConfigSchema.safeParse` call in `loadConfigSource`) is unchanged structurally; the schema definition itself becomes stricter. **Import-time invariant**: if `bundled-names.ts` is stale, missing, or malformed, plugin module-init fails before any config parsing happens. Unit 1's sanity check and Unit 3's drift gate are the two defense layers against this failure mode.
- **Published artifacts**: The JSON Schema served at versioned + `/latest` URLs becomes substantially more typed (per-key properties on `agents`, enum constraints on `disabled_*` array members). External consumers see autocomplete via `$schema` field.
- **Error propagation**: Zod parse errors surface the misspelled key with the full bundled-name list in the message. The error happens at parse time inside `loadConfigSource`; no further propagation surface to design.
- **API surface parity**: `agents`, `disabled_agents`, `disabled_skills` become strict-typed. `disabled_commands` and `categories` remain untyped (out of scope per brainstorm). No new fields, no removed fields.
- **Integration coverage**: User configs are validated end-to-end via `loadConfigSource`; existing integration tests in `tests/integration/opencode.test.ts` will exercise the new schema during plugin load.
- **Unchanged invariants**: `AgentOverlaySchema` (`src/lib/config-schema.ts:171-186`) is preserved exactly; `categories` and `disabled_commands` shapes preserved exactly; `SystematicConfigSchema` top-level field set preserved exactly. `SECURITY_OVERLAY_FIELDS` trust boundary (`src/lib/config-schema.ts:330`, mirrored in `src/lib/config.ts:72`) is preserved — a typo on a security-relevant overlay is rejected at parse time, never reaches the overlay-application phase.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Generator bug emits an empty `BUNDLED_AGENT_NAMES` set → every config fails parse | Unit 1's sanity check aborts on empty discovery and on any shrinkage. Unit 3's drift check catches if the committed `bundled-names.ts` diverges from filesystem reality. |
| Zod 4's `z.toJSONSchema` emission shape changes in a minor version, breaking IDE autocomplete | Unit 3's drift check fails-loud on schema-shape drift; the existing JSON Schema check normalizes against the committed file. Empirical anchor in the brainstorm fixes the expected shape for `zod@4.4.3`. |
| User has a valid-on-v2.14.x config with a user-defined agent at `agents.<custom-name>` that breaks on v2.15.0 upgrade | Unit 4 release notes call out the migration explicitly with a before/after example. Error message lists the exact key that failed plus all valid bundled names. |
| Bundled-agent rename or removal breaks user configs referencing the old name | Same migration story applies. Maintainers run `bun scripts/generate-config-schema.ts --allow-shrink` locally to acknowledge intentional removal, commit the regenerated `bundled-names.ts`, and push. CI verifies the committed file matches filesystem. Bundled-agent renames have always been breaking changes for user configs (runtime overlay matches by exact name). |
| CI/automation users auto-upgrade through v2.15.0 and see immediate parse failures with no human present | Intentional: silent broken behavior on v2.14.x was never producing the user's intended config. v2.14.x can be pinned in CI for grace period. Release notes warn explicitly. |
| Multi-version upgrade cascade (typo'd bundled keys + custom agents misplaced + bundled names renamed across versions) | Acknowledged in brainstorm. Hard break surfaces issues sequentially; user fixes each error and restarts. Migration guide section in Unit 4 lists the common invalidation classes. |
| Test seam for empty-discovery is awkward without an injectable helper | Unit 1's approach extracts a pure `discoverBundledNames(rootDir)` helper. Tests construct temp-root fixtures with controllable `agents/` and `skills/` subdirectories. The test seam is planning-time, not implementation-deferred. |
| Plugin module-init fails if `bundled-names.ts` is stale, missing, or malformed | Unit 1's sanity check catches discovery failures at generator time; Unit 3's drift gate catches divergence between committed file and filesystem. The import-time failure mode is documented in Unit 3's verification with an explicit test. |

## Documentation / Operational Notes

- **Release notes (v2.15.0)** — semantic-release will pick `feat:` and bump minor. Commit body should include the migration callout. Marcus's standard PR-body practice (memory `#2632`: public-facing prose, no agent/session/memory refs) applies.
- **Monitoring** — no operational monitoring; this is a parse-time schema change with no runtime telemetry surface.
- **Rollback** — if a user hits a parse error that they cannot fix immediately, they can pin to `@fro.bot/systematic@2.14.x` in their dependency manifest. Memory `#3062` already covers the dependency-ordering rule for any follow-up PRs.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-16-typed-config-validation-requirements.md](../brainstorms/2026-05-16-typed-config-validation-requirements.md)
- `scripts/generate-config-schema.ts` (generator to extend)
- `scripts/generate-registry.ts` (existing filesystem-walk-to-committed-source pattern to mirror)
- `src/lib/config-schema.ts:243-291` (current schema shape)
- `src/lib/agents.ts:51-62`, `src/lib/skills.ts:109-141` (sync discovery helpers)
- `tests/unit/config-schema.test.ts`, `tests/unit/generate-config-schema.test.ts` (existing test surfaces)
- Memory `#2065`, `#2734`, `#2767`, `#3062` (institutional learnings carried forward)
- `SECURITY_OVERLAY_FIELDS` (`src/lib/config-schema.ts:330`, mirrored in `src/lib/config.ts:72`) — trust boundary preserved by typed validation
- `docs/solutions/best-practices/provider-availability-source-defaults-2026-05-12.md` Pattern 5 (Generator-owned dual outputs)
