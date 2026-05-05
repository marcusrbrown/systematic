---
title: Content-integrity gate and validation/bootstrap test coverage
type: feat
status: completed
date: 2026-04-18
completed_at: 2026-04-24
origin: docs/brainstorms/2026-04-18-infra-improvements-requirements.md
pr: https://github.com/marcusrbrown/systematic/pull/301
---

## Post-merge note

Shipped in two PRs: PR #301 (initial gate + tests, v2.5.0) and PR #306 (Fro Bot follow-up). Gate later wired into CI in PR #313, and extended with sub-file resolution check in PR #319. Now enforces: runtime-aligned skill frontmatter fields, banned `preconditions`, required non-empty `name`/`description`, bundled agents must omit the `model` field (per PR #336 reversal), and all internally-referenced sub-files must resolve on disk.

# Content-integrity gate and validation/bootstrap test coverage

## Overview

Add a content-integrity gate that runs as a unit test in the existing CI Test job. The gate enforces two content invariants across shipped `skills/`, `agents/`, and `src/*.ts` files: (1) every `systematic:<category>:<name>` reference resolves to an existing agent file, (2) a fixed list of CC/CEP banned patterns appears only in documented allowlist entries. Alongside the gate, close two longstanding unit-test gaps by adding `tests/unit/validation.test.ts` and `tests/unit/bootstrap.test.ts`, both including regression tests for known-fragile behavior with explicit CORRECTNESS/FRAGILITY tags so future refactors are intentional rather than silent.

Ships as **2.5.0 minor** (single PR). No breaking API, no runtime behavior changes — all three units are pure additions (new script, new allowlist config, three new test files). The gate is already green on v2.4.1 main with the proposed allowlist, so no transition grace period is needed.

## Problem Frame

v2.4.0 shipped two classes of silent content drift past local verification: a zsh `for` loop that iterated once on its multi-line input (41 unconverted files), and a reconciliation-sync policy that imported skill updates without validating that the newly-referenced agents existed (phantom dispatch directives for `slack-researcher` and `session-historian`). Both bugs originated in sync infrastructure that is now deleted (no recurrence via the same mechanism). The risk this initiative addresses is forward-looking: manual edits, sub-agent bulk changes, and ad-hoc CLI conversions can still introduce the same classes of content errors, and markdown content has no compile-time, typecheck-time, lint-time, or test-time signal by default.

In parallel, `src/lib/validation.ts` (168 lines) and `src/lib/bootstrap.ts` (69 lines) + the `INTERNAL_AGENT_SIGNATURES` skip heuristic in `src/index.ts` have no direct unit-test coverage. `loadAgentAsConfig` silently swallows validator errors returning `null`; the skip heuristic uses substring matching on the joined system prompt. Both are currently working, but neither has a signal when someone refactors them into broken.

(see origin: `docs/brainstorms/2026-04-18-infra-improvements-requirements.md`)

## Requirements Trace

**Content-integrity gate (I3.a):**

- R1. Add `scripts/content-integrity.ts` with `checkContentIntegrity(rootDir)` function covering phantom-ref + banned-pattern checks. (Unit 1)
- R2. Ship a fixed banned-pattern list as a typed constant: `Claude Code`, `TaskCreate`, `AskUserQuestion`, `compound-engineering:`, `CLAUDE.md`, `${CLAUDE_PLUGIN_ROOT}`, `.claude/`, `.context/compound-engineering/`. (Unit 1)
- R3. Add `tests/unit/content-integrity.test.ts` that invokes the gate and hard-fails on any violation; error output names file, line, and pattern/reference. (Unit 1)
- R4. Add `scripts/.drift-allowlist.json` with structured per-file-per-pattern exemptions covering `claude-permissions-optimizer`, `orchestrating-swarms`, and `converter.ts`. (Unit 1)
- R5. Typed schema validation of the allowlist, with warnings (non-fatal) for broad `**` pathGlobs and zero-match pathGlobs. A missing `.drift-allowlist.json` file is treated as an empty allowlist (gate still runs; no exemptions apply). (Unit 1)
- R6. Gate is scoped to `skills/**/*.md`, `agents/**/*.md`, and `src/**/*.ts` — excludes `docs/`, `.opencode/`, `.github/`, `dist/`, `node_modules/`, `registry/`, and `src/**/*.md`. Reference-integrity check runs on `*.md` only; banned-pattern check runs on both `*.md` and `*.ts`. (Unit 1)

**Validation module coverage (I3.b):**

- R7. Add `tests/unit/validation.test.ts` covering every exported function in `src/lib/validation.ts`: `isRecord`, `isPermissionSetting`, `isToolsMap`, `isAgentMode`, `normalizePermission`, `extractString`, `extractNonEmptyString`, `extractNumber`, `extractBoolean` (all 9 exports as of v2.4.1). (Unit 2)
- R8. At least one regression test in `validation.test.ts` tagged CORRECTNESS or FRAGILITY covering the silent-null-on-malformed-frontmatter chain — `loadAgentAsConfig` returns `null` when a validator returns `undefined` on malformed input. (Unit 2)

**Bootstrap module coverage (I3.c):**

- R9. Add `tests/unit/bootstrap.test.ts` covering `getBootstrapContent` + the `INTERNAL_AGENT_SIGNATURES` skip heuristic from `src/index.ts`. (Unit 3)
- R10. At least one regression test in `bootstrap.test.ts` tagged CORRECTNESS or FRAGILITY covering the substring-match skip behavior. (Unit 3)
- R11. Add a consistency assertion between the CC-tool-name mapping surfaces: every backticked tool name appearing in `getToolMappingTemplate`'s prose template in `src/lib/bootstrap.ts` must have a corresponding entry in `TOOL_NAME_MAP` in `src/lib/converter.ts`. Catches accidental drift between the two mappings, per the documented coupling in `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md`. (Unit 3)

