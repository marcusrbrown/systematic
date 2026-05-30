# With/Without Systematic — Pre-Registered Evaluation

**Status:** RESULT RECORDED (rubric below was written BEFORE any trial run)
**Date:** 2026-05-29
**Plan unit:** U3 (docs/plans/2026-05-27-001-feat-promotion-and-growth-plan.md)

## RESULT (recorded after running — publishable delta confirmed)

2×2: {gpt-5.5, opencode-go/kimi-k2.6} × {without, with-workflow-invoked}.

| Cell | Wall time | Process | Review |
|------|-----------|---------|--------|
| gpt-5.5 without | 56s | single response | none (competent SQL: CONCURRENTLY, batched commits, GREATEST/NULL, trigger, down) |
| gpt-5.5 with | 9m8s | ce:brainstorm→plan→work→review + TDD | 7 review subagents, 5 revisions; caught FOR-EACH-ROW WAL amplification, DROP/CREATE-TRIGGER triggerless-window race (stale data), unbounded full-scan backfill, missing lock/statement timeouts |
| kimi-k2.6 without | 1m53s | single response (used write/glob/bash) | none (competent SQL + "before you run" checklist + rationale table) |
| kimi-k2.6 with | 6m44s | ce:brainstorm→plan→work→review | inline self-review, severity table (P2/P3/Advisory), applied P2 fixes |

Baseline skipped ≥2 rubric criteria (planning artifact, tests, review pass, knowledge capture = 4/5) → **PUBLISHABLE per pre-registered bar.**

**Honest framing (data-supported, non-overclaiming):** Both models write competent FIRST-DRAFT SQL unaided — the "without" baseline is not incompetent. Systematic's value is the structured review loop surfacing non-obvious production risks a one-shot misses, on BOTH frontier and open-source models. Frontier models exploit the review machinery more deeply (independent subagent dispatch + more revisions); the open model did a lighter inline review. Demo must NOT claim "Systematic makes bad code good" — it makes the review step happen at all.

Raw transcripts: results/{baseline,treatment}.jsonl (gpt-5.5), results-kimi/{baseline,treatment}.jsonl (kimi).

This document is written and committed BEFORE running any trial, so the evaluation
cannot be retro-fitted to a flattering result. If the result does not meet the
publishable-delta bar below, the page becomes an honest "where Systematic helps /
where it doesn't" decision guide (no-ship condition), not a staged win.

## Models

- Primary: `openai/gpt-5.5` (frontier, paid — avoids free-model rate-limit masquerade)
- Comparison (GATED on a publishable primary result): `opencode-go/kimi-k2.6` (open-source)

## Task (committed before running — do NOT swap to a more flattering task post-hoc)

**Chosen class:** _[FILLED IN PHASE A — see "Task choice" below]_

Two candidate classes from the plan; exactly one is run:
1. OAuth login flow (security + edge cases surface in review)
2. Database migration with backfill (planning + data-integrity decisions surface)

## Arms

- **WITHOUT (baseline):** OpenCode with NO plugins loaded. Same model, same prompt,
  clean isolated config. Verify `systematic_skill` tool + `/ce:*` commands are ABSENT
  before accepting the run.
- **WITH (treatment):** OpenCode with Systematic loaded (`dist/index.js`). Same model,
  same task. _[Treatment style — presence-only vs workflow-invoked — see OPEN DESIGN
  DECISION below; confirmed before run.]_

## Isolation recipe (minimum that matters — per reliable-cli-integration-testing-2026-04-26)

```
OPENCODE_CONFIG_DIR=<empty mktemp -d>           # skip user ~/.config/opencode
OPENCODE_CONFIG_CONTENT='{"plugin":[...]}'      # [] for baseline, [file://dist/index.js] for treatment
opencode run --format json -m openai/gpt-5.5 "<prompt>"   # --pure on baseline arm
```
- Paid model is deliberate (free models rate-limit and masquerade as failures).
- Same `--dir` (same fresh project workspace) + same prompt across both arms.
- Capture full JSONL; extract text + tool parts.

## Pre-registered publishable-delta bar (decide BEFORE seeing output)

The WITH run must demonstrate a CLEAR, HONEST improvement over WITHOUT on the SAME task.
Publishable if the WITHOUT run skips **≥2 of** the following that the WITH run does NOT skip:

1. **Explicit planning step** before writing code (decomposition, sequencing)
2. **Named edge cases** (e.g. token refresh/expiry for OAuth; rollback/partial-failure for migration)
3. **Project-standard adherence** (tests, types, error handling as first-class — not afterthought)
4. **A review/verification pass** (self-review, security/data-integrity check)
5. **Knowledge capture** (what was learned / why decisions were made, persisted)

Quantitative anchors recorded for both arms (descriptive, not the gate):
- # distinct workflow phases observed
- # edge cases named
- whether tests were written
- whether a review/verification step occurred

## No-ship condition (explicit failure branch — NOT a fallback to fabrication)

If the WITH run does NOT clear the ≥2-skip bar, DO NOT publish a with/without win.
Instead author an honest decision guide: "When Systematic helps / when raw prompting
is fine" — using the real (underwhelming) transcripts as evidence. An honest "it
depends" page beats a staged victory.

## Honesty constraints

- Real transcripts only. No idealization, no editing the model's output to look worse/better.
- If the demo underwhelms, the binding constraint is "fix the product or change the
  framing," never "fabricate the transcript."
- Baseline contamination = dishonest demo. Verify clean baseline every run.

## OPEN DESIGN DECISION (confirm before frontier burn)

**Treatment-arm style** — two honest options, materially different:

- **(A) Presence-only:** load Systematic, same single prompt as baseline, observe whether
  the bootstrap injection alone nudges gpt-5.5 toward structured behavior. Tests "what does
  merely installing it do in a one-shot run." Weaker but maximally apples-to-apples.
- **(B) Workflow-invoked:** the WITH prompt explicitly drives the Systematic workflow
  (brainstorm → plan → work → review), matching how a user actually uses it. Tests the real
  product value. Stronger delta, but the prompt differs between arms (workflow invocation),
  which must be disclosed in the demo as the honest framing ("this is how you use it").

The plan's D3 describes the WITH flow as "brainstorm→plan→work→review" → leans (B).
Recommendation: **(B) workflow-invoked**, disclosed plainly, because it reflects real
usage and the demo's job is to show what the product does when used as intended. (A) risks
a falsely-weak result that misrepresents the product (one-shot bootstrap nudging is not
the value proposition).
