---
title: 'feat: Minimal skill-deprecation surface (v2.19.0) + mark CC-residue skills as deprecated'
type: feat
status: active
date: 2026-05-17
origin: docs/brainstorms/2026-05-17-excise-cc-residue-skills-requirements.md
---

# Minimal skill-deprecation surface (v2.19.0) + mark CC-residue skills as deprecated

## Overview

Ship a deliberately-minimal skill-deprecation surface in v2.19.0: one `deprecated:` frontmatter field, one runtime warning, content-integrity gating for bundled skills. Then mark `orchestrating-swarms` and `claude-permissions-optimizer` as deprecated using that surface.

**v3.0.0 (the actual deletion) is OUT OF SCOPE for this plan.** v2.19.0 ships standalone. After v2.19.0 is in the wild, a separate brainstorm-and-plan cycle revisits the v3.0.0 excision with empirical signal on the deprecation warning's effect. If v3.0.0 never happens, the deprecation warning + both skills staying bundled is an acceptable steady state. The Future Work appendix at the bottom of this plan preserves the v3.0.0 scope sketch so the eventual ce:plan cycle starts grounded.

## Problem Frame

Systematic ships as an OpenCode-first plugin. Two bundled skills carry CC-specific semantics that don't translate to OpenCode:

- **`orchestrating-swarms`** teaches CEP's `Teammate` API (`TeammateTool`, `spawnTeam`, `requestShutdown`, `TaskCreate`/`TaskList`/`TaskGet`/`TaskUpdate`, `team_name` parameter on `task()`, `run_in_background: true`, CC built-in `subagent_type` names). Line 9 of its own SKILL.md admits it's aspirational. Has `disable-model-invocation: true` so the LLM never auto-dispatches it, but it ships in the npm tarball + OCX.

- **`claude-permissions-optimizer`** reads `~/.claude/projects/*.jsonl` + writes `~/.claude/settings.json`. Librarian research confirmed OpenCode has a permission system but it's architecturally different (SQLite, session-scoped, auto-persisting via the `always` button). No prompt-fatigue analog. Zero ecosystem demand for an OpenCode-side optimizer.

The brainstorm decided to delete both eventually but to ship a deprecation cycle first. This plan delivers the deprecation cycle. The deletion is sketched in Future Work but not planned here — picking the v3.0.0 timing requires signal that's only available after v2.19.0 has been in the wild.

Systematic has zero deprecation infrastructure today (`SKILL_FRONTMATTER_FIELDS` has no `deprecated`, no runtime warning machinery, no prior skill has been deprecated). v2.19.0 adds just enough to support the two known deprecations.

## Requirements Trace

This plan implements R1-R5, R14-R15 from `docs/brainstorms/2026-05-17-excise-cc-residue-skills-requirements.md`. **R6-R13 (v3.0.0 deletion + replacement) are out of scope here; see Future Work appendix.**

