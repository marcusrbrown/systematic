---
title: "An unquoted conventional-commit title hides a plan from search"
date: 2026-10-31
category: logic-errors
module: content-integrity
problem_type: logic_error
component: tooling
symptoms:
  - "Plans under docs/plans had a title like `feat: Add x`, and their frontmatter did not parse as YAML"
  - "Search skipped those plans with a warning and still returned hits, so nothing failed"
  - "No gate checked plan frontmatter, so the files stayed broken"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
tags:
  - yaml
  - frontmatter
  - ce-plan
  - search
  - quoting
  - content-integrity
---

# An unquoted conventional-commit title hides a plan from search

## Problem

A plan titled `title: feat: Add x` is not a string to YAML. A colon followed by a space inside a plain scalar starts a mapping, so the frontmatter fails to parse. Search cannot index a document it cannot parse, so those plans never appeared in results.

## Symptoms

- Several plans under `docs/plans/` failed to parse, and search skipped them.
- The skip was warned, not silent. `parseCorpusDocument` returns `{ ok: false, reason: 'invalid frontmatter' }` (`src/lib/search-corpus.ts:347-358`), and the loader adds `skipped <path>: invalid frontmatter` to its warnings when that happens (`parseCorpusDocument` call site, `src/lib/search-corpus.ts:428-434`). No gate and no consumer read that warning.

## What Didn't Work

No failed attempt is recorded. The option the fix rules out is quoting only the failing files. The template would then keep producing unquoted titles.

## Solution

Quote the failing titles:

```diff
-title: feat: Add Agent Configuration Overlays
+title: "feat: Add Agent Configuration Overlays"
```

Fix the source of new ones. The ce:plan template showed `title: [Plan Title]` at v3.28.1, and it now shows a quoted placeholder. Phase 3.1 tells the planner why (`skills/ce-plan/SKILL.md:360`, `skills/ce-plan/SKILL.md:517`):

```md
  - Quote the title in the frontmatter (`title: "feat: Add user authentication"`): a conventional-commit title contains a colon, which YAML reads as a mapping, and the plan then fails to parse
```

## Why This Works

A conventional-commit title (`feat:`, `fix:`) always contains a colon followed by a space, so an unquoted one always breaks. Wrapping the value in matching quotes makes it a string. Escape inside the quotes whatever the chosen style requires: in double quotes, write `\"` for a quote and `\\` for a backslash; in single quotes, double any `'`. A title that contains none of these characters needs no escaping.

The template made the failure likely, not certain, because an unquoted placeholder invited an unquoted title.

## Prevention

- `checkPlanFrontmatterParse` fails any plan under `docs/plans/` whose frontmatter does not parse, and `hasUnquotedColonTitle` makes the message name the `title` field when that is the cause (`scripts/content-integrity.ts:3490-3539`). The content-integrity run calls it at `scripts/content-integrity.ts:4113`, and its unit tests start at `tests/unit/content-integrity.test.ts:1088`.
- `tests/unit/ce-plan-template-contract.test.ts:30-50` asserts that the template title starts with a double quote, and that a `feat: Add x` title substituted into the template parses back unchanged.
- Skill frontmatter (`scripts/content-integrity.ts:1106`) and solution frontmatter (`scripts/content-integrity.ts:1739`) already had a parse gate. Plans were the gap.
- Open item: brainstorm and ideation docs have no parse gate, and search skips them the same way. This was not checked for broken files.

## Related Issues

- `docs/solutions/logic-errors/frontmatter-close-delimiter-must-be-a-whole-line-2026-10-30.md`: also loses a document's fields without a loud failure, but through a parser that reports no error. Here the parser reports one and nothing read it.
- `docs/solutions/best-practices/search-kinds-separately-instead-of-one-merged-ranking-2026-10-31.md`: the search design that made this skip matter.
