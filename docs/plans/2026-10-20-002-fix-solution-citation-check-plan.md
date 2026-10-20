---
title: "fix: Verify path:line citations in docs/solutions"
type: fix
status: active
date: 2026-10-20
---

# fix: Verify path:line citations in docs/solutions

## Overview

`docs/solutions/` cites source as `path:line` and `path:start-end`, and nothing checks that a citation still points at what its sentence describes. This plan adds a content-integrity check that fails when a cited file is missing, a range is out of bounds, a span holds nothing but blank or comment lines, or a named identifier is absent from the span. It also fixes every citation that breaks today, so the gate lands as an error and the tree stays green.

## Problem Frame

Issue #1014. At `dc79ac8b`, `docs/solutions/` holds 83 citations in 22 of 113 docs. A throwaway scan with the rules below found 42 failures:
- 22 are real drift: deleted files, out-of-range lines, spans that slid onto comments, and moved symbols.
- 20 come from rules this plan resolves: 15 bare basenames, 4 non-repo paths and 1 deliberate comment citation.

`scripts/content-integrity.ts` validates solution frontmatter but never reads citations. It has no warning channel, so a check either fails the gate or does nothing.

## Requirements Trace

- R1. Every bare `path:line[-end][,line]` citation in `docs/solutions/**` resolves to a repo-relative file that exists and is not under `dist/`, `node_modules/`, `.slim/`, `.context/` or `.worktrees/`.
- R2. Every cited line or range is inside the file.
- R3. A cited span is not made up only of blank or comment lines, unless the citing sentence contains the word "comment".
- R4. When the citing sentence backticks a compound identifier that occurs in the cited file, at least one such identifier appears inside the span. When it doesn't, the violation suggests the line of its definition, if one exists.
- R5. A backticked `:N` with no path is an error.
- R6. Violations fail `bun scripts/content-integrity.ts`, report the doc's own file line, and name the citation and the failure class.
- R7. The tree is clean when this lands: every current failure is fixed, not exempted.
- R8. Doc-writing guidance states the citation convention.

## Scope Boundaries

- Only `docs/solutions/**`. Excluded: `docs/plans/**` (point-in-time records), `skills/**` (one fictional worked example; sub-file links are already checked), `ARCHITECTURE.md`, `STRUCTURE.md` and `AGENTS.md` (no line citations).
- Superseded docs are checked like any other doc. None carries a citation today.
- URLs are not checked. Citations to code outside the repo, or to deleted code, become pinned links with a tag or commit in the URL.
- Prose citations ("lines 30–31") and citations with no compound identifier get no symbol check. This is a stated lexical limit.
- Comment detection is a per-extension line-prefix rule, not a lexer. A template literal line starting with `//` reads as a comment.

## Context & Research

### Relevant Code and Patterns

- `scripts/content-integrity.ts`:
  - `checkContentIntegrity` builds the `CheckResult`.
  - `totalViolations` sets the exit code. A check missing from it exits 0.
  - `printResult` calls one print helper per check.
  - `collectScanTargets` already lists `docs/solutions` markdown recursively.
  - `checkSolutionSchema` loops over that list, and `checkSubfileReferences` is the per-line resolution pattern.
  - `StaleSkillLoadNameViolation` is the existing violation that carries a line and a suggestion.
- `tests/unit/content-integrity.test.ts`:
  - fixture helpers `makeFixtureRepo` and `writeFile`;
  - the `checkStaleSkillLoadNames` describe (table tests);
  - the `checkSolutionSchema` describe;
  - the real-repo describe using `assertNoViolations`;
  - a `Bun.spawnSync` exit-code test.
- CI runs the gate and `bun run typecheck:scripts` in `.github/workflows/main.yaml`.

### Institutional Learnings

