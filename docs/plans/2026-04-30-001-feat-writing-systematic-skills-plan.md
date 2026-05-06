---
title: 'feat: Add writing-systematic-skills authoring spec + foundation validators'
type: feat
status: completed
date: 2026-04-30
completed_at: 2026-05-04
origin: docs/brainstorms/2026-04-28-writing-systematic-skills-requirements.md
pr: https://github.com/marcusrbrown/systematic/pull/325
---

## Post-merge reconciliation (2026-05-05)

All 7 units shipped — see PR #325. One direction was inverted post-merge:

- **Unit 2 — empirical-audit cleanup**: the original prescription was to add `model: inherit` to 13 agents that were missing it. This was inverted by PR #336 (https://github.com/marcusrbrown/systematic/pull/336), which removed `model: inherit` from all 50 bundled agents. The replacement convention is to omit the field entirely (per OpenCode's documented contract: subagents inherit the invoking primary agent's model when `model:` is unset). The content-integrity gate now flags any present `model:` value, including the literal `inherit`. Outcome (clean catalog enforced by gate) is preserved; direction is reversed.
- **Unit 6 — registry/AGENTS.md count**: shipped at 46 skills as planned.

V2 candidates from this plan's Documentation/Operational Notes that remain open: (1) `ce:*` workflow conventions, (2) `name:` namespace migration for the 37 bare-name skills, (3) authoring-time enforcement, (4) `argument-hint` slot-typing.

# feat: Add writing-systematic-skills authoring spec + foundation validators

## Overview

Ship V1 of the Systematic authoring conventions spec as a bundled skill (`systematic:writing-systematic-skills`) layered on top of the user-installed `writing-skills` foundation, plus two new content-integrity validators that enforce the foundation rules in CI. The validator's allowed-fields set is descriptive of the runtime loader's actual contract (`src/lib/skills.ts:71–84`); only `preconditions` is banned (the one field with no runtime consumer). The validator runs in dry-run mode against the live catalog FIRST as the empirical audit, then cleanup is regenerated from that output, then the validator flips to enforcing. Audit-driven cleanup means the gate runs zero violations on `main` from day one.

This is a single-PR shipment targeting v2.7.0 minor.

## Problem Frame