## Scope Boundaries

- **Not in scope — OCX registry auto-generation (I3.d).** Hand-maintained registry remains. Separate cycle.
- **Not in scope — Bundled asset error surfacing (I3.e).** `loadAgentAsConfig` / `loadCommandAsConfig` continue to return `null` on failure. Separate cycle.
- **Not in scope — Legacy `commands/` code path cleanup (I3.f).** `src/lib/commands.ts`, `tests/unit/commands.test.ts`, `collectCommands`/`loadCommandAsConfig` in `config-handler.ts` remain as dead code. Separate cycle.
- **Not in scope — Refactoring the skip heuristic.** Tests document current behavior; a proper frontmatter-based opt-out is a separate design decision.
- **Not in scope — Count drift, frontmatter schema, markdown link integrity.** Adjacent drift-prevention ideas rolled into OCX auto-gen territory.
- **Not in scope — Regex anchoring check.** CodeQL handles this server-side already.
- **Not in scope — CI comment bot / dedicated workflow file.** The gate runs inside the existing Test job.
- **Not in scope — New OpenCode hook adoption.** `experimental.session.compacting` strategic-moat work is its own brainstorm.
- **Not in scope — Initiative #2 work.** `orchestrating-swarms` rewrite-or-delete, `ce-work-beta`, `lfg`/`slfg` merge, todo trio consolidation — deferred to 3.0.0.

## Context & Research

### Relevant Code and Patterns

- `scripts/build-registry.ts` — script-file conventions: `#!/usr/bin/env bun` shebang, `node:` protocol imports, manual argv loop, `main()` at bottom, `console.error + process.exit(1)` for fatal errors. Model for `scripts/content-integrity.ts`.
- `src/lib/walk-dir.ts:17-51` — `walkDir(root, { maxDepth, filter })` returns `WalkEntry[]` with `path`, `name`, `isDirectory`, `depth`, `category`. Foundation for file discovery in the gate.
- `src/lib/frontmatter.ts:19` — `parseFrontmatter` used by ~16 call sites; not needed by the gate directly but helpful reference for markdown scanning style.
- `tests/unit/build-registry.test.ts` — pattern for testing a script via `Bun.spawnSync` (CLI-style). Relevant if we test the CLI entry point separately; the gate's pure `checkContentIntegrity` will be tested via direct import.
- `tests/unit/skills.test.ts:13-18`, `tests/unit/config.test.ts:30-36` — temp-dir fixture pattern: `fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))` in `beforeEach`, `fs.rmSync(testDir, { recursive: true, force: true })` in `afterEach`. Gate test needs fixtures for positive cases (phantom injected, banned pattern injected).
- `tests/unit/plugin.test.ts` (137 lines) — only tests plugin-loading and bundled-content existence; does NOT currently test the transform hook. bootstrap.test.ts fills that gap.
- `src/index.ts:10-14` — `INTERNAL_AGENT_SIGNATURES` array (3 signatures): "You are a title generator", "You are a helpful AI assistant tasked with summarizing conversations", "Summarize what was done in this conversation". Private const (not exported); Unit 3 makes it `export const` so bootstrap.test.ts can reconstruct the skip predicate without duplicating data.
- `src/index.ts:91-113` — the skip predicate: `const existingSystem = output.system.join('\n').toLowerCase()` followed by `INTERNAL_AGENT_SIGNATURES.some((sig) => existingSystem.includes(sig.toLowerCase()))`. Inline inside the `experimental.chat.system.transform` hook. When true, the hook `return`s early, skipping bootstrap injection.
- `src/lib/validation.ts` — 9 exports: `isRecord` (line 19), `isPermissionSetting` (23), `isToolsMap` (29), `isAgentMode` (34), `normalizePermission` (84), `extractString` (129, has `fallback = ''` default parameter), `extractNonEmptyString` (138), `extractNumber` (148), `extractBoolean` (156, **no fallback parameter**, returns `boolean | undefined`, coerces strings `'true'`/`'false'` case-insensitively). All need happy-path + malformed-shape coverage.
- `src/lib/bootstrap.ts:32-69` — `getBootstrapContent(config, deps)` pure function; returns `string | null`. Five config branches to cover (enabled default, enabled custom-file-exists, enabled custom-file-missing, disabled, missing using-systematic skill).
- `src/lib/bootstrap.ts:11-30` — `getToolMappingTemplate` returns a markdown template string containing CC tool names in prose (e.g., `` `TodoWrite` → `todowrite` ``). Unit 3's consistency test (R11) extracts tool names from this template via regex and cross-references against `TOOL_NAME_MAP`.
- `src/lib/converter.ts:83-96` — `TOOL_NAME_MAP` is a private `const Record<string, string>` mapping CC tool names to their OpenCode equivalents. Must stay synchronized with `TOOL_MAPPINGS` (line 40) per the inline comment at lines 81-82. Unit 3 makes `TOOL_NAME_MAP` `export const` so the consistency test can import it.
- `biome.json` — formatter/linter applies to new `.ts` files. `.drift-allowlist.json` is not linted.

### Institutional Learnings