- `content-integrity-has-no-warning-channel-2026-06-06.md`: the check must be wired through totals, output and the gate, and tested against the real tree.
- `an-allowlist-is-a-claim-the-content-is-correct-2026-08-17.md` and `exemption-predicates-must-name-the-uncheckable-condition-2026-08-18.md`: fix broken citations rather than exempting them, and test each exemption boundary.
- `measure-a-source-scanner-blind-spots-2026-09-07.md`: prove the check by injecting failures, and prefer structural bounds over heuristics.
- `neutral-v1-marker-migrated-set-identifier-gate-2026-07-17.md`: report real file lines, frontmatter included.
- `typecheck-does-not-cover-ci-gate-scripts-2026-08-17.md`: run `typecheck:scripts`.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "build-new-within-scope",
  "scope": "scripts/content-integrity.ts and docs/solutions/**",
  "freshness": { "vcs_reference": "dc79ac8b" },
  "budget": { "max_search_passes": 6, "max_candidate_inspections": 12, "exhausted": false },
  "candidates": [
    {
      "path_or_symbol": "scripts/content-integrity.ts:checkSubfileReferences",
      "description": "Resolves relative sub-file paths in skills/*/SKILL.md by existence only.",
      "disposition": "insufficient",
      "insufficiency_reason": "No line, range or symbol check, and its scope is skills only."
    },
    {
      "path_or_symbol": "scripts/content-integrity.ts:checkSolutionSchema",
      "description": "Validates docs/solutions frontmatter against the compound schema.",
      "disposition": "insufficient",
      "insufficiency_reason": "Never reads the document body, so it sees no citations."
    },
    {
      "path_or_symbol": "scripts/content-integrity.ts:collectScanTargets",
      "description": "Enumerates docs/solutions markdown recursively.",
      "disposition": "insufficient",
      "insufficiency_reason": "An enumerator only: the new check reuses its file list as input, but it validates nothing."
    },
    {
      "path_or_symbol": "scripts/content-integrity.ts:checkStaleSkillLoadNames",
      "description": "Line-aware token scan with rename suggestions.",
      "disposition": "insufficient",
      "insufficiency_reason": "Judges skill-name tokens, not file or line pointers."
    }
  ],
  "excluded_scopes": [
    { "scope": "docs/plans/**", "reason": "Point-in-time records whose citations describe the code at planning time." },
    { "scope": "skills/**", "reason": "Sub-file links are already checked; the one line citation is a fictional worked example." },
    { "scope": ".slim/clonedeps/**", "reason": "Read-only upstream clones that are absent in CI." }
  ]
}
```

## Key Technical Decisions

- **Extraction:** match a left-anchored repo-relative path with an extension, then `:line`, an optional `-` or `–` end, and optional `,line` items. Mask URLs first. Strip a leading `./`. Skip `path:line:col` stack frames. Reject `..` and leading `/`. Citations inside code fences are checked; a fence marker line only ends a paragraph.
- **Sentence association:** join the paragraph and split on sentence punctuation outside backtick spans. Each citation takes the identifiers of its own segment. Several citations in one segment share them, and any match passes.
- **Identifier filter:** a whole backticked span counts if it is a bare identifier, a dotted chain or a call `name()`. It must also have `_`, an interior capital, or be ALL_CAPS. It is considered only if it occurs somewhere in the cited file. No stopword list.
- **Comment rule:** per extension. ts/js/tsx/mjs: `//`, `/*`, `*`. yaml/yml/sh/toml/py: `#`. md, mdx, json and any other extension get no comment rule. A span fails only when every line is blank or comment. A sentence with `\bcomments?\b` exempts its citations from the comment rule and the symbol rule. They stay structural.
- **Suggestions:** only from a definition line (`function|const|let|var|class|interface|type|enum NAME`) or a key line (`NAME:` with optional quotes). Import and export-from lines never count. No definition means no suggestion.
- **Ordering:** the docs cite `scripts/content-integrity.ts` itself, so citations are fixed after the code lands. The gate is wired in the same unit as the fixes, so every commit stays green.

## Open Questions

### Resolved During Planning

- *Exempt superseded docs?* No. They carry no citations, and a deleted file can take a pinned commit link.
- *How is `dist/config.js:397-398` fixed?* It is Pi's installed package, so it becomes a pinned Pi 0.80.6 link.
- *Which commit does a deleted-file link pin?* The `main` commit nearest the citing doc's date, checked to still hold the cited lines.

### Deferred to Implementation

- *Final failure count.* Wider sentence association and the identifier filter change the scan's 42. The implementer re-runs the shipped extractor and reports the before and after counts.
- *Exact corrected ranges.* Range ends for moved functions, the 13 `tests/integration/pi.test.ts` citations, `tests/unit/plugin.test.ts:661`, the Starlight stack frame and the two retired fence labels each need reading by hand.

## Implementation Units

- [ ] **Unit 1: Citation check and its tests**

**Goal:** add `checkSolutionCitations(rootDir, solutionMarkdownFiles)`, exported but not yet called by the gate.

**Requirements:** R1–R6

