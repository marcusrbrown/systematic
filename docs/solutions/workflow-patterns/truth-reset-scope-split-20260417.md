---
title: 'Truth Reset: Narrow Initiatives Outperform Bundled Ones, and Document-Review Convergence Is a Scope Signal'
date: 2026-04-17
severity: medium
category: workflow-patterns
component: ce-brainstorm-to-ship-pipeline
tags:
  - workflow-patterns
  - scope-management
  - document-review
  - ce-brainstorm
  - ce-plan
  - ce-work
  - credibility-repair
  - initiative-sizing
environment: 'Systematic plugin / ce:brainstorm → ce:plan → ce:work pipeline'
symptoms:
  - "Bundled 'credibility reset' plan (24 requirements, 20 implementation units, 3 PRs, 3.0.0 major bump) produced reviewer convergence on 'overscoped'"
  - 'Three independent persona reviewers (product-lens, scope-guardian, feasibility) arrived at the same recommendation from different angles'
  - "First attempt mixed three distinct initiatives (trust repair, portfolio rationalization, infra improvements) that share a theme but have different risk profiles and user impact"
root_cause: "A single plan that addresses multiple distinct problem classes simultaneously accumulates risk from all of them while providing value only proportional to the smallest shippable subset. Narrow initiatives let trust repair ship cleanly as a minor release while deferring breaking catalog changes and infrastructure improvements to their own dedicated cycles — each with its own brainstorm, research, and plan rather than inherited scope from an overstuffed parent."
resolution_type: workflow_improvement
confidence: verified
related:
  - docs/solutions/integration-issues/zsh-for-loop-word-splitting-silent-failure-20260417.md
  - docs/solutions/workflow-issues/reconciliation-sync-reference-integrity-20260417.md
  - docs/solutions/workflow-patterns/iterative-oracle-plan-review.md
---

# Truth Reset: Narrow Initiatives Outperform Bundled Ones, and Document-Review Convergence Is a Scope Signal

## Problem

A public-facing trust gap (README claiming `48 skills / 29 agents` vs reality of `45 / 49`, OCX bundles advertising parity but registering subsets, three stale GitHub issues referencing a deleted sync workflow) prompted a "credibility reset" plan. The first plan tried to solve:

1. **Trust repair** — fix README, AGENTS.md, OCX bundles, close stale issues
2. **Portfolio rationalization** — consolidate `lfg/slfg`, retire `ce-work-beta`, merge todo trio, delete `setup`/`orchestrating-swarms`
3. **Infra improvements** — OCX registry auto-generation, CI drift gate, validation.ts tests, bootstrap.ts tests, delete legacy `commands/` dir

The combined scope: 24 requirements, 20 implementation units, 3 sequential PRs, a `3.0.0` major bump with a `BREAKING CHANGE:` commit footer. Document-review spawned five persona reviewers in parallel (feasibility, product-lens, scope-guardian, adversarial, coherence). Four completed (coherence hit a bundled-agent config bug unrelated to the plan). Three of the four reviewers independently, from different angles, arrived at "this plan is overscoped — split it".

## Symptoms

- **Plan length:** 1121 lines, 20 implementation units, 13 top-level sections
- **Version bump required:** 3.0.0 major, breaking changes across skill names/registry/OCX bundles
- **Sequential PR count:** 3 (A+B pair → C+D atomic pair → E+F pair)
- **Reviewer convergence on "overscoped":**
  - product-lens: "3.0.0 bump is cosmetic — all 'breaking' changes are graceful degradations. Reserve majors for capability stories."
  - scope-guardian: "The stated problem was docs accuracy. The plan solves that plus 12 other things."
  - feasibility: "PR 2 atomicity risk — Unit 10 (orchestrating-swarms rewrite, now known to be 114 refs across 1718 lines) may block Units 12+."
- **Adversarial reviewer:** flagged missing rollback procedure and OCX protocol compatibility gate (different class of finding)

## What Didn't Work

