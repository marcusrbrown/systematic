---
title: 'refactor!: v3 bundle curation — remove niche assets, consolidate overlaps'
type: refactor
status: active
date: 2026-07-11
origin: docs/brainstorms/2026-07-11-v3-bundle-curation-requirements.md
---

# v3 Bundle Curation

## Overview

Reshape the bundled catalog around Systematic's identity (focused agentic-workflow tool, headless-capable, ce:* root): remove 12 peripheral/vertical skills plus `setup`, remove 14 non-universal or duplicate agents, merge the todo trio into a single `todos` skill, fold `writing-systematic-skills` into `writing-skills`, extend the removed-names safety net to cover agents, rewire all inbound references, and regenerate every generated surface. Net: 46→31 skills, 51→37 agents. Breaking — ships on the `v3` branch.

## Problem Frame

The bundle grew by accretion; every asset ships to every install (including headless Fro Bot) and pays catalog-noise, maintenance, and identity costs. v3 is the breaking-release window where removals are cheap. (See origin: docs/brainstorms/2026-07-11-v3-bundle-curation-requirements.md)

## Requirements Trace

- R1–R3. Remove niche-vertical skills, peripheral-integration skills, and the `setup` placeholder.
- R4–R6. Merge todo trio into one skill; fold writing pair; rewire references to merged-away names.
- R7–R10. Remove stack-specific personas, duplicate standalone reviewers, Figma-dependent design agents, `ankane-readme-writer`.
- R11–R12. No dangling references (content-integrity clean); ce:review persona tables updated.
- R13. Removed skill names → `REMOVED_BUNDLED_SKILL_NAMES`; removed agent names → `REMOVED_BUNDLED_AGENT_NAMES`; pre-merge todo names included.
- R14. All generated surfaces regenerated in the same change; registry sources pruned.

## Scope Boundaries

- No new capabilities; no changes to surviving skill/agent content beyond reference rewiring.
- Pi harness (plan 003) and cleanup Units 2–6 (plan 002) remain separate work.

### Deferred to Separate Tasks

- Non-coding-project gap audit of the ce:* loop — future brainstorm.
- Any replacement skills for cut capabilities — post-v3 if demand appears.

## Context & Research

### Relevant Code and Patterns

