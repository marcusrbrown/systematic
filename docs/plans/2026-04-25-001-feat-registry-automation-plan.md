---
title: "feat: Auto-generate OCX registry from filesystem with V2 migration"
type: feat
status: active
date: 2026-04-25
origin: docs/brainstorms/2026-04-25-registry-automation-requirements.md
---

# feat: Auto-generate OCX registry from filesystem with V2 migration

## Overview

Replace the hand-maintained OCX registry with an auto-generated one. A new generator script scans `skills/` and `agents/` directories, extracts frontmatter, and produces V2 OCX registry components — eliminating the 82% skill and 52% agent registration gap. The build script is updated to consume V2 format, symlinks are removed, and a `--check` mode in CI prevents future drift.

## Problem Frame

`registry/registry.jsonc` is hand-maintained with only 8/45 skills and 24/50 agents registered. Every new skill or agent requires a manual entry — drift is guaranteed. The registry also uses V1 schema format while V2 is current, and `registry/files/` contains unused symlinks (`skills` and `agents` symlinks are not referenced by the build script — it resolves skill/agent paths directly from the repo root). (See origin: `docs/brainstorms/2026-04-25-registry-automation-requirements.md`)

## Requirements Trace

- R1–R9: Generator script (discovery, V2 components, curated preservation, bundle deps, JSONC comments, frontmatter fallback, exclusions)
- R10–R13: V2 schema migration (URL, types, paths, string shorthand)
- R14–R15: Symlink removal
- R16–R19: Build script V2 updates
- R20–R21: CI drift validation
- R22–R23: Test coverage

## Scope Boundaries

