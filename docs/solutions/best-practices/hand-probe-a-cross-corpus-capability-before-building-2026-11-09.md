---
title: Hand-probe a cross-corpus capability before building it, and claim only what a citation check shows
date: 2026-11-09
category: best-practices
module: ce-connect
problem_type: best_practice
component: development_workflow
severity: medium
symptoms:
  - "Requirements for a cross-project capability cite no real contradiction or repeated lesson, and the full build is scheduled before any value probe"
  - "A stale-citation check passes a citation whose line number still exists but whose cited code has moved"
applies_when:
  - "A feature's value depends on what already exists in other corpora, such as cross-project search, deduplication or sibling-project tooling"
  - "Designing a check that reports whether references in documents still hold"
  - "Writing a claim that rests on `path:line` citations"
tags:
  - ce-connect
  - probe
  - cross-project
  - citations
  - stale-citation-check
  - evaluation
  - measurement
---

# Hand-probe a cross-corpus capability before building it, and claim only what a citation check shows

## Context

`ce:connect` finds contradictions between learnings and lessons that one project recorded and a sibling project still needs. Its requirements, as first written, cited no real instance of either. The whole build (helper, agent, ledger, host enforcement) was scheduled before anyone had looked at whether the corpora held any. Reviewing the requirements raised that gap and a second one: the stale-citation check as specified compared a file and a line number, which passes when the text at that line has moved.

This doc records the probe that closed the first gap and the claim limits that closed the second. The measurement style it follows is the one in [count real lexical misses before adding an embeddings lane](count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md): count real cases first, then decide.

## Guidance

### Probe by hand before building

Run the smallest version of the capability by hand, over the real corpora, and let a person judge the output before any code exists.

1. **Pin the corpora.** Record the revision of every repository read. The probe covered 328 learnings across three repositories at pinned revisions.
2. **Use a read-only lane** with a bounded question: contradictions between two learnings, and lessons one project recorded that another shows the failure for and has not recorded.
3. **Check every quoted excerpt against its source** with a fixed-string search. Every excerpt in the probe matched.
4. **Have a person judge each candidate** and fix the gate beforehand. The probe passed when people promoted candidates.

The probe returned five candidates, all lessons to carry to another project and none a contradiction. A maintainer promoted three of the first four and called the fourth real but not worth fixing. That was enough to justify the build. It also showed that in this sample, lessons to carry over were far more common than contradictions.

### Read the probe for design, not just for a verdict

Five findings shaped the helper and the researcher:

- **Evidence mostly lives outside the learnings.** It was in code, workflows and config. A candidate needs a step that turns a rule into a repository search, so the design reads tracked code as well as documents.
- **Summarize a rule, do not read it whole.** `applies_when` plus the Guidance and Prevention sections are the compact summary of a learning. Extract those.
- **One rule family at a time.** An all-to-all comparison is unbounded and unreadable.
- **Same-subject pairs usually turn out compatible.** A contradiction needs the same contract in the same situation, and an empty contradiction result is a plausible outcome, not a bug.
- **Tool output truncation is a real limit.** Write per-document summaries to disk and page through them. The same limit later truncated a long single-line data file; see [the line-capped read tool](../integration-issues/line-capped-read-tool-truncated-single-line-json-2026-11-09.md).

State what the probe did not read. It read titles and status for all 328 documents and about 30 in full, so a probe result is evidence about candidates and says nothing about what it missed.

### Say what a citation check can claim

The check compares a symbol inside the cited span instead of trusting the line number: `checkCitation` (`src/lib/connect-evidence.ts:540-570`) returns `passed`, `not-in-span` (with `foundElsewhere`) or `unchecked`. The verdicts, the cap (`maxCitationsPerProject`, 500, in `CONNECT_BOUNDS`, `src/lib/connect-evidence.ts:51-68`) and the safe-read mechanics are defined in [the evidence boundary doc](evidence-boundary-for-reading-other-repositories-2026-11-09.md). What matters for a claim built on it:

- **`passed` means the name is in those lines.** It does not mean the sentence beside the citation is still true, and a verdict is not a diff.
- **No citations is not all citations holding.** `reportProjectCitations` (`src/lib/connect-evidence.ts:751-785`) marks a project `unsupported` when none of its documents holds a `path:line` citation. In a hand count at planning time, only 42 to 46 of 137 learnings in one corpus used that form (counted once, not re-checked; the evidence boundary doc cites 46), so a claim that depends on citations overclaims for the rest.
- **Past the cap, the rest were not checked.** Report that as a fact about coverage, not as a failure; [the evaluation protocol doc](pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md) shows what happens when a bound is treated as a failure.

Phrase results as counts of what was examined (checked, holding, not in span and how many of those moved, unchecked by reason), never as "this learning is current".

## Why This Matters

A capability built on an unprobed premise can be correct, well tested and useless. The probe was a read-only pass by hand, and it supplied the first real instances the requirements lacked. A citation check that overstates its result is worse than none: people stop re-reading a learning because a tool called its references fresh.

## When to Apply

- Before building anything whose value is "what exists elsewhere": search lanes, dedup, sibling-project tooling, cross-repository audits.
- When requirements cite no real instance of the thing the feature finds.
- When specifying or documenting any check on references, links or citations.

## Examples

**Overclaim:** "All citations in this project still hold."

**Claim the check supports:** "Checked `<n>` of `<total>` citations (the cap was reached). `<a>` hold, `<b>` are not in the cited lines (`<c>` of those occur elsewhere in the file), `<d>` could not be checked. Learnings without `path:line` citations were not examined."

## Related

- [Count real lexical misses before adding an embeddings lane to search](count-real-lexical-misses-before-adding-an-embeddings-lane-2026-11-01.md)
- [Mining real needs cannot settle whether an external decision store matters](mining-real-needs-cannot-settle-whether-a-decision-store-matters-2026-11-02.md)
- [Evidence boundary for reading other repositories](evidence-boundary-for-reading-other-repositories-2026-11-09.md)
- [Pre-registered evaluation of a model-driven tool](pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md)
