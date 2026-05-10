---
title: "feat: Zod-backed user config + published JSON schema + first-class JSONC"
type: feat
status: active
date: 2026-05-10
origin: docs/brainstorms/2026-05-10-zod-config-schema-jsonc-requirements.md
---

# feat: Zod-backed user config + published JSON schema + first-class JSONC

## Overview

Replace the hand-rolled validators that parse `systematic.json` (in `src/lib/config.ts` and `src/lib/agent-overlays.ts` overlay paths only) with a single Zod schema. Generate a JSON Schema from that source at build time and publish it to the docs site under a versioned URL (`/systematic/schemas/v<MAJOR>/systematic-config.schema.json` + `/latest/` mirror) for IDE autocomplete via `$schema`. Bundle the same schema in the published npm package as an offline fallback. Auto-generate the user-config reference docs page (`docs/src/content/docs/reference/systematic-config.mdx`) from the same Zod source so descriptions, defaults, and enums cannot drift between the schema and the docs. Add `.jsonc` as a first-class config extension that takes precedence over `.json` at every config-search location.

## Problem Frame

Two compounding friction points motivate this work (see origin doc Problem Frame). Users authoring `systematic.json` have no IDE autocomplete, no `$schema` URL, and no field-level reference page — authoring is "read the source or guess." When validation fails, the hand-rolled validators in `src/lib/config.ts` and `src/lib/agent-overlays.ts` produce inconsistent errors and must be hand-edited every time the shape evolves; the v2.10.0 trust-sensitive overlay work and v2.11.0 auth-aware array shape both required parallel changes to validators that a single source-of-truth schema would have captured automatically. Adjacent: `systematic.json` does not support comments, despite `jsonc-parser` already being a runtime dep — only the loader's filename precedence treats `.jsonc` as second-class.

## Requirements Trace

- R1. (see origin) Define a single Zod schema for the user-facing `systematic.json` shape, covering all top-level keys: `agents`, `categories`, `disabled_skills`, `disabled_agents`, `disabled_commands`, `bootstrap`.
- R2. (see origin) Replace hand-rolled validation in `src/lib/config.ts` and `src/lib/agent-overlays.ts` (overlay paths only).
- R3. (see origin) Validation errors include the offending field path and a human-readable reason.
- R4. (see origin) Source-default constants migrate to Zod-backed assertions.
- R5. (see origin) Build-time codegen generates `systematic-config.schema.json`.
- R6. (see origin) Schema published to docs site at `v<MAJOR>/` + `latest/` mirror.
- R7. (see origin) Schema's `$id` points at the major-versioned URL, not `/latest/`.
- R8. (see origin) Reference page at `docs/src/content/docs/reference/systematic-config.mdx` generated from the Zod source.
- R9. (see origin) Reference page links to the published schema URL with copy-paste `$schema` line.
- R10. (see origin) Reference page reachable from the docs sidebar (explicit entry in `docs/astro.config.mjs`).
- R11. (see origin) `.jsonc` takes precedence over `.json` at each config-search location.
- R12. (see origin) Existing `systematic.json` users see no behavior change.
- R13. (see origin) Hardcoded `.json` references in tests, docs, and CLI output updated to handle both extensions.
- R14. (see origin) Schema bundled in the published npm package at a stable path (`dist/schemas/systematic-config.schema.json`) as an offline fallback.

## Scope Boundaries

- Bundled-asset frontmatter validation (SKILL.md, agent .md frontmatter) stays in the content-integrity gate — not migrated to Zod in this work.
- OCX registry shape stays as-is — `bun run registry:validate` and `bun run registry:drift` paths unchanged.
- Internal Systematic types (converter, manifest, plugin-config-handler emission) stay as TypeScript types; Zod is for the user-config boundary only.
- No schema-versioning UI on the docs site — older versions reachable only via the major-versioned `$schema` URL.
- No deprecation warnings for v2.11.0 → v3.x field renames — and this work introduces no field renames; the no-shim policy is forward-looking only.
- No automatic `$schema` injection — users add the line themselves.
- No custom error formatter for v1 — Zod's default formatter is sufficient (re-evaluate as a separate follow-up if v1 errors prove confusing).

## Context & Research

### Relevant Code and Patterns