**First-pass plan writing: "solve all related problems in one coherent release."** The problems *were* related (all stem from public-facing truth drift in Systematic's catalog + infrastructure), but "related" is not the same as "ship-together". Related problems share root themes; ship-together problems share risk profiles and user impact.

**Treating reviewer findings as a checklist of autofixes.** The first instinct on receiving 22 reviewer findings was to apply the obvious autofixes (9 mechanical fixes applied successfully) and consider the review done. But the three overlapping scope findings were not autofixable — they were signals that the *structure* of the plan was wrong, not that individual units needed tweaking.

**Assuming the brainstorm would catch scope issues.** The brainstorm (via `ce:brainstorm`) did produce a 24-requirement document, and the plan (via `ce:plan`) faithfully implemented all 24 requirements. Neither step failed; they correctly executed a scope that was never challenged upstream. The challenge came only at document-review time.

## Solution

**Split the bundled initiative into three narrow initiatives, each with its own brainstorm → plan → ship cycle:**

| Initiative                        | Scope                                                              | Release   | PRs |
| --------------------------------- | ------------------------------------------------------------------ | --------- | --- |
| **#1 — Truth Reset**                  | README/AGENTS.md/docs accuracy, CEP divorce, sub-file sync, issues | 2.4.0 minor | 1   |
| **#2 — Portfolio Rationalization** | Catalog consolidation, breaking skill-name changes                 | 3.0.0 major | 1-3 |
| **#3 — Infra Improvements**           | OCX automation, CI gates, test coverage, legacy cleanup            | 2.5.0 minor | 1-2 |

The superseded plan (`docs/plans/2026-04-17-001-refactor-credibility-reset-plan.md`) was kept on-disk with `[SUPERSEDED]` frontmatter marker and a link to the new plan. Its research (CEP precheck analysis, test-coverage gap audit, OCX parity analysis) remained valuable for Initiatives #2 and #3 when those are brainstormed.

The narrow plan (`docs/plans/2026-04-17-002-refactor-truth-reset-plan.md`) cut scope to 10 requirements, 7 implementation units, 1 PR, 2.4.0 minor — 60% reduction.

## Why This Works

**Minor releases have different consumer impact than major releases.** Users on 2.x don't think twice about 2.4.0. Users on 2.x think carefully about 3.0.0, read migration guides, pin versions. Wrapping graceful-degradation catalog changes in a 3.0.0 bump creates cognitive overhead proportional to the bump label, not the actual impact.

**Trust repair and catalog rationalization have different risk profiles.** Trust repair is low-risk (string edits, count fixes, doc updates, infrastructure deletions verified by zero-consumer checks). Catalog rationalization is higher-risk (breaking skill-name invocations, retiring beta skills, rewriting or deleting a 1718-line skill). Bundling them makes the whole release as risky as the riskiest component.

**Document-review convergence reveals structural plan issues.** A single reviewer flagging "overscoped" is a data point. Three reviewers independently arriving at the same recommendation from different angles (business impact, catalog hygiene, implementation atomicity) is a structural signal. The plan is genuinely miscalibrated; treat the convergence as decisive.

## Prevention

**When convergence happens, split — don't argue.** If 2+ document-review personas flag "scope" (under any framing: overscoped, multi-theme, bundled, unclear release label, atomicity concerns), treat it as a scope-split signal rather than individual findings to address. The specific recommendation of each reviewer may differ; what matters is the convergence on "structure of the plan is wrong".

**Decision rule for "should this be one plan or three?":**

Ask: *"Can the smallest shippable subset of this plan stand alone as a complete deliverable with its own rationale?"* If yes, split the subset out. Repeat. The remaining work becomes Initiative #2, #3, etc. — each with its own brainstorm when the time comes.

Signs a plan should be split:

- **Version-bump magnitude disagreement** between sections (e.g., some units are clearly minor, others clearly major)
- **Risk-profile variance** (some units are string edits; others are rewrites or deletions with ripple effects)
- **User-impact variance** (some units are invisible to users; others change invocation names or require migration)
- **Sequential-PR requirement** (if Units A+B must land before C+D can start, that's a strong signal for A+B being a distinct deliverable)
- **Reviewer convergence on scope** (the direct evidence)

**Write plans for the shipping cadence, not for the research cadence.** A brainstorm can legitimately explore 24 requirements across three themes. A plan is not a transcription of the brainstorm — it's a scoping of which subset ships now. When the brainstorm output feels like a plan, rewrite until it becomes a scoping decision tree. The 001 → 002 supersession in this cycle is the archetype: the brainstorm output was saved in Plan 001; Plan 002 chose the narrowest viable subset and deferred the rest.

**Archive superseded plans, don't delete them.** Their research artifacts remain valuable for the deferred initiatives. Supersede via frontmatter (`status: superseded`, `superseded_by: <new-plan-path>`) rather than deletion.

**Memory:** this pattern is worth invoking by name — "document-review convergence" — in future plan reviews. When a plan reviewer says "this might be overscoped," ask: "do we have convergence?" If yes, split is the default action; bundling requires explicit justification.
