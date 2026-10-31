---
title: Search each document kind separately instead of one merged ranking
date: 2026-10-31
category: best-practices
module: search-core
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "An agent searches a corpus that mixes document kinds of very different length and metadata"
  - "Choosing between one merged call and one call per kind"
  - "Writing a success criterion for a retrieval change"
tags:
  - search
  - ranking
  - bm25
  - evaluation
  - post-hoc
  - hypothesis
---

# Search each document kind separately instead of one merged ranking

## Context

Past-work search added `plan`, `brainstorm` and `ideation` kinds next to `solution`. `kind: all` ranks them in one BM25F list, and the kinds are not alike. Plans are much longer than solutions, and only solutions carry `tags`, `symptoms` and `module` (`docs/plans/2026-10-30-001-feat-search-past-work-plan.md:139`). Long documents can win a merged ranking on common terms.

## Guidance

When an agent searches several kinds, make one call per kind, merge the hits by path, and do not call `all`. The researcher prompt says so in `agents/research/learnings-researcher.md:53`:

> Make one search per kind, `solution`, `plan`, `brainstorm` and `ideation`, and merge the hits by repo-root path … Never search `all`: long plans crowd the other kinds out of its top results.

A wiring test pins the rule with `expect(text).not.toMatch(/kind: "?all"?/)` (`tests/unit/past-work-wiring-contract.test.ts:122-127`). Keep `all` as a selector for people. Plan decision KTD12 records the same choice (`docs/plans/2026-10-30-001-feat-search-past-work-plan.md:205`).

Treat the design as a hypothesis with a structural reason, not as a measured win.

## Why This Matters

On 16 labeled queries, scored at top 5, the union of `all` and `solution` found 12 and one call per kind found 15 (`docs/plans/2026-10-30-001-feat-search-past-work-plan.md:205`). Three things limit what that shows:

- **The comparison was exploratory and post-hoc.** The per-kind variants were tried after the merged results were seen, so it is not a pre-registered test.
- **The per-kind union returns more candidates.** It returns about 16 paths against 7 to 9 for the two-call union, so it has more chances to hit. Reading cost was not modeled.
- **The grep baseline matched all 16 queries.** This set gives no evidence of a recall gain over grep. That baseline was one run whose paths were hand-filtered to the four directories (`tests/fixtures/search-past-work-baseline.json:204-212`, counts at `tests/fixtures/search-past-work-baseline.json:392-394`).

## When to Apply

- A corpus mixes kinds whose documents differ much in length or metadata.
- The caller is an agent that reads several top-5 lists side by side.
- A new retrieval path needs a success criterion. Name the comparator and the cutoff.

## Examples

One ideation query (q05) ranked its target first when ideation was searched alone, and the target was missing from `all`'s top 20 (measured during the PR, not committed). The ideation kind held a single document, so it ranks first whenever a query term matches its indexed fields, and this find is partly mechanical.

## Related

- `docs/solutions/best-practices/a-retrieval-lane-that-recalls-well-can-still-lose-after-fusion-2026-10-30.md`: name the comparator and the cutoff, and check a combined result against the best single lane per query.