- `src/lib/config.ts` — current loader, `getConfigPaths()` at line 297, three search locations at lines 302-307. Hand-rolled validation entry point.
- `src/lib/agent-overlays.ts` — 15 private validators/helpers (`validateExactAgentOverlays`, `validateCategoryOverlays`, `validateOverlayFields`, `validateOverlayFieldValue`, `validateModel`, `validateNonEmptyString`, `validateTemperature`, `validateTopP`, `validatePositiveInteger`, `validateBoolean`, `validateMode`, `validateColor`, `validateSkills`, `validatePermission`, `validatePermissionRule`) plus the 2 public validator entrypoints (`validateAgentOverlays`, `validateSourceCategoryModelDefaults`).
- `src/lib/validation.ts` — shared frontmatter/permission parsing utilities used by `agents.ts`, `commands.ts`, `skills.ts`, `converter.ts`. **Not migrated** in this work — reused by Zod schema's preprocess steps where helpful.
- `docs/scripts/transform-content.ts` — existing reference-page generation (322 LOC, `generatePage`/`generateIndexPage`, writes via `fs.writeFileSync` to `OUTPUT_DIR = '../src/content/docs/reference'`). New `generate-config-reference.ts` mirrors this pattern as a sibling script.
- `scripts/generate-registry.ts` — existing build-time generation pattern (filesystem walk → emit JSON, supports `--check` mode for drift detection). New `scripts/generate-config-schema.ts` mirrors this pattern.
- `docs/astro.config.mjs:56-61` — sidebar autogeneration is per-directory (`reference/skills`, `reference/agents` only). New page needs an explicit entry, not autogenerate.
- `package.json` `scripts` — `docs:generate` is the single entry point users run; the new generator chains into it.
- `package.json` `files: ["dist", "skills", "agents"]` — bundled schema goes under `dist/schemas/` so the existing entry covers it.

### Institutional Learnings

- `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md` — the trust-profile-per-overlay-field pattern that v2.9.0/v2.9.1 hardened. The new Zod schema is the natural home to encode this as a tag (`.meta({ trust: 'project-or-higher' })`), making the trust-sensitivity contract structural rather than enforced in `validateOverlayFieldValue`.
- `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md` — OpenCode's downstream config-validation taught that arbitrary string fields shipped as plugin output can be rejected at runtime. The Zod schema for color must enumerate OpenCode's accepted set (`OPENCODE_AGENT_COLOR_TOKENS` in `scripts/content-integrity.ts:722-730`), keeping the lesson durable in code.
- `docs/solutions/code-quality/git-auto-merge-silent-identifier-duplication-2026-05-09.md` — multi-file refactors should land in a single PR with verification on the integrated state. This plan's 5 units land in one PR.

### External References

- Zod 4 native `z.toJSONSchema(schema, options?)` API (verified via librarian — pinned to `^4.4.3`).
- Zod metadata API: `.describe(text)` and `.meta({ description, examples })` for documentation; `.default(value)` for runtime defaults but **not guaranteed** to round-trip into JSON Schema `default`. Verified during U1.
- `z.toJSONSchema()` requires explicit `override` for setting root `$id` and `$schema`.
- VSCode + Zed JSON language servers have historically had partial support for JSON Schema draft-2020-12. Plan emits draft-07 to maximize IDE compat; verify Zod 4 supports `target: 'draft-7'` option in U1.
- `zod-to-json-schema` package is unmaintained as of Nov 2025 — Zod 4 native is the only forward path.

## Key Technical Decisions

