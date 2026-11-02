---
title: Mining real needs cannot settle whether an external decision store matters
date: 2026-11-02
category: best-practices
module: search-core
problem_type: tooling_decision
component: tooling
severity: medium
symptoms:
  - "A trial counts real questions that only an external decision store answers and finds almost none, so it cannot say whether the store is useful"
  - "A store looks useful on the one sample that was seeded from the same pull requests the questions came from"
  - "Past-work search reads docs/solutions and docs/plans but a project keeps its decisions in RFCs, a wiki, runbooks or a decision graph"
applies_when:
  - "Deciding whether to give the past-work researcher access to a decision store outside the Systematic doc directories"
  - "Designing a measurement that labels real needs against a catalogue and counts what only one store answers"
  - "Sampling needs from pull request titles, issue titles or agent dispatch prompts"
tags:
  - search
  - decision-store
  - external-sources
  - evaluation
  - measurement
  - sampling
  - opt-in
  - past-work
---

# Mining real needs cannot settle whether an external decision store matters

## Context

The past-work researcher reads `docs/solutions`, `docs/plans`, `docs/brainstorms` and `docs/ideation`. Some projects keep their decisions elsewhere: older RFCs and product records, a wiki, runbooks, or a decision graph such as Deciduous. None of those reach the researcher.

Before building access, the trial borrowed the method of the lexical-misses evaluation (`count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md`): mine real needs, label each against a frozen catalogue, and count how many only the external store answers. The plan is `docs/plans/2026-11-01-001-feat-decision-store-trial-plan.md`. Four public repos each got a pool of needs, and five stores were counted in six store-by-pool cells.

## Lesson

**Deciding whether an external decision store matters by counting mined needs failed twice, and the cause was the method, not the stores.** The first run found almost nothing. A re-measure meant to fix that failed in a different way. Neither run says the stores are useless, and neither says they are useful. Five structural reasons explain the zeros:

1. **An exclusive-coverage gate cancels an external answer whenever any Systematic doc merely helps.** The gate counted a need for a store only when no Systematic doc was labeled in either tier. A labeler that lists documents that would help, as this one did, returns Systematic docs for most needs. Those docs cancelled the store's answer. For the same needs, counting only the answers tier gave 7 for legacy records and 7 for the `.github` wiki in the `.github` pool, where the gate gave 0 and 1.
2. **Pull request titles are weak stand-ins for planning questions, and genuine information-need questions are rare in GitHub history.** A human title is a statement, such as a change description, and it sits close to the plan or learning that the same change produced. In the largest pool at most 2 of 925 human-opened threads had a title ending in a question mark. The first need rule produced 27 representatives and none came from GitHub. The rule was replaced before any relevance label ran.
3. **Sampling the earliest needs first picks needs that predate the stores.** The 30 earliest needs per pool were almost all older than the store they were meant to test. Only the legacy cell had mostly later needs. The Deciduous graph did not exist until 2026-09-09, and the sparkle needs ended in 2025-09.
4. **A store seeded from the same pull requests as the needs is circular.** Sparkle's graph was built from its pull request bodies and commits, so a need taken from a PR title usually found the node that same PR authored. The rule that drops a need whose own change wrote a labeled record removed 98 of 105 examined sparkle needs, and 76 of the 98 would otherwise have counted for Deciduous. The cell rests on the 7 survivors.
5. **The first sentences of dispatch prompts are boilerplate.** The re-measure used the first sentence of each `learnings-researcher` dispatch prompt as the need. Many open with a generic instruction, a path or a read-only notice, so the sample carried little topic.

## Findings

### Run 1: the earliest needs per pool, exclusive gate

Floor: a cell qualifies at 5 or more needs where a store record is labeled and no Systematic doc is. A pool under 15 is thin. The `.github` wiki has two cells and is never summed.

| Cell | Store / pool | Needs | Gating count | Answers-only | Result |
|---|---|---|---|---|---|
| 1 | Deciduous / sparkle | 7 | 5 | 4 | qualifies, thin |
| 2 | legacy records / agent | 30 | 0 | 7 | no |
| 3 | agent wiki / agent | 30 | 1 | 3 | no |
| 4 | `.github` wiki / agent | 30 | 1 | 1 | no |
| 5 | `.github` wiki / `.github` | 30 | 1 | 7 | no |
| 6 | runbooks / infra | 30 | 0 | 0 | no |