**Dependencies:** None

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts`

**Approach:**
- Each violation carries the doc path, the 1-based line in the raw file, the citation text, a class and an optional suggestion.
- Classes: missing file, disallowed root, out of range, blank or comment span, symbol absent, orphan continuation.
- The header comment states the lexical limits.

**Execution note:** test-first.

**Patterns to follow:** `checkSubfileReferences`, `checkStaleSkillLoadNames` and its table tests, and the `checkSolutionSchema` fixtures.

**Test scenarios:**
- Happy path: a citation whose span contains a named identifier passes. So does a citation with no identifier whose span holds code.
- Error path:
  - Each class yields one violation: missing file, `dist/` path, line past the end, range past the end, all-blank span, all-comment span, identifier only outside the span, and orphan `:N`.
- Edge case, suggestions:
  - A moved `const` gets the right suggested line.
  - A key-form `"lint":` gets its key line.
  - An identifier that occurs only in an import gets no suggestion.
- Edge case, comment rule and exemption:
  - "comment" in the sentence passes a comment span. "commented" and "comment" in another sentence do not.
  - A mixed code and comment span passes.
  - A `#` line in a `.ts` file is not a comment.
- Edge case, extraction:
  - Not matched: URLs, `blob/v1/...:12` inside a URL, `path:12:7` stack frames, `..` paths and `.slim/clonedeps` tails.
  - Matched: a leading `./` and an en-dash range.
  - A comma list checks each line, and a citation inside a code fence is checked.
- Edge case, identifiers: a lower-case word like `bun` is ignored. A dotted chain and `name()` are used.
- Edge case, line numbers: a citation after a 10-line frontmatter reports its real file line.

**Verification:** the new tests pass, `bun run typecheck:scripts` passes, and the gate is unchanged.

- [ ] **Unit 2: Citation convention in doc guidance**

**Goal:** tell doc writers how to cite.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `skills/compound-docs/SKILL.md`
- Modify: `skills/ce-compound/assets/resolution-template.md`
- Modify: `ARCHITECTURE.md`

**Approach:**
- Guidance: cite repo-relative paths, backtick the symbol in the same sentence, use a pinned link for code outside the repo or deleted code, and write `<file>:<line>` placeholders in examples.
- `ARCHITECTURE.md`'s content-integrity check list gains one sentence.

**Test expectation:** none, because these are prose edits. The existing gates cover them.

**Verification:** `bun scripts/content-integrity.ts`, `bun run registry:drift` and markdownlint all pass. Regenerate the registry if drift reports a change.

- [ ] **Unit 3: Fix every citation and turn the gate on**

**Goal:** make the tree clean, then make violations fail the gate.

**Requirements:** R6, R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `scripts/content-integrity.ts` (add a `CheckResult` field, the call in `checkContentIntegrity`, the sum in `totalViolations` and a print helper)
- Modify: the failing docs under `docs/solutions/`
- Test: `tests/unit/content-integrity.test.ts` (real-repo and subprocess tests)

**Approach:**
- Wire the check in first. Then run the gate and fix every reported citation:
  - corrected lines;
  - repo-relative paths for basenames;
  - pinned links for code outside the repo and deleted files;
  - full paths for orphan continuations.
- Give each `tests/integration/pi.test.ts` citation a backticked symbol.
- Re-run the gate until it reports 0. Fix no citation by exempting it.

**Test scenarios:**
- Integration: the real repository reports no citation violations.
- Integration: a temp repo with one stale citation, run as `bun scripts/content-integrity.ts <root>`, exits 1 and prints the citation.
- Integration: restoring one fixed citation to its old value makes the real-repo gate fail.

**Verification:** the gate is clean. Record the before count (first gated run) and after count (0) in the PR. The full unit suite, `typecheck:all` and Biome pass.

## System-Wide Impact

- **Interaction graph:** a new step in the existing gate. The CI job and the command are unchanged.
- **Error propagation:** violations add to `totalViolations` and fail CI.
- **Unchanged invariants:** the other content-integrity checks, `docs/plans`, and skills content checks.
- **Future authors:** any edit that moves a cited line now fails CI until the citation is updated. That is the intended cost.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| False errors on legitimate prose | The identifier filter applies only to compound names that occur in the file. Only "comment" exempts the comment and symbol rules. Each boundary has a test. |
| Edits to `content-integrity.ts` keep shifting its own citations | Citations are fixed after the code is final. Docs citing this file are rechecked by the same gate. |
| Pinned links rot | They point at immutable tags or commits. |

## Sources & References

- Related issue: #1014
- Related code: `scripts/content-integrity.ts`, `tests/unit/content-integrity.test.ts`