- `docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md` — defines the phantom-ref grep pattern (lines 77-93) and the two-assertion CI gate spec (lines 97-101) this plan implements. **Direct foundation** for Unit 1's phantom-ref check.
- `docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md` — same CI gate spec from the banned-pattern angle. Verification-iteration independence recommendation (lines 117-122): the gate must not use the same iteration pattern as any batch conversion script that might introduce drift. `find | while read` or `find -exec` is the canonical correct pattern, which we follow by using `walkDir` + array iteration instead of shell loops.
- `docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md` — the converter's code-block-skipping is intentional for prose conversion; the gate must scan **inside** code blocks because CC tool names in code examples are exactly the drift we want to catch. (This differs from the converter's semantics by design.)
- `docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md` — notes the `TOOL_NAME_MAP` (`converter.ts`) ↔ `TOOL_MAPPINGS` (`bootstrap.ts` template) coupling. Unit 3 includes a consistency check between these two mappings as a small bonus test.
- `docs/solutions/workflow-patterns/truth-reset-scope-split-20260417.md` — context for why Initiative #3 is narrow: convergent document-review findings on the original bundled plan led to the three-initiative split. Not actionable for implementation; noted for posterity.

### External References

None. This is internal infrastructure; no external docs/APIs/libraries beyond the existing Bun + TypeScript stack.

## Key Technical Decisions

- **Hand-rolled glob matching, no new dependency.** Proposed pathGlobs in R4 are all prefix-match with `/**` suffix or exact path. Matching rule: `glob.endsWith('/**')` → `filePath.startsWith(glob.slice(0, -3))`; else exact match. Zero added runtime dep, trivial code, trivial test. Reconsider when patterns get more complex.
- **Export `INTERNAL_AGENT_SIGNATURES` from `src/index.ts` and `TOOL_NAME_MAP` from `src/lib/converter.ts`.** Two one-line changes — `const` → `export const` — make both constants reachable from bootstrap.test.ts without duplicating data. Neither change has runtime behavior impact (both constants were previously private). The skip predicate itself stays inline in the transform hook (no behavior refactor); Unit 3's test reconstructs it locally using the exported data.
- **Pure function + direct import for primary tests; `Bun.spawnSync` for CLI smoke only.** `checkContentIntegrity(rootDir)` is a pure function exported from `scripts/content-integrity.ts`; most tests import it and call it directly (faster, simpler, easier to assert on structured return values). One smoke test uses `Bun.spawnSync` (matching `build-registry.test.ts`) to verify the script's CLI entry point exits 0 on a clean repo. The script's `main()` wraps `checkContentIntegrity` and exits 0/1 based on the result.
- **Runtime category discovery.** The gate reads `agents/` subdirectories at runtime (`fs.readdirSync('agents/')` filtered to `isDirectory()`) rather than hardcoding a regex alternation. Adding a new category auto-extends coverage.
- **Reference-integrity check scans `*.md` only; banned-pattern check scans `*.md` + `*.ts`.** Reference resolution is a markdown-content concern (skills/agents reference each other in prose). Banned patterns can appear in code constants too (e.g., `converter.ts` holds them as documented rules — allowlisted). This asymmetric scope is cheaper than unifying behavior and matches the semantic difference.
- **Missing `.drift-allowlist.json` file is treated as an empty allowlist.** The gate still runs against an empty-exemption set. This makes the gate work in fresh clones before anyone has added exemptions and keeps the "gate must not silently degrade" contract: an absent file doesn't mean "skip the gate," it means "no exemptions apply." Malformed JSON or unknown banned patterns still throw per R5.
- **CORRECTNESS / FRAGILITY tags on regression tests.** Every regression test in R8 and R10 carries an inline comment declaring whether it documents intended behavior (CORRECTNESS) or known-suboptimal behavior (FRAGILITY with link to memory/doc). Makes future refactors explicit rather than inheriting ambiguity from the current author.
- **Coverage reported in PR description, not CI-gated.** `bun test --coverage` output for `src/lib/validation.ts` and `src/lib/bootstrap.ts` is included in the PR body as an informational signal. No hard-fail on percentage. The regression tests are the real contract.

## Open Questions

### Resolved During Planning

- **Q: Glob library or hand-roll?** Hand-roll. Patterns are simple; new deps need justification.
- **Q: How to test the inline skip heuristic?** Export `INTERNAL_AGENT_SIGNATURES` from `src/index.ts` (one-line change), reconstruct the predicate in the test using the exported data. No behavior refactor.
- **Q: CLI entry point or library-only?** Both. Script exports `checkContentIntegrity` (library) AND has a `main()` wrapper invokable via `bun scripts/content-integrity.ts` (CLI). Matches `build-registry.ts` pattern.
- **Q: How to assert the TOOL_NAME_MAP ↔ TOOL_MAPPINGS consistency given neither is currently exported?** Export `TOOL_NAME_MAP` from `converter.ts` (one-line change). `TOOL_MAPPINGS` is context-dependent regex and cannot be simply exported as structured data (per the comment at `converter.ts:81-82`); instead, the test extracts CC tool names from `getToolMappingTemplate`'s template string via regex (matching markdown list items like `` `TodoWrite` → `todowrite` ``) and asserts each extracted name is a key in the exported `TOOL_NAME_MAP`. The assertion is ~10 lines.
- **Q: Missing `.drift-allowlist.json` file behavior?** Treated as an empty allowlist. The gate still runs; no exemptions apply. Malformed JSON or schema-invalid entries still throw per R5.

### Deferred to Implementation