- **One cell reached the floor, and it is the circular one.** Deciduous reached 5 of 7. It is thin, every need predates the graph, and under the answers-only count it has 4.
- **The second labeler could not move any cell across the floor.** On the sampled needs (3, 9, 9, 9), swapping its labels in changed no cell from qualifying to not or back. No cell is borderline and no store is untestable.
- **Systematic docs dominate the labels.** Needs labeled both a Systematic doc and a store record: 22 of 30 in the agent pool and 23 of 30 in the `.github` pool. The primary labeler returned about 5 to 7 documents that would help for each document it called an answer.

### Tier sensitivity

The gate counts a record in either tier. Counting only the answers tier on both sides gives the second row of the table above: 4, 7, 3, 1, 7 and 0. The gate and the sensitivity disagree on which cells reach 5, which is why the zeros cannot be read as absence.

### Agreement and the recall control

The recall control passed in every pool before any real label ran: hand-written needs, each written from one Systematic doc, returned that doc in 5 of 5 in every pool.

A second labeler from another model family labeled ceil(0.3 n) of each pool. Pooled over those needs:

| Pool | Sampled / needs | Kappa | Jaccard | Same four-way outcome |
|---|---|---|---|---|
| sparkle | 3 / 7 | 0.89 | 0.80 | 100% |
| agent | 9 / 30 | 0.59 | 0.42 | 78% |
| `.github` | 9 / 30 | 0.48 | 0.33 | 56% |
| infra | 9 / 30 | 0.57 | 0.42 | 78% |

The second labeler listed about half as many documents (119 against 238 on the same 30 needs). It agreed with the first on whether a sampled need counted for a cell in 43 of 48 cell checks, and on the four-way outcome in 22 of 30 needs.

### Source mix and date ranges

Needs came from PR or issue titles (87 of 97) and the first problem sentence of a body (10 of 97). The date ranges by pool:

| Pool | Needs | Months |
|---|---|---|
| sparkle | 7 | 2020-12 to 2025-09 |
| agent | 30 | 2026-01 |
| `.github` | 30 | 2022-11 to 2025-03 |
| infra | 30 | 2026-04 |

### A4: re-measure on dispatch topics, recorded as a protocol failure

A re-measure followed on needs dated after each store's first record. The sources were `learnings-researcher` dispatch prompts for the agent, `.github` and infra pools, and human titles for sparkle (a weaker source). Up to 10 needs per pool were taken at even spacing from a seeded offset, with the ships-first bar (at least 3 incremental needs per store) fixed before any label.

| Cell | Store / pool | Needs | Direct | Incremental | Exclusive |
|---|---|---|---|---|---|
| 1 | Deciduous / sparkle | 2 | 2 | 1 | 1 |
| 2 | legacy records / agent | 10 | 0 | 0 | 0 |
| 3 | agent wiki / agent | 10 | 0 | 0 | 0 |
| 4 | `.github` wiki / agent | 10 | 0 | 0 | 0 |
| 5 | `.github` wiki / `.github` | 10 | 0 | 0 | 0 |
| 6 | runbooks / infra | 5 | 0 | 0 | 0 |

Direct means the store has an answers-tier record. Incremental adds that no Systematic doc is in the answers tier. Exclusive is the run 1 rule.

**This table is a protocol failure and carries little weight.** The topic rule took the literal first sentence of each prompt. Of the kept dispatch needs, 5 of 10, 6 of 10 and 5 of 5 (agent, `.github`, infra) opened with a generic instruction or notice, and the primary labeler returned no document at all for 5 of 10, 5 of 10 and 5 of 5. The only store records in any dispatch-pool label were 3 agent-wiki records in the helps tier. Sparkle's window held 3 human-opened threads in total. The measurement stopped here, and the ships-first rule was retired without being applied.

## Decision

Access to external stores is justified by direct need in the projects that opt in, not by this measurement. The follow-up is opt-in external-source search through the existing lexical engine, with every store available as an opt-in and no store gated. It stays opt-in and bounded, and the default behavior of the past-work researcher does not change.

Its value is checked by dogfooding: a manual record of 10 runs, with the decision taken from those. A future gate on usefulness should not reuse this protocol.

## What would settle it

- **Questions written as questions.** Needs taken from the researcher's own `systematic_search` calls or from dispatch prompts with the whole task read, not the first sentence.
- **Needs dated after the stores exist.** Sample across the history instead of earliest-first, and sample per store.
- **A count that does not let a helping doc cancel an answer.** Report the answers-tier incremental count as the primary measure and the exclusive count beside it.
- **A store that was not built from the needs' own changes.** Otherwise the authorship rule removes the cases the store was meant to answer.