**Minimal deprecation surface (v2.19.0)**
- R1. Extend `SKILL_FRONTMATTER_FIELDS` with `deprecated: { since, removal, replacement?, reason? }`. Strings only. `reason` required for bundled (CI gate), optional for third-party (runtime permissive).
- R2. Runtime warning emits once per session per skill from the skill-execution path. Format: `[systematic] skill "<name>" is deprecated since v<since>; will be removed in v<removal>.` plus optional `Replacement:` and `Reason:` clauses.
- R3. Mark both target skills as deprecated. `since: v2.19.0`, `removal: v3.0.0`. `orchestrating-swarms` cites `orchestrating-subagents` as replacement (forward reference; OK even though the replacement doesn't exist yet). `claude-permissions-optimizer` cites no replacement.
- R4. v2.19.0 deprecation announcement lands via the squash-commit message body (not PR body). semantic-release's `release-notes-generator` includes commit body text in the generated changelog; PR body text is NOT included.
- R5. Skill-frontmatter parser stays permissive at runtime; content-integrity is strict for bundled skills.

**Quality gate**
- R14. CI passes typecheck, lint, docs:build, content-integrity, schema:drift, registry:drift, unit tests, Node ESM smoke.
- R15. `bun src/cli.ts list skills` lists both target skills and emits warnings on load.

## Scope Boundaries

- **v2.19.0 only.** This plan ships standalone. v3.0.0 deletion + replacement skill are explicitly NOT planned here.
- **No richer deprecation policy.** Severity levels, machine-readable output, CLI subcommand for inspecting deprecations are all explicitly out of scope. If future deprecations need more, that's a follow-up brainstorm informed by experience with v2.19.0.
- **No portability discipline.** Separate downstream concern.
- **No external-facing cleanup.** agentskills.io, blog posts, OCX mirrors out of scope.

### Out of Scope

- **v3.0.0 deletion of `orchestrating-swarms` + `claude-permissions-optimizer`**: deferred to a separate brainstorm-and-plan cycle after v2.19.0 ships. See Future Work appendix for design context.
- **New `orchestrating-subagents` replacement skill**: deferred with the v3.0.0 work. The forward reference in R3 (`replacement: orchestrating-subagents`) is intentional — it commits to the name without committing to a delivery timeline.
- **Cross-reference from `using-systematic/SKILL.md` to a future skill**: out of scope until that skill exists.

## Context & Research

### Relevant Code and Patterns

**Skill loader pipeline**
- `src/index.ts:35-56` — `initializePlugin` invokes `createSkillTool({ skillsDir, disabledSkills })`. Plugin-load-scoped closure.
- `src/lib/skill-tool.ts:93-205` — `createSkillTool()` factory. `execute()` at lines 148-205 is the natural warning-emission site.
- `src/lib/skills.ts:12-27` + `:74-103` — `SKILL_FRONTMATTER_FIELDS` allow-list + `extractFrontmatter()`. The `metadata` field at `:74-81` is the nested-object precedent.
- `src/lib/skill-loader.ts:63-91` — `loadSkill()` wraps frontmatter + body into XML template. **Important per feasibility review: `LoadedSkill` does NOT currently carry frontmatter to the caller.** U1 must extend the type to thread `deprecated` through to `createSkillTool().execute()`.

**Content-integrity gate extension**
- `scripts/content-integrity.ts:192-198` — `ALLOWED_SKILL_FRONTMATTER_FIELDS` derives from `SKILL_FRONTMATTER_FIELDS`.
- `scripts/content-integrity.ts:630-717` — `scanSkillFrontmatter` + `checkRequiredSkillField` + `checkSkillFrontmatterFields`. New rule fits beside these.
- `scripts/content-integrity.ts:806-815` — `isSkillEntryFile()` already detects bundled SKILL.md paths. The bundled-only check in R5 uses this helper.

**Frontmatter `metadata` precedent**
- `src/lib/skills.ts:74-81` shows nested-object value handling: parse the raw object, validate each sub-value is a string, drop silently if not. Same pattern applies to `deprecated`.
- `src/lib/frontmatter.ts:19-43` — `parseFrontmatter` is generic and permissive.

### Institutional Learnings

- **`docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md`** — Direct precedent for splitting deprecation work from breaking removal. Validates shipping v2.19.0 standalone and treating v3.0.0 as a separate cycle.
- **`docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`** — Precedent for adding a frontmatter field with content-integrity strict validation + runtime permissive parse.
- **`docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md`** — `license:` field precedent for adding a new SKILL.md frontmatter field. Same shape applies to `deprecated:` (entry-point file, runtime permissive, CI strict).

### External References

External research skipped. Strong local patterns for every novel surface in this plan.

## Key Technical Decisions

- **`console.warn` for emission** — visible to OpenCode session logs without requiring SDK-level message hooks. Project precedent in `tests/unit/model-availability.test.ts:583-607`.
- **Thread `deprecated` through `LoadedSkill`** — the existing `LoadedSkill` type at `src/lib/skill-loader.ts:63-87` doesn't carry frontmatter to consumers; U1 extends the type minimally to carry the `deprecated` block (only that field, not all frontmatter) so `createSkillTool().execute()` can act on it without re-parsing the file.
- **Dedup set in `createSkillTool()` closure** — per-plugin-instance lifetime. Fresh OpenCode session = fresh plugin load = warning re-emits, which matches user expectations.
- **Permissive runtime, strict CI** — matches the `license:` field precedent. Runtime never crashes on malformed `deprecated:` from third-party skills; bundled skills are gated at content-integrity time.
- **`reason` required for bundled** — adversarial reviewer correctly flagged optional `reason` invites "we added the field but didn't decide." For in-repo deprecations the reason IS the value.
- **v3.0.0 explicitly NOT planned here** — adversarial reviewer flagged that the back-to-back release assumption is fragile. v2.19.0 ships standalone. v3.0.0 starts as its own brainstorm-and-plan cycle when ready. If v3.0.0 never ships, the deprecation warning + both skills staying bundled is acceptable.
- **v2.18.x downgrade is the only documented rescue path** — for the eventual v3.0.0 release. v2.18.x and v2.19.x remain on npm; users who break on v3.0.0 install `@fro.bot/systematic@^2.19` until they can migrate. Standard semver behavior, no backport commitment.

## Open Questions

### Resolved During Planning

- **Where does the warning emit?** `console.warn` from `createSkillTool().execute()` after the matched skill loads. Repo-research confirmed this is the natural site.
- **Where does the warning get its data?** `LoadedSkill` must be extended to carry `deprecated` (per feasibility review's P1 finding). U1 handles this.
- **Where does dedup state live?** Closure-scoped `Set<string>` inside `createSkillTool()`. Per-plugin-load lifetime.
- **Per-plugin-load vs per-session lifetime** — closure scope = per plugin instance, which matches OpenCode's current per-session plugin initialization behavior (`src/index.ts:33-83`). The plan does not depend on this being a stronger contract: if a future OpenCode version reuses plugin instances across sessions, the warning de-emits indefinitely — acceptable failure mode since the deprecation is informational, not load-blocking.
- **What if `disable-model-invocation: true` is set on a deprecated skill?** Warning still emits via explicit invocation (the only path that loads such a skill).
- **Permissive vs strict `deprecated:` validation?** Runtime permissive (follows `metadata` precedent: drops malformed sub-fields silently). Content-integrity strict for bundled (`reason` required, enforced via `isSkillEntryFile()` path check).
- **Rescue path for a future v3.0.0 user impact** — v2.18.x downgrade. Standard semver behavior; no backport branch maintained.

### Deferred to Implementation

- **Exact prose for `reason` strings in the marked skills** — implementer drafts during U3 (folded into U2 per scope-guardian review). The prose should be specific about the CC-vs-OpenCode divergence, not vague.

## Implementation Units

- [ ] **Unit 1: Extend skill frontmatter loader + LoadedSkill type with `deprecated:` field**

**Goal:** Add `deprecated` to `SKILL_FRONTMATTER_FIELDS`, extend `extractFrontmatter` to parse the nested-object value with string sub-field validation, and thread the parsed `deprecated` block through `LoadedSkill` so `createSkillTool().execute()` can act on it.

**Requirements:** R1

**Dependencies:** None.

**Files:**
- Modify: `src/lib/skills.ts`
- Modify: `src/lib/skill-loader.ts` (extend `LoadedSkill` to carry `deprecated`)
- Test: `tests/unit/skills.test.ts`

**Approach:**
- Add `'deprecated'` to `SKILL_FRONTMATTER_FIELDS`.
- Extend `SkillFrontmatter` type with `deprecated?: { since: string, removal: string, replacement?: string, reason?: string }`.
- In `extractFrontmatter`, recognize `deprecated` as nested object (mirror `metadata` handling at `src/lib/skills.ts:74-81`). Validate `since` and `removal` are non-empty strings — if missing or non-string, drop the entire `deprecated` block. Validate `replacement` and `reason` as optional strings — if present but non-string, drop them silently. Never throw.
- Extend `LoadedSkill` (or equivalent shape) at `src/lib/skill-loader.ts:63-87` to carry the parsed `deprecated` block. Minimal addition — only this field, not all frontmatter.
- `loadSkill()` populates the new field on the result.

**Execution note:** Test-first. Write failing tests for `extractFrontmatter` + `LoadedSkill` shape BEFORE source changes.

**Patterns to follow:**
- `metadata` field handling at `src/lib/skills.ts:74-81` (nested object, silent drops).
- `license` field precedent from PR #394.

**Test scenarios:**
- Happy — full `deprecated` block (all 4 fields) parses; `LoadedSkill.deprecated` populated.
- Edge — missing `removal` drops the entire block; `LoadedSkill.deprecated` is undefined.
- Edge — non-string `replacement` keeps `since`+`removal` but drops `replacement` silently.
- Edge — skill with no `deprecated` parses cleanly with `LoadedSkill.deprecated === undefined`.

**Verification:**
- New tests pass.
- Existing skills.test.ts passes unchanged.
- `bun scripts/generate-config-schema.ts --check` passes (no `bundled-names.ts` change since adding a field doesn't change the bundled-name list).

---

- [ ] **Unit 2: Emit runtime deprecation warning + mark both target skills**

**Goal:** Emit one `console.warn` per session per skill from `createSkillTool().execute()` when a deprecated skill loads. Mark both `orchestrating-swarms` and `claude-permissions-optimizer` as deprecated in their SKILL.md frontmatter.

**Requirements:** R2, R3

**Dependencies:** Unit 1.

**Files:**
- Modify: `src/lib/skill-tool.ts`
- Modify: `skills/orchestrating-swarms/SKILL.md`
- Modify: `skills/claude-permissions-optimizer/SKILL.md`
- Test: `tests/unit/skill-tool.test.ts`

**Approach:**
- Add a closure-scoped `Set<string>` to `createSkillTool()` capturing emitted skill names.
- In `execute()` after the matched skill loads, check `loadedSkill.deprecated`. If present and the skill name is not in the dedup set, emit `console.warn` with formatted message, then add to set.
- Message: `[systematic] skill "<name>" is deprecated since v<since>; will be removed in v<removal>.` + ` Replacement: <replacement>.` if set + ` Reason: <reason>.` if set.
- Add `deprecated:` to `orchestrating-swarms/SKILL.md` frontmatter: `{ since: "v2.19.0", removal: "v3.0.0", replacement: "orchestrating-subagents", reason: "<implementer drafts: name CEP `Teammate` API specifics that don't exist in OpenCode>" }`.
- Add `deprecated:` to `claude-permissions-optimizer/SKILL.md` frontmatter: `{ since: "v2.19.0", removal: "v3.0.0", reason: "<implementer drafts: name OpenCode's SQLite-backed permission model + always-button precedent>" }`. No `replacement`.

**Execution note:** Test-first. Capture `console.warn` via spy. Assert exact message format and dedup behavior BEFORE source changes.

**Patterns to follow:**
- `console.warn` precedent in `tests/unit/model-availability.test.ts:583-607`.
- Closure-scoped state precedent in `bootstrapContent` + `hasLoggedInit` at `src/index.ts:34-83`.

**Test scenarios:**
- Happy — invoking a deprecated skill emits one warning with full message.
- Happy — invoking the same skill twice in the same tool instance emits one warning total.
- Edge — `replacement` absent → message omits `Replacement:` clause cleanly.
- Edge — `reason` absent → message omits `Reason:` clause cleanly.
- Integration — a fresh `createSkillTool` instance has empty dedup set; warnings re-emit (simulates new plugin load / session).

**Verification:**
- New tests pass.
- Manual probe: load each deprecated skill via `systematic_skill` in a local OpenCode session; warning emits exactly once.
- `bun src/cli.ts list skills` lists both skills without errors.

---

- [ ] **Unit 3: Extend content-integrity gate — `deprecated.reason` required for bundled skills**

**Goal:** When a bundled skill (`skills/<name>/SKILL.md`) has a `deprecated:` block, content-integrity requires `reason` to be a non-empty string. Third-party skills are unaffected.

**Requirements:** R5

**Dependencies:** Unit 1, Unit 2 (target skills must have correctly-populated `deprecated` blocks).

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Add `checkDeprecatedReasonForBundled(frontmatter, filePath)` beside existing checks at `scripts/content-integrity.ts:657-717`.
- Rule fires only when `frontmatter.deprecated` is present AND `isSkillEntryFile(filePath)` returns true (use existing helper at `:806-815`). If both conditions hold, `frontmatter.deprecated.reason` must be a non-empty string. Otherwise emit a structured violation.
- Wire into `scanSkillFrontmatter` dispatch.

**Note on path-detection brittleness (adversarial finding):** the `isSkillEntryFile` helper is path-convention-based, not provenance-based. This is acceptable because content-integrity only runs against this repo's filesystem. A third-party consumer reusing the gate could re-derive the bundled-skill predicate from their own conventions.

**Execution note:** Test-first. Write content-integrity test against synthetic fixtures BEFORE adding the rule.

**Patterns to follow:**
- `checkRequiredSkillField` at `scripts/content-integrity.ts:630-688` for rule shape.
- `isSkillEntryFile` at `:806-815` for bundled-skill detection.
- Test fixture shape at `tests/unit/content-integrity.test.ts:718-744`.

**Test scenarios:**
- Happy — bundled skill with `deprecated.reason` populated passes.
- Edge — bundled skill with `deprecated:` but no `reason` fails with structured violation.
- Edge — bundled skill with `deprecated.reason` as empty string fails.
- Integration — gate run against actual repo state after U2 (target skills have `reason`) passes.

**Verification:**
- `bun scripts/content-integrity.ts` runs clean against post-U2 repo state.
- A synthetic bundled-skill fixture without `deprecated.reason` fails the gate.

---

### PR-creation checklist (R4)

R4 is satisfied by the PR-creation process, not an implementation unit. Address at merge time:

- **Squash-commit message body** carries the deprecation announcement. semantic-release's `release-notes-generator` with the conventionalcommits preset includes commit BODY text in the generated changelog/release notes; PR body text is NOT included. Past releases (v2.17.0 etc.) confirm this — release bodies contain commit summaries only.
- Required content in the squash-commit body:
  - Both deprecated skill names
  - `removal: v3.0.0` as the planned (but not committed-to-a-timeline) future release
  - Replacement disposition: `orchestrating-subagents` for `orchestrating-swarms`; "no replacement" for `claude-permissions-optimizer`
  - v2.18.x downgrade path as the rescue option
  - Explicit note that v3.0.0 timing is not committed
- The PR body itself remains a reviewer-context document — it can summarize the same info for reviewers but doesn't drive the release notes.
- Verify after merge: `gh release view v2.19.0 --json body --jq '.body'` shows the deprecation section.

## System-Wide Impact

- **Interaction graph:** `src/lib/skills.ts` (parser extension), `src/lib/skill-loader.ts` (LoadedSkill type extension), `src/lib/skill-tool.ts` (warning emission), `scripts/content-integrity.ts` (bundled-only `reason` gate). No other downstream callers.
- **Error propagation:** Runtime malformed `deprecated:` drops silently per `metadata` precedent. Bundled-skill content errors caught at CI.
- **State lifecycle:** Closure-scoped dedup set has plugin-load lifetime. Repo-research confirmed each OpenCode session creates a new plugin instance, so per-session re-emission is the actual behavior.
- **API surface parity:** v2.19.0 adds one frontmatter field to the allow-list. No `bundled-names.ts` regen needed (the field is not part of `BUNDLED_SKILL_NAMES`).
- **Unchanged invariants:** All 47 existing bundled skills continue to load normally. `SKILL_FRONTMATTER_FIELDS` allow-list adds one entry; existing field validation behavior unchanged. Runtime parser stays permissive.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| `LoadedSkill` type extension cascades into unexpected consumers | Repo-research confirmed `LoadedSkill` has only one consumer (`createSkillTool().execute()`). Type extension adds one optional field; existing callers don't break. |
| Per-plugin-instance dedup vs per-session expectations diverge | Closure scope = per plugin instance, matches OpenCode's current per-session plugin init (`src/index.ts:33-83`). Plan does not depend on a stronger contract; if a future OpenCode reuses plugin instances, the warning de-emits indefinitely — acceptable since deprecation is informational. |
| Bundled-skill detection in U3 is path-convention-based, not provenance-based | Explicit note in U3 Approach. Acceptable for the scope (in-repo gate only). |
| v3.0.0 never ships AND a future user is impacted | Acceptable joint outcome: if v3.0.0 never lands, both skills stay bundled with a dedup'd informational warning — no impact. If v3.0.0 lands and a user breaks, v2.18.x and v2.19.x remain on npm as standard-semver downgrade targets. No backport branch maintained. |

## Documentation / Operational Notes

- v2.19.0 PR description carries the deprecation announcement (see PR-creation checklist for R4).
- v2.19.0 ships standalone. No follow-up plan committed; v3.0.0 is its own future brainstorm-and-plan cycle.
- No monitoring or runbook impact.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-17-excise-cc-residue-skills-requirements.md`
- **Skill loader pipeline:** `src/lib/skills.ts:12-27, :74-103`, `src/lib/skill-loader.ts:63-91`, `src/lib/skill-tool.ts:93-205`
- **Content-integrity extension pattern:** `scripts/content-integrity.ts:630-717`, `:806-815`
- **Frontmatter `metadata` precedent:** `src/lib/skills.ts:74-81`, `src/lib/frontmatter.ts:19-43`
- **Test patterns:** `tests/unit/skills.test.ts:21-194`, `tests/unit/skill-tool.test.ts:123-302`, `tests/unit/content-integrity.test.ts:214-260, :718-744`
- **Solution-doc precedents:**
  - `docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md`
  - `docs/solutions/best-practices/typed-config-validation-build-time-codegen-2026-05-16.md`
  - `docs/solutions/best-practices/third-party-bundled-skills-light-adaptation-2026-05-17.md`

---

## Future Work (NOT IN SCOPE for this plan)

**v3.0.0 — Delete CC-residue skills + ship OpenCode-native replacement.** Sketch only; pick up via a separate `ce:brainstorm` → `ce:plan` cycle after v2.19.0 has been in the wild long enough to assess deprecation-warning effect.

### v3.0.0 acceptance criteria (carried from brainstorm R6-R13)

- Delete `skills/orchestrating-swarms/` and `skills/claude-permissions-optimizer/` directories.
- Remove both entries from `registry/registry.jsonc:759-800`. Profiles at `registry/files/profiles/{omo,standalone}/ocx.jsonc` don't reference these skills, so no profile cleanup needed.
- Remove both `pathGlob` entries from `scripts/.drift-allowlist.json`.
- Update `AGENTS.md` + in-repo docs that reference either skill by name. Solution docs (`docs/solutions/**`) that recommend either skill need their recommendations replaced or explicitly reframed — leaving a "(removed in v3.0.0)" note next to a recommendation creates a broken-recommendation footgun (adversarial finding).
- Add `skills/orchestrating-subagents/SKILL.md` (OpenCode-native multi-subagent orchestration primer using parallel/sequential `task()` patterns, narrow trigger semantics).
- Run `bun scripts/generate-config-schema.ts --allow-shrink` to regen `bundled-names.ts` with the two skill names dropped. **CI implication:** `docs:build` and `schema:drift` jobs run regen without the flag; the v3.0.0 PR must address this CI surface explicitly. Options: (a) make `--allow-shrink` opt-in via a CI workflow input on PR label, (b) hand-edit `bundled-names.ts` post-regen and rely on `--check` parity, (c) introduce a `--explicit-shrink-allowed` config that the PR sets explicitly.

### v3.0.0 risks (carried from brainstorm + adversarial review)

- **`--allow-shrink` social guardrail** — currently opt-in per-invocation. Future PRs that shrink other bundled artifacts could reuse the flag accidentally. v3.0.0 plan should consider a scoped wrapper (e.g., `bun scripts/generate-config-schema.ts --shrink=orchestrating-swarms,claude-permissions-optimizer`) that requires naming what's being removed.
- **Phase 0 trigger probe for replacement skill** — narrow trigger semantics need adversarial probing (4-6 prompts), not just the two confirming examples from the brainstorm. v3.0.0 plan should bound iteration count (e.g., max 3 description tightening passes before escalating to a different framing).
- **Doc cleanup for solution docs** — if a solution doc recommends a deleted skill, leaving a "(removed in v3.0.0)" note creates contradictory guidance. v3.0.0 plan should treat each solution-doc reference as a content-replacement decision, not a label.
- **v3.0.0 rescue path** — Marcus locked: v2.18.x downgrade is the rescue path. No backport branch maintained. Document in v3.0.0 release notes.

### Why this is in Future Work, not Implementation Units

The v3.0.0 deletion is meaningfully more risky than v2.19.0 (breaking semver, multiple downstream regen surfaces, requires CI surface decisions, new skill needs trigger validation). Picking the v3.0.0 timing requires signal we don't have yet: did anyone notice the v2.19.0 warning? Did anyone open an issue about the deprecation? Did the OCX registry surface any consumer impact?

Shipping v2.19.0 first and revisiting v3.0.0 as a separate cycle preserves optionality. If v3.0.0 never happens, that's an acceptable outcome — both skills stay bundled, the deprecation warning stays informational, the bundle doesn't grow.
