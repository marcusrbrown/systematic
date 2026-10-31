---
title: A retrieval lane that recalls well can still lose after fusion
date: 2026-10-30
category: best-practices
module: search-core
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Fusing a lexical lane and a semantic lane with plain reciprocal rank fusion (RRF)"
  - "One lane returns a much longer list than the other"
  - "A hybrid ranker is judged by an aggregate found@k on a small labelled query set"
  - "Choosing between fusion variants on a tune split of about a dozen queries"
  - "A success criterion compares a new retrieval path to a baseline"
tags:
  - search
  - hybrid-search
  - rrf
  - measurement
  - evaluation
  - baseline
  - success-criteria
---

# A retrieval lane that recalls well can still lose after fusion

## Context

`systematic_search` ships lexical search (BM25F over `docs/solutions/`). An embeddings lane was built to cover queries whose answer shares no key terms with the query: Ollama `nomic-embed-text`, 126 docs, 1,569 chunks. Its output was fused with the lexical ranking by plain RRF (reciprocal rank fusion, `k = 60`) and measured on the committed 19-query set in `tests/fixtures/search-queries.json` (14 tune queries, 5 held out).

The plan's success criterion had two halves (`docs/plans/2026-10-29-001-feat-durable-output-search-plan.md:107`): hybrid never does worse than lexical on the set, and it wins at least one query whose answer shares no key terms. The first half failed. The second half passes only at rank ≤ 8, where hybrid moves q12 from a miss to rank 7. At the fixture's top-5 cutoff, hybrid wins none of the three `lexical_reachable: false` queries: lexical has 1 and hybrid has 1 (q16). By that cutoff both halves fail. The plan records the outcome: the semantic lane was deferred (`docs/plans/2026-10-29-001-feat-durable-output-search-plan.md:876`).

The fusion code was never merged. It is on the unpushed local branch `feat/search-semantic` (commit 4e8df291). Main has no semantic stage.

## Guidance

**Under plain RRF, agreement between lanes beats a top rank in one lane.** A doc that a lane does not return gets 0 from that lane. So a doc ranked 1 by the strong lane alone can lose to a mediocre doc that both lanes return, for lexical lists up to about 196 entries, which covers this corpus. A semantic-only candidate scores at most 1/61, so it cannot beat lexical rank 1.

| Doc | Score |
|---|---|
| Lexical-only, rank 1 | 1/61 = 0.0164 |
| Rank 5 in both lanes | 2/65 = 0.0308 |
| Semantic rank 20 plus lexical rank 126 | 1/80 + 1/186 = 0.0179 |

**Unequal depth makes the loss total.** In the measurement, lexical returned 120 to 126 of the 126 docs per query. That is a property of the run, not of the code: `searchLexical` returns every doc with a positive score, so the tail length depends on term overlap. The semantic lane contributed its top 20. The third row above is the worst case for a doc in both lists, and it still beats the first row. So every doc in both lanes' lists outscored every lexical-only doc, and the fused list was 20 "both" docs followed by the lexical-only tail. The first lexical-only doc landed at fused position 21 in 18 of 19 queries (position 20 in q12).