- `src/lib/removed-names.ts` — safety net with BOTH `REMOVED_BUNDLED_SKILL_NAMES` and `REMOVED_BUNDLED_AGENT_NAMES` (agent list currently empty; mechanism exists).
- Cleanup plan 002 Unit 1 (merged, PR #587) — the proven atomic delete + removed-names + regen recipe, including the content-integrity overlap gate and `bun run schema:generate` / `registry:build` regen chain.
- `scripts/content-integrity.ts` — phantom-reference gate; also line 259 remediation string names `writing-systematic-skills` (must be updated in Unit 4).
- Generated: `src/lib/bundled-names.ts` (via `scripts/generate-config-schema.ts`), `registry/registry.jsonc` (via `scripts/build-registry.ts`), docs reference pages (via `docs:generate`). Registry profile files under `registry/files/profiles/` carry no removed-asset references (verified).

### Inbound-reference map (verified on post-sync v3)

**Skills being cut** — beyond generated surfaces, live references are:
- `setup`: `src/lib/bootstrap.ts:114` (example string), `tests/unit/skill-loader.test.ts:16-28` (name-formatting fixture), `tests/unit/converter.test.ts:387-391` (conversion fixture; file is deleted wholesale by 002 Unit 2), `tests/manual/smoke-deprecation-warning.ts:111-113` (deleted by 002 Unit 3), `scripts/build-registry.ts:274-276` (comment mentions `generate_command`).
- `feature-video`: `skills/git-commit-push-pr/SKILL.md:83,201` (evidence-capture step), `skills/slfg/SKILL.md:36` (step 9).
- `test-xcode`: self-contained (its todo-create ref dies with it).
- Others (dspy-ruby, dhh-rails-style, andrew-kane-gem-writer, every-style-editor, rclone, gemini-imagegen, proof, changelog, generate_command): no live inbound references outside generated surfaces.

**Agents being cut** — live references:
- ce:review: `skills/ce-review/SKILL.md:134-138,144,364,386,449,515`, `references/persona-catalog.md:46-50,58`, `references/review-output-template.md:138` (stack persona rows + schema-drift-detector wiring).
- `deepen-plan/SKILL.md:237-247` + `skills/ce-plan/references/deepening-workflow.md:128-138` (security-sentinel, performance-oracle, data-integrity-guardian, data-migration-expert).
- `skills/ce-compound/SKILL.md:276-281,400-401,467-476` (category→reviewer routing incl. kieran-rails/python).
- `skills/orchestrating-subagents/SKILL.md:85-86` (security-sentinel/performance-oracle example).
- `skills/ce-work/SKILL.md:299` (figma-design-sync step).

**Todo trio / writing pair** — live references:
- `skills/ce-review/SKILL.md:49,718` (todo-create), `skills/test-browser/SKILL.md:224,229` (todo-create), `skills/lfg/SKILL.md:24` (todo-resolve), `skills/slfg/SKILL.md:35` (todo-resolve), trio-internal cross-refs (die with merge).
- `writing-systematic-skills`: `scripts/content-integrity.ts:259` remediation string.

## Key Technical Decisions

- **Merged todo skill is `todos`** (`skills/todos/SKILL.md`), sections Create / Triage / Resolve preserving each workflow's rules; old names `todo-create`/`todo-resolve`/`todo-triage` become removed skills (warn-and-ignore).
- **Rewire targets:** `security-sentinel`→`security-reviewer`, `performance-oracle`→`performance-reviewer`, `data-integrity-guardian` and `data-migration-expert`→`data-migrations-reviewer`, `figma-design-sync` (ce-work step)→`design-iterator`, todo-* refs→`todos`.
- **feature-video ripple accepted:** git-commit-push-pr's capture path and slfg step 9 are removed outright; PR evidence degrades to preserving existing `## Demo` blocks.
- **Unit granularity = one gate-passing atomic commit each** (removal + rewiring + removed-names + regen together), mirroring 002 Unit 1. Content-integrity forbids splitting removal from rewiring.
- **Sequencing vs plan 002:** this plan is self-contained; the `setup` fixtures in `converter.test.ts` / `smoke-deprecation-warning.ts` are strings in files 002 later deletes — Unit 1 updates the skill-loader fixture only (rename to a surviving skill), leaves converter/manual fixtures (harmless strings, deleted by 002). 002 Units 2–6 can land before or after.

## Open Questions

### Resolved During Planning

- Merged todo name: `todos`.
- Registry profiles: no profile-file references to cut assets exist; only `registry.jsonc` source entries need pruning (regen handles).
- Agent safety net: `REMOVED_BUNDLED_AGENT_NAMES` already exists — populate it.

### Deferred to Implementation

- Exact prose of merged `todos` sections — implementer merges bodies, deduplicating shared frontmatter/conventions.
- Whether `docs:generate` fully removes orphaned reference pages (verify during Unit 5; delete manually if the generator only adds).

## Implementation Units

- [ ] **Unit 1: Remove 12 peripheral/vertical skills**

**Goal:** Delete `dspy-ruby`, `dhh-rails-style`, `andrew-kane-gem-writer`, `every-style-editor`, `rclone`, `gemini-imagegen`, `test-xcode`, `proof`, `feature-video`, `changelog`, `generate_command`, `setup`; rewire live references; extend removed-names; regenerate.

**Requirements:** R1, R2, R3, R13, R14

**Dependencies:** None

**Files:**
- Delete: `skills/{dspy-ruby,dhh-rails-style,andrew-kane-gem-writer,every-style-editor,rclone,gemini-imagegen,test-xcode,proof,feature-video,changelog,generate_command,setup}/`
- Modify: `src/lib/removed-names.ts` (+12 skill names), `src/lib/bootstrap.ts:114` (swap `systematic:setup` example for a surviving skill), `skills/git-commit-push-pr/SKILL.md` (remove feature-video capture path, keep preserve-existing-evidence behavior), `skills/slfg/SKILL.md` (drop step 9), `scripts/build-registry.ts:274-276` (comment), `tests/unit/skill-loader.test.ts:16-28` (fixture name)
- Regenerate: `src/lib/bundled-names.ts`, `registry/registry.jsonc`, v2 schema
- Test: `tests/unit/config.test.ts` (extend warn-and-ignore coverage to a sample of new removed names)

**Test scenarios:**
- Happy path: `disabled_skills: ['rclone']` → warn-and-ignore, config loads.
- Edge: removed name in `disabled_skills` alongside a valid name → valid name still honored.
- Integration: content-integrity passes with zero references to any deleted skill.

**Verification:** full unit suite, typecheck, content-integrity, schema+registry drift clean, docs build.

- [ ] **Unit 2: Remove 14 agents, rewire reviewer references**

**Goal:** Delete the 6 stack-specific personas (`kieran-rails-reviewer`, `kieran-python-reviewer`, `dhh-rails-reviewer`, `julik-frontend-races-reviewer`, `schema-drift-detector`, `lint`), 5 duplicate standalones (`security-sentinel`, `performance-oracle`, `data-integrity-guardian`, `data-migration-expert`, `cli-agent-readiness-reviewer`), 2 Figma agents (`figma-design-sync`, `design-implementation-reviewer`), and `ankane-readme-writer`; rewire every inbound reference; populate `REMOVED_BUNDLED_AGENT_NAMES`.

**Requirements:** R7, R8, R9, R10, R11, R12, R13, R14

**Dependencies:** None (independent of Unit 1)

**Files:**
- Delete: the 14 agent `.md` files across `agents/{review,design,docs,workflow}/`
- Modify: `skills/ce-review/SKILL.md` (drop 5 conditional-persona rows at 134-138, row 144, schema-drift mentions at 364/386/449/515), `skills/ce-review/references/persona-catalog.md` (rows 46-50, 58), `skills/ce-review/references/review-output-template.md:138`, `skills/deepen-plan/SKILL.md:237-247` (→ security-reviewer/performance-reviewer/data-migrations-reviewer), `skills/ce-plan/references/deepening-workflow.md:128-138` (same mapping), `skills/ce-compound/SKILL.md` (category routing → surviving personas; drop Rails/Python rows), `skills/orchestrating-subagents/SKILL.md:85-86` (example agents → surviving names), `skills/ce-work/SKILL.md:299` (→ design-iterator), `src/lib/removed-names.ts` (+14 agent names)
- Regenerate: `src/lib/bundled-names.ts`, `registry/registry.jsonc`, v2 schema
- Test: `tests/unit/config.test.ts` (agent-name warn-and-ignore via `disabled_agents`)

**Test scenarios:**
- Happy path: `disabled_agents: ['security-sentinel']` → warn-and-ignore.
- Edge: mixed valid + removed agent names → valid honored, removed warned.
- Integration: content-integrity zero dangling agent references; ce:review persona tables parse (manual read).

**Verification:** full gates as Unit 1.

- [ ] **Unit 3: Merge todo trio into `todos`**

**Goal:** Create `skills/todos/SKILL.md` (Create/Triage/Resolve sections merging the three bodies); delete the three dirs; rewire; removed-names.

**Requirements:** R4, R6, R13, R14

**Dependencies:** Unit 1 (test-xcode's todo refs already gone)

**Files:**
- Create: `skills/todos/SKILL.md`
- Delete: `skills/{todo-create,todo-resolve,todo-triage}/`
- Modify: `skills/ce-review/SKILL.md:49,718`, `skills/test-browser/SKILL.md:224,229`, `skills/lfg/SKILL.md:24`, `skills/slfg/SKILL.md:35` (→ `todos`), `src/lib/removed-names.ts` (+3)
- Regenerate: bundled-names, registry, schema
- Test: `tests/unit/config.test.ts` (todo-create warn case)

**Test scenarios:**
- Happy path: merged skill discovered under `todos`, description present.
- Edge: `disabled_skills: ['todo-create']` → warn-and-ignore.
- Integration: no `todo-create|todo-resolve|todo-triage` references outside docs/solutions + plans (content-integrity clean).

**Verification:** full gates.

- [ ] **Unit 4: Fold writing-systematic-skills into writing-skills**

**Goal:** Append a "Systematic bundled skills" section to `skills/writing-skills/SKILL.md` carrying the Systematic-specific contracts (frontmatter rules, content-integrity, reference-file conventions); delete `skills/writing-systematic-skills/`; update the content-integrity remediation string.

**Requirements:** R5, R6, R13, R14

**Dependencies:** None

**Files:**
- Modify: `skills/writing-skills/SKILL.md`, `scripts/content-integrity.ts:259`, `src/lib/removed-names.ts` (+1)
- Delete: `skills/writing-systematic-skills/`
- Regenerate: bundled-names, registry, schema
- Test: `tests/unit/content-integrity.test.ts` (remediation string still asserts correctly)

**Test scenarios:**
- Happy path: writing-skills contains the folded section; content-integrity remediation names it.
- Edge: `disabled_skills: ['writing-systematic-skills']` → warn-and-ignore.

**Verification:** full gates.

- [ ] **Unit 5: Docs sweep + final verification**

**Goal:** Regenerate docs reference content; verify orphaned reference pages are gone (delete manually if generator is add-only); update the migration guidance started by 002 Unit 5 with the curation removals table; full-suite final verification across all gates.

**Requirements:** R11, R14

**Dependencies:** Units 1–4

**Files:**
- Regenerate: `docs/src/content/docs/reference/**` via `docs:generate`
- Modify: migration doc (coordinate with 002 Unit 5 location) — removed/merged asset table with replacements
- Test expectation: none — docs/verification unit.

**Verification:** `bun test`, typecheck, lint, content-integrity, schema+registry drift, `docs:verify`; grep proves zero live references to any removed name outside docs/solutions/, docs/plans/, CHANGELOG.

## System-Wide Impact

- **Interaction graph:** ce:review persona selection, deepen-plan/ce-plan deepening dispatch, ce-compound routing, lfg/slfg step lists — all rewired to surviving assets.
- **API surface parity:** `disabled_skills`/`disabled_agents` enums shrink (schema regen); removed names warn instead of erroring.
- **Integration coverage:** content-integrity gate is the cross-file proof; per-unit warn-and-ignore tests prove the config path.
- **Unchanged invariants:** surviving skill/agent content untouched beyond reference rewiring; plugin hook behavior, skill-tool, bootstrap flow unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Docs generator is add-only, leaving orphaned reference pages | Unit 5 verifies and deletes manually |
| ce:review behavior drifts from persona-table edits | Table edits are row deletions + name swaps only; manual read-through in Unit 2 verification |
| 002/003 land interleaved and touch shared generated surfaces | Each unit regenerates; drift gates catch stale artifacts on either side |
| Users depended on cut skills | Removed-names warning + migration table (Unit 5); breaking release is the contract |

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-11-v3-bundle-curation-requirements.md (local, gitignored)
- Sibling plans: docs/plans/2026-07-06-002-feat-v3-cleanup-release-plan.md, docs/plans/2026-07-06-003-feat-pi-harness-support-plan.md
- Proven recipe: PR #587 (Unit 1 of plan 002)
