---
title: Count real lexical misses before adding an embeddings lane to search
date: 2026-11-01
category: best-practices
module: search-core
problem_type: tooling_decision
component: tooling
severity: medium
symptoms:
  - "Lexical search misses a past-work query whose answer shares no key terms, and an embeddings lane looks like the fix"
  - "A hybrid or rephrase candidate wins on a paraphrase split but nobody has counted misses on real needs"
applies_when:
  - "Proposing semantic or embeddings retrieval for systematic_search"
  - "Proposing to have the researcher reissue a weak search in different vocabulary"
  - "Choosing a floor for how many real misses justify a new retrieval lane"
  - "Judging a candidate that adds documents after the lexical hits"
tags:
  - search
  - hybrid-search
  - embeddings
  - evaluation
  - pre-registration
  - lexical
  - rephrase
  - measurement
---

# Count real lexical misses before adding an embeddings lane to search

## Context

`systematic_search` is lexical (BM25F over `docs/solutions/`, `docs/plans/`, `docs/brainstorms/` and `docs/ideation/`). The researcher calls it four times in the past-work scope, once per kind, at limit 5. Two candidates were proposed to cover needs whose answer shares no key terms with the query:

- **B**, rescue slots: embeddings from a loopback Ollama (`nomic-embed-text`) add up to N documents after each call's lexical hits.
- **D**, rephrase: the researcher reissues a weak search once in different vocabulary and merges by path.

An earlier attempt fused the two lanes and lost lexical hits (`a-retrieval-lane-that-recalls-well-can-still-lose-after-fusion-2026-10-30.md`). This evaluation extends that lesson: it asked first whether real needs miss often enough to need either candidate.

## Finding

**In the shipped researcher shape (four per-kind calls at limit 5), lexical missed 2 of 60 mined real needs.** The floor was 8. The two misses, `q-h119` and `q-h203`, sit just outside the top 5: `q-h119` at rank 6 in the solution and plan calls, `q-h203` at rank 9 in the solution call. The run stopped at the floor and no candidate was run on the mined set.

| Call shape (lexical only, 60 representatives) | Misses |
|---|---|
| Past-work: four per-kind calls at limit 5 (gate shape) | 2 of 60 |
| One `solution` call at limit 8, scored on solution targets | 6 of 60 (4 of the 30 whose primary target is a solution); all within rank 20 |
| One `all` call at limit 5 | 12 of 60 (9 at ranks 6 to 20, 3 beyond 20) |
| Past-work, unconverted need sentence | 1 of 60 |

Under the equal-slot rule below, `q-h119` at rank 6 would not have counted as a rescue for any N of 1 or more: a document at lexical rank 6 is inside the window B shows.

**On a 22-query vocabulary-disjoint tune split, both candidates failed on precision, not on loss.** Neither lost a lexical hit. The qualifying bar was 3 rescues, at least half of the added documents relevant, and zero lexical losses.

| Candidate | Rescues (of 7 lexical misses) | Added documents | Judged relevant | Result |
|---|---|---|---|---|
| B (N=2, cosine floor 0.70) | 2 | 47 | 17 (36%) | fails rescues and precision |
| D (one reissue, M=5) | 5 | 95 | 36 (38%) | fails precision |

- **B:** the cosine score of the missed targets fell in 0.63 to 0.72, while the top-scoring wrong document for the same queries reached 0.64 to 0.74. The ranges overlap, so no floor separates them. A floor of 0.72 or higher removed every rescue. No (N, floor) cell reached half precision.
- **D:** one reissue in the past-work shape is four calls of up to 5 documents, so up to 20 added. Across the 31 queries lexical already found in the earlier 19- and 16-query fixture sets, the model reissued on 6 (19%), costing 21 extra search calls. On the 7 lexical misses of the tune split it reissued on 6.

## Protocol

- **Floor and cap.** Mine real needs until 8 lexical misses or 60 representatives, whichever comes first. At 60 with fewer than 8 misses, stop and choose nothing. Every count is in representatives (one per cluster), so one long thread cannot dominate.
- **Equal-slot control.** A rescue counts only if the target is outside lexical top 5+N, where N is the number of added slots per call (M for a rephrase). Rescues are stratified by lexical rank: 6 to 20, over 20, no term overlap. Without this, a rank-6 hit that B surfaces is just a deeper lexical cut.
- **Labels before rankers.** A labeler reads the whole 293-document catalogue and lists every document that would help with the need, across all four kinds. It never sees ranker output, and no candidate's documents are pooled in. Each batch of about 20 was labeled before its lexical run. Labels were frozen and hashed once after mining ended.
- **Researcher-form queries.** Each need sentence (at most 40 words, verbatim) is converted by a pinned model into the query the researcher would send, following the Step 1b instruction of `agents/research/learnings-researcher.md`. The converted set is hashed and frozen. The gate runs on converted queries; sentence-form results are reported only.
- **Blind judging.** Documents a candidate adds that the labels do not name are judged afterwards, in a shuffled pool with hidden provenance and seeded controls, by a model from a different family than D's. "Uncertain" counts as not relevant. A second pass covers 25%. In the tune rehearsal the pool held 220 items; 137 were judged (every B and D addition plus 4 controls). The 4 controls were judged correctly and the second pass agreed on 31 of 35 (89%).
- **Tune split.** 22 paraphrases written from each target's problem, with every content term shared with the target's indexed fields rejected by the real tokenizer. `tests/fixtures/search-hybrid-tune.json` holds the 17 whose target is a committed kind; the 5 brainstorm targets are left out because `docs/brainstorms/` is untracked.
- **Mining.** Sources, in order: the researcher's own `systematic_search` calls, dispatches to the researcher, user questions, and GitHub issues and PRs (read-only). Sessions and PRs about this evaluation were excluded, as was the session or PR that authored a labeled target.