- Generator covers skills and agents only — bundles, profiles, and plugin entries stay hand-curated (see origin: Decision #1)
- Bundle `dependencies` arrays are auto-populated; all other bundle/profile/plugin fields are manual
- No external registry publishing — local build only
- No description generation from SKILL.md body content — frontmatter `description` is the source

## Context & Research

### Relevant Code and Patterns

- `scripts/build-registry.ts` — existing build pipeline: `loadRegistrySource()` → `validateRegistry()` → `buildRegistry()` → `buildPackument()`. V2 update points at lines 187-217 (type literals), 372-375 (OCX_TARGET_REWRITES), 447-451 (file entries)
- `src/lib/skills.ts:findSkillsInDir()` — scans for `SKILL.md`, extracts frontmatter, returns `SkillInfo[]`
- `src/lib/agents.ts:findAgentsInDir()` — scans for `.md` files, returns `AgentInfo[]` with names/files/categories
- `src/lib/frontmatter.ts:parseFrontmatter()` — YAML frontmatter extraction via regex + js-yaml
- `src/lib/walk-dir.ts:walkDir()` — recursive directory walker with depth/filter support
- `tests/unit/build-registry.test.ts` — existing tests use `registry/registry.jsonc` directly as fixture; error accumulation pattern with extracted helpers

### Institutional Learnings

- `docs/solutions/code-quality/ocx-registry-review-fixes.md` — test complexity must stay under Biome's 15-point threshold; use helper extraction pattern for error accumulation loops; CLI args need validation with descriptive errors
- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md` — use `find | while read` for batch iteration, never `for f in $VAR` in zsh

## Key Technical Decisions

- **Component names from filesystem, not frontmatter**: Frontmatter `name` fields contain colons (`ce:brainstorm`) and underscores (`generate_command`) that violate V2 schema pattern `^[a-z0-9]+(-[a-z0-9]+)*$`. Skills use directory name, agents use `agent-` prefix + filename stem.
- **Reuse existing lib functions**: `findSkillsInDir`, `findAgentsInDir`, `extractAgentFrontmatter`, `walkDir`, `parseFrontmatter` for discovery and parsing. `findAgentsInDir` returns names/files/categories but not description — use `extractAgentFrontmatter` (or `parseFrontmatter` directly) per agent to extract descriptions. `findSkillsInDir` returns frontmatter `name` which may contain colons/underscores — always use `path.basename(skill.path)` for the component name, not `skill.name`.
- **Generate fresh header comment**: The generator writes a standard header comment block (registry name, schema URL, generation timestamp). It does NOT preserve V1-era comments — the existing comments reference symlinks and V1 behavior that will be stale after migration. `jsonc-parser` supports comment extraction via `parseTree`, but preserving stale comments is worse than regenerating them.
- **Remove singularization**: V2 schema accepts plural target prefixes (`agents/`, `skills/`). `OCX_TARGET_REWRITES` and `normalizeTargetPath` are removed entirely. String shorthand applies to both skills and agents since source path = target path.
- **String shorthand for all file entries**: With no `.opencode/` prefix and no singularization, every file entry's source path IS its install target path. All entries use V2 string shorthand.
- **`--check` mode via in-memory comparison**: Generate registry content in memory, compare with existing file. Exit 0 if identical, exit 1 with diff indication if changed.

## Open Questions

### Resolved During Planning

- **Should `normalizeTargetPath` be replaced or removed?** Removed entirely — V2 accepts plural paths, no rewriting needed.
- **How to handle JSONC comments?** Generate a fresh header comment block rather than preserving V1-era comments that reference symlinks and outdated behavior. `jsonc-parser` supports comment extraction via `parseTree`/`createScanner`, but preservation is the wrong approach here.
- **Generator test fixture strategy?** Use temp directories with synthetic skill/agent structures, not the real `registry/registry.jsonc` — generator tests should be isolated from actual repo content. Build-registry tests continue using the real registry as fixture.

### Deferred to Implementation

- **Exact `walkDir` filter options**: Whether to use `walkDir`'s built-in filtering or post-filter results against the exclusion list (R9) — depends on `walkDir`'s current API surface.
- **JSONC output formatting**: Whether `JSON.stringify(data, null, 2)` matches the existing file's indentation or needs adjustment.
- **`--check` comparison refinement**: If string comparison produces false positives from key ordering or formatting differences in hand-edited curated entries, upgrade to parse-and-deep-compare strategy. Start with string comparison (simpler) and iterate if needed.

## Implementation Units

- [ ] **Unit 1: V2 migration of build-registry.ts**

**Goal:** Update the build script to consume V2 format — type literals, path handling, string file entries. This is a prerequisite for everything else since the generator produces V2 output.

**Requirements:** R10–R12, R16–R19, R22

**Dependencies:** None

**Files:**
- Modify: `scripts/build-registry.ts`
- Modify: `tests/unit/build-registry.test.ts`
- Modify: `registry/registry.jsonc` (manual V1→V2 type migration: strip `ocx:` prefixes, remove `.opencode/` from target paths, convert to string shorthand where source=target)

**Approach:**
- Replace all `'ocx:skill'`, `'ocx:agent'`, `'ocx:command'`, `'ocx:bundle'`, `'ocx:profile'`, `'ocx:plugin'` type literals with unprefixed versions (`'skill'`, `'agent'`, etc.) in both the validator map and type-specific validators
- Update `RegistryFile` type to union: `RegistryFile | string`. Update all consumers: `validateSkillComponent` (checks `f.path === 'SKILL.md'`), `validateFileComponent` (checks `file.path.endsWith`), `resolveComponentFilePath`, and `buildPackument` to handle string entries via `typeof file === 'string'` → `{ path: file, target: file }`
- Simplify `resolveComponentFilePath` to `path.join(PROJECT_ROOT, filePath)` for all component types in V2. The current skill-specific resolution (`path.join(PROJECT_ROOT, 'skills', component.name, file.path)`) assumes `file.path` is skill-dir-relative (V1). In V2, all paths are repo-root-relative — `resolveComponentFilePath` must not prepend type-specific prefixes
- Remove `OCX_TARGET_REWRITES` constant and `normalizeTargetPath` function — targets pass through as-is. Update the existing test `writes normalized target paths for agents` to expect plural `agents/` paths (no singularization)
- Manually migrate existing `registry/registry.jsonc` entries from V1 to V2: strip `ocx:` type prefixes, convert file entries to repo-root-relative string shorthand (e.g., skill `{path: 'SKILL.md', target: '.opencode/skills/agent-browser/SKILL.md'}` → `'skills/agent-browser/SKILL.md'`). This prevents the build from breaking between Unit 1 and Unit 2
- Update schema URL from V1 to V2

**Patterns to follow:**
- Existing `build-registry.ts` structure — modify in place, don't restructure
- Test helper extraction pattern from `docs/solutions/code-quality/ocx-registry-review-fixes.md`

**Test scenarios:**
- Happy path: V2 component with unprefixed type `skill` validates successfully
- Happy path: V2 component with string file entry `"skills/foo/SKILL.md"` resolves correctly in packument
- Happy path: V2 component with `{path, target}` object file entry still works (backward compat within V2)
- Edge case: Component with mixed string and object file entries in same `files` array
- Error path: Component with unrecognized type (e.g., `'ocx:skill'` — old V1 format) fails validation
- Integration: Full build from manually-migrated V2 `registry.jsonc` produces valid `dist/registry/index.json` and component packuments (uses the real registry after manual migration, not a synthetic fixture)

**Verification:**
- `bun test tests/unit/build-registry.test.ts` passes with updated expectations
- `bun scripts/build-registry.ts` produces valid `dist/registry/` output
- No references to `ocx:` prefix, `OCX_TARGET_REWRITES`, or `normalizeTargetPath` remain in `build-registry.ts`

---

- [ ] **Unit 2: Generator script**

**Goal:** Create `scripts/generate-registry.ts` that auto-generates V2 registry components from filesystem + frontmatter, preserves hand-curated entries, auto-populates bundle dependencies, and writes output with JSONC comment preservation.

**Requirements:** R1–R9, R13

**Dependencies:** Unit 1 (build script must handle V2 format)

**Files:**
- Create: `scripts/generate-registry.ts`
- Modify: `registry/registry.jsonc` (generated output replaces current V1 content)

**Approach:**
- Import `findSkillsInDir` from `src/lib/skills.ts`, `findAgentsInDir` and `extractAgentFrontmatter` from `src/lib/agents.ts`, `walkDir` from `src/lib/walk-dir.ts`, `parseFrontmatter` from `src/lib/frontmatter.ts`
- **Skill discovery**: `findSkillsInDir('skills')` → for each skill, use `path.basename(skill.path)` for the component name (NOT `skill.name` — that comes from frontmatter and may contain colons). Call `walkDir(skillDir)` to enumerate all files, filter exclusions (R9), compute repo-root-relative paths via `path.relative(PROJECT_ROOT, filePath)`. Generate V2 component: `{ name: dirName, type: 'skill', description: skill.description, files: [string shorthand paths] }`
- **Agent discovery**: `findAgentsInDir('agents')` → for each agent, read the file and call `extractAgentFrontmatter` (or `parseFrontmatter` directly) to get `description`. Generate V2 component: `{ name: 'agent-' + filenameStem, type: 'agent', description: frontmatter.description, files: [agentFilePath] }`
- **Component name sanitization**: Derive from filesystem paths. Transform underscores to hyphens (`generate_command` → `generate-command`) to satisfy V2 schema pattern `^[a-z0-9]+(-[a-z0-9]+)*$`. Agent names use `agent-` prefix + filename stem
- **Curated entry preservation**: Read existing `registry.jsonc` with `jsonc-parser`, identify entries where `type` is `bundle`, `profile`, or `plugin`. Carry these through to output with two modifications: (1) type migration if still V1 (`ocx:bundle` → `bundle`), (2) bundle dependency auto-population per R6. All other fields (name, description, metadata, non-aggregator dependencies) are preserved as-is
- **Bundle dependency auto-population**: For bundles named exactly `skills` or `agents`, replace `dependencies` array with all generated component names of the matching type, sorted alphabetically
- **Header comment generation**: Write a standard header comment block (registry name, schema URL, generation note with timestamp). Do not preserve V1-era comments — they reference symlinks and outdated behavior
- **Output format**: Header comment + `JSON.stringify(registryObject, null, 2)` + trailing newline. V2 schema URL, unprefixed types, string shorthand for all generated file entries. Curated entry file formats are preserved as-is (may be string or object)
- **Ordering**: Generated components sorted alphabetically by name, followed by curated entries
- **Frontmatter fallback** (R8): Component names always come from filesystem, not frontmatter — no fallback needed for names. For descriptions: if frontmatter is missing or unparseable, warn to stderr and set description to empty string. If description is empty (whether from missing frontmatter or empty field), exit with error — V2 schema requires non-empty descriptions

**Patterns to follow:**
- `scripts/build-registry.ts` for CLI argument parsing and error reporting style
- `scripts/content-integrity.ts` for structured exit codes and stderr messaging
- `src/lib/skills.ts` and `src/lib/agents.ts` for discovery patterns

**Test scenarios:** Covered in Unit 5 (generator tests are isolated with synthetic fixtures)

**Test expectation: none** — this unit creates the script; Unit 5 covers testing. Manual verification runs the generator and inspects output.

**Verification:**
- `bun scripts/generate-registry.ts` completes without errors
- `registry/registry.jsonc` contains all 45 skills and 50 agents as V2 components
- Curated entries (bundles, profiles, plugin) preserved with V2 types
- Bundle `skills` and `agents` dependencies match generated component counts
- `bun scripts/build-registry.ts` builds successfully from the generated V2 registry
- JSONC header comments present in output

---

- [ ] **Unit 3: Symlink removal**

**Goal:** Delete the `registry/files/skills` and `registry/files/agents` symlinks. Keep `registry/files/profiles/` (real files).

**Requirements:** R14, R15

**Dependencies:** Unit 1 (build script no longer uses type-specific path prefixing; symlinks were never used by the build script for skill/agent resolution)

**Files:**
- Delete: `registry/files/skills` (symlink → `../../skills`)
- Delete: `registry/files/agents` (symlink → `../../agents`)

**Approach:**
- `rm registry/files/skills registry/files/agents`
- Verify `registry/files/profiles/` and its contents are untouched
- Verify `bun scripts/build-registry.ts` still works without symlinks (the build script never used them for skill/agent resolution — it resolves directly from repo root)

**Test expectation: none** — symlink removal is a file deletion, not behavioral code.

**Verification:**
- No symlinks in `registry/files/` (`find registry/files -type l` returns empty)
- `registry/files/profiles/` directory and contents unchanged
- Full build still succeeds: `bun scripts/build-registry.ts`

---

- [ ] **Unit 4: Generator --check mode and CI integration**

**Goal:** Add drift detection to the generator and wire it into CI so registry staleness blocks the build.

**Requirements:** R20, R21

**Dependencies:** Unit 2 (generator must exist)

**Files:**
- Modify: `scripts/generate-registry.ts`
- Modify: `.github/workflows/main.yaml`

**Approach:**
- **`--check` flag**: Parse `process.argv` for `--check`. When set: generate registry content in memory (same logic as normal mode), read existing `registry/registry.jsonc`, compare strings. If identical → exit 0 with "Registry is up to date" message. If different → exit 1 with "Registry is out of date. Run `bun scripts/generate-registry.ts` to update." and optionally show which components differ.
- **CI step**: Add `bun scripts/generate-registry.ts --check` step to `main.yaml` build job, positioned after the content-integrity gate step. Same pattern: runs `bun`, checks exit code, blocks on failure.

**Patterns to follow:**
- Content-integrity gate CI step in `.github/workflows/main.yaml` for positioning and naming
- `scripts/content-integrity.ts` for `--check` style exit code patterns

**Test scenarios:**
- Happy path: `--check` on an up-to-date registry exits 0
- Error path: `--check` on a stale registry (after adding a skill directory without running generator) exits 1
- Edge case: `--check` on a registry with only whitespace differences (normalize before compare)

**Verification:**
- `bun scripts/generate-registry.ts --check` exits 0 on current repo
- After creating a dummy skill directory, `--check` exits 1
- CI workflow has the step in the correct position

---

- [ ] **Unit 5: Generator tests**

**Goal:** Comprehensive test coverage for the generator script — discovery, frontmatter parsing, curated entry preservation, bundle dependency auto-population, and V2 format correctness.

**Requirements:** R23

**Dependencies:** Unit 2, Unit 4

**Files:**
- Create: `tests/unit/generate-registry.test.ts`

**Approach:**
- Use temp directories with synthetic skill/agent structures (same pattern as `content-integrity.test.ts` — real temp dirs, no mocking)
- Create minimal `SKILL.md` files with frontmatter, agent `.md` files, and a seed `registry.jsonc` with curated entries
- Test generator output by running it against the temp dir and parsing the result

**Patterns to follow:**
- `tests/unit/content-integrity.test.ts` for temp dir setup/teardown and real-filesystem testing
- `tests/unit/build-registry.test.ts` for error accumulation helpers

**Test scenarios:**
- Happy path: Skill with SKILL.md + references/ subdirectory → correct V2 component with all files listed as string shorthand
- Happy path: Agent `foo-bar.md` → component name `agent-foo-bar`, type `agent`, single file entry
- Happy path: Curated bundle entry preserved in output with V2 type (`bundle` not `ocx:bundle`)
- Happy path: Bundle named `skills` gets `dependencies` auto-populated with all generated skill component names, sorted
- Happy path: Bundle named `agents` gets `dependencies` auto-populated with all generated agent component names, sorted
- Happy path: Generated components sorted alphabetically, curated entries after generated
- Edge case: Skill with missing frontmatter → warning emitted, falls back to directory name
- Edge case: Skill with empty description in frontmatter → error exit
- Edge case: Excluded files (`.DS_Store`, `.gitkeep`, `AGENTS.md`) not in component file lists
- Edge case: Agent in nested category directory (`agents/review/foo.md`) → correct file path in component
- Integration: `--check` returns 0 on freshly generated registry, 1 after adding new skill
- Happy path: Fresh header comment block present in output (not V1-era preserved comments)
- Edge case: Skill with underscore in directory name (`generate_command`) → component name `generate-command` (underscore→hyphen)

**Verification:**
- `bun test tests/unit/generate-registry.test.ts` passes
- All scenarios cover distinct requirements
- Cognitive complexity stays under Biome's 15-point threshold

## System-Wide Impact

- **Build pipeline**: `build-registry.ts` consumes V2 format → `dist/registry/` output changes shape (unprefixed types, plural paths, string file entries). Downstream consumers of `dist/registry/` must handle V2 packuments.
- **CI workflow**: New `--check` step added to build job. Failure blocks merge — same enforcement pattern as content-integrity gate.
- **OCX consumers**: Anyone who installed components via `ocx add` from the old V1 registry will see V2 format on next install. OCX CLI handles both formats (V2 is backward compatible in the CLI).
- **Unchanged invariants**: `dist/registry/index.json` and `dist/registry/components/*.json` continue to be the build output paths. Profile files in `registry/files/profiles/` are untouched. The `build-registry.ts` version resolution chain (git tag → package.json → dev) is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| V2 format breaks existing OCX CLI consumers | OCX CLI supports both V1 and V2. V2 schema is documented and validated. |
| Generator misses files in skill directories | Uses `walkDir` (recursive) + exclusion list. Integration test against real repo validates count. |
| `generate_command` directory name has underscore | Generator transforms underscores to hyphens for V2 schema compliance. Test covers this case. |
| `--check` mode has false positives from whitespace | Normalize both strings before comparison (trim trailing whitespace/newlines). |
| Build-registry test updates break pre-existing tests | The 2 pre-existing test failures on `main` are already tracked — new changes should not add more. Run full suite after each unit. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-25-registry-automation-requirements.md](docs/brainstorms/2026-04-25-registry-automation-requirements.md)
- Related code: `scripts/build-registry.ts`, `src/lib/skills.ts`, `src/lib/agents.ts`, `src/lib/frontmatter.ts`, `src/lib/walk-dir.ts`
- Related learning: `docs/solutions/code-quality/ocx-registry-review-fixes.md`
- OCX V2 schema: `https://ocx.kdco.dev/schemas/v2/registry.json`
- OCX docs: `https://kdco.mintlify.app/registries/create`
