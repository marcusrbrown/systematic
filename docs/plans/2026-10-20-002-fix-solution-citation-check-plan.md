---
title: "fix: Verify path:line citations in docs/solutions"
type: fix
status: completed
date: 2026-10-20
---

# fix: Verify path:line citations in docs/solutions

## Overview

`docs/solutions/` cites source as `path:line` and `path:start-end`, and nothing checks that a citation still points at what its sentence describes. This plan adds a content-integrity check with six failure classes:
- `missing-file`: the cited file does not exist, or is not a regular file.
- `disallowed-root`: the cited file is under `dist/`, `node_modules/`, `.slim/`, `.context/` or `.worktrees/`.
- `out-of-range`: a cited line or range falls outside the file, or is reversed or zero.
- `empty-span`: the cited span holds nothing but blank or comment lines.
- `symbol-absent`: a named identifier is absent from the span.
- `orphan-line`: a backticked `:N` has no path.

It also fixes every citation that breaks today, so the gate lands as an error and the tree stays green.

## Problem Frame

Issue #1014. At `dc79ac8b`, `docs/solutions/` holds 83 citations in 22 of 113 docs. A throwaway scan with the rules below found 42 failures. These counts are preliminary:
- 22 are real drift: deleted files, out-of-range lines, spans that slid onto comments, and moved symbols.
- 20 come from rules this plan resolves: 15 directory-less file names, 4 non-repo paths and 1 deliberate comment citation.

`scripts/content-integrity.ts` validates solution frontmatter but never reads citations. It has no warning channel, so a check either fails the gate or does nothing.

## Requirements Trace

- R1. Every `path:line[-end][,line]` citation in `docs/solutions/**` resolves to a repo-relative regular file whose path matches the on-disk case. The file is not under `dist/`, `node_modules/`, `.slim/`, `.context/` or `.worktrees/`.
- R2. Every cited line or range is inside the file, and a range is not reversed.
- R3. A cited span is not made up only of blank or comment lines, unless the citing sentence contains the word "comment".
- R4. When the citing sentence backticks a compound identifier that occurs in the cited file, at least one such identifier appears inside the span. When it doesn't, the violation suggests the line of its definition, if one exists. A sentence containing the word "comment" is exempt from this rule. When the sentence has no compound identifier that occurs in the file, the rule is skipped and the citation passes.
- R5. A backticked `:N` with no path is an error.
- R6. A violation reports the doc's own file line and names the citation and its class. Any violation fails `bun scripts/content-integrity.ts`.
- R7. The tree is clean when this lands: every current failure is fixed, not exempted.
- R8. Doc-writing guidance states the citation convention.

## Scope Boundaries

- Only `docs/solutions/**`. Excluded: `docs/plans/**` (point-in-time records), `skills/**` (one fictional worked example; sub-file links are already checked), `ARCHITECTURE.md`, `STRUCTURE.md` and `AGENTS.md` (no line citations).
- Superseded docs are checked like any other doc. None carries a citation today.
- URLs are not checked. Citations to code outside the repo, or to deleted code, become pinned links with a tag or commit in the URL.
- `.slim/` is a disallowed root. Citations into it fail, so the two existing `.slim/clonedeps` citations become pinned upstream links.
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
- `redos-after-plugin-trust-boundary-inversion-2026-05-11.md`: a pattern run over input of unbounded length must not backtrack. Scan with `indexOf`, and cover the worst inputs with a storm test.

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
      "path_or_symbol": "scripts/content-integrity.ts:splitCodeSpans",
      "description": "Splits a line into backtick spans and prose with an indexOf-based scan, handling delimiters of any length.",
      "disposition": "insufficient",
      "insufficiency_reason": "A span splitter only: the new check reuses it to find identifiers, but it judges no citation."
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
    { "scope": ".slim/clonedeps/**", "reason": "Surveyed out: .slim/ is a disallowed root, so citations into it fail and must be pinned links." }
  ]
}
```

## Key Technical Decisions

- **Extraction:** match a left-anchored repo-relative path with an extension, then a citation of one or more spans. A span is `line` or `start-end` with `-` or `–`, and spans are joined by commas. Mask URLs first. A bare path is a repo path with no `./` prefix, and a leading `./` is stripped. Skip `path:line:col` stack frames. Reject `..` and leading `/`.
- **Comma lists:** a list is one citation with several spans. The structural rules run on each span. The symbol rule passes if any span matches.
- **Paragraphs and segments:** citations are extracted from the unsplit paragraph. Each is then assigned to the segment that contains its start, so no citation is cut by the split. Segments split on `[.!?;]` followed by whitespace or end of line, outside backtick spans.
- **Code fences:** a citation inside a fence is checked. A fenced line is its own segment, with no splitting and no backtick spans, so it gets the structural checks only. A fence marker line ends a paragraph.
- **Code spans:** reuse `splitCodeSpans`, which is `indexOf`-based. No pattern runs over a line of unbounded length with nested quantifiers.
- **Identifier filter:** the compound test applies to the whole text of a backticked span. A span counts if it is a plain identifier, a dotted chain or a call `name()`, and the whole text has `_`, an interior capital, or is ALL_CAPS. So `opts.strictMode` counts, while `main()` and `opts.strict` do not. A span is considered only if it occurs somewhere in the cited file. No stopword list.
- **Comment rule:** per extension. ts/js/tsx/mjs: `//`, `/*`, `*`. yaml/yml/sh/toml/py: `#`. md, mdx, json and any other extension get no comment rule. A span fails only when every line is blank or comment. A sentence with `\bcomments?\b`, matched case-insensitively, exempts its citations from the comment rule and the symbol rule. They stay structural.
- **File resolution:** the path must name a regular file. Compare it against the parent directory's entries to require the exact case, and reject a directory.
- **Suggestions:** only for TS/JS definition lines (`function|const|let|var|class|interface|type|enum NAME`) and the key form (`NAME:` with optional quotes). Other languages get none, and import and export-from lines never count. The suggestion uses the first missing identifier in sentence order and the first match in file order, and is a single line. No definition means no suggestion.
- **Ordering:** the docs cite `scripts/content-integrity.ts` itself, so citations are fixed after the code lands. The gate is wired in the same unit as the fixes, so every commit stays green.