- **Zod becomes a declared runtime dependency in `package.json`** at `^4.4.3`. Inverts the prior unstated constraint about avoiding zod in `dist/index.js` (which was about transient leaks via inlining `@opencode-ai/plugin/tool`). Build externalization stays unchanged: `--external @opencode-ai/plugin --external js-yaml`. Zod ships intentionally bundled.
- **JSON Schema target: draft-07** (not Zod 4's default draft-2020-12). Maximizes IDE compatibility (VSCode, Zed both have weaker 2020-12 support). Set via `z.toJSONSchema(schema, { target: 'draft-7' })` if supported by the installed Zod 4 minor; if not supported, post-process to strip draft-2020-12-only constructs.
- **Use `.meta({ description, examples })`, not `.describe()` alone** for the schema annotations. `.describe()` works for description but `.meta()` is the canonical Zod 4 way to attach examples. Defaults (`.default()`) verified to round-trip into JSON Schema `default` in U1; if not, fall back to `.meta({ default: ... })`.
- **Codegen + reference page run as sibling scripts** in `scripts/generate-config-schema.ts` and `docs/scripts/generate-config-reference.ts`. Both wired into `docs:generate` after `transform-content.ts`. Mirrors existing `scripts/generate-registry.ts` shape; avoids coupling to `transform-content.ts` (which is topic-bound to skill/agent pages).
- **Schema published as static asset** at `docs/public/schemas/v<MAJOR>/systematic-config.schema.json` + `docs/public/schemas/latest/systematic-config.schema.json`. Starlight serves `docs/public/` at the site root, so the published URL is `https://fro.bot/systematic/schemas/v<MAJOR>/systematic-config.schema.json`.
- **JSONC precedence implemented in `getConfigPaths()`** by adding an internal helper `resolveConfigPath(dir, basename)` that probes `<dir>/<basename>.jsonc` then `<dir>/<basename>.json` and returns the first hit or undefined. Existing callers continue to receive a single path per location. Eager resolution mirrors the current caching shape — no probe duplication during config load.
- **Bundled npm schema at `dist/schemas/systematic-config.schema.json`**. The existing `package.json` `files: ["dist", ...]` entry covers it without modification. Generator writes to both `docs/public/schemas/v<MAJOR>/` and `dist/schemas/` in the same pass.
- **Schema's `$id` matches the major-versioned URL**, identical across the docs-site copy and the bundled npm copy. The `/latest/` URL serves the same content but doesn't appear as `$id`.

## Open Questions

### Resolved During Planning

- **Use Zod 4 native `.toJSONSchema()` or `zod-to-json-schema`?** Zod 4 native — `zod-to-json-schema` unmaintained as of Nov 2025.
- **Where does reference-page generation run?** Sibling new script `docs/scripts/generate-config-reference.ts`, invoked from `docs:generate` after `transform-content.ts`. Avoids coupling to `transform-content.ts` (which is topic-bound to skill/agent pages).
- **`docs/public/schemas/` vs Starlight content collection?** `docs/public/schemas/` — Starlight default for arbitrary static assets, no content-collection config gymnastics.
- **`getConfigPaths()` shape — return both candidates or eager-resolve?** Eager-resolve via internal `resolveConfigPath(dir, basename)` helper. Existing callers continue to receive a single path per location; no duplicate probe during config load.
- **JSON Schema draft target?** Draft-07. Not Zod 4's native default (2020-12) — VSCode/Zed JSON language servers have weaker 2020-12 support. Set via `z.toJSONSchema(schema, { target: 'draft-7' })` — verified supported per Zod 4 docs.
- **Does `.default(value)` round-trip into JSON Schema `default`?** No. Per Zod 4 docs, the native exporter preserves `description`, `title`, and `examples` from `.meta()` — NOT `.default()`. The schema must use `.meta({ default: value })` for documented defaults; runtime parsing defaults still apply via `.default()` separately. Documented in `config-schema.ts` header during U1.
- **Does Zod 4 support `target: 'draft-7'` in `toJSONSchema`?** Yes. Per Zod 4 docs, `target` accepts `"draft-04" | "draft-4" | "draft-07" | "draft-7" | "draft-2020-12" | "openapi-3.0"`. Use `'draft-7'` directly; no post-process step needed.
- **Should the plugin offer an opt-in `$schema` injection (e.g., `systematic config init`)?** Out of scope for v1 (deferred per origin doc). Re-evaluate as a separate small follow-up after observing v3.0.0 adoption.

### Deferred to Implementation

*(None. Both originally-deferred questions were resolved via Phase 1.2 librarian research before plan finalization.)*

## Implementation Units

- [x] **Unit 1: Zod schema for `systematic.json`**

**Goal:** Define the canonical Zod schema for the user-facing config surface and verify the JSON-Schema codegen API contract.

**Requirements:** R1, R3, R4

**Dependencies:** None

**Files:**
- Create: `src/lib/config-schema.ts` — exports `SystematicConfigSchema` (top-level Zod object covering `agents`, `categories`, `disabled_skills`, `disabled_agents`, `disabled_commands`, `bootstrap`), `AgentOverlaySchema`, `CategoryOverlaySchema`, `BootstrapSchema`, `validateConfig(input): ValidationResult`, `assertSourceCategoryModelDefaults()` (Zod-backed replacement for the existing assertion).
- Modify: `package.json` — add `"zod": "^4.4.3"` to `dependencies`.
- Test: `tests/unit/config-schema.test.ts`

**Approach:**
- Mirror the user-config field set from `src/lib/config.ts:35-52`: top-level `agents`, `categories`, `disabled_skills`, `disabled_agents`, `disabled_commands`, `bootstrap`. **All six** top-level fields must be covered — omitting `disabled_commands` would reject existing user configs and violate R12. Per-agent / per-category overlays mirror the field set in `src/lib/agent-overlays.ts` validators (model, variant, temperature, top_p, tools, disable, mode, color, steps, hidden, permission, etc.).
- Annotate every leaf field with `.meta({ description, examples })`. Use `.describe()` only where a single-line description suffices.
- Color enum reuses `OPENCODE_AGENT_COLOR_TOKENS` from `scripts/content-integrity.ts:722-730`. Re-export the constant from a shared location if needed (or duplicate as a Zod enum and add a regression test that they stay in sync).
- Trust-sensitivity tagging: each overlay field carries `.meta({ trust: 'project-or-higher' | 'any' })` so the layered-trust-boundary contract from PR #344 is structural in the schema. The validation layer reads this metadata when applicable.
- First commit verifies the two implementation-deferred Zod 4 details: (a) `.default()` round-trips into JSON Schema `default`, (b) `target: 'draft-7'` option is supported. Inspection only — no codegen yet (that's U3). Document the verified API behavior in a comment at the top of `config-schema.ts`.

**Patterns to follow:**
- `src/lib/agent-overlays.ts` — existing validation surface and error-message style. Reuse field semantics and constraint shapes (e.g., temperature ≥ 0, top_p ≤ 1, color enum).
- `OPENCODE_AGENT_COLOR_TOKENS` from `scripts/content-integrity.ts:722-730` for color enum values.
- Zod 4 idioms: `z.object().strict()` for closed objects (rejects unknown keys at the top level AND at the per-agent / per-category overlay level). The plan uses strict mode at every layer so unknown overlay fields fail loudly with a path-named error — mirrors the existing `ALLOWED_OVERLAY_FIELDS` behavior at `src/lib/agent-overlays.ts:65,417` which produces clear `unsupported agent overlay field "..."` messages today. Forward-compatibility for genuinely-new fields belongs to schema versioning (major-bump → new schema version), not to per-call permissiveness.

**Test scenarios:**
- Happy path: parse a complete valid `systematic.json` (all fields populated) — succeeds, returns typed object.
- Happy path: parse an empty `{}` — succeeds, returns object with default values applied (`disabled_skills: []`, `disabled_agents: []`, `disabled_commands: []`, `bootstrap.enabled: true`, `agents: {}`, `categories: {}` per `src/lib/config.ts:44-52`). Defaults are emitted via `.meta({ default: value })` because `.default()` does NOT round-trip into JSON Schema `default` per Zod 4 docs.
- Edge case: parse a config with unknown top-level keys — strict mode rejects with named field path; document this in the error.
- Error path: `agents.explorer.temperature: "high"` (string instead of number) — error names `agents.explorer.temperature` and indicates expected number type. Covers AE5.
- Error path: `agents.explorer.top_p: 1.5` (out of range) — error names the path and indicates the `0 ≤ top_p ≤ 1` constraint.
- Error path: `agents.explorer.color: "purple"` (invalid color) — error names `agents.explorer.color` and lists valid enum values from `OPENCODE_AGENT_COLOR_TOKENS`.
- Error path: `agents.explorer.mode: "weird"` (invalid mode enum) — error names the path and lists valid mode values.
- Error path: `agents.explorer.steps: -1` or `agents.explorer.steps: 0` (positive-integer constraint) — error names the path.
- Error path: `agents.explorer.hidden: "yes"` (string instead of boolean) — error names the path with expected boolean type.
- Error path: `agents.explorer.permission: "open"` (invalid permission rule shape) — error names the path and indicates the expected rule structure.
- Error path: `categories.review.model: ""` (empty string) — error names the path and indicates non-empty constraint.
- Error path: per-agent overlay with extra unknown field (`agents.explorer.foo: "bar"`) — strict mode rejects with a path-named error matching the existing `unsupported agent overlay field "foo"` shape from `validateOverlayFields` at `src/lib/agent-overlays.ts:417`. Preserves current strict-validation behavior.
- Integration: `assertSourceCategoryModelDefaults()` against the actual `SOURCE_CATEGORY_MODEL_DEFAULTS` and `SOURCE_AGENT_MODEL_DEFAULTS` constants — passes for current shipped values; intentionally-bad mock fails with a path-named error.
- Regression: trust-tagged fields enumerate exactly the protected set from the existing `SECURITY_OVERLAY_FIELDS` constant in `src/lib/config.ts`.

**Verification:**
- All test scenarios pass.
- The schema can be imported and called from `src/lib/config.ts` and `src/lib/agent-overlays.ts` without circular-import issues.
- A standalone scratch script that calls `z.toJSONSchema(SystematicConfigSchema, { target: 'draft-7' })` produces output and the comment in `config-schema.ts` documents whether draft-07 was supported and whether `.default()` round-tripped.

- [x] **Unit 2: Replace overlay validators with Zod-delegating wrappers**

**Goal:** Migrate the hand-rolled validation paths in `src/lib/config.ts` and `src/lib/agent-overlays.ts` to delegate to the Zod schema, preserving all existing public function signatures.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/config.ts` — replace the validation logic in `loadConfigWithSources()` and related paths with a call to `validateConfig()` from `config-schema.ts`. Preserve the public `loadConfigWithSources` and `getConfigPaths` signatures; only the internal validation changes.
- Modify: `src/lib/agent-overlays.ts` — replace the 15 hand-rolled private validators/helpers with thin wrappers that delegate to the Zod schema. Keep public exports (`validateAgentOverlays`, `validateSourceCategoryModelDefaults`, `assertSourceCategoryModelDefaults`) — their bodies become Zod calls. Remove the now-unused private helpers (`validateExactAgentOverlays`, `validateCategoryOverlays`, `validateOverlayFields`, `validateOverlayFieldValue`, `validateModel`, `validateNonEmptyString`, `validateTemperature`, `validateTopP`, `validatePositiveInteger`, `validateBoolean`, `validateMode`, `validateColor`, `validateSkills`, `validatePermission`, `validatePermissionRule`).
- Test: `tests/unit/agent-overlays.test.ts` — update existing tests to confirm error-message paths still surface field names; remove tests that asserted private-helper behavior; add a regression test that the public validator surface is byte-equivalent for valid input.

**Approach:**
- Each public validator becomes a 3-5 line wrapper: parse with Zod, format errors via Zod's default formatter (one consistent shape), throw or return per the existing signature.
- Source-default constants assertion (`assertSourceCategoryModelDefaults`) becomes a `parse` call against the schema's `SOURCE_CATEGORY_MODEL_DEFAULTS` shape — the schema knows its own contract.
- Trust-sensitivity check: the existing `SECURITY_OVERLAY_FIELDS` set in `src/lib/config.ts` becomes a derived constant computed from the Zod schema's `.meta({ trust: 'project-or-higher' })` annotations. One source of truth.
- Error messages MUST include the field path (e.g., `agents.explorer.temperature`). Zod's default formatter does this; validate explicitly in a test.
- **Error-shape audit (mandatory)**: before completing U2, grep for callers that pattern-match on the OLD validator error strings. Specifically check: (a) `src/cli.ts` for any `error.message.includes(...)` paths around config-load failures, (b) any `tests/unit/*.test.ts` test that asserts on a literal validator error message string (use grep for `unsupported agent overlay field` and `expects` on `.message` / `.toThrow` patterns), (c) `src/lib/config-handler.ts` for any error-string-matching on validation failures from `loadConfigWithSources`, (d) `src/index.ts` for the same. Update each caller to either accept Zod's structured `issues[]` shape or pattern-match on the new flattened error string. The audit is implementation work — the plan names the targets, the implementer performs the grep and updates.

**Patterns to follow:**
- Existing public validator signatures in `agent-overlays.ts` (`validateAgentOverlays({ agents, source }) → ValidationResult`).
- Trust-overlay precedence pattern from PR #344 (`src/lib/config.ts` + `src/lib/agent-overlays.ts` — overlay value's `source.trust` enforced for `SECURITY_OVERLAY_FIELDS`).

**Test scenarios:**
- Happy path: existing valid configs continue to validate cleanly. (Lift several real-world configs from `tests/unit/agent-overlays.test.ts` fixtures.)
- Error path: invalid configs produce error messages naming the field path. Cover the same surface area as the existing test suite (each removed private-helper test replaced by one Zod-equivalent).
- Edge case: `validateAgentOverlays` with overlay value setting a trust-sensitive field from a project-trust source — accepted (existing behavior).
- Edge case: same overlay value from a low-trust source — rejected with the same "trust" error class as today.
- Regression: `SECURITY_OVERLAY_FIELDS` derived from the schema metadata exactly equals the previously-hand-coded set. Test fails if the schema's metadata drifts.
- Regression: `assertSourceCategoryModelDefaults` continues to pass for the actual constants.

**Verification:**
- All existing tests in `tests/unit/agent-overlays.test.ts` pass (after the in-test updates above).
- All existing tests in `tests/unit/config.test.ts` and `tests/unit/config-handler.test.ts` pass without modification — public validator surface unchanged.
- The full test suite passes with no new failures.
- `agent-overlays.ts` line count drops by ~250-300 LOC (the 15 private helpers removed).

- [ ] **Unit 3: Build-time codegen for published JSON schema + bundled npm copy**

**Goal:** Generate `systematic-config.schema.json` from the Zod source, write it to both the docs site (`docs/public/schemas/v<MAJOR>/` + `latest/`) and the bundled npm location (`dist/schemas/`).

**Requirements:** R5, R6, R7, R14

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/generate-config-schema.ts` — reads `src/lib/config-schema.ts`, calls `z.toJSONSchema(SystematicConfigSchema, { target: 'draft-7', override: { $id: ... } })`, writes to three target paths. Supports `--check` mode (exits 1 if generated output differs from disk) for CI drift detection.
- Modify: `package.json` `scripts` — add `schema:generate: "bun scripts/generate-config-schema.ts"` and `schema:drift: "bun scripts/generate-config-schema.ts --check"`. Wire `schema:generate` into `docs:generate` (runs after `transform-content.ts`) and make sure `prepublishOnly` runs it after `build` (so the bundled copy survives `dist/`'s clean step). The generator also accepts `--version <semver>` for explicit override, mirroring `scripts/build-registry.ts`'s flag.
- Modify: `.github/workflows/main.yaml` — add `bun run schema:drift` step in the build job (mirrors registry drift check).
- Test: `tests/unit/generate-config-schema.test.ts`

**Approach:**
- Generator resolves the major version using the same fallback pattern as `scripts/build-registry.ts:resolveVersion` at `scripts/build-registry.ts:130-180`: explicit `--version` flag input → `git describe --tags --abbrev=0` → `package.json` (rejecting the `0.0.0-semantic-release` placeholder that lives in the unreleased tree) → hard-fail with a clear error if none yield a valid semver. This avoids writing to `v0/` from dev branches and CI, where `package.json.version` is the placeholder `0.0.0-semantic-release` and the actual published major is in the most-recent git tag. Bumping the major (next git tag) triggers writing to the new `vN/` directory; the previous `vN-1/` directory continues to exist (no automatic deletion — older majors stay published).
- `latest/` directory is rewritten on every run to match the current major.
- Bundled npm copy at `dist/schemas/systematic-config.schema.json` has the same content as the major-versioned docs copy; `$id` matches the docs URL.
- All three writes happen in the same pass so divergence is impossible.
- `--check` mode reads the existing files at all three locations, regenerates, and exits 1 if any byte-differ. Mirrors `scripts/generate-registry.ts --check` shape.

**Patterns to follow:**
- `scripts/generate-registry.ts` — `--check` mode shape, reading from / writing to `dist/`.
- `docs/scripts/transform-content.ts` — reading from project root, writing to `docs/`.
- The version-resolution helper pattern from `scripts/build-registry.ts` (git tag → `package.json` → dev fallback), or trivially write the same logic inline.

**Test scenarios:**
- Happy path: generator runs against a synthetic temp dir with a stub `package.json` (version `3.0.0`) — produces three files: `docs/public/schemas/v3/systematic-config.schema.json`, `docs/public/schemas/latest/systematic-config.schema.json`, `dist/schemas/systematic-config.schema.json`. All three byte-identical; each copy embeds the same major-versioned `$id`.
- Happy path: `$id` field reads `https://fro.bot/systematic/schemas/v3/systematic-config.schema.json` (NOT the `/latest/` URL). Covers AE4.
- Happy path: schema includes `$schema` pointing to draft-07 (`http://json-schema.org/draft-07/schema#`).
- Edge case: generator runs twice in a row — second run is a no-op (no file writes; `--check` would pass).
- Edge case: a hand-edit to one of the three files is detected — `--check` exits 1 with a diff-style message naming the file.
- Edge case: bumping major from `2.11.0` to `3.0.0` writes to `v3/` and updates `latest/`; `v2/` stays intact (assert it's still on disk).
- Edge case: dev tree where `package.json.version` is `0.0.0-semantic-release` AND no git tags exist — generator exits 1 with a clear "no resolvable version" error rather than writing to `v0/`. (Real release CI has both git tags and a real version after `semantic-release` runs; only fresh-clone dev branches without tags should hit this.)
- Edge case: explicit `--version 3.0.0-rc.1` flag overrides the resolver — generator writes to `v3/` and `latest/` regardless of git tag or `package.json` state.
- Error path: invalid `package.json` version (e.g., missing) — generator exits 1 with a clear error.
- Regression: a small representative agent overlay validates successfully against the generated schema with `ajv` (or equivalent) — proves the published schema accepts the same configs the runtime does.

**Verification:**
- All test scenarios pass.
- Running `bun run docs:generate` produces all three schema files on disk with no manual intervention.
- `bun run schema:drift` exits 0 on a clean tree, exits 1 after a hand-edit.
- The published schema's `$id` matches the docs URL pattern exactly.
- IDE smoke test (manual, documented in PR): adding `"$schema": "https://fro.bot/systematic/schemas/v2/systematic-config.schema.json"` to a real `systematic.json` triggers VSCode/Zed autocomplete on at least one nested field. (Manual; not automated in tests.)

- [ ] **Unit 4: Auto-generated reference docs page + sidebar entry**

**Goal:** Generate `docs/src/content/docs/reference/systematic-config.mdx` from the Zod schema's `.meta({ description, examples })` annotations. Add an explicit sidebar entry so the page is reachable.

**Requirements:** R8, R9, R10

**Dependencies:** Unit 1, Unit 3 (the generator reads metadata from the Zod schema; the page links to the schema URL Unit 3 publishes)

**Files:**
- Create: `docs/scripts/generate-config-reference.ts` — reads `SystematicConfigSchema`, walks the schema tree, emits a Starlight-compatible `.mdx` page. Each field becomes a section with description, type, default (if any), enum (if any), and at least one example. Page header includes the copy-paste `$schema` line.
- Modify: `docs/astro.config.mjs` — add an explicit sidebar entry under the Reference section pointing at `reference/systematic-config`. (Sidebar autogenerate covers `reference/skills` and `reference/agents` only.)
- Modify: the generated `systematic-config.mdx` page header includes a brief note about offline IDE behavior — the schema's `$id` is the canonical online URL, so IDEs that prefer fetching the canonical schema may attempt to reach the docs site even when the bundled npm copy is also on disk. Users needing strict offline behavior should configure their editor to associate `systematic.{json,jsonc}` with `node_modules/@fro.bot/systematic/dist/schemas/systematic-config.schema.json` directly.
- Modify: `package.json` `scripts` — wire `docs/scripts/generate-config-reference.ts` into `docs:generate` after `scripts/generate-config-schema.ts` (so the page can reference the published schema URL).
- Test: `tests/unit/generate-config-reference.test.ts`

**Approach:**
- Walking the Zod schema tree: for each `.shape` entry, emit a heading. For each leaf, emit description + type + default + examples + enum. Use `z.toJSONSchema` output as the structural source if simpler than walking Zod's internal tree directly; otherwise use Zod's `.shape` directly.
- The `$schema` copy-paste line in the page header points to `/systematic/schemas/v<MAJOR>/systematic-config.schema.json` (matching what U3 publishes).
- Page is regenerated on every `docs:generate`; the file is generator-owned. Hand-edits will be clobbered on the next regeneration; the generator output's header comment makes this clear so contributors don't waste time on the file directly. (No `docs/.gitignore` change is needed — the file is committed to track generator output diffs in PRs, same convention as the other auto-generated reference pages.)
- Sidebar entry under "Reference" (existing section), labeled "User Configuration" or similar.

**Patterns to follow:**
- `docs/scripts/transform-content.ts:90` (`generatePage`) — Starlight `.mdx` shape, frontmatter conventions.
- `docs/scripts/transform-content.ts:194` (`generateIndexPage`) — sidebar/index conventions.
- `docs/astro.config.mjs:56-61` — existing sidebar entry shapes (Reference > Skills, Reference > Agents).

**Test scenarios:**
- Happy path: generator runs against a synthetic temp dir — produces `systematic-config.mdx` with frontmatter, copy-paste `$schema` block, one section per top-level config key (`agents`, `categories`, `disabled_skills`, `disabled_agents`, `disabled_commands`, `bootstrap`), at least one example per field.
- Happy path: every leaf field in the schema has a non-empty description in the generated page (catches an undocumented field at build time).
- Error path: a field with no `.meta({ examples })` causes the generator to exit 1 with an error naming the field path. R8 requires every field to have at least one example, so the contract is enforced at build time, not at runtime. (If a field is genuinely example-free — e.g., a `Record<string, unknown>` passthrough — the schema can supply a placeholder example or the field is annotated as `example-exempt` via metadata.)
- Edge case: enum fields render as a list of valid values.
- Error path: unreadable schema (Zod schema fails to import) — generator exits 1 with the import error.
- Regression: running the generator twice produces byte-identical output.

**Verification:**
- All test scenarios pass.
- `bun run docs:build` succeeds end-to-end including the new page.
- The new page renders in the local dev server (`bun run docs:dev`) under the Reference section.
- The page's copy-paste `$schema` URL matches what U3 publishes.

- [ ] **Unit 5: JSONC precedence in loader + blast-radius cleanup**

**Goal:** Add `.jsonc` as a first-class config extension that takes precedence over `.json` at every config-search location. Update hardcoded `.json` references in tests, docs, and CLI output.

**Requirements:** R11, R12, R13

**Dependencies:** None (independent of U1-U4 but lands in same PR)

**Files:**
- Modify: `src/lib/config.ts` — add internal helper `resolveConfigPath(dir, basename)` that probes `<dir>/<basename>.jsonc` then `<dir>/<basename>.json` and returns the first hit or `undefined`. Update `getConfigPaths()` at line 297 to use this helper for all three search locations. Existing callers continue to receive a single resolved path per location.
- Modify: `src/cli.ts` — `config show` and `config path` commands display the resolved path (`.jsonc` or `.json`) accurately.
- Modify: `tests/unit/config.test.ts` — add tests for JSONC precedence; update fixtures that hardcode `.json` filenames where they should be agnostic.
- Modify: `tests/unit/config-handler.test.ts` — update fixtures the same way.
- Modify: `tests/unit/plugin.test.ts` — update fixtures.
- Modify: `tests/integration/opencode.test.ts` — extend `homeDir`-based fixtures to cover JSONC-first behavior in at least one integration test.
- Modify: `docs/src/content/docs/getting-started/configuration.mdx` — document that both `.jsonc` and `.json` are supported, with `.jsonc` taking precedence. Show a JSONC example as the recommended starting point.

**Approach:**
- The probe is two `fs.existsSync` calls in order. No globbing. Bounded cost.
- Silent precedence when both files exist — explicit project decision recorded in origin doc AE1. No warning emitted; the JSONC file's existence is the explicit user signal.
- `cli.ts` updates the `config show` and `config path` output to print the actual resolved path so users debugging precedence can see which file was loaded.
- Test fixtures: any test that creates a `systematic.json` in a synthetic dir continues to work unchanged. New tests cover the `.jsonc` precedence cases.
- `configuration.mdx` updates show JSONC as the recommended format with comments demonstrating why (e.g., commenting why a specific agent is disabled). Keeps the JSON example for users who prefer it.
- The work has three logical sub-phases that the implementer may land as separate commits within this unit for cleaner review: (1) loader and CLI behavior change in `src/lib/config.ts` and `src/cli.ts` plus their direct unit tests, (2) test-fixture cleanup across the three test files plus the integration test extension, (3) docs update in `configuration.mdx`. Splitting is optional; the unit can land as one commit if simpler. Verification gates (below) apply to the integrated state.

**Patterns to follow:**
- `src/lib/config.ts:302-307` — existing config-search locations (treat the basename `systematic` as the constant input to `resolveConfigPath`).
- `tests/unit/config.test.ts` — existing `homeDir` / `projectDir` fixture pattern.

**Test scenarios:**
- Happy path: only `systematic.json` exists in a search location — loader reads it, no behavior change. Covers AE3, R12.
- Happy path: only `systematic.jsonc` exists in a search location with line comments and trailing commas — loader reads it, parses correctly. Covers AE2, R11.
- Edge case: both `systematic.jsonc` and `systematic.json` exist in the same search location — loader reads `.jsonc` and ignores `.json`. No warning emitted. Covers AE1, R11.
- Edge case: neither file exists in a search location — that location contributes nothing (existing behavior).
- Edge case: search location dir doesn't exist — returns undefined cleanly (no crash). (Existing behavior, but worth a regression test in the new code path.)
- Edge case: `.jsonc` file is malformed (truly invalid JSONC) — loader fails with an error naming the file (the existing parser already handles this; verify the new code path preserves the behavior).
- Integration: `tests/integration/opencode.test.ts` — homeDir-based fixture with both files present, OpenCode `config()` hook returns the JSONC content.
- CLI: `bun src/cli.ts config show` after creating both files prints the `.jsonc` path.
- CLI: `bun src/cli.ts config path` prints the `.jsonc` path.
- Regression: existing test suites pass without modification — public `loadConfigWithSources` signature unchanged.

**Verification:**
- All test scenarios pass.
- `bun src/cli.ts config show` and `bun src/cli.ts config path` both reflect JSONC precedence.
- The `configuration.mdx` page renders correctly in local docs dev.
- No hardcoded-`.json` references remain in the modified test files.

## System-Wide Impact

- **Interaction graph:** The Zod schema becomes the single source of truth consumed by (a) runtime validation in `loadConfigWithSources`, (b) `validateAgentOverlays` and friends in `agent-overlays.ts`, (c) the JSON-schema codegen in `scripts/generate-config-schema.ts`, (d) the docs-page generator in `docs/scripts/generate-config-reference.ts`, (e) the source-default constant assertion. Five consumers, one schema.
- **Error propagation:** Validation errors from Zod surface to the same callers that consume hand-rolled errors today. The error shape changes (Zod's default formatter has structured `issues[]`), so any caller that pattern-matched on the old error string format needs updating. U2 names the audit targets explicitly (CLI error handlers in `src/cli.ts`, test assertions on validator error messages, `config-handler.ts` and `src/index.ts` propagation paths). The acceptance bar remains "field path + human-readable reason" — no custom formatter for v1.
- **State lifecycle risks:** None — the work is replacement, not state-bearing. Source defaults and user overlays continue to flow through the same merge paths.
- **API surface parity:** Public exports from `agent-overlays.ts` keep their signatures; only the internal validators are removed. No breaking change for any downstream caller that imports from `src/lib/`.
- **Integration coverage:** U3's generator round-trips a representative config through `ajv` (or an equivalent) to prove the published JSON schema accepts the same shapes the runtime does. U5's integration test extends `homeDir` fixtures to cover JSONC precedence end-to-end.
- **Unchanged invariants:** OpenCode's `config(cfg)` hook output shape remains identical. `cfg.agent[*]` field set unchanged. No new fields added; no field renames. Existing `systematic.json` files continue to load identically (R12). Bundled-asset frontmatter validation in the content-integrity gate is unchanged. OCX registry shape and emission is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Adding zod as a runtime dep increases `dist/index.js` size meaningfully. | Zod 4 is ~30KB minified after tree-shaking for the API surface this work uses. The current `dist/index.js` is ~50KB; final size ~80KB is acceptable for a plugin. Bun build's tree-shaking handles unused Zod features. Verify in U1 with `bun run build && wc -c dist/index.js`. |
| Published schema URL becomes a long-term contract; future major bumps require careful coordination. | The major-versioned URL pattern explicitly handles future majors (older versions stay published indefinitely; `/latest/` always points at current). The URL pattern is self-documenting; no separate policy note is needed on the docs site. |
| IDE behavior with the published schema is hard to test in CI. | U3's verification includes a manual IDE smoke test in the PR description (one screenshot of VSCode autocomplete on a real `systematic.json`). Documented as a manual step; not automated. |
| Trust-tagged metadata in the Zod schema drifts from the hand-coded `SECURITY_OVERLAY_FIELDS` constant. | U2 derives `SECURITY_OVERLAY_FIELDS` directly from the schema metadata (single source of truth). Regression test asserts the derived set equals the previously-hand-coded set; future drift breaks the test loudly. |

## Documentation / Operational Notes

- The new `docs/src/content/docs/reference/systematic-config.mdx` is generated, not hand-written. Documenters add new fields by editing the Zod schema's `.meta()` annotations, not the .mdx file. Add a comment at the top of `docs/src/content/docs/reference/systematic-config.mdx` (in the generator output) explaining this so contributors don't waste time editing the generated file.
- v3.0.0 release notes (when this work ships) should call out: (a) the new `$schema` URL users can add for IDE autocomplete, (b) the JSONC precedence change (silent — no behavior shift for users with only `.json`), (c) the bundled npm schema fallback for offline IDEs.
- A future small follow-up (deferred per origin doc) could add `systematic config init` CLI subcommand to write the `$schema` line into an existing config. Not in scope for this PR.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-10-zod-config-schema-jsonc-requirements.md](docs/brainstorms/2026-05-10-zod-config-schema-jsonc-requirements.md)
- Related code: `src/lib/config.ts:297-307`, `src/lib/agent-overlays.ts`, `scripts/generate-registry.ts`, `docs/scripts/transform-content.ts`, `docs/astro.config.mjs:56-61`, `scripts/content-integrity.ts:722-730` (`OPENCODE_AGENT_COLOR_TOKENS`).
- Related solutions docs: `docs/solutions/best-practices/layered-trust-boundaries-overlay-config-2026-05-09.md`, `docs/solutions/integration-issues/opencode-config-schema-rejects-ad-hoc-agent-colors-2026-05-09.md`.
- Related PRs: #344 (trust-sensitive overlay fields), #345 (source category model defaults v1), #346 (color schema fix), #348 (auth-aware source resolution).
- External: Zod 4 (^4.4.3) `z.toJSONSchema()` — verified via librarian Phase 1.2 dispatch; OCX registry V2 schema URL pattern (`https://ocx.kdco.dev/schemas/v2/registry.json`) as precedent for major-versioned static schema publication.