Systematic ships 45 skills and 50 agents with no written authoring spec. Every new skill makes one-off frontmatter and file-layout decisions, and drift compounds. One skill carries an idiosyncratic frontmatter field with no runtime consumer (`compound-docs` uses `preconditions`); 13 of 50 bundled agents lack the `model: inherit` declaration the other 37 carry. (`claude-permissions-optimizer` carries `context: fork` + `subtask: true`, which the runtime loader actively reads at `src/lib/skills.ts:79` to drive forked-subtask dispatch — NOT idiosyncratic; preserved as-is.) The recent infra investments (content-integrity gate from PR #301, sub-file integrity from PR #319, registry generator from PR #315) make this the right moment to consolidate validators.

A spec without validators is documentation-only; validators without a spec are opaque. The V1 thesis is that the combination compounds: the skill is the source of truth authors read; the gate is the enforcement that catches drift before merge. (See origin: docs/brainstorms/2026-04-28-writing-systematic-skills-requirements.md.)

## Requirements Trace

- R1–R7. Foundation skill content (frontmatter rules, file layout, identity defaults). Mapped to Units 3 + 4. R7's `ai:systematic` sub-rule is reframed: it is the machine-id / API-attribution string (per `skills/proof/SKILL.md:22`), not a skill cross-reference convention.
- R12. `checkFrontmatter` validator extension. Mapped to Unit 1.
- R13. `checkAgentModel` validator extension. Mapped to Unit 1.
- R14. Pre-V1 audit. **Empirical, not conceptual**: Unit 1 lands the validators in dry-run mode and runs them against the live catalog; output is the audit. Unit 2 cleanup uses that empirical output. Unit 5 flips the validator to enforcing mode.
- R15. Cleanup of every frontmatter violation surfaced by the empirical audit. Mapped to Unit 2.
- R16. Cleanup of every agent-model violation surfaced by the empirical audit. Mapped to Unit 2.
- R17. Remove `workflows` from `SUBFILE_DIRECTORY_NAMES` constant. Mapped to Unit 1.

## Scope Boundaries

- `ce:*` workflow conventions (phase numbering, document-review interleave, output filename patterns) — deferred to V2 per origin doc; empirical phase-catalog disproof during brainstorm.
- Composition + robustness conventions — deferred to V2.
- Tone/voice rules beyond writing-skills — not codified.
- Full agent authoring spec beyond `model: inherit` — not in V1.
- Generator/templating tooling (`scaffold-skill`) — deferred to V2.
- Bulk normalization beyond audit findings — V1 cleanup matches audit scope exactly; broader normalization is organic via future PRs.

## Context & Research

### Relevant Code and Patterns

- `scripts/content-integrity.ts` (800 lines) — already exposes `checkReferenceIntegrity`, `checkSubfileReferences`, `checkBannedPatterns`. The new `checkFrontmatter` and `checkAgentModel` follow the exact same shape: pure functions returning typed violation arrays, called from `checkContentIntegrity()`, printed by per-check `printX` helpers. **Critical detail**: `main()` at lines 784–787 currently computes its exit code via an INLINE SUM, NOT via `totalViolations()`. Unit 1 must update both `totalViolations()` (line 759) AND replace the inline sum in `main()` with a `totalViolations(result)` call so future checks only require one update.
- `src/lib/skills.ts:71–84` — `extractFrontmatter` is the runtime loader's source of truth for what frontmatter fields a skill may carry. Reads: `name`, `description`, `license`, `compatibility`, `metadata`, `disable-model-invocation`, `user-invocable`, `context` (derives `subtask: true` when value is `'fork'`), `agent`, `model`, `argument-hint`, `allowed-tools`. The validator's allowed-fields set must match this enumeration.
- `src/lib/frontmatter.ts:19` — `parseFrontmatter` returns `{ data, body, hadFrontmatter, parseError }`. On `parseError: true`, `data` is `{}`; the validator emits ONE `malformed-frontmatter` violation and short-circuits remaining field checks for that file.
- `tests/unit/content-integrity.test.ts` (1034 lines) — `bun:test` + real temp dirs via `os.mkdtempSync`; no mocking libraries. New validator tests follow the same fixture pattern (`makeFixtureRepo`, `writeSkill`, `writeAgent`, `writeAllowlist`).
- `skills/ce-brainstorm/SKILL.md` (198 lines) — body length target reference (target ≤ 350 lines for the new skill). `skills/ce-plan/SKILL.md` is 737 lines; the spec target is intentionally tighter than ce:plan, treating ce:plan as a skill where content density warranted depth, not a structural guideline.
- `skills/document-review/SKILL.md` — example of a skill with rich frontmatter (`argument-hint`, `disable-model-invocation: true`) following current conventions.
- `agents/review/testing-reviewer.md` — canonical placement reference for `model: inherit` in agents that also carry `mode: subagent` and `temperature: 0.1` (matches the 12 review agents in Unit 2 cleanup; closer pattern than `agents/research/best-practices-researcher.md` which lacks those siblings fields).

### Pre-Plan Audit — Conceptual

A conceptual audit during planning (grep-based) confirmed the following at the time the plan was written:

| Audit dimension                | Conceptual result                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Banned-field hits (`preconditions`) | 1 (compound-docs)                                                                         |
| Runtime-recognized field usage | `context: fork` + `subtask: true` on claude-permissions-optimizer (both ALLOWED, not banned) |
| Missing `model:` in agents       | 13 (12 in `agents/review/`, 1 in `agents/workflow/bug-reproduction-validator.md`)         |
| Non-`inherit` model values       | Zero                                                                                    |
| `workflows/` sub-dirs in skills  | Zero                                                                                    |
| Optional standardized usage    | `argument-hint` 21 / `disable-model-invocation` 15 / `allowed-tools` 4 — all valid        |

**The empirical audit is Unit 1's dry-run pass against the live catalog.** The conceptual numbers above are the expected baseline; Unit 2 cleanup is regenerated from Unit 1's output, not from this table. Edge cases the conceptual audit may not catch include malformed YAML, whitespace-only field values, files where the regex in `parseFrontmatter` doesn't match (e.g., trailing whitespace before closing fence), and `name: null` parsing under JSON_SCHEMA. Unit 1's dry-run pass is the source of truth.

### Institutional Learnings

- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-2026-04-17.md` — for any batch file iteration in this PR, use `find ... | while IFS= read -r f` or `find ... -exec sed`. Verification grep must use a different iteration pattern than the conversion.
- Plan-taxonomy leak rule (memory + WORKFLOW_RULES): `R1`/`Unit 1`/`(v1)` patterns must NOT appear in shipped source files. Spec text describes conventions directly. Pre-PR grep gate: `grep -rn -E "\bR[0-9]+|Unit [0-9]+|\(v[0-9]+\)" <source files>` returns zero.

### External References

- None used. Codebase has all needed patterns. (writing-skills upstream is at `~/.agents/skills/writing-skills/SKILL.md`; the new skill cites it but does not duplicate its content.)

## Key Technical Decisions

- **Validator allow-list is descriptive of runtime loader.** The R5 allowed-fields set enumerates every field `extractFrontmatter` in `src/lib/skills.ts:71–84` recognizes: `name`, `description`, `argument-hint`, `disable-model-invocation`, `allowed-tools`, `license`, `compatibility`, `metadata`, `user-invocable`, `agent`, `model`, `context`, `subtask`. Banned set is a literal denylist of just `preconditions` (the one field with no runtime consumer; compound-docs is the only current user). This eliminates semantic drift between loader and validator and preserves runtime contract for `claude-permissions-optimizer`'s forked-subtask dispatch.
- **Reuse `parseFrontmatter` from `src/lib/frontmatter.ts`** for both new validators. Single source of truth for YAML parsing.
- **`argument-hint` format = accept any non-empty string in V1.** All 21 current uses are free-text bracketed; slot-typing deferred to V2.
- **No `--dry-run` flag in shipped CLI.** The validator runs in dry-run mode internally during Unit 1 (via a private function flag, not a CLI surface) to capture the audit output. After Unit 5 flips to enforcing mode, no permanent CLI flag remains. Per scope-guardian S2: a permanent flag adds CLI surface without a documented current consumer; deferred to V2 if a real iteration pain emerges.
- **All foundation violations exit non-zero.** No advisory tier.
- **Validator surface = extend `scripts/content-integrity.ts`, not a new script.** One CI step, one report. The file is currently 800 lines; adding two checks brings it to ~950. If V2 adds a third check pattern that pushes the file past ~1000 lines or 5 distinct check types, split into `scripts/content-integrity/{checks,reports,main}.ts`. V1 stays in-place.
- **No frontmatter-on-sub-file rules in V1.** Existing sub-file integrity check (PR #319) verifies path resolution; per-type rules would be premature.
- **`workflows` removal from `SUBFILE_DIRECTORY_NAMES` ships with the validator code (Unit 1)**, including doc-comment updates at `scripts/content-integrity.ts:12–13` and `:486–487` (which currently example `workflows/foo.yml` and would otherwise lie).
- **Skill body lives in `skills/writing-systematic-skills/SKILL.md`; depth content lives in a SINGLE `references/foundation-conventions.md`** with H2 sections matching the SKILL.md body. Target ≤ 350 lines for SKILL.md; reference file unbounded. Per scope-guardian S1: the 3-file split mirrors R5/R6/R7 taxonomy without a navigation-driven justification. Implementer may split if a section grows past ~250 lines, but the default is one file.
- **`name: systematic:writing-systematic-skills` for the new skill.** No existing Systematic skill uses the `systematic:` prefix in its `name:` field (8 use `ce:` prefix; 37 are bare). The new skill is the first. Per origin R1; namespace migration for existing 37 bare-name skills is deferred to V2 with a migration plan. V1 documents the convention; the validator does not enforce `name:` value patterns.
- **`ai:systematic` is reframed as agent-identity attribution**, NOT a skill cross-reference convention. Per `skills/proof/SKILL.md:22`: 'Machine ID (`by` on every op, `X-Agent-Id` header): `ai:systematic`'. R7's third sub-bullet documents this accurately. V1 does not validate it (documentation-only).

## Open Questions

### Resolved During Planning

- **`parseFrontmatter` reuse vs inline YAML**: Reuse. Single source of truth.
- **`argument-hint` shape enforcement**: Accept any non-empty string in V1. Stricter shape is a V2 question.
- **Audit mode**: Empirical — Unit 1's dry-run pass against the live catalog. No permanent CLI `--dry-run` flag.
- **Cleanup scope**: Determined empirically by Unit 1's output. Conceptual baseline is 1 banned-field skill (compound-docs/preconditions) + 13 agents missing `model: inherit`; final scope flexes to whatever Unit 1 surfaces.
- **Sub-file frontmatter rules in V1**: None. Path-resolution check (PR #319) is sufficient.
- **`ai:systematic` framing**: Agent-identity attribution (machine ID), not skill cross-reference. Documented in spec body; not validated in V1.
- **Validator allow-list scope**: Match the runtime loader's full set (`src/lib/skills.ts:71–84`). Single banned field: `preconditions`.
- **Forked-subtask dispatch (`context: fork` / `subtask: true`)**: Preserved. Both fields are runtime-recognized and on the allow-list.
- **References/ split**: Single `references/foundation-conventions.md` by default. Implementer may split if a section grows past ~250 lines.
- **PR shipping**: Single PR, but re-sequenced — validators land FIRST in dry-run, cleanup follows, validator flips to enforcing mode last.
- **Parse-error short-circuit**: When `parseFrontmatter` returns `parseError: true`, emit one `malformed-frontmatter` violation per file and skip remaining field-level checks.
- **`name: null` ambiguity**: A `name:` field that parses to `null` (e.g., bare `name:` or `name: ~`) is treated as `missing-required-field`, NOT `empty-required-field`. Empty-required-field applies only to literal empty strings (`name: ""`). Documented in Unit 1 type definitions.
- **Registry script path**: Use `scripts/build-registry.ts` (the canonical npm-script-exposed entrypoint per `package.json: registry:build`). `scripts/generate-registry.ts` exists but is not the documented public path.

### Deferred to Implementation

- **Skill body section ordering**: writing-skills uses a particular section order; the new skill should follow it but minor adjustments are likely once content is being written.
- **Reference file split timing**: Whether `foundation-conventions.md` ever exceeds the ~250-line threshold and needs splitting. Decide at write time.
- **Exact remediation message phrasing**: Each validator emits a one-line remediation pointing to the spec; specific wording is implementation-time polish.
- **`--validate-only` vs `--check` flag for build-registry.ts**: Confirm exact CLI flag during Unit 6's registry regeneration step (the `package.json` script uses `--validate-only`).

## Output Structure

```text
skills/writing-systematic-skills/
├── SKILL.md                                 # Bedrock spec (≤350 lines)
└── references/
    └── foundation-conventions.md            # H2: Frontmatter / File Layout / Identity Defaults
```

The implementer may split `foundation-conventions.md` if a section grows past ~250 lines, but the V1 default is one file.

## Implementation Units

The ordering below is the empirical audit pattern: validators land FIRST in dry-run mode, their output drives cleanup scope, and the validator flips to enforcing mode last. This avoids the failure mode where Unit 4 surfaces a violation Unit 1 missed in a single-PR shipment.

- [x] **Unit 1: Validator implementation (dry-run by default, no CLI flag)**

  **Goal:** Add `checkFrontmatter` and `checkAgentModel` to the content-integrity gate. Wire them into the result type. Have them run automatically as part of `checkContentIntegrity()`. **Do not yet flip the gate's exit code to count their violations.** This unit ships a validator that prints violations to stderr but exits 0; Unit 5 flips it to enforcing mode.

  **Requirements:** R12, R13, R17

  **Dependencies:** None.

  **Execution note:** Test-first. Add failing tests for the new violation types; implement until green; repeat per rule. Mirrors PR #301's TDD pattern for `checkSubfileReferences`.

  **Files:**
  - Modify: `scripts/content-integrity.ts`
    - Add `FrontmatterViolation` and `AgentModelViolation` types
    - Add `checkFrontmatter` and `checkAgentModel` functions
    - Extend `CheckResult` with `frontmatterViolations` and `agentModelViolations` arrays
    - Update `totalViolations()` to sum both new arrays
    - Replace the inline sum in `main()` (lines 784–787) with a `totalViolations(result)` call so future checks only require one update
    - Add `printFrontmatterViolations()` and `printAgentModelViolations()` helpers per the existing `printX` pattern
    - **Crucially**: have `main()` exit 0 even when the new violations are non-empty. The check still runs and prints; only the exit code is held back. Implement via a feature flag constant `ENFORCE_FRONTMATTER_RULES = false` at module scope, gating only the exit-code calculation. Unit 5 flips this to `true`.
    - Remove `workflows` from `SUBFILE_DIRECTORY_NAMES` (line 480 area)
    - Update doc comments at lines 12–13 (header block) and lines 486–487 (regex example) to drop `workflows/foo.yml` from the example list
  - Test: `tests/unit/content-integrity.test.ts` (extends existing 1034-line file; adds new `describe` blocks per check)

  **Approach:**
  - **Type definitions:**

    ```typescript
    export interface FrontmatterViolation {
      file: string
      rule:
        | 'banned-field' // currently only `preconditions`
        | 'unknown-field' // not in allowed-fields list
        | 'missing-required-field' // name or description absent (or parses to null)
        | 'empty-required-field' // name or description is literal empty string
        | 'malformed-frontmatter' // parseFrontmatter returned parseError: true
        | 'missing-frontmatter' // no --- markers at all
      message: string
      remediation: string
    }
    export interface AgentModelViolation {
      file: string
      message: string
    }
    ```

    *(Directional sketch; final shape may evolve at write time.)*

  - **Allowed-fields constant** (matches `extractFrontmatter` in `src/lib/skills.ts:71–84`):

    ```typescript
    const ALLOWED_SKILL_FRONTMATTER_FIELDS = new Set([
      'name',
      'description',
      'argument-hint',
      'disable-model-invocation',
      'allowed-tools',
      'license',
      'compatibility',
      'metadata',
      'user-invocable',
      'agent',
      'model',
      'context',
      'subtask',
    ])
    const BANNED_SKILL_FRONTMATTER_FIELDS = new Set(['preconditions'])
    ```

  - **`checkFrontmatter(rootDir, skillFiles)`**: filters to `skills/*/SKILL.md`; calls `parseFrontmatter`. **Short-circuit on parseError**: emit one `malformed-frontmatter` violation and skip remaining checks for that file. Otherwise: emit `missing-frontmatter` if `hadFrontmatter === false`; emit `missing-required-field` if `name` is absent or null; emit `empty-required-field` if `name === ''`; same for `description`; emit `banned-field` (with specific message) for any field in `BANNED_SKILL_FRONTMATTER_FIELDS`; emit `unknown-field` for any field not in `ALLOWED_SKILL_FRONTMATTER_FIELDS ∪ BANNED_SKILL_FRONTMATTER_FIELDS`.

  - **`checkAgentModel(rootDir, agentFiles)`**: walks every agent `.md` file; calls `parseFrontmatter`; flags missing `model:` field OR non-`inherit` value (including null and empty-string). Emits one violation per file.

  - **`CheckResult` extension**: add `frontmatterViolations: FrontmatterViolation[]` and `agentModelViolations: AgentModelViolation[]`.

  - **`totalViolations()` update**: include both new arrays. Then replace `main()`'s inline sum with `totalViolations(result)`.

  - **`ENFORCE_FRONTMATTER_RULES = false` gate**: in `main()`, compute the violation count as: `phantomRefs + brokenSubfileRefs + bannedPatterns + (ENFORCE_FRONTMATTER_RULES ? frontmatterViolations + agentModelViolations : 0)`. Helpers print regardless. Unit 5 sets the constant to `true`.

  - **`workflows` removal**: one-line edit to `SUBFILE_DIRECTORY_NAMES`. Regex at line 499 auto-updates. Update the doc comments in the header (lines 12–13) and the SUBFILE_PATH_REGEX comment (lines 486–487).

  **Patterns to follow:**
  - `checkSubfileReferences` (lines 513–565) for per-check function signature and scan loop.
  - `printPhantomRefs` / `printBrokenSubfileRefs` (lines 727–745) for output format (`process.stderr.write` with `file:line message`).

  **Test scenarios:**
  - **Happy path — `checkFrontmatter`:**
    - Skill with `{name, description}` only → zero violations.
    - Skill with all 13 allowed fields populated → zero violations.
  - **Banned-field (only `preconditions`):**
    - Skill with `preconditions: foo` → 1 violation, rule=`banned-field`, message names `preconditions`, remediation references `systematic:writing-systematic-skills`.
    - Skill with `subtask: true` → zero violations (allowed; runtime-recognized).
    - Skill with `context: fork` → zero violations.
  - **Unknown-field violations:**
    - Skill with `experimental: true` → 1 violation, rule=`unknown-field`.
    - Skill with multiple unknown fields → multiple violations, one per field.
  - **Missing/empty/null required fields:**
    - Skill with frontmatter but no `name:` → 1 violation, rule=`missing-required-field`, message names `name`.
    - Skill with `name:` (bare, parses to null) → 1 violation, rule=`missing-required-field`.
    - Skill with `name: ~` (parses to null) → 1 violation, rule=`missing-required-field`.
    - Skill with `name: ""` → 1 violation, rule=`empty-required-field`.
    - Skill with no `description:` → 1 violation, rule=`missing-required-field`, message names `description`.
  - **Frontmatter parsing edge cases (parse-error short-circuit):**
    - Skill with no `---` markers → 1 violation, rule=`missing-frontmatter`. No additional field-level violations.
    - Skill with malformed YAML inside fences → 1 violation, rule=`malformed-frontmatter`. **Asserts: exactly 1 violation, not 3** (no cascading missing-name/missing-description noise).
  - **Happy path — `checkAgentModel`:**
    - Agent with `model: inherit` → zero violations.
  - **`checkAgentModel` violations:**
    - Agent with no `model:` field → 1 violation.
    - Agent with `model: anthropic/claude-haiku-4-5` → 1 violation.
    - Agent with `model: ""` (empty) → 1 violation.
    - Agent with `model: ~` (null) → 1 violation.
  - **Edge case — scope:**
    - `checkFrontmatter` ignores `agents/**/*.md`.
    - `checkAgentModel` ignores `skills/**/*.md`.
    - Reference sub-files (e.g., `skills/foo/references/bar.md`) are not scanned by either validator.
  - **Integration scenario — dry-run gate:**
    - Fixture with 1 banned-field skill + 1 missing-model agent → violations printed; `main()` returns 0 (because `ENFORCE_FRONTMATTER_RULES = false`).
  - **Integration scenario — `checkSubfileReferences` after `workflows` removal:**
    - Skill SKILL.md citing `workflows/foo.yml` no longer triggers a sub-file integrity check (the path is no longer recognized as a skill sub-directory).

  **Verification:**
  - All new tests pass; existing 418 tests still pass.
  - `bun scripts/content-integrity.ts` exits 0 on the live catalog (validators run, print violations, but flag is off).
  - `bun scripts/content-integrity.ts --verbose` includes counts of `frontmatterViolations` and `agentModelViolations` in its summary.
  - `SUBFILE_DIRECTORY_NAMES` no longer contains `workflows`; doc comments updated.

- [x] **Unit 2: Cleanup of empirically-surfaced violations** *(direction inverted post-merge — see Post-merge reconciliation above)*

  **Goal:** Drive the catalog to zero foundation-rule violations using Unit 1's empirical output as the source of truth.

  **Requirements:** R15, R16

  **Dependencies:** Unit 1 (validator must exist and have produced the audit output).

  **Approach:**
  - Run `bun scripts/content-integrity.ts --verbose` against the live catalog. Capture the listed `frontmatterViolations` and `agentModelViolations`.
  - The expected baseline (per the conceptual audit during planning):
    - `frontmatterViolations`: compound-docs has `preconditions` (1 violation, rule=banned-field).
    - `agentModelViolations`: 13 agents missing `model: inherit`.
  - **Files actually modified depend on Unit 1's output.** If the empirical audit surfaces violations the conceptual audit missed (e.g., a malformed-frontmatter file, an unknown field on a skill not previously inspected, an agent with `model:` set to something unexpected), this unit's file list expands to cover them. The unit is complete when re-running the validator produces zero violations of either new type.
  - **Expected file list (will be confirmed against Unit 1 output before commit):**
    - Modify: `skills/compound-docs/SKILL.md` (remove `preconditions:` field; move semantics to body as a "Prerequisites" section if present)
    - Modify: `agents/review/api-contract-reviewer.md` (add `model: inherit`)
    - Modify: `agents/review/correctness-reviewer.md`
    - Modify: `agents/review/data-migrations-reviewer.md`
    - Modify: `agents/review/dhh-rails-reviewer.md`
    - Modify: `agents/review/julik-frontend-races-reviewer.md`
    - Modify: `agents/review/kieran-python-reviewer.md`
    - Modify: `agents/review/kieran-rails-reviewer.md`
    - Modify: `agents/review/kieran-typescript-reviewer.md`
    - Modify: `agents/review/maintainability-reviewer.md`
    - Modify: `agents/review/performance-reviewer.md`
    - Modify: `agents/review/reliability-reviewer.md`
    - Modify: `agents/review/security-reviewer.md`
    - Modify: `agents/workflow/bug-reproduction-validator.md`
  - For agent edits: add `model: inherit` line in frontmatter, matching the placement convention in `agents/review/testing-reviewer.md` (a sibling agent already carrying `model: inherit` along with `mode: subagent` and `temperature: 0.1` — closer pattern than research-category agents which lack `mode`/`temperature` fields).
  - For `compound-docs/SKILL.md`: drop `preconditions:`. Move equivalent prose into body as "Prerequisites" section if not already present.
  - **`claude-permissions-optimizer/SKILL.md` is NOT modified.** Its `context: fork` and `subtask: true` are runtime-recognized and on the allow-list; the conceptual audit's earlier framing (banned-field violation) was wrong and is corrected in this plan.
  - Run `bun scripts/content-integrity.ts --verbose` after each batch to confirm violations decrease toward zero.

  **Patterns to follow:**
  - `agents/review/testing-reviewer.md` for canonical `model: inherit` placement in agents that also carry `mode: subagent` / `temperature: 0.1`.
  - Existing skills with no banned fields (`ce:brainstorm`, `ce:plan`, `document-review`) for compliant frontmatter shape.

  **Test scenarios:**
  - Test expectation: none — pure content cleanup. Coverage comes from Unit 1's validator tests; Unit 6's catalog-wide assertion confirms zero violations.

  **Verification:**
  - All listed agent files contain `model: inherit` in frontmatter.
  - `compound-docs/SKILL.md` frontmatter has no `preconditions` key.
  - `claude-permissions-optimizer/SKILL.md` frontmatter is unchanged (still has `context: fork` and `subtask: true`).
  - `bun scripts/content-integrity.ts` reports zero `frontmatterViolations` and zero `agentModelViolations` (still exits 0 because flag is off; Unit 5 flips it).
  - `bun test tests/unit` still passing.

- [x] **Unit 3: Author skills/writing-systematic-skills/SKILL.md (bedrock spec)**

  **Goal:** Ship the foundation-spec skill body — concise, scannable, layered on writing-skills.

  **Requirements:** R1, R2, R3, R4, R5, R6, R7 (skill-scoped sub-rules surfaced in body)

  **Dependencies:** Unit 2 (so the spec describes a clean baseline).

  **Files:**
  - Create: `skills/writing-systematic-skills/SKILL.md`

  **Approach:**
  - Frontmatter: `name: systematic:writing-systematic-skills`; `description` is third-person "Use when…" pattern (per writing-skills); under 1024 chars total.
  - Body sections (working order, adjust at write-time):
    1. **When to use** — one-paragraph trigger conditions: authoring a new Systematic skill, auditing an existing one, fixing a CI gate violation.
    2. **Foundation: invoke writing-skills first** — explicit pointer to `~/.agents/skills/writing-skills/SKILL.md`; this skill carries only the Systematic delta (R3).
    3. **Frontmatter rules** — required (`name`, `description`); optional standardized fields enumerated with one-line purpose for each (`argument-hint`, `disable-model-invocation`, `allowed-tools`, `license`, `compatibility`, `metadata`, `user-invocable`, `agent`, `model`, `context`, `subtask`); single banned field (`preconditions`). Direct prose, no R-IDs. Point to `references/foundation-conventions.md` for worked examples.
    4. **File layout** — `skills/<name>/SKILL.md` plus optional `references/`, `scripts/`, `assets/`, `templates/`. Direct prose. Point to `references/foundation-conventions.md` for examples.
    5. **Identity defaults** — agent `model: inherit`; skill `description` third-person "Use when…"; `ai:systematic` is the machine-id / API-attribution string used by `skills/proof/SKILL.md` (per `:22` verbatim) and `ce:*` handoff docs — NOT a skill cross-reference convention. Point to `references/foundation-conventions.md`.
    6. **Validator** — `bun scripts/content-integrity.ts` enforces these rules in CI; one paragraph naming the gate and the kinds of violations it catches.
  - Body length target: ≤ 350 lines. Mirror `ce:brainstorm` (198 lines) for tone/density. (Note: `ce:plan` at 737 lines is denser and is treated as a counter-example, not a structural exemplar.)
  - Self-referential test: the skill's own SKILL.md must pass every rule it codifies (R4). Verified by Unit 6's catalog-wide assertion.

  **Patterns to follow:**
  - `skills/ce-brainstorm/SKILL.md` for body structure tone (concise, action-oriented, references for depth).
  - `skills/document-review/SKILL.md` for skill-with-rich-frontmatter shape.
  - `~/.agents/skills/writing-skills/SKILL.md` for the user-foundational skill being layered on.

  **Test scenarios:**
  - Test expectation: none for SKILL.md content directly. Validator tests in Unit 1 prove the file passes every rule. Unit 6's catalog-wide assertion confirms compliance.

  **Verification:**
  - `bun scripts/content-integrity.ts` passes with the new SKILL.md present (no new violations).
  - File length under 350 lines.
  - Frontmatter contains only `name` and `description` (the new spec skill does not need any optional standardized fields, though R5 permits them).
  - Manual readthrough confirms the skill does not duplicate writing-skills content.

- [x] **Unit 4: Author references/foundation-conventions.md**

  **Goal:** Ship judgment-call guidance and worked examples in a single reference file.

  **Requirements:** R2 (depth lives in references/)

  **Dependencies:** Unit 3 (SKILL.md establishes section names that references mirror).

  **Files:**
  - Create: `skills/writing-systematic-skills/references/foundation-conventions.md`

  **Approach:**
  - Single file with H2 sections matching the SKILL.md body sections:
    - `## Frontmatter` — detailed table of every allowed field with one-line purpose, when to use, and example. Includes a "common mistakes" section (e.g., `preconditions:` is banned because it has no runtime consumer; `subtask: true` and `context: fork` are equivalent for the runtime loader and either is acceptable).
    - `## File Layout` — directory tree examples; when to add `scripts/` (executable helpers) vs `templates/` (stubs an agent fills in) vs `assets/` (static content not modified at runtime). Reference to PR #319 sub-file integrity rule.
    - `## Identity Defaults` — why `model: inherit` is mandatory for bundled agents (provider portability — hardcoded `anthropic/*` IDs break non-Anthropic users); `ai:systematic` as machine-id / API-attribution string (with the `skills/proof/SKILL.md:22` example); third-person "Use when…" pattern.
  - File starts with a single `# Foundation Conventions` H1 heading. No YAML frontmatter (matches existing pattern in `skills/ce-brainstorm/references/handoff.md`).
  - Implementer may split if a section grows past ~250 lines; otherwise keep one file.

  **Patterns to follow:**
  - `skills/ce-brainstorm/references/handoff.md`, `skills/ce-brainstorm/references/requirements-capture.md` (PR #319 imports) for reference-file tone, density, and lack of YAML frontmatter.
  - `skills/ce-plan/references/visual-communication.md` for reference-as-decision-tree structure.

  **Test scenarios:**
  - Test expectation: none — plain markdown content. Sub-file path resolution is verified by Unit 1's `checkSubfileReferences` (the SKILL.md citing this reference must resolve).

  **Verification:**
  - The reference path cited in `skills/writing-systematic-skills/SKILL.md` resolves on disk.
  - `bun scripts/content-integrity.ts` passes with the reference file present.
  - Total reference content roughly ≤ 600 lines (informational target; not a hard rule).

- [x] **Unit 5: Flip the validator to enforcing mode**

  **Goal:** Activate the foundation-rule violations as gate-blocking errors. After this unit, any future PR introducing a banned field, missing required field, or missing `model: inherit` will fail CI.

  **Requirements:** R12, R13 (enforcement)

  **Dependencies:** Unit 2 (catalog must be clean), Unit 3 (new skill is itself compliant), Unit 4 (reference file resolves).

  **Files:**
  - Modify: `scripts/content-integrity.ts` — set `ENFORCE_FRONTMATTER_RULES = true` (one-line edit). Optionally remove the constant and inline the sum if the gate flag is no longer useful.

  **Approach:**
  - Run `bun scripts/content-integrity.ts` — must exit 0 against the live catalog (Unit 2 cleanup + Unit 3/4 new skill must already produce zero violations).
  - Add a regression test asserting that introducing a synthetic banned-field violation in the test fixture causes `main()` to return 1.

  **Patterns to follow:**
  - PR #301 / #319 / #313 — same flip-to-enforcing pattern.

  **Test scenarios:**
  - **Integration scenario — enforcing-mode gate:**
    - Fixture with 1 banned-field skill + 1 missing-model agent → `main()` returns 1.
  - **Real-repo integration smoke:**
    - `checkContentIntegrity(REPO_ROOT)` returns `frontmatterViolations: []` and `agentModelViolations: []` on the post-Unit-2 repo; `main()` returns 0.

  **Verification:**
  - All tests pass.
  - `bun scripts/content-integrity.ts` exits 0 on the live catalog.
  - Local test: introduce a synthetic violation (e.g., add `preconditions:` to a test fixture skill), run the gate, assert exit 1, revert.

- [x] **Unit 6: Register the new skill in registry + update AGENTS.md**

  **Goal:** Ship the skill in the OCX registry so it's installable and update the documented skill count.

  **Requirements:** None directly — operational completeness.

  **Dependencies:** Units 3 + 4 (skill files exist on disk).

  **Files:**
  - Modify: `registry/registry.jsonc` (auto-regenerated)
  - Modify: `dist/registry/` (auto-regenerated; committed as required by registry drift check)
  - Modify: `AGENTS.md` (root) — update skill count from 45 to 46
  - Modify: `docs/AGENTS.md` — update skill count from 45 to 46

  **Approach:**
  - Run `bun run registry:build` (which calls `scripts/build-registry.ts` per `package.json`). The generator auto-discovers the new skill, sanitizes the name (`writing-systematic-skills` is already kebab-case-clean), and adds it to the registry. The single reference sub-file becomes a file entry automatically.
  - Update both `AGENTS.md` files for the skill count (45 → 46).
  - Verify `bun run registry:validate` (which calls `scripts/build-registry.ts --validate-only`) exits 0 (no drift) before commit.

  **Patterns to follow:**
  - Registry regeneration pattern from PR #315 / #319.
  - `AGENTS.md` count updates from PR #314.

  **Test scenarios:**
  - Test expectation: none — generated artifact + doc updates. Coverage comes from CI's existing registry drift check.

  **Verification:**
  - `bun run registry:validate` exits 0.
  - `dist/registry/` reflects the new skill component.
  - `bun test` still passing.
  - Both AGENTS.md files show skill count 46.

- [x] **Unit 7: Final quality gate + plan-taxonomy verification**

  **Goal:** Confirm the PR is ready for review. Catalog-wide compliance, all gates green, no plan-taxonomy leakage.

  **Requirements:** verifies AE5 (catalog-wide cleanliness) — no new R-IDs.

  **Dependencies:** Units 1–6.

  **Files:** None (verification only).

  **Approach:**
  - Run full quality gate locally:
    - `bun run build`
    - `bun run typecheck`
    - `bun run lint`
    - `bun test` (all unit + integration)
    - `bun scripts/content-integrity.ts` (must exit 0)
    - `bun run registry:validate` (must exit 0)
    - `node --input-type=module -e "import('./dist/index.js')"` (Node ESM smoke)
  - Run plan-taxonomy grep against changed source/spec files:
    `grep -rn -E "\bR[0-9]+|Unit [0-9]+|\(v[0-9]+\)" skills/writing-systematic-skills/ scripts/content-integrity.ts tests/unit/content-integrity.test.ts`
    Must return zero in shipped source. (Plan doc may keep taxonomy; shipped source must not.)
  - Verify `checkFrontmatter` returns `[]` against the new skill's own SKILL.md (R4 self-referential test).
  - Verify catalog-wide assertion: `checkContentIntegrity(REPO_ROOT)` returns zero violations across all 46 skills + 50 agents.

  **Test scenarios:**
  - Test expectation: none — verification step.

  **Verification:**
  - All quality gates exit 0.
  - Plan-taxonomy grep returns zero matches in shipped source.
  - Catalog-wide content integrity is clean.

## System-Wide Impact

- **Interaction graph:** Skill loader (`src/lib/skill-loader.ts`) discovers the new skill automatically via `findSkillsInDir`. Registry generator (`scripts/build-registry.ts`) auto-includes it. Content-integrity gate (`scripts/content-integrity.ts`) gains two new checks; existing checks unchanged.
- **Error propagation:** New validators emit violations through the existing `CheckResult` pipeline. Exit code aggregation runs through `totalViolations()` after Unit 1's refactor (the inline sum at `scripts/content-integrity.ts:784–787` is replaced). CI build job already runs the gate.
- **State lifecycle risks:** None. Validators are pure functions over filesystem; cleanup is idempotent.
- **API surface parity:** Two new exported types (`FrontmatterViolation`, `AgentModelViolation`) and two new exported functions (`checkFrontmatter`, `checkAgentModel`). Existing exports unchanged. No breaking changes to plugin entry point.
- **Integration coverage:** Real-repo smoke test in `tests/unit/content-integrity.test.ts` (mirroring existing pattern at lines 980+) asserts `frontmatterViolations: []` and `agentModelViolations: []` against actual `main` post-Unit-2.
- **Unchanged invariants:**
  - `dist/index.js` still exports only the plugin factory function. No new named exports leak to entry point (per OpenCode plugin loader constraint).
  - Runtime loader contract is preserved — `claude-permissions-optimizer`'s forked-subtask dispatch (`context: fork` / `subtask: true`) is not modified.
  - Existing `BANNED_PATTERNS` and allowlist behavior are preserved.
  - `parseFrontmatter` API unchanged.
  - Skill loader behavior unchanged.

## Risks & Dependencies

| Risk                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empirical audit (Unit 1 dry-run pass) surfaces violations the conceptual audit missed                                | Expected and accommodated: Unit 2's file list flexes to whatever Unit 1 surfaces. The Unit 2 description explicitly reads the empirical output before committing the cleanup. If a malformed-frontmatter or unknown-field hit appears on a previously-uninspected file, decide between fix-in-place vs. allowlist-with-reason inline. |
| Mid-PR scope expansion if Unit 1 surfaces violations needing per-case decisions                                        | The single-PR re-sequencing means Unit 5 (validator enforcement) is the LAST commit. If Unit 2 cleanup needs to expand or split, Unit 5 simply waits. Decision tree: (a) for runtime-recognized fields, allowlist; (b) for new unknown fields, add to Unit 2 cleanup; (c) for malformed YAML, fix in place.                            |
| Spec body grows past 350-line target                                                                                  | 350-line target is informational; if content warrants depth, push it into `references/foundation-conventions.md` rather than letting SKILL.md grow. Single threshold (350); no second 400-line threshold.                                                                                                                             |
| `ENFORCE_FRONTMATTER_RULES` flag remains `false` after merge by oversight                                              | Unit 5's verification includes a synthetic-violation-then-revert local test that proves the flag is `true` and the gate exits 1 on violations. CI on the post-merge `main` will also fail if the flag is left off and any violation slips in.                                                                                          |
| `name:` namespace migration creates inconsistency — 1 skill with `systematic:` prefix, 37 with bare names               | Acknowledged. V2 migration plan handles this. V1 documents the convention without enforcing it. The new skill is the first instance and sets precedent.                                                                                                                                                                               |
| New validator semantics differ subtly from runtime skill-loader's frontmatter expectations                              | Both use `parseFrontmatter` from `src/lib/frontmatter.ts`. The validator's allow-list constant explicitly mirrors the runtime loader's enumerated set. Single source of truth prevents drift.                                                                                                                                          |
| Plan-taxonomy leak from this plan into shipped source                                                                 | Unit 7 runs the documented grep gate. The reference file `foundation-conventions.md` will contain prose that may incidentally use the words "unit" or "requirement" in non-taxonomy senses; the grep is `\bR[0-9]+|Unit [0-9]+|\(v[0-9]+\)` so plain English is safe.                                                                  |
| Self-referential test reveals the new skill itself violates a rule                                                    | Catalog-wide assertion in Unit 7 catches this. If it fails, fix in place before merge.                                                                                                                                                                                                                                                |
| Author behavior change (skill being invoked before authoring) is unenforced                                            | Acknowledged limitation. The validator's remediation messages reference `systematic:writing-systematic-skills` so authors hit the spec via gate failure rather than relying on voluntary invocation. Authoring-time enforcement (pre-commit hook, scaffold tool) is deferred to V2. Same class as recently invalidated probes; documented but not solved by V1. |

## Documentation / Operational Notes

- **CHANGELOG**: v2.7.0 minor entry covering: new bundled skill `systematic:writing-systematic-skills`, `checkFrontmatter` + `checkAgentModel` validators, `workflows` removal from `SUBFILE_DIRECTORY_NAMES`, audit-driven cleanup of 13 agents + 1 skill (compound-docs).
- **PR description**: should describe what authors gain (a written spec, gate enforcement, clean baseline) without referencing internal session details (no R-IDs, no Unit numbers).
- **No rollout concerns**: validators are CI-time only; no runtime impact on plugin consumers. Cleanup is content-only with no behavioral consequences. `claude-permissions-optimizer` is unchanged — its forked-subtask dispatch is preserved.
- **Post-merge**: V2 brainstorm candidates: (1) `ce:*` workflow conventions (phase numbering, document-review interleave); (2) `name:` namespace migration plan (37 bare-name skills → `systematic:` prefix); (3) authoring-time enforcement (scaffold tool, pre-commit); (4) `argument-hint` slot-typing.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-28-writing-systematic-skills-requirements.md](../brainstorms/2026-04-28-writing-systematic-skills-requirements.md)
- **Related code:**
  - `scripts/content-integrity.ts` — gate runtime; new checks slot into existing pattern
  - `src/lib/skills.ts:71–84` — `extractFrontmatter` is the runtime loader's allowed-fields source of truth
  - `src/lib/frontmatter.ts:19` — `parseFrontmatter` reused by both new validators
  - `tests/unit/content-integrity.test.ts:980+` — real-repo smoke test pattern to mirror
  - `skills/ce-brainstorm/SKILL.md` — body length / density reference (198 lines)
  - `skills/proof/SKILL.md:22` — `ai:systematic` machine-id usage example
  - `agents/review/testing-reviewer.md` — canonical `model: inherit` placement for review agents with `mode: subagent`
  - `package.json` (`registry:build`, `registry:validate`) — canonical registry script entrypoints
- **Related PRs:**
  - PR #301 — content-integrity gate base (TDD pattern, fixture helpers)
  - PR #315 — registry generator
  - PR #319 — sub-file integrity check
- **External docs:** None used. writing-skills is a user-installed skill; the new skill cites it but does not duplicate.
