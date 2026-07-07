---
title: "feat: v3.0.0 compatibility cleanup release"
type: feat
status: active
date: 2026-07-06
origin: docs/brainstorms/2026-07-06-v3-cleanup-release-requirements.md
target_branch: v3
---

# feat: v3.0.0 Compatibility Cleanup Release

## Overview

v3.0.0 is a breaking **cleanup** release. It removes the dead CEP-era compatibility surfaces whose behavior has already been made explicit and gated in v2.x: the runtime converter (`src/lib/converter.ts` and its three callers), the `systematic convert` CLI subcommand, and the two deprecated skills `orchestrating-swarms` and `claude-permissions-optimizer`. It populates the (already-shipped, currently-empty) removed-name warn-and-ignore mechanism so deleting those skills cannot brick users who followed v2.19 deprecation guidance, regenerates every surface that reflects the bundle, deletes the frozen v2 JSON Schema, ships committed migration guidance, and verifies the packaged plugin in an isolated OpenCode runtime.

This release earns its major-version bump by removing stale surfaces, not by adding capability. All behavior-preserving prerequisites (explicit `mode`/`temperature` gates, the converter-injected-field audit, the `orchestrating-subagents` replacement skill, and the warn-and-ignore machinery from #534) have shipped.

**Development posture:** All work lands via PRs into the long-lived `v3` branch. The branch is release-safe by construction (no workflow's `push` trigger includes `v3`; `.releaserc.yaml` stays `branches: [main]`), so breaking commits accumulate without triggering a publish. v3 cuts live later via a `--no-ff` merge of `v3` into `main`.

## Problem Frame

The converter was migration-era code from the CEP→OpenCode transition. It still runs at bundled-asset load time in three places (agent/command loading via `config-handler.ts`, skill loading via `skill-loader.ts`, and the dev CLI via `cli.ts`), normalizing frontmatter and rewriting CC-shaped skill bodies. Research (this session) confirmed that under the post-#534 content-integrity gates, **every frontmatter normalization branch is now a no-op on current bundled data**, and the converter's only non-bundled input is the dev CLI — so removing it is behavior-safe for the shipped plugin. Its body transforms remain load-bearing only for the two deprecated skills' CC-shaped bodies, which this release deletes.

Two deprecated skills remain discoverable: `orchestrating-swarms` (a CEP/Claude-Code-Teammate fossil with no OpenCode equivalent) and `claude-permissions-optimizer` (targets Claude Code permission files, no OpenCode surface). Both were deprecated in v2.19.0. Deleting them under the current strict `disabled_skills`/`disabled_agents` enums would throw uncaught out of plugin init and brick exactly the users who followed deprecation guidance (`disabled_skills: ["orchestrating-swarms"]`) — which is why the warn-and-ignore net must be populated in the same release.

## Requirements Trace

Carried from the origin brainstorm (see origin: `docs/brainstorms/2026-07-06-v3-cleanup-release-requirements.md`):

- R1. Remove runtime converter use from all three callers, replicating or intentionally dropping its normalization rather than only deleting call sites.
- R2. Delete `src/lib/converter.ts` after a zero-import/zero-call-site audit.
- R3. Migrate only converter tests that preserve a behavior guarantee or loader equivalence; delete dead-path converter tests.
- R3a. Confirm converter input scope — proven this session: production callers hardcode `source: 'bundled'`; the converter never runs on user-supplied files (only the dev CLI takes arbitrary paths). Behavior-preserving claim holds for bundled assets.
- R4. Remove the `systematic convert` command, help text, routing, and unused `convertContent` import from `src/cli.ts`.
- R5. Release guidance explains the removal and gives a v2.x pin path; accepts out-of-repo breakage.
- R6. Delete `skills/orchestrating-swarms/` and `skills/claude-permissions-optimizer/`.
- R7. Remove the deleted skills from every generated/active surface (canonical list below).
- R8. Keep `claude-permissions-optimizer` removed without replacement; migration guidance states the gap honestly and names OpenCode's own permission config as the manual alternative.
- R9. `orchestrating-subagents` survives regeneration across the same canonical surface list.
- R10. Removed bundled names in `disabled_skills`/`disabled_agents` warn-and-ignore, not hard-fail (ships in the same release that deletes the skills).
- R10a. Durable gate + regression tests: a removed name warns and loads; genuinely-invalid config still throws.
- R11. Regenerate the canonical surfaces; **delete** `docs/public/schemas/v2/` on the cut.
- R12. Committed migration guidance (not only release notes) covering removed skills, config/profile cleanup, CLI converter removal, and the v2 pin path; release checklist verifies narrated notes match committed docs.
- R13. Verify the packaged v3 plugin in an isolated OpenCode runtime (loads without converter; catalog exposes `orchestrating-subagents`, omits removed skills; removed name in `disabled_skills` loads with a warning; invalid config still throws). Fixture loads the packaged artifact, not only source-local TypeScript.
- R14. No broad imported-skill rewrites, model-default changes, or general frontmatter redesign.
- R15. Correct active product guidance only; do not scrub historical docs for grep cleanliness.

Added under confirmed full scope (tied dead code stranded by the cleanup):

- R16. Remove the now-unreachable deprecation-warning machinery: `formatDeprecationMessage` and the deprecation branch in `src/lib/skill-tool.ts`, and the `SkillDeprecated` interface in `src/lib/skills.ts` (no bundled skill will carry a `deprecated:` block after R6).
- R17. Remove the `inferBuiltInTemperature` runtime temperature fallback (`src/lib/agent-overlays.ts`) — its own content-integrity gate comment already declares it "removed in v3.0.0" — and adjust the gate so explicit `temperature:` remains required (unreachable fallback, not a behavior change on gated data).

## Scope Boundaries

- Broad imported-skill rewriting is out of scope (R14).
- Model defaults are out of scope; bundled agent markdown stays model-free (R14).
- General frontmatter-semantics redesign is out of scope (R14).
- Historical docs and shipped plan records stay historical unless linked from active user guidance (R15).

### Deferred to Separate Tasks

- The cooperative coordination-queue tool (buildable subset of swarm coordination): future idea, not v3. Native agent-to-agent messaging (OpenCode PR #32192) is watch-only.
- `systematic generate --harness`: deferred until a concrete non-OpenCode consumer exists.
- Any converter-shape tolerance for future CC-authored skills: intentionally abandoned; new skills author in OpenCode shape directly.

## Context & Research

### Relevant Code and Patterns

**Converter (removal target):**
- `src/lib/converter.ts` — exports `convertContent`, `convertFileWithCache`, `clearConverterCache`, `TOOL_NAME_MAP` (zero live importers of `TOOL_NAME_MAP`; the `bootstrap.ts` cross-check comment is stale), `CONVERTER_VERSION`.
- Callers: `src/lib/config-handler.ts` (`loadAgentAsConfig` agent path + `loadCommandAsConfig` command path — the command loop is already a no-op over an empty `commands/` dir), `src/lib/skill-loader.ts` (`loadSkill`), `src/cli.ts` (`runConvert`, dev-only, arbitrary path).
- Per-consumer normalization is dead on current bundled data: content-integrity gates enforce explicit `mode: subagent` and `temperature:`, no bare `model`, no `permissionMode`/`maxTurns`/`maxSteps`/`disable-model-invocation` on agents. The skill `context: fork → subtask` mapping is already performed independently by `extractFrontmatter` in `src/lib/skills.ts`. `config-handler.ts` overwrites the converter's `description` with a suffixed form, making that branch structurally dead.
- Body transforms (`transformBody`: Task→task capitalization, `.claude/`→`.opencode/` path rewrites) are load-bearing ONLY for the two deprecated skills' bodies; dead after R6.

**Removed-name safety (populate target):**
- `src/lib/removed-names.ts` — `REMOVED_BUNDLED_SKILL_NAMES` / `REMOVED_BUNDLED_AGENT_NAMES`, both empty (shipped in #534).
- Threaded through `src/lib/config-schema.ts` (`createSystematicConfigSchema` options `removedSkillNames`/`removedAgentNames`, appended to the `disabled_skills`/`disabled_agents` enum tuples so they parse) and `src/lib/config.ts` (post-parse `computeDroppedNames` + `warnDroppedNames` + effective-config filter; per-load `Set` dedup, no global state).
- Warning wording (`src/lib/config.ts` `warnDroppedNames`): `[systematic] "<name>" in \`<field>\` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning.`
- Overlap gate: `checkRemovedNamesOverlap` in `scripts/content-integrity.ts` asserts removed names never intersect current bundled names — so deletion (R6) and population must land together.
- Generator threads removed names too: `scripts/generate-config-schema.ts` passes them into the factory so the published schema enum matches runtime.

**Generated-surface canonical list (R7):** `src/lib/bundled-names.ts` (generated — "DO NOT EDIT BY HAND"), `registry/registry.jsonc` + `dist/registry/`, `docs/public/schemas/` + `dist/schemas/`, `docs/src/content/docs/reference/skills/` (per-skill pages + `index.mdx` CardGrid), `docs/src/data/stats.json`. Hand-edited residue: `scripts/.drift-allowlist.json` (two `pathGlob` exemptions), `docs/src/content/docs/guides/ocx-registry.mdx` (`ocx add systematic/orchestrating-swarms`), `tests/unit/transform-content.test.ts` (uses `orchestrating-swarms` as a fixture case name).
Generators: `bun run docs:generate` (→ `generate-config-schema.ts` bundled-names + schema, `transform-content.ts` docs pages, `generate-stats.ts` stats), `bun run registry:build`.

**Isolated-runtime fixture (extend target):** `tests/integration/opencode.test.ts` — `IsolatedFixture` (temp HOME + all XDG roots + `OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT`), `runOpencode` spawns real `opencode`, `buildSourceLocalConfig()`/`buildDistLocalConfig()` load `file://` src/dist. **No path loads the packaged tarball** — R13 requires adding an `npm pack`/install path.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` — the loader treats every named export of `src/index.ts` as a plugin factory; a stowaway export bricks load (v2.5.0, v2.12.1). Converter removal must not re-export anything from the entry. The existing ESM export-shape smoke test (`main.yaml` "Verify plugin loads") is the structural guard; keep it green.
- `docs/solutions/integration-issues/opencode-plugin-hook-silent-defect-swallow-2026-05-19.md` — a synchronous throw inside a hook becomes a swallowed Effect defect (silent failure). The warn-and-ignore path must never throw; warnings go to a synchronous stderr channel.
- `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md` — when the runtime silently drops values, the gate must mirror the exact drop rule, not check raw YAML. The overlap gate mirrors the runtime removed-name set.
- `docs/solutions/best-practices/content-integrity-has-no-warning-channel-2026-06-06.md` — content-integrity has one warning bucket; every other check is binary and sums into `totalViolations()`. Warn-and-ignore's warning lives at the runtime, NOT in the gate; the gate hard-passes/fails on the overlap rule. Do not attempt to make content-integrity "advisory-warn."
- `docs/solutions/best-practices/harden-converter-injected-agent-defaults-2026-06-06.md` — the 4-step converter-default-removal shape (derive → write explicit → fill-if-absent with `??` → gate on usable value, not mere presence). Prerequisite for R17.
- `docs/solutions/integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md` — the canonical isolated-runtime pattern (override HOME + every XDG root + `OPENCODE_CONFIG_CONTENT` last; recursive `.opencode` snapshot). Basis for R13.
- `docs/solutions/best-practices/zod-json-schema-ref-dedup-postprocessors-2026-05-17.md` — if the schema generator uses `reused: 'ref'`, v3 schema post-processors must unwrap `$ref`/`allOf` nodes; add an AJV parity test asserting Zod and AJV agree on accept/reject.
- `docs/solutions/workflow-issues/registry-drift-on-skill-description-change-2026-05-20.md` — `bun run build` does NOT regenerate the registry; deleting skills requires committing regenerated `registry/registry.jsonc` or CI's drift check fails.
- `docs/solutions/integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md` — Astro `redirects` destinations are NOT auto-prefixed with `base`; any removed-skill URL redirect must hand-prefix `/systematic`.
- `docs/solutions/workflow-issues/risks-table-rows-must-enforce-as-spec-checks-2026-05-18.md` — subagents read per-Unit specs, not the Risks table; every mitigation is echoed as a Unit test scenario below.
- `docs/solutions/integration-issues/reconciliation-sync-reference-integrity-20260417.md` + `.../sync-cep-missing-sub-files-SyncCEP-20260219.md` — after removal, `checkReferenceIntegrity` must find zero surviving `systematic:*` references to deleted skills and zero orphaned sub-file references.

### External References

None required — this is internal cleanup on well-understood local surfaces.

## Key Technical Decisions

- **Delete the two skills FIRST (with removed-names population + surface regen in the same commit), then remove the converter.** The converter's body transforms are load-bearing only for those skills' CC-shaped bodies; once deleted, the converter is fully dead. The overlap gate forces deletion + `removed-names` population + `bundled-names` regen into one atomic commit.
- **Warn-and-ignore is runtime-only; the gate is binary.** The `[systematic]` stderr warning lives in `config.ts` (already shipped). content-integrity has no advisory-warning channel, so its role is the hard overlap gate mirroring the runtime removed-name set. Do not add a soft-warn to content-integrity.
- **Populate `REMOVED_BUNDLED_SKILL_NAMES` with both deleted names; agent list stays empty** (no agents deleted). The existing empty-list mechanism proves the path; v3 only supplies data.
- **Converter removal replicates nothing on the runtime path.** Every frontmatter branch is proven no-op on bundled data (post-#534 gates), and the only non-bundled input was the dev CLI (also removed). Loaders read frontmatter directly via existing `extractFrontmatter`/`extractAgentFrontmatter`. This is a stated breaking change (loss of CC-shape tolerance for future files) noted in migration guidance.
- **Delete the v2 schema on the cut.** The generator auto-emits `v<MAJOR>/` + `latest/` from the resolved version; keeping a frozen `v2/` risks v3 configs pinned to the v2 `$schema` URL validating against the wrong contract. Users needing v2 pin the v2 package.
- **Remove tied dead code (R16, R17) in this release** rather than leaving unreachable branches behind a live runtime path.
- **`feat!:` / `BREAKING CHANGE:` commit framing** — this is the release that earns the major. The breaking surface is the two deleted skills and the removed CLI command.

## Open Questions

### Resolved During Planning

- Does the converter run on user files? No — production callers hardcode `source: 'bundled'`; only the dev CLI takes arbitrary paths (resolved via research, R3a).
- Where does the warn-and-ignore filter live? Post-parse in `config.ts` (already shipped in #534); v3 only populates `removed-names.ts`.
- Which converter tests carry behavior worth preserving? Only the "explicit `mode: subagent` is behavior-preserving" equivalence assertion (`tests/unit/content-integrity.test.ts`) and any loader-equivalence coverage; the rest are dead-path and get deleted (R3).
- Which surfaces are generated vs hand-edited? Enumerated in Context (generated: bundled-names, registry, schemas, docs pages, stats; hand-edited: drift-allowlist, ocx-registry guide, one test fixture).

### Deferred to Implementation

- **Schema major during v3-branch development.** The generator derives `v<MAJOR>/` from the resolved package version; on the pre-cut `v3` branch the version placeholder is `0.0.0-semantic-release`. Confirm at implementation whether the v2→v3 schema path transition + `v2/` deletion should be staged during development or gated to the cut (it may need to ride the release that resolves the real `3.0.0` version). Do not hand-fake the major.
- Exact `[systematic]` migration-doc anchor URL in the warning text (the committed migration doc lands in this release; wire the anchor once its path is fixed).
- Whether any surviving redirect from removed-skill doc URLs is warranted, and its exact base-prefixed destination.

## High-Level Technical Design

> *This illustrates the intended sequencing and dependency shape for review. It is directional guidance, not implementation specification.*

```
Phase 1 (breaking, atomic per the overlap gate)
  Unit 1: delete 2 skills
          + populate REMOVED_BUNDLED_SKILL_NAMES
          + regenerate bundled-names / registry / schema / docs / stats
          + hand-edit drift-allowlist / ocx guide / test fixture
          + warn-and-ignore regression tests
                    │  (converter body transforms now dead)
                    ▼
Phase 2 (behavior-preserving cleanup)
  Unit 2: remove converter + 3 call sites + CLI `convert` command + test migration
  Unit 3: remove tied dead code (deprecation machinery R16, inferBuiltInTemperature R17)
                    │
                    ▼
Phase 3 (convergence + assurance)
  Unit 4: v2 schema deletion + v3/latest emission + AJV parity test
  Unit 5: committed migration guidance (active docs)
  Unit 6: isolated packaged-plugin runtime validation
```

## Implementation Units

- [ ] **Unit 1: Delete deprecated skills, populate removed-names, regenerate surfaces**

**Goal:** Remove `orchestrating-swarms` and `claude-permissions-optimizer` from the bundle and every generated/active surface, populate the warn-and-ignore removed-name list, and prove removed names load-with-warning while invalid config still throws. Atomic because the content-integrity overlap gate rejects a removed name that still exists in `bundled-names`.

**Requirements:** R6, R7, R8, R9, R10, R10a, R11 (regen only; v2 deletion is Unit 4)

**Dependencies:** None (first unit; the breaking change)

**Files:**
- Delete: `skills/orchestrating-swarms/` (whole dir), `skills/claude-permissions-optimizer/` (whole dir)
- Modify: `src/lib/removed-names.ts` — set `REMOVED_BUNDLED_SKILL_NAMES = ['orchestrating-swarms', 'claude-permissions-optimizer']`
- Regenerate (via `bun run docs:generate` + `bun run registry:build`): `src/lib/bundled-names.ts`, `registry/registry.jsonc`, `dist/registry/`, `docs/src/content/docs/reference/skills/*` (per-skill pages + `index.mdx`), `docs/src/data/stats.json`, `docs/public/schemas/` + `dist/schemas/`
- Hand-edit: `scripts/.drift-allowlist.json` (remove both `pathGlob` exemptions), `docs/src/content/docs/guides/ocx-registry.mdx` (remove `orchestrating-swarms` install line), `tests/unit/transform-content.test.ts` (replace the `orchestrating-swarms` fixture case with a surviving skill)
- Test: `tests/unit/config.test.ts`, `tests/unit/content-integrity.test.ts`

**Approach:**
- Delete directories first, populate `removed-names`, then regenerate — in one commit — so the overlap gate sees the names gone from `bundled-names` and present in `removed-names` simultaneously.
- Run `checkReferenceIntegrity` (content-integrity) to confirm no surviving skill/agent references either deleted name and no orphaned sub-file references.
- Confirm `orchestrating-subagents` survives across every regenerated surface.

**Execution note:** Test-first for the warn-and-ignore regression — assert `disabled_skills: ["orchestrating-swarms"]` loads with a warning before populating `removed-names`.

**Patterns to follow:** `docs/solutions/best-practices/content-integrity-mirror-runtime-drop-rules-2026-05-17.md`; existing `removed-names` threading in `config-schema.ts`/`config.ts`.

**Test scenarios:**
- Happy path: `disabled_skills: ["orchestrating-swarms"]` parses, drops the name, emits the exact `[systematic]` warning, and loads.
- Happy path: `disabled_skills: ["claude-permissions-optimizer"]` same behavior.
- Error path: `disabled_skills: ["never-existed-skill"]` still throws the actionable schema error.
- Edge case: mixed `["orchestrating-swarms", "ce-review"]` — removed name dropped-with-warning, valid name retained, loads.
- Gate: content-integrity overlap check passes only when both names are absent from `bundled-names` and present in `removed-names`; fails if a removed name still exists as a bundled skill.
- Reference integrity: zero surviving `systematic:*` references to either deleted skill; zero orphaned sub-file references.
- Regeneration: `orchestrating-subagents` present in `bundled-names`, `registry.jsonc`, docs index + per-skill page, stats count; both deleted names absent from all.

**Verification:** `bun run docs:generate` + `bun run registry:build` produce no drift; `bun test` green including the new warn-and-ignore + overlap-gate coverage; `orchestrating-subagents` survives, both deleted names gone everywhere.

- [ ] **Unit 2: Remove the runtime converter, its call sites, and the CLI convert command**

**Goal:** Delete `src/lib/converter.ts` and all runtime + CLI usage, reading bundled frontmatter directly (normalization is proven no-op on bundled data). Now safe because Unit 1 removed the only skills whose bodies needed the converter's transforms.

**Requirements:** R1, R2, R3, R3a, R4, R5

**Dependencies:** Unit 1 (deprecated-skill bodies must be gone before body transforms are dropped)

**Files:**
- Delete: `src/lib/converter.ts`
- Modify: `src/lib/config-handler.ts` (remove `convertFileWithCache` from the agent path; remove the no-op command loop + its converter call), `src/lib/skill-loader.ts` (remove `convertFileWithCache`; read the skill body directly), `src/cli.ts` (remove `runConvert`, the `convert` help text/routing, and the `convertContent` import)
- Delete: `tests/unit/converter.test.ts`, `tests/integration/converter-validation.test.ts` (dead-path)
- Migrate (if not already independent): any loader-equivalence assertion worth keeping into `tests/unit/config-handler.test.ts` / `tests/unit/skill-loader.test.ts` / `tests/unit/content-integrity.test.ts`
- Test: `tests/unit/config-handler.test.ts`, `tests/unit/skill-loader.test.ts`, `tests/unit/cli.test.ts`

**Approach:**
- Replace each `convertFileWithCache(file, type, {source:'bundled'})` with a direct `fs.readFileSync` + existing `extractFrontmatter`/`extractAgentFrontmatter` path.
- Zero-import audit: no `from '*converter*'` remains in `src/`, `scripts/`, `tests/`.
- Remove the stale `TOOL_NAME_MAP`/bootstrap cross-check comment along with the file.
- CLI: `systematic convert` becomes an unknown subcommand; help text no longer lists it.

**Execution note:** Characterization-first — before deleting, assert current bundled agents/skills produce byte-identical loaded output with and without the converter (proves the no-op claim), then remove.

**Patterns to follow:** `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md` (transitive-reference audit, not just `rm`).

**Test scenarios:**
- Happy path: a representative bundled agent loads into the same `AgentConfig` (all fields) as before removal.
- Happy path: a representative bundled skill loads with the same body + frontmatter as before removal.
- Edge case: the (empty) command path is gone with no loader error.
- Error path: `systematic convert <file>` exits as an unknown command; help output omits `convert`.
- Integration: plugin config hook still emits every agent with valid fields (guards the loader-equivalence claim end-to-end).
- Audit: zero remaining converter imports across `src/`, `scripts/`, `tests/`.

**Verification:** `bun run typecheck` clean (no stale imports); `bun test` green; ESM export-shape smoke test still reports exactly `['default']`.

- [ ] **Unit 3: Remove tied dead code (deprecation machinery + temperature fallback)**

**Goal:** Delete the now-unreachable deprecation-warning path and the runtime temperature-inference fallback stranded by Units 1–2.

**Requirements:** R16, R17

**Dependencies:** Unit 1 (no bundled skill carries `deprecated:` after the two deletions)

**Files:**
- Modify: `src/lib/skill-tool.ts` (remove `formatDeprecationMessage` and the `deprecated`-warning branch), `src/lib/skills.ts` (remove the `SkillDeprecated` interface + its use in `extractFrontmatter`/`SkillInfo` once unreferenced), `src/lib/agent-overlays.ts` (remove `inferBuiltInTemperature` and its call in the overlay path), `scripts/content-integrity.ts` (keep the explicit-`temperature:` gate; drop any comment/logic that assumed the runtime fallback)
- Test: `tests/unit/skill-tool.test.ts`, `tests/unit/skills.test.ts`, `tests/unit/agent-overlays.test.ts`, `tests/unit/content-integrity.test.ts`

**Approach:**
- Confirm zero bundled skills have `deprecated:` frontmatter before deleting the machinery (Unit 1 guarantees it).
- `inferBuiltInTemperature` is already unreachable on gated data (every bundled agent has explicit `temperature:`); removing it makes explicit temperature strictly required at the type level too.
- Delete `SkillDeprecated` only after confirming no non-test importer remains.

**Test scenarios:**
- Happy path: loading a bundled skill no longer attempts a deprecation warning; catalog + skill-tool behavior unchanged for all surviving skills.
- Edge case: a synthetic skill with a `deprecated:` block is no longer specially handled (frontmatter field simply ignored) — documents the removed behavior.
- Gate: content-integrity still fails an agent missing explicit `temperature:` (the gate, not the runtime fallback, is now the sole enforcement).
- Audit: no runtime references to `inferBuiltInTemperature`, `formatDeprecationMessage`, or `SkillDeprecated` remain.

**Verification:** `bun run typecheck` clean; `bun test` green; content-integrity still rejects a temperature-less agent.

- [ ] **Unit 4: Delete v2 schema, emit v3 + latest, add AJV parity**

**Goal:** On the cut, remove the frozen `docs/public/schemas/v2/` and ensure the generator emits `v3/` + `latest/` matching runtime, with an AJV parity test guarding cross-field constraints.

**Requirements:** R11

**Dependencies:** Unit 1 (schema enum reflects the deleted skills); resolves at/near the release cut (see Deferred: schema-major question)

**Files:**
- Delete: `docs/public/schemas/v2/systematic-config.schema.json`
- Regenerate: `docs/public/schemas/v3/`, `docs/public/schemas/latest/`, `dist/schemas/`
- Test: `tests/unit/generate-config-schema.test.ts` (or the schema-generation test home) — add AJV parity

**Approach:**
- Confirm the generator resolves `v<MAJOR>` from the release version; do not hand-fake it (see Deferred question).
- If the generator uses Zod `reused: 'ref'`, ensure post-processors unwrap `$ref`/`allOf` per the ref-dedup learning.
- AJV parity: for a set of valid + invalid configs (including a removed name in `disabled_skills` and a genuinely-invalid enum), assert `SystematicConfigSchema.safeParse` and AJV-against-the-generated-schema agree on accept/reject.

**Test scenarios:**
- Happy path: generated v3 schema `disabled_skills` enum includes current bundled skills + the two removed names (so pinned configs still parse), omits nothing valid.
- Parity: Zod and AJV agree accept/reject on the valid/invalid config matrix.
- Regression: `latest/` is byte-identical to `v3/`; no `v2/` remains.

**Verification:** schema drift check passes; AJV parity test green; `docs/public/schemas/v2/` absent.

- [ ] **Unit 5: Committed migration guidance**

**Goal:** Ship migration guidance in active docs (not only release notes) covering removed skills, config/profile cleanup, CLI converter removal, and the v2 pin path.

**Requirements:** R5, R8, R12, R15

**Dependencies:** Units 1–2 (documents the actual removed surfaces)

**Files:**
- Create/Modify: a migration page under `docs/src/content/docs/` (e.g. a v3 migration guide), linked from active navigation
- Modify: any active guide referencing the removed CLI command or skills (not historical docs — R15)

**Approach:**
- State plainly: `orchestrating-swarms` → use `orchestrating-subagents`; `claude-permissions-optimizer` has NO Systematic replacement — name OpenCode's own permission config as the manual alternative (R8).
- Frame `disabled_skills`/`disabled_agents` cleanup as removing now-inert entries (a warning, not an error) per the shipped warn-and-ignore behavior.
- Document CLI converter removal + the v2 pin path (`npm i @fro.bot/systematic@2`) for one-off conversion; accept out-of-repo breakage.
- Wire the runtime warning's migration-doc anchor once the page path is fixed.

**Test scenarios:**
- Test expectation: none (docs content) — verified by `bun run docs:build` (MDX parses, links resolve) and a manual read that the claude-permissions gap is stated honestly.

**Verification:** `bun run docs:build` green (112+ pages); migration page reachable from active nav; narrated release notes will be reconciled against this page at cut (R12 checklist item).

- [ ] **Unit 6: Isolated packaged-plugin runtime validation**

**Goal:** Verify the packaged v3 plugin in an isolated OpenCode runtime — loads without converter, catalog exposes `orchestrating-subagents` and omits removed skills, a removed name in `disabled_skills` loads with a warning, invalid config still throws. Must load the packaged artifact, not only source-local TypeScript.

**Requirements:** R13

**Dependencies:** Units 1–4

**Files:**
- Modify: `tests/integration/opencode.test.ts` — add an `npm pack` (or install-into-temp) path alongside `buildSourceLocalConfig()`/`buildDistLocalConfig()`, and the four assertions
- Possibly add: a small helper to pack the local repo and reference the tarball from the fixture's `projectDir`

**Approach:**
- Extend `IsolatedFixture` with a packaged-artifact load path (`npm pack` → install into `fixture.projectDir/node_modules/@fro.bot/systematic`), reusing the existing HOME/XDG/`OPENCODE_CONFIG_CONTENT` override discipline.
- Reuse `createProbePlugin` to capture the rendered skill catalog and assert membership.
- Skip guard stays (`OPENCODE_AVAILABLE` + model auth) so CI without the binary skips cleanly.

**Execution note:** Integration-first — these assertions only prove value against a real spawned runtime; unit mocks cannot substitute.

**Test scenarios:**
- Integration: packaged plugin loads; startup produces no converter-related error.
- Integration: rendered catalog contains `systematic:orchestrating-subagents`, omits `systematic:orchestrating-swarms` and `systematic:claude-permissions-optimizer`.
- Integration: config `{ disabled_skills: ["orchestrating-swarms"] }` → exit 0 + stderr contains the literal `[systematic] "orchestrating-swarms" in \`disabled_skills\` is no longer a bundled name and will be ignored.`
- Integration: config `{ disabled_skills: ["never-existed-skill"] }` → non-zero exit + `Invalid Systematic config in …`.

**Verification:** integration suite green where `opencode` is available (skips cleanly otherwise); the packaged-artifact path exercises the real tarball, not `file://` source.

## System-Wide Impact

- **Interaction graph:** config hook (`config-handler.ts`), skill tool (`skill-loader.ts`/`skill-tool.ts`), and plugin init (`src/index.ts`) all previously ran the converter at load; all three now read frontmatter directly. The warn-and-ignore path runs in both plugin init and the config hook — both must tolerate removed names identically (idempotent, per-load `Set` dedup already shipped).
- **Error propagation:** the change narrows what throws — removed names no longer throw; genuinely-invalid config still does. No throw may escape a hook (silent-defect learning).
- **State lifecycle risks:** the converter's per-process mtime cache disappears; every read now parses fresh (negligible cost, identical output on bundled data).
- **API surface parity:** only the two disable lists soften (already shipped); `disabled_commands` and `agents.<key>` overlays stay strict. The CLI loses `convert`.
- **Unchanged invariants:** `src/index.ts` exports only `default`; bundled agent markdown stays model-free; explicit `mode: subagent` + `temperature:` gates remain enforced; strict validation for unknown overlay fields/typos.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Deleting skills before populating `removed-names` (or split across commits) trips the overlap gate and blocks CI | Unit 1 is atomic: delete + populate + regenerate in one commit; test scenario asserts the gate passes only in the combined state |
| A removed name bricks plugin load on upgrade | Warn-and-ignore populated in the SAME release (Unit 1); integration test (Unit 6) proves `disabled_skills:["orchestrating-swarms"]` loads with a warning against the packaged artifact |
| Converter removal silently changes bundled behavior | Characterization test (Unit 2) asserts byte-identical loaded output before removal; every normalization branch proven no-op on gated data |
| A stowaway export from `src/index.ts` during cleanup bricks the loader | Keep the ESM export-shape smoke test (`['default']` only) green in CI (Unit 2 verification) |
| Registry/schema/docs drift ships stale generated surfaces | Regenerate via `docs:generate` + `registry:build` in Unit 1; drift checks + AJV parity (Unit 4) gate CI |
| v2 schema deletion mistimed vs the schema major derived from a placeholder version on the pre-cut branch | Deferred question flags staging vs cut-gating; do not hand-fake the major (Unit 4) |
| Removed-skill doc URLs 404 after regen | If a redirect is added, hand-prefix `/systematic` per the Astro-base learning; `docs:build` gate (Unit 5) |
| Narrated release notes drift from committed migration doc | R12 checklist item reconciles narrated notes against the committed page at cut |

## Documentation / Operational Notes

- v3.0.0 is a major with a migration story; the committed migration page (Unit 5) is the source of truth and the runtime warning links to it.
- Release-notes narration must be reconciled against the committed migration doc at cut (semantic-release ingests commit subjects only; a `gh release edit --notes-file` patch may be needed for the audience-facing migration section).
- Cut mechanics: `--no-ff` merge of `v3` into `main` brings the `feat!:`/`BREAKING CHANGE:` commits onto the default branch so semantic-release cuts `3.0.0`.

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-06-v3-cleanup-release-requirements.md
- Superseded prior plan: docs/plans/2026-06-05-001-feat-v3-compatibility-cleanup-plan.md
- Sibling (shipped) prerequisite: docs/plans/2026-07-06-001-feat-removed-name-config-safety-plan.md (warn-and-ignore mechanism, #534 / v2.32.0)
- Converter removal targets: src/lib/converter.ts, src/lib/config-handler.ts, src/lib/skill-loader.ts, src/cli.ts
- Generated surfaces: registry/registry.jsonc, src/lib/bundled-names.ts, docs/public/schemas/, docs/src/content/docs/reference/, docs/src/data/stats.json
- Gates: scripts/content-integrity.ts (overlap gate, reference integrity), schema/registry drift checks
- Isolated-runtime fixture: tests/integration/opencode.test.ts
