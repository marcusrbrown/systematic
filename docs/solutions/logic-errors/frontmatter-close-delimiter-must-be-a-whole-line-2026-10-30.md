---
title: The frontmatter close delimiter must be a whole line, not the tail of a value
date: 2026-10-30
category: logic-errors
module: frontmatter
problem_type: logic_error
component: tooling
symptoms:
  - "A frontmatter value that ends in --- (for example title: Crash on start---) closed the block early"
  - "Fields after that line, such as status and superseded_by, were silently lost"
  - "The leftover YAML lines became body text"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - frontmatter
  - regex
  - parser
  - yaml
  - delimiter
  - latent-bug
  - lifecycle
---

# The frontmatter close delimiter must be a whole line, not the tail of a value

## Problem

`parseFrontmatter` in `src/lib/frontmatter.ts` ended the block at the first `---` followed by a line break, even when that `---` ended a value. A value such as `title: Crash on start---` closed the block early. The parser then dropped `status` and `superseded_by`, reported no error (`parseError` stayed `false`), and put the rest of the YAML in the body.

The regression test added with the fix (`tests/unit/search-core.test.ts:475`) asserts that such a doc resolves to its successor. The search impact on the old code was not reproduced.

The bug was latent. No `key: value` line under `docs/solutions` or in `tests/fixtures` ends in `---`, so the existing corpus does not exercise it.

## Symptoms

A value ending in `---` closed the block early: later fields were lost without an error.

## Solution

The old closing pattern (commit 42c3618d^) was:

```ts
/^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/
```

The fixed pattern is the `frontmatterRegex` in `src/lib/frontmatter.ts:41`:

```ts
/^---\r?\n((?:[\s\S]*?\r?\n)?)---\r?\n([\s\S]*)$/
```

## Why This Works

In the old pattern, the line break before the closing `---` was optional (`\r?\n?`). With the break optional, the lazy `[\s\S]*?` could stop in the middle of a line, and the next three characters, `---`, matched the end of a value. After it the pattern needed only `\r?\n`, which the end of that same line supplied.

In the fixed pattern, group 1 is either empty or ends in the line break (`(?:[\s\S]*?\r?\n)?`). The closing `---` can therefore only start at the beginning of a line. An empty block (`---\n---\n`) still matches because the group is optional, and CRLF still parses because `\r?\n` is kept on both sides.

## Prevention

Tests that pin the behavior:

- `tests/unit/frontmatter.test.ts:171`: a value line that ends in `---` does not close the block, and later fields survive.
- `tests/unit/frontmatter.test.ts:191`: the same case with CRLF line endings.
- `tests/unit/frontmatter.test.ts:198`: empty frontmatter with CRLF still parses.
- `tests/unit/frontmatter.test.ts:205`: empty frontmatter and an empty body still parse.
- `tests/unit/search-core.test.ts:475`: end to end, a superseded doc whose title ends in `---` resolves to its successor.

Caveat: the test at `tests/unit/frontmatter.test.ts:185` ("does not close the block on a --- that is only a line prefix") also passes on the old pattern. It is a guard against a regression in the other direction, not a regression test for this bug. Do not count it as coverage.

The rule: test the delimiter as the tail of a value, not only as a line of its own. A parser test that only places `---` alone on a line cannot tell a whole-line match from a substring match.

The parser is shared. Find its callers with a search for `parseFrontmatter` under `src/` and `scripts/`; a fix changes how every skill, agent and command file is read.

## Related Issues

Open item: `extractFrontmatterBlock` (`src/lib/frontmatter.ts:21`) is still loose by contract, and its callers in `scripts/content-integrity.ts` have not been checked for exposure.

- `docs/solutions/best-practices/lifecycle-validator-runs-only-in-ci-so-agent-prose-must-enforce-it-2026-10-26.md`: why a superseded doc must resolve to its successor, and what the lifecycle checks guarantee.
- `docs/solutions/runtime-errors/circular-yaml-alias-aborts-content-integrity-report-2026-10-26.md`: another frontmatter edge case that the shared checks must survive without throwing.