**Measure the fused result against the best single lane, per query and at top 5, before shipping.** The aggregate hid the loss. Found@8 (first relevant doc at rank ≤ 8) was 16/19 for both rankings; top 5 (the fixture's recall cutoff) was 16 for lexical and 14 for hybrid:

| Mode | Slice | n | top1 | top5 | found@8 | MRR@8 |
|---|---|---|---|---|---|---|
| lexical | all | 19 | 14 | 16 | 16 | 0.761 |
| hybrid (V0, as built) | all | 19 | 13 | 14 | 16 | 0.718 |
| lexical | tune | 14 | 10 | 12 | 12 | 0.746 |
| hybrid (V0) | tune | 14 | 10 | 11 | 13 | 0.760 |
| lexical | held out | 5 | 4 | 4 | 4 | 0.800 |
| hybrid (V0) | held out | 5 | 3 | 3 | 3 | 0.600 |

Hybrid gained two queries at rank ≤ 8 and lost two, and the gains landed at ranks 6 and 7, outside the top 5. Rank of the first relevant doc at limit 8 (`miss` means not in the top 8):

| Query | Lexical | Hybrid (V0) | Fused position of the lexical hit |
|---|---|---|---|
| issue-820-prose-dedup | 1 | miss | 21 |
| q19-dependency-bump-fails-test | 4 | miss | 23 |
| q12-pipeline-finished-nothing-shipped | miss | 7 | |
| q18-plugin-key-ignored-new-major | miss | 6 | |
| q16-stray-slashes-in-posted-text | 5 | 3 | |
| q03-old-links-subpath | miss | miss (14 at limit 20) | |

The two lost docs are exactly the ones the semantic lane did not return in its top 20. For the other 17 queries it did return the relevant doc, so recall at depth 20 was 17/19. That says nothing about top-5 precision. Judged by title, the hybrid's top 5 held weakly related docs for q03, q12, q18 and q19. For q19 the lexical rank-4 doc fell out of the top 8; the top 5 held five other docs, several CI-adjacent by title.

**Capping both lanes to equal depth did not fix it.** Seven fusion variants were fixed in advance. The offline harness reproduced the shipped ranks on 19/19 queries for both lexical and V0. The decisive rows:

| Variant | Definition | All: top5 / found@8 | Held-out found@8 | #820 rank | q19 rank |
|---|---|---|---|---|---|
| V0 | lexical full, semantic 20 (as built) | 14 / 16 | 3 | miss | miss |
| V1 | both lanes capped at 20 | 14 / 15 | 3 | miss | miss |
| V5 | semantic ranks every doc, lexical full, semantic weight 0.5 | 15 / 16 | 4 | 5 | 7 |
| V6 | lexical top 3 pinned plus V1 | 15 / 16 | 4 | 1 | miss |
| lexical | | 16 / 16 | 4 | 1 | 4 |

- V1 and V2 (both lanes capped at 50) still lose #820. Capping the lists does not remove the agreement effect. The fused position of #820 under V1 and V2 was not recorded. V3 (semantic ranks every doc) and V4 (V1 with semantic weight 0.5) lose it too.
- V6 fixes #820 but loses q19, whose relevant doc is lexical rank 4, below the pin.
- Weighting the weaker lane down (V5) is the only variant that lost nothing lexical found. It still trails lexical at top 5 (15 against 16). It was found after the fact, by looking at all 19 queries, which include the very queries that motivated the work. Treat it as a hypothesis. With n = 19 the gap between V5 and V0 or V6 is a one-to-two-query swing.

**A tune split too small to separate variants will pick "change nothing".** On the 14 tune queries V0, V2 and V3 tied on found@8 (13) and top 5 (11), with MRR 0.760, 0.759 and 0.759. The pre-set rule froze V0 on a 0.001 MRR gap, which is the shipped behavior. The frozen V0 failed acceptance check (a), "no query lexical found is lost". It lost #820 (held-out) and q19 (tune). Fix the variants and the selection rule in advance, and size the tune split so the rule can discriminate.

**Name the comparator and the cutoff in every criterion.**

- `lexical_reachable` labels overlap with frontmatter only (`tests/fixtures/search-queries.json`).
- The recorded grep baseline found all three "unreachable" queries (`tests/fixtures/search-baseline-grep.json`). That baseline is the unmodified learnings-researcher recorded against 03b1b333: grep-first with OR'd synonym patterns, then reading.
- Lexical search, which reads the body, found one of them (q16, rank 5).
- So the label predicted neither the agent baseline nor the lexical ranker.
- The #820 query is labelled reachable only through the stopwords "not" and "the". The label was pinned by hand.
- The fixture records returned paths, not the terms that found them, so do not claim the agent matched "by meaning".
- The plan at `docs/plans/2026-10-29-001-feat-durable-output-search-plan.md:107` names no comparator for the "no shared key terms" half. The plan at `docs/plans/2026-10-29-001-feat-durable-output-search-plan.md:106` reports the grep baseline beside lexical and says it is not a go/no-go gate.

## Why This Matters

A hybrid that ties on the aggregate and looks fine in a demo can still bury the best answer the cheaper lane had at rank 1. In a search tool the top-5 hit is the one an agent reads. Shipping the fusion would have traded two lexical hits (ranks 1 and 4) for hits at ranks 6 and 7, both outside the top 5.

The lane's recall was not the problem. The fusion rule was. Judging the lane by its own recall at depth 20 (17/19) would have approved a change that made the combined result worse.

## When to Apply

- Before adding any second retrieval lane behind RRF or a similar rank-based fusion.
- When the lanes return lists of different lengths, or when one lane has a tail of low-score matches.
- When a success criterion says "never worse than the baseline". Check that half per query, not by total.
- When tuning on a split of about a dozen queries.

## Examples

Order of work that would have caught this earlier:

1. Run the single best lane and the fused result on the same labelled queries.
2. Print per-query rank for both, plus top-5 hit counts, not only found@k.
3. List every query the best lane found that the fused result does not.
4. Only then compare fusion variants, against rules written down before the run.

Revisit the semantic lane with a fresh query set labelled before any ranker runs, and test weighting the weaker lane down (V5) as a pre-registered variant rather than a post hoc finding.

## Related

- `docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md`: a metric that looks fine can be evidence about the instrument, not the system.
- `docs/solutions/best-practices/search-kinds-separately-instead-of-one-merged-ranking-2026-10-31.md`: the same comparator-and-cutoff discipline applied to merging document kinds, with post-hoc numbers labeled.