## Protocol

- **Catalogues.** For each pool, one frozen catalogue of the repo Systematic docs plus its external stores, read from a pinned commit. The catalogue lists title, headings and an excerpt of up to 400 characters, so a labeler sees it whole.
- **Labeling.** One call per need. The labeler listed the documents that answer the need and those that would help, in two tiers, and never saw ranker or search output. Results were stored on first success and the resolved model string was pinned.
- **Needs.** A human PR or issue title with the commit prefix removed, or the first problem sentence of the body when fewer than 5 words remained. Bot and agent text, a need that repeats 6 or more words of bot text, and a need that quotes a catalogue title were dropped.
- **Authorship.** A need was dropped whole when its own PR, or the session that dispatched it, wrote a labeled document.
- **Amendments.** A1 widened the Deciduous dependency-title regex (the sparkle catalogue was rebuilt; the others did not change). A2's first need rule and rubric were replaced by A3 before any relevance label, which restored the hybrid-search need rule. A4 is the re-measure above.
- **Models.** Primary labeler, classifier and reviewer: `anthropic/claude-sonnet-5-5`. Second labeler: `openai/gpt-5.6-luna`. Both ran through `opencode run` with no temperature sent, so determinism is observed, not guaranteed.

## Caveats

- **Agent-drafted text under a human account.** A human-opened PR can carry text an agent drafted, and it cannot be told apart from the author's own writing.
- **Systematic-only catalogue scope.** README and architecture files are not in the catalogue, so a need answered there shows as store-only or nothing.
- **Early-history sampling.** The 30 earliest needs are a small, old slice of each pool.
- **Unmapped authorship.** Deciduous nodes with no PR key: 29 of 421 (6.9%). Only 7 of 48 wiki pages name a source that resolves to one of the four repos, so the wiki's authorship rests mostly on the commit that added each page.
- **The lazy window edge.** Text was fetched oldest-first and stopped at 105 representatives per pool, so the fetch never reached the sessions.
- **Topic mismatch for the `.github` pool.** Its needs are PR titles about a repo that mostly holds workflow and wiki content, while its dispatch prompts concern other repos.
- **Hosted models.** Labels came from two hosted models through a gateway. The calls are not replayable.

## Cost

469 gateway calls: 257 for the primary labeler (rehearsals, the recall control, the real walk and A4), 39 for the second labeler, 165 for need classification, 4 for the Deciduous reviewer and 4 for the transport probe. No rate limits. The 3 GB opencode session snapshot was deleted after the authorship indices were built.

## Provenance

- **Pinned refs.**
  - `marcusrbrown/sparkle@9653534e`
  - `fro-bot/agent@263d79e7`
  - `fro-bot/.github@2c7ecbeb`
  - `marcusrbrown/infra@351bb6b3`
- **Hashes.** The protocol hash is `04fd9f8dfd71d990cf1d237af48db25d7866b67e80f0f16980d2c075eff99c15`, the A4 protocol hash is `6047a109d0bc6359d5a1d01e9244641cdc492ca4a899e4c38f507d4dc11bf1e1`, and the hash of the decision text is `d6ca1a289b2edd09c89c57847ac1784769b88404069a40a86641938667970573`. The catalogue, label, kept-set and outcome hashes are in the fixture header.
- **Scratch.** The harness, mining code and raw text were kept in scratch and are not committed. Reusable pieces (the catalogue builders, the Deciduous filter, the labeler prompts, the recall control and the model transport) were copied to a separate scratch directory with a README of known defects.
- **Evidence.** `tests/fixtures/decision-store-trial-evidence.json` records, per need, an opaque id, source class, month, whether the Systematic docs were returned in the answers or helps tier, which external stores had a counting record in each tier, and the four-way outcome, with run 1 and A4 in separate sections. It stores flags only, with no document paths, mined text, thread numbers or session ids. The per-cell counts are derived from those flags. Agreement and the second-labeler swaps are recorded header values, because they need document-level labels that are not kept. `tests/unit/decision-store-trial-fixtures.test.ts` recomputes every cell count from the flags and checks the shape.

## Related

- `docs/solutions/best-practices/count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md`: the evaluation whose method this trial reused, and whose source-mix caveat (most needs are PR titles) applies here too.
- `docs/solutions/best-practices/search-kinds-separately-instead-of-one-merged-ranking-2026-10-31.md`: why the researcher searches one kind per call.
- `docs/plans/2026-11-01-001-feat-decision-store-trial-plan.md`: the trial plan.