## Frozen settings

These are the settings the tune phase chose. No pre-registration was written, because the run stopped before the step that needs one.

| Setting | Value |
|---|---|
| Rescue slots per call (N) / rephrase limit (M) | 2 / 5 |
| Cosine floor, aggregation | 0.70, max per document |
| Embeddings | `nomic-embed-text` on loopback Ollama 0.40.4; prefixes `search_query:` and `search_document:` (each followed by a space); chunker v1 |
| Timeout | 3 s (cold first query measured at 0.8 s worst case) |
| Weighted fusion reference (A) | weight 0.5, not tuned |
| D bundle | the researcher prompt with the rephrase rule, the no-synonym sentence and the grep synonym lines edited; 23,998 body bytes against the 24,027 cap |
| Models | labeler, query conversion and rephrase: `anthropic/claude-sonnet-5-5`; judge and D's second-family run: `openai/gpt-5.6-luna` |
| Lexical code | frozen at commit 32e2097f |

Temperature 0 was requested for every model call, but both providers' requests carried no temperature field, so determinism was observed (identical output across two probes), not guaranteed.

## Caveats

- **Source mix.** 56 of the 60 representatives are GitHub PR titles, 2 are dispatch needs and 2 are user questions. The researcher's own search calls all fell inside the evaluation window, so none counted. Most dispatch prompts open with a generic "search `docs/solutions/` for…" line and name no topic. A PR title is a short noun phrase close to the plan or learning it authored, which favors lexical search.
- **Manual cut.** After the mechanical checks, 31 items were dropped by hand: 30 as "not a need" (generic search instructions, conversational lines, dependency bumps) and 1 broken sentence. A looser criterion could keep more session needs and raise the miss count.
- **Authorship and leak drops.** 84 items were dropped because the PR or session that produced them had authored a labeled target, and 32 because they quoted a document's title or filename.
- **Labeler agreement.** A second labeler from another family labeled 18 of the 60. Per-document agreement over the catalogue was 95.5% (mostly agreeing on negatives), mean kappa 0.44, mean Jaccard 0.31, and the same primary target in 9 of 18. The second labeler was much stricter. On those 18, lexical found the target for 18 with the first labels and 17 with the second's, so label breadth barely moves the count. No label set (0 of 60) held only documents whose titles share a term with the need.
- **B tuning rule changed after the first grid.** The rule fixed before tuning was most rescues, then fewest irrelevant additions. The first grid (floors 0.50 to 0.70) showed about three irrelevant additions per rescue, so the floor grid was extended to 0.85 and the rule made precision-aware. The chosen cell is therefore post hoc. No cell reached half precision under either rule, so the conclusion does not depend on the choice.
- **Scope.** One corpus (294 documents at the freeze), one embedding model, one lexical build, and hosted models for labeling and judging. The tune split has 22 queries with one labeled document each.
- **Evidence.** `tests/fixtures/search-hybrid-evidence.json` records, per representative, opaque id, source kind, the primary labeled document, the lexical outcome in each call shape, and whether the target has `symptoms` frontmatter. The 15 representatives that lexical missed in at least one call shape also list every labeled document; the other 45 list only the primary. It holds no mined text. Per-candidate outcomes are marked not applicable.

## Cost

About 740 gateway calls (labeling and its sampling, need extraction, query conversion, rephrase decisions, judging, researcher checks), no rate limits. Warming the vector store for 8,006 chunks took 259 s on a laptop.

## When to reopen

- A different embedding model whose scores separate missed targets from noise.
- A corpus or query population where real lexical misses reach the floor: a larger corpus, or needs written in free vocabulary instead of PR titles.
- A different source mix, such as more session questions, if the manual cut is relaxed.

Reuse the protocol and the two fixtures. Write the settings and decision rule down before any run on the mined set.

## Provenance

- The fusion and embeddings client code stays on the unpushed local branch `feat/search-semantic` at commits `7f179183`, `4e8df291` and `f2cf775e`. Main has no semantic stage.
- The evaluation harness and mining code were kept in scratch and are not committed. Tree hashes: harness `4cf9ff2a58371b726536604ebb260fdafaaaa095aafdcbb24e0debca5edc9375`, mining `0cd3ce3e04e68a346e91b4902a8e1778e41bc8e617b631d24f00d4aa22f6fb44`. The frozen corpus, label set, converted-query set and lexical run hashes are in the evidence fixture header.

## Related

- `docs/solutions/best-practices/a-retrieval-lane-that-recalls-well-can-still-lose-after-fusion-2026-10-30.md`: the earlier fusion measurement this work extends.
- `docs/solutions/best-practices/search-kinds-separately-instead-of-one-merged-ranking-2026-10-31.md`: why the researcher searches one kind per call, which sets the gate shape.
- `docs/plans/2026-10-31-001-feat-hybrid-search-evaluation-plan.md`: the evaluation plan.