- **Exact structure of `CheckResult`.** The requirements doc sketches `{ phantomRefs, bannedPatterns, exemptHits }`; implementation may refine (e.g., separate `errors` / `warnings` arrays for R5's typed-schema failures vs pathGlob warnings). Decided when writing the code.
- **Exact error message format when the gate fails in the test.** Must include file, line, and pattern/reference per R3; exact string format is an implementation detail.
- **Where to surface the two warnings (stale pathGlob, broad `**` pathGlob).** Options: stdout as part of the gate's normal output, or dedicated `console.warn` with a tag. Chosen during implementation after seeing how `bun test` displays warnings.

## High-Level Technical Design

> *This illustrates the intended module layout and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
scripts/
├── content-integrity.ts              # NEW — checkContentIntegrity + CLI main()
└── .drift-allowlist.json             # NEW — 3 allowlist entries per R4

tests/unit/
├── content-integrity.test.ts         # NEW — gate tests + fixtures (R3)
├── validation.test.ts                # NEW — validation.ts coverage (R7, R8)
└── bootstrap.test.ts                 # NEW — bootstrap.ts + skip heuristic (R9, R10)

src/index.ts                          # MODIFY — one-line change: export INTERNAL_AGENT_SIGNATURES
```

**Module boundaries** for `scripts/content-integrity.ts`:

```
checkContentIntegrity(rootDir: string): CheckResult
    ├── loadAllowlist(rootDir)      // parse + validate .drift-allowlist.json, emit warnings
    ├── discoverCategories(rootDir) // read agents/ subdirs at runtime
    ├── collectScanFiles(rootDir)   // walkDir for *.md under skills/, agents/; *.ts under src/
    ├── checkReferenceIntegrity(files, categories)  // *.md only
    └── checkBannedPatterns(files, bannedPatterns, allowlist)  // *.md + *.ts
```

**Dependency graph** for implementation units:

```
Unit 1 (content-integrity gate) ─── Independent, can land first
Unit 2 (validation.test.ts)     ─── Independent, can land any time
Unit 3 (bootstrap.test.ts)      ─── Independent, can land any time (requires 1-line edit to src/index.ts)
```

All three units commute — any order. Recommended order in one PR: 1 → 2 → 3 for reviewer narrative flow, but no technical dependency.

## Implementation Units

- [ ] **Unit 1: Content-integrity gate (script + allowlist + test)**

**Goal:** Ship the content-integrity check as a pure exported function with a CLI wrapper, the allowlist config, and its unit test. After this unit, `bun test tests/unit` hard-fails on any phantom `systematic:*` reference or banned CC/CEP pattern appearing outside the documented allowlist.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** None

**Files:**
- Create: `scripts/content-integrity.ts`
- Create: `scripts/.drift-allowlist.json`
- Create: `tests/unit/content-integrity.test.ts`

**Approach:**
- Model script structure on `scripts/build-registry.ts`: shebang, `node:` imports, pure functions, `main()` at bottom.
- Use `src/lib/walk-dir.ts`'s `walkDir` as the file-discovery foundation. Call it twice: once for `*.md` files under `skills/` + `agents/`, once for `*.ts` files under `src/`.
- `discoverCategories(rootDir)` reads `agents/` subdirectories at runtime. Any subdirectory whose name is not `.DS_Store`-ish counts.
- `loadAllowlist(rootDir)` parses `scripts/.drift-allowlist.json`. Schema validation: for each entry, `pathGlob` non-empty string, `patterns` non-empty array whose entries all appear in the hardcoded `BANNED_PATTERNS` constant, `reason` length ≥ 20 chars. Malformed entries → throw with the invalid entry named. Unknown pathGlob extensions (e.g., `?` or `[abc]` glob chars) are rejected — we only support prefix-`/**` or exact match.
- Two warnings (non-fatal): (a) pathGlob matches zero files in the scan set, (b) pathGlob contains `**` without a specific subdirectory prefix (regex check: `/\*\*/` with no non-`**` path segment before it). Warnings print to stderr with a clear prefix like `drift-allowlist warning:` so the test can assert on them.
- `checkReferenceIntegrity(files, categories)` iterates scanned markdown files, extracts all `systematic:<category>:<name>` via a regex where `<category>` is built from the `categories` array at runtime, checks each against `agents/<category>/<name>.md` existence.
- `checkBannedPatterns(files, bannedPatterns, allowlist)` iterates scanned files, for each line checks every banned-pattern substring. Non-allowlisted hits go to `bannedPatterns[]`; allowlisted hits go to `exemptHits[]` (so tests can verify allowlist coverage).
- `main()` runs `checkContentIntegrity` against `process.cwd()`, prints human-readable output, exits 0 on clean / 1 on failure.
- Test uses temp-dir fixture pattern (`fs.mkdtempSync(...)`). Test fixtures include: (a) a clean repo snapshot that should produce zero violations, (b) a phantom-ref fixture that adds `systematic:research:ghost-agent` to a skill and verifies the check reports it with file+line, (c) a banned-pattern fixture that adds `TaskCreate` to a skill outside allowlist and verifies the check reports it, (d) a malformed allowlist fixture to verify schema validation errors, (e) a broad-pathGlob fixture (`skills/**`) to verify the warning, (f) a zero-match pathGlob fixture (`skills/nonexistent/**`) to verify the warning.
- Run the gate against the real repo root as one of the test cases (integration smoke): assert zero phantom refs, zero non-exempt banned patterns. This is the "catches both v2.4.0 bugs if reintroduced" contract.

**Patterns to follow:**
- `scripts/build-registry.ts` — script conventions
- `src/lib/walk-dir.ts:17-51` — `walkDir` API
- `tests/unit/skills.test.ts:13-18` — temp-dir fixture
- `tests/unit/build-registry.test.ts` — script-invoked-from-test pattern (used here for the CLI `main()` smoke test)

**Test scenarios:**
- Happy path: `checkContentIntegrity(repoRoot)` on v2.4.1 main returns `{ phantomRefs: [], bannedPatterns: [], exemptHits: [<~39 hits across allowlisted files>] }`.
- Happy path (CLI): `bun scripts/content-integrity.ts` on v2.4.1 main exits 0.
- Happy path: valid allowlist entry with patterns matching R2's banned-pattern list validates successfully.
- Happy path: reference `systematic:research:learnings-researcher` in any scanned file resolves to `agents/research/learnings-researcher.md` and does not appear in `phantomRefs`.
- Edge case: skill file with zero `systematic:*` references contributes nothing to any output array.
- Edge case: a new category (e.g., creating `agents/new-category/foo.md` in a fixture) is auto-discovered and `systematic:new-category:foo` resolves.
- Error path: phantom reference `systematic:research:nonexistent-agent` in a fixture skill is reported with `{ file, line, reference }`.
- Error path: banned pattern `TaskCreate` in a fixture skill (outside allowlist) is reported with `{ file, line, pattern }`.
- Error path: malformed `.drift-allowlist.json` (not valid JSON) throws with clear error.
- Error path: allowlist entry with empty `pathGlob` throws.
- Error path: allowlist entry with `patterns: ["Unknown Pattern"]` (not in R2 list) throws.
- Error path: allowlist entry with `reason` length < 20 chars throws.
- Error path: allowlist entry with unsupported glob chars (e.g., `skills/[abc]/**`) throws.
- Warning path: pathGlob `skills/nonexistent-dir/**` matches zero files and emits a warning on stderr.
- Warning path: pathGlob `skills/**` (broad `**` without subdirectory prefix) emits a warning on stderr.
- Integration: allowlisted banned pattern (`Claude Code` inside `skills/claude-permissions-optimizer/SKILL.md`) appears in `exemptHits` but not `bannedPatterns`.

**Verification:**
- `bun test tests/unit/content-integrity.test.ts` passes all scenarios.
- Whole-repo assertion: `checkContentIntegrity(process.cwd())` returns zero `phantomRefs` and zero `bannedPatterns` on v2.4.1 main before any Unit 2 / 3 changes.
- Introducing `systematic:research:test-phantom` anywhere in `skills/**/*.md` causes the test to fail with a clear error message.
- Introducing `TaskCreate` in any non-allowlisted file causes the test to fail.
- `bun run build && bun run typecheck && bun run lint` all pass for the new files.

---

- [ ] **Unit 2: validation.ts test coverage**

**Goal:** Every exported function in `src/lib/validation.ts` has direct unit coverage, and at least one regression test documents the "silent null on malformed frontmatter" chain with an explicit CORRECTNESS or FRAGILITY tag.

**Requirements:** R7, R8

**Dependencies:** None (independent of Units 1 and 3)

**Files:**
- Create: `tests/unit/validation.test.ts`
- Read-only reference: `src/lib/validation.ts` (the subject)

**Approach:**
- Follow the existing `tests/unit/*.test.ts` import convention: `import { afterEach, beforeEach, describe, expect, test } from 'bun:test'`.
- Import every exported function from `../../src/lib/validation.ts` directly. No mocking.
- One `describe` block per exported function. Each function's block contains happy-path assertions (every documented shape) and malformed-shape assertions (wrong types, nulls, unknown keys).
- `isRecord`, `isPermissionSetting`, `isToolsMap`, `isAgentMode`: type-guard predicates — true for every valid form, false for representative invalid forms (null, undefined, number, string when object expected, array when object expected, malformed object).
- `normalizePermission` needs the most cases: every `AgentMode` string literal, every `PermissionSetting` object shape, bash-map variants, array forms. Read `validation.ts` first to enumerate; don't invent contracts.
- `extractString` accepts a `fallback = ''` default parameter — tests cover happy paths, null/undefined/wrong-type returning the supplied fallback, and default fallback when omitted.
- `extractNonEmptyString`: returns the trimmed value for non-empty strings, `undefined` for empty/whitespace-only/non-string input.
- `extractNumber`: returns the number value for numeric input, `undefined` for non-numeric input (may also coerce numeric strings — verify from source before asserting).
- `extractBoolean` has **no fallback parameter** and returns `boolean | undefined`. Tests cover: `true`/`false` happy path, string coercion (`'true'` / `'false'` / `'TRUE'` / `'  true  '` return the coerced boolean), non-boolean non-string input returns `undefined`, missing key returns `undefined`.
- Regression test for the "silent null on malformed frontmatter" chain: construct an agent config-like object that would reach `validation.ts` via `loadAgentAsConfig` (see `src/lib/agents.ts`) with an invalid `permissions` shape. Call the validator directly on the malformed object and assert the return value matches the **current** behavior (either `undefined` or a default). Add the inline comment:

  ```ts
  // FRAGILITY: validation.ts silently returns null/undefined on malformed input.
  // loadAgentAsConfig then swallows the null at the caller. Broken bundled assets
  // disappear with no CI signal. See docs/brainstorms/2026-04-18-infra-improvements-requirements.md
  // (trade-off: "bundled asset error surfacing" is I3.e, deferred). If a future
  // initiative adds build-time error surfacing, this test's assertion must change.
  ```

  The tag is `FRAGILITY` because the current behavior is documented as suboptimal in the requirements doc's trade-offs section.

**Patterns to follow:**
- `tests/unit/frontmatter.test.ts` — clean function-by-function coverage style
- `tests/unit/config.test.ts:30-36` — temp-dir fixture (may not be needed here if all inputs are constructed in-memory)
- `tests/unit/config-handler.test.ts` — integration-style coverage of a 648-line module (for structural inspiration)

**Test scenarios:**

*Type-guard predicates (R7):*
- Happy path: `isRecord({})`, `isRecord({ a: 1 })` return `true`; `isRecord(null)`, `isRecord([])`, `isRecord('string')`, `isRecord(42)` all return `false`.
- Happy path: `isPermissionSetting({ ask: 'allow', edit: 'ask' })` returns `true` for valid permission shape; verify exact required fields from source before asserting.
- Error path: `isPermissionSetting({})`, `isPermissionSetting(null)`, `isPermissionSetting([])` return `false`.
- Happy path: `isToolsMap({ bash: true, edit: false })` returns `true`; `isToolsMap({ bash: 'not-boolean' })` returns `false`.
- Happy path: every `AgentMode` literal string value passes `isAgentMode` (read source for the full list).
- Error path: `isAgentMode(null)`, `isAgentMode(undefined)`, `isAgentMode(123)`, `isAgentMode('not-a-mode')` all return `false`.

*`normalizePermission` (R7):*
- Happy path: `normalizePermission('ask')` returns the equivalent `PermissionSetting` object form (verify from source).
- Happy path: `normalizePermission({ bash: { 'ls *': 'allow' } })` returns a well-formed structure.
- Edge case: `normalizePermission(null)`, `normalizePermission(undefined)` return the current fallback (determine from source; likely `undefined`).
- Edge case: `normalizePermission({ bash: 'not-a-map' })` returns the current fallback.
- Edge case: `normalizePermission(['allow'])` — array form — returns whatever the current contract says.

*`extractString` (R7, has `fallback = ''`):*
- Happy path: `extractString({ foo: 'bar' }, 'foo', 'fallback')` returns `'bar'`.
- Happy path: `extractString({ foo: 'bar' }, 'foo')` returns `'bar'` (default fallback not used).
- Edge case: `extractString({}, 'missing', 'fb')` returns `'fb'`.
- Edge case: `extractString({}, 'missing')` returns `''` (default fallback).
- Edge case: `extractString({ foo: 42 }, 'foo', 'fb')` returns `'fb'` (wrong type).

*`extractNonEmptyString` (R7):*
- Happy path: `extractNonEmptyString({ foo: 'bar' }, 'foo')` returns `'bar'` (verify trimming behavior from source).
- Edge case: `extractNonEmptyString({ foo: '' }, 'foo')` returns `undefined`.
- Edge case: `extractNonEmptyString({ foo: '   ' }, 'foo')` returns `undefined` (whitespace-only).
- Edge case: `extractNonEmptyString({ foo: 42 }, 'foo')` returns `undefined` (wrong type).
- Edge case: `extractNonEmptyString({}, 'missing')` returns `undefined`.

*`extractNumber` (R7):*
- Happy path: `extractNumber({ n: 42 }, 'n')` returns `42`.
- Happy path: `extractNumber({ n: 0 }, 'n')` returns `0`.
- Edge case: `extractNumber({ n: 'not-a-number' }, 'n')` returns `undefined` (or coerced value — verify from source).
- Edge case: `extractNumber({}, 'missing')` returns `undefined`.

*`extractBoolean` (R7, no fallback, returns `boolean | undefined`):*
- Happy path: `extractBoolean({ flag: true }, 'flag')` returns `true`.
- Happy path: `extractBoolean({ flag: false }, 'flag')` returns `false`.
- Happy path (string coercion): `extractBoolean({ flag: 'true' }, 'flag')` returns `true`.
- Happy path (string coercion): `extractBoolean({ flag: 'false' }, 'flag')` returns `false`.
- Happy path (case + whitespace): `extractBoolean({ flag: '  TRUE  ' }, 'flag')` returns `true`.
- Edge case: `extractBoolean({ flag: 'yes' }, 'flag')` returns `undefined` (not a recognized string).
- Edge case: `extractBoolean({ flag: 1 }, 'flag')` returns `undefined` (number not coerced).
- Edge case: `extractBoolean({}, 'missing')` returns `undefined`.

*Regression (R8):*
- Regression: construct a malformed agent-config object that would reach `validation.ts` via the `loadAgentAsConfig` chain (e.g., `permissions: { bash: 'not-a-map' }` on a full agent config). Call the relevant validator directly and assert the return value matches the current contract. Include the inline `// FRAGILITY: ...` comment tying to the origin doc and noting that `loadAgentAsConfig` swallows the resulting fallback into a silent `null` return, which is I3.e scope to fix.

**Verification:**
- `bun test tests/unit/validation.test.ts` passes all scenarios.
- `bun test --coverage` reports per-file coverage for `src/lib/validation.ts`; figure is recorded in the PR description. No hard threshold.
- Regression test carries the `// FRAGILITY: ...` comment exactly as specified.
- `bun run lint` clean on the new file.

---

- [ ] **Unit 3: bootstrap.ts test coverage (plus INTERNAL_AGENT_SIGNATURES export)**

**Goal:** `getBootstrapContent` has coverage for all five config branches, the `INTERNAL_AGENT_SIGNATURES` skip heuristic is testable via a one-line export of the signatures array, at least one regression test documents the substring-match behavior with an explicit CORRECTNESS or FRAGILITY tag, and a small bonus test verifies the `TOOL_NAME_MAP` ↔ `TOOL_MAPPINGS` consistency.

**Requirements:** R9, R10

**Dependencies:** None (independent of Units 1 and 2); requires a one-line edit to `src/index.ts` captured in this unit's file list.

**Files:**
- Create: `tests/unit/bootstrap.test.ts`
- Modify: `src/index.ts` (one line: `const INTERNAL_AGENT_SIGNATURES = [...]` → `export const INTERNAL_AGENT_SIGNATURES = [...]`)
- Modify: `src/lib/converter.ts` (one line: `const TOOL_NAME_MAP: Record<string, string> = { ... }` → `export const TOOL_NAME_MAP: Record<string, string> = { ... }`)
- Read-only reference: `src/lib/bootstrap.ts`

**Approach:**
- Export `INTERNAL_AGENT_SIGNATURES` from `src/index.ts` (one-line change) so bootstrap.test.ts can import the canonical signatures array and reconstruct the skip predicate locally without duplicating the data. Similarly export `TOOL_NAME_MAP` from `src/lib/converter.ts` (one-line change) for the consistency test in R11. Both are strictly additive — no runtime behavior change.
- Import `getBootstrapContent` from `../../src/lib/bootstrap.ts`, `INTERNAL_AGENT_SIGNATURES` from `../../src/index.ts`, and `TOOL_NAME_MAP` from `../../src/lib/converter.ts`. Define a test-local `shouldSkipBootstrap(system: string[])` helper that mirrors the production predicate: `INTERNAL_AGENT_SIGNATURES.some(sig => system.join('\n').toLowerCase().includes(sig.toLowerCase()))`.
- Use temp-dir fixtures to construct `bundledSkillsDir` for `getBootstrapContent` test cases. Seed the temp dir with a minimal `using-systematic/SKILL.md` for the happy path; omit it for the missing-skill path.
- For the `config.bootstrap.file` custom-override path, create a temp file with known contents and assert `getBootstrapContent` returns it verbatim. For the custom-file-missing case, point at a nonexistent path and assert the fallback behavior (current contract: falls through to the bundled skill path per `bootstrap.ts:40-47`).
- For the skip heuristic, construct representative `output.system` arrays (arrays of strings, joined with `\n` inside the predicate): one with content containing a signature substring, one with unrelated content. Assert the local `shouldSkipBootstrap` helper matches production behavior. Add a regression test for the substring-match edge case: a legitimate prompt about "title generation" that happens to contain a signature substring triggers the skip. Tag the comment as `FRAGILITY` because the substring match is explicitly documented as fragile in the origin doc's trade-offs.
- R11 consistency test: extract CC tool names from `getToolMappingTemplate`'s template string using a regex that matches markdown-list backtick patterns like `` `ToolName` → ``. The template is a hardcoded string constant in `bootstrap.ts:11-30`; import the function and call it with a synthetic `bundledSkillsDir` to get the rendered template, then regex-extract. Assert every extracted CC tool name is a key (case-insensitive, as `TOOL_NAME_MAP` stores lowercase keys per `converter.ts:187`) in `TOOL_NAME_MAP`.

**Patterns to follow:**
- `tests/unit/plugin.test.ts` — plugin-loading test pattern (for reference; this new file tests bootstrap-specific behavior directly, not plugin loading)
- `tests/unit/skills.test.ts:13-18` — temp-dir fixture
- `tests/unit/config.test.ts:30-36` — config fixture pattern

**Test scenarios:**
- Happy path: `getBootstrapContent({ bootstrap: { enabled: true, file: null } }, { bundledSkillsDir })` with a seeded `using-systematic/SKILL.md` returns a string containing `<SYSTEMATIC_WORKFLOWS>` and the tool-mapping template.
- Happy path: `getBootstrapContent({ bootstrap: { enabled: false, file: null } }, deps)` returns `null`.
- Happy path: `getBootstrapContent({ bootstrap: { enabled: true, file: '/tmp/custom.md' } }, deps)` with a seeded custom file returns the custom file's contents verbatim.
- Happy path: `getBootstrapContent({ bootstrap: { enabled: true, file: '~/custom.md' } }, deps)` expands `~/` to `os.homedir()`.
- Edge case: custom `config.bootstrap.file` pointing to a nonexistent path falls back to the bundled skill (verify current contract from source).
- Edge case: `using-systematic/SKILL.md` missing from `bundledSkillsDir` returns `null` (current contract).
- Happy path (skip heuristic): `shouldSkipBootstrap(['You are a title generator ...'])` returns `true`.
- Happy path (skip heuristic): `shouldSkipBootstrap(['You are a helpful AI assistant tasked with summarizing conversations ...'])` returns `true`.
- Happy path (skip heuristic): `shouldSkipBootstrap(['Summarize what was done in this conversation ...'])` returns `true`.
- Happy path (skip heuristic): `shouldSkipBootstrap(['You are helping the user build a feature.'])` returns `false` (no signature substring).
- Regression (FRAGILITY-tagged): `shouldSkipBootstrap(['You are documenting the title generator agent for future work.'])` — legitimate prompt containing "title generator" as prose — returns `true`. Tag documents this as known-fragile; a frontmatter-based opt-out would fix it. Comment references `docs/brainstorms/2026-04-18-infra-improvements-requirements.md` trade-offs section.
- Consistency check (R11): every CC tool name extracted from `getToolMappingTemplate` via regex is a case-insensitive key in `TOOL_NAME_MAP`. Construct the reverse assertion too: any key in `TOOL_NAME_MAP` that appears in the template prose must map consistently. Exact extraction regex and assertion resolved at implementation time.

**Verification:**
- `bun test tests/unit/bootstrap.test.ts` passes all scenarios.
- `bun test --coverage` reports per-file coverage for `src/lib/bootstrap.ts`; figure recorded in PR description.
- Regression test carries the `// FRAGILITY: ...` comment exactly as specified.
- The one-line `export` change to `src/index.ts` does not break any existing plugin behavior: `bun test tests/unit/plugin.test.ts` still passes, Node.js smoke test (`node --input-type=module -e "import('./dist/index.js')"`) still exits 0.
- `bun run build && bun run typecheck && bun run lint` all pass.

## System-Wide Impact

- **Interaction graph:** `scripts/content-integrity.ts` has no runtime consumers in the plugin itself; it runs only at test time and via CLI. The two one-line `export` additions (`INTERNAL_AGENT_SIGNATURES` in `src/index.ts` and `TOOL_NAME_MAP` in `src/lib/converter.ts`) have no caller impact — both constants were previously private, so adding export is strictly additive.
- **Error propagation:** The gate's test file hard-fails on any phantom-ref or non-allowlisted banned-pattern hit. Schema-invalid allowlist entries throw with the invalid entry named. Warnings (stale pathGlob, broad `**`) surface in test stderr but do not fail.
- **State lifecycle risks:** None. Gate is pure (reads files, computes result, returns). No state persistence, no cleanup concerns.
- **API surface parity:** No public API changes. The two `export const` additions (`INTERNAL_AGENT_SIGNATURES`, `TOOL_NAME_MAP`) are reachable from `@fro.bot/systematic` but are not advertised or documented externally; no consumer should depend on them.
- **Integration coverage:** Unit 1's test includes a real-repo integration smoke — `checkContentIntegrity(process.cwd())` against the actual working tree — so the gate's behavior on the shipped catalog is verified end-to-end, not just against synthetic fixtures.
- **Unchanged invariants:** The three plugin hooks (`config`, `tool`, `system.transform`) retain identical signatures and behavior. The `SystematicPlugin` factory function's return shape is unchanged. `skills/`, `agents/`, and `.opencode/` directory layouts are unchanged. All existing tests continue to pass.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Hand-rolled glob matching misses an edge case in allowlist pathGlobs | R5's allowlist schema validation rejects unsupported glob chars up front (`?`, `[`, `]`, non-`**` wildcards). Only `<path>/**` and exact match are accepted. Matching rule is ~5 lines, covered by explicit unit tests in Unit 1. |
| Runtime category discovery breaks if someone flattens `agents/` or introduces a non-category subdirectory (e.g., `.tmp/`) | Category discovery filters to `isDirectory()` and skips names starting with `.`. Noted as an acknowledged trade-off in the origin document; regression test covers the happy path explicitly. |
| Exporting `INTERNAL_AGENT_SIGNATURES` from `src/index.ts` and `TOOL_NAME_MAP` from `src/lib/converter.ts` alters the published plugin's shape | Both changes are strictly additive (previously private → now exported const). No external consumers; not part of the documented public API. Smoke test verifies plugin loads cleanly in Node.js. |
| Regression tests lock in a bug instead of a feature | CORRECTNESS / FRAGILITY tags on each regression test make the contract explicit. Future refactors that improve FRAGILITY-tagged behavior must update the test intentionally. |
| `bun test --coverage` output format is hard to parse into a PR description | Coverage is informational, not CI-gated. Copying the table from `bun test --coverage` output into the PR description is manual; tolerable for a single-maintainer repo. |
| `TOOL_NAME_MAP` ↔ `TOOL_MAPPINGS` consistency test is brittle if either side is refactored | The consistency check uses a semantic assertion ("every name in one appears in the other"), not a hash match. If the refactor is intentional, the test needs updating — same contract as other regression tests. |
| Allowlist entry for `orchestrating-swarms` persists after Initiative #2 rewrites/deletes the skill | R5's zero-match pathGlob warning surfaces a stale allowlist entry as soon as the pathGlob stops matching any files. Cleanup is one commit in Initiative #2. |

## Documentation / Operational Notes

- **README / AGENTS.md:** No changes required. The drift gate is internal infrastructure and does not affect user-visible behavior.
- **CONTRIBUTING-style guidance:** After this PR lands, add a short note to the repo (either in the repo root `CONTRIBUTING.md` if one exists, or in `AGENTS.md`) explaining the `.drift-allowlist.json` process: when to add an entry, what `reason` content is expected (minimum 20 chars, ideally cite a memory or doc), and what the two warnings mean. This is not a blocker for the PR; a follow-up commit can add it.
- **PR description:** Must include `bun test --coverage` output for `src/lib/validation.ts` and `src/lib/bootstrap.ts` per success criteria; no hard threshold.
- **Release notes (2.5.0):** "Add content-integrity gate for reference-resolution and banned-pattern drift detection; close test-coverage gaps in `validation.ts` and `bootstrap.ts`." No user-facing impact, no migration needed.
- **Monitoring:** No operational change. No new telemetry, no new runtime paths.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-18-infra-improvements-requirements.md](../brainstorms/2026-04-18-infra-improvements-requirements.md)
- **Institutional learnings cited:**
  - [docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md](../solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md)
  - [docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md](../solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md)
  - [docs/solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md](../solutions/integration-issues/converter-code-block-tool-name-capitalization-20260210.md)
  - [docs/solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md](../solutions/best-practices/destructive-to-nondestructive-converter-Systematic-20260209.md)
- **Prior initiative plan (context):** [docs/plans/2026-04-17-002-refactor-truth-reset-plan.md](./2026-04-17-002-refactor-truth-reset-plan.md) — completed as v2.4.0
- **Related PRs:** #290 (v2.4.0 truth reset), #291 (plan completion metadata), #294 (Anthropic model alias fix, v2.4.1)
- **External docs:** None