## Open Questions

### Resolved During Planning

- *Exempt superseded docs?* No. They carry no citations, and a deleted file can take a pinned commit link.
- *How is `dist/config.js:397-398` fixed?* It is Pi's installed package, so it becomes a pinned Pi 0.80.6 link.
- *Which commit does a deleted-file link pin?* The `main` commit nearest the citing doc's date, checked to still hold the cited lines.

### Deferred to Implementation

- *Final failure count.* Wider sentence association and the identifier filter change the scan's 42. The implementer re-runs the shipped extractor and reports the before and after counts.
- *Exact corrected ranges.* Range ends for moved functions, the 13 `tests/integration/pi.test.ts` citations, `tests/unit/plugin.test.ts:661` and the two retired fence labels each need reading by hand.
- *The Starlight frame.* `rehype-steps.ts:32` has no column, so it is not skipped as a stack frame. It fails and is fixed by hand with a pinned link or a reword.

## Implementation Units

- [x] **Unit 1: Citation check and its tests**

**Goal:** add `checkSolutionCitations(rootDir, solutionMarkdownFiles)`, exported but not yet called by the gate.

**Requirements:** R1–R5, and the violation shape of R6

**Dependencies:** None

**Files:**
- Modify: `scripts/content-integrity.ts`
- Test: `tests/unit/content-integrity.test.ts` (add the import at the file's import block)

**Approach:**
- Each violation carries the doc path, the 1-based line in the raw file, the citation text, a class and an optional suggestion.
- Classes: `missing-file`, `disallowed-root`, `out-of-range`, `empty-span`, `symbol-absent`, `orphan-line`.
- The header comment states the lexical limits.

**Execution note:** test-first. `makeFixtureRepo` creates no `docs/solutions`, so tests pass an explicit file list.

**Patterns to follow:** `checkSubfileReferences`, `checkStaleSkillLoadNames` and its table tests, and the `checkSolutionSchema` fixtures.

**Test scenarios:**
- Happy path: a citation whose span contains a named identifier passes. So does a citation with no identifier whose span holds code.
- Error path, one violation per class:
  - `missing-file`: a missing path, and a directory path.
  - `disallowed-root`: `dist/`, `node_modules/` and `.slim/` paths.
  - `out-of-range`: a line past the end, a range past the end, a reversed range, and `:0`.
  - `empty-span`: an all-blank span and an all-comment span.
  - `symbol-absent`: an identifier only outside the span.
  - `orphan-line`: a backticked `:N` with no path.
- Edge case, suggestions:
  - A moved `const` gets the right suggested line.
  - A key-form `"lint":` gets its key line.
  - An identifier that occurs only in an import gets no suggestion.
  - A non-TS/JS file gets no suggestion.
  - With two missing identifiers, the first in sentence order is used, and the suggestion is one line.
- Edge case, comment rule and exemption:
  - "comment" and "Comment" in the sentence pass a comment span, and a missing identifier in that sentence also passes. "commented" and "comment" in another sentence do not.
  - A mixed code and comment span passes.
  - A `#` line in a `.ts` file is not a comment.
- Edge case, extraction:
  - Not matched: URLs, `blob/v1/...:12` inside a URL, `path:12:7` stack frames and `..` paths.
  - Matched: a leading `./` and an en-dash range.
  - A comma list checks each span structurally, and passes the symbol rule if any span matches.
  - A citation inside a code fence gets the structural checks only.
  - A citation is never cut by the sentence split, and sits in the segment where it starts.
- Edge case, identifiers:
  - `Read` and `bun` are not considered, so a citation that names only them passes.
  - `main()` is not considered, and `opts.strictMode` is considered.
  - A dotted chain and a compound call are used.
- Edge case, line numbers: a citation after a 10-line frontmatter reports its real file line.
- Edge case, file resolution: a path with the wrong case fails on a case-sensitive match.
- Performance: each of these finishes in under 1 s: a 100 KB line of `a.a.a…`, 10,000 unmatched backticks, and a long `:1,1,1…` run.

**Verification:** the new tests pass, `bun run typecheck:scripts` passes, and the gate is unchanged.

- [x] **Unit 2: Citation convention in doc guidance**

**Goal:** tell doc writers how to cite.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `skills/compound-docs/SKILL.md` (the "Specific file:line references" line)
- Modify: `skills/ce-compound/assets/resolution-template.md` and `skills/ce-compound-refresh/assets/resolution-template.md` (identical edits, kept byte-identical for `tests/unit/compound-contract-parity.test.ts`)
- Modify: `skills/compound-docs/assets/resolution-template.md` (differs from the other two)
- Modify: `ARCHITECTURE.md`

**Approach:**
- Guidance: cite repo-relative paths, backtick the symbol in the same sentence, use a pinned link for code outside the repo or deleted code, and write `<file>:<line>` placeholders in examples.
- `ARCHITECTURE.md`'s content-integrity check list gains one sentence.

**Test expectation:** none, because these are prose edits. The parity test, `registry:drift`, the Pi personas check and the bootstrap tests cover the edited files.

**Verification:** `bun scripts/content-integrity.ts`, `bun run registry:drift`, `bun scripts/generate-pi-subagents-personas.ts --check`, the parity and bootstrap tests, and markdownlint all pass. Regenerate the registry if drift reports a change.

- [x] **Unit 3: Fix every citation and turn the gate on**

**Goal:** make the tree clean, then make violations fail the gate.

**Requirements:** the gate-failure part of R6, and R7

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `scripts/content-integrity.ts`:
  - the new `CheckResult` field;
  - the call in `checkContentIntegrity`;
  - the sum in `totalViolations`;
  - the print helper and its call in `printResult`;
  - the header comment that calls `docs/solutions` "frontmatter parse-safety only";
  - the `collectScanTargets` doc comment.
- Modify: the failing docs under `docs/solutions/`
- Test: `tests/unit/content-integrity.test.ts` (the real-repo `assertNoViolations` line for the new field, and the subprocess test)

**Approach:**
- Unit 3 lands as a single commit. Wire the check in first, then run the gate in the working tree before any fix. That run gives the before count.
- Fix every reported citation:
  - corrected lines;
  - repo-relative paths for directory-less file names;
  - pinned links for code outside the repo, deleted files and `.slim/` paths;
  - full paths for orphan continuations.
- Give each `tests/integration/pi.test.ts` citation a backticked symbol.
- Re-run the gate until it reports 0. Fix no citation by exempting it.

**Test scenarios:**
- Integration: the real repository reports no citation violations.
- Integration: a temp repo with one stale citation, run as `bun scripts/content-integrity.ts <root>`, exits 1 and prints the citation.
- Integration: restoring one fixed citation to its old value makes the real-repo gate fail.

**Verification:** the gate is clean. Record the before count and the after count (0) in the PR. The full unit suite, `typecheck:all` and Biome pass.

## System-Wide Impact

- **Interaction graph:** a new step in the existing gate. The CI job and the command are unchanged.
- **Error propagation:** violations add to `totalViolations` and fail CI.
- **Unchanged invariants:** the other content-integrity checks, `docs/plans`, and skills content checks.
- **Future authors:** an edit that moves a cited symbol out of its span now fails CI until the citation is updated. That is the intended cost.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| False errors on legitimate prose | The identifier filter applies only to compound names that occur in the file, and the symbol rule is skipped when none is considered. Only "comment" exempts the comment and symbol rules. Each boundary has a test. |
| A pattern backtracks on a long line | Spans come from the `indexOf`-based `splitCodeSpans`. A storm test bounds each worst input at 1 s. |
| Edits to `content-integrity.ts` keep shifting its own citations | Citations are fixed after the code is final. Docs citing this file are rechecked by the same gate. |
| Pinned links rot | They point at immutable tags or commits. |

## Sources & References

- Related issue: #1014
- Related code: `scripts/content-integrity.ts`, `tests/unit/content-integrity.test.ts`
