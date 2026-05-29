---
name: running-with-without-evals
description: Use when producing or refreshing a "with vs without Systematic" demo, an A/B plugin evaluation, or any recorded-session comparison of OpenCode behavior with and without a plugin loaded — for a public page, a credibility artifact, or internal validation.
---

# Running With/Without Evals

## Overview

A with/without eval captures real `opencode run` transcripts on the same task, once with a plugin loaded and once without, to show what the plugin actually changes. The output is **recorded sessions**, not a benchmark.

**Core principle:** the result is only worth publishing if it would survive a hostile reader who has the transcripts. That means pre-registering the bar before you run, keeping a clean baseline, including the control that could disprove your thesis, and conceding what the baseline already does well.

The reusable harness lives at `tests/manual/with-without-eval/run-arm.sh`. Reuse it; don't reinvent the isolation.

## When to use

- Building or refreshing the `with-without-systematic` demo page
- Validating that a plugin/skill change actually moves model behavior
- Producing a credibility artifact for public promotion

## When NOT to use

- You need statistical claims — this is n=1–3 recorded sessions, not a benchmark. Don't dress it up as one.
- The task is trivial (the baseline will look fine and the eval proves nothing)

## The method

1. **Pre-register first.** Write the task, the models, and the publishable-delta bar to a `PRE-REGISTRATION*.md` BEFORE any run. State the no-ship condition (if the bar isn't cleared, ship an honest decision guide, not a staged win). Committing this first is what lets you claim the result wasn't retrofitted.
2. **Run each arm** via `run-arm.sh <baseline|treatment> <model> <prompt-file> <out-dir> [seed-dir]`. Baseline = `--pure` + empty plugin array; treatment = plugin loaded. Use a **paid model** — free models rate-limit and the failure masquerades as empty output.
3. **Verify the baseline is clean and the treatment loaded** — the script checks `systematic_skill` is absent (baseline) / present (treatment). A contaminated baseline is a dishonest demo.
4. **Add the controls that matter** (see below) before drawing conclusions.
5. **Have Oracle review the methodology and the drafted page** before publishing. Council for the design if the matrix is non-trivial.

## Isolation recipe (the part that bites)

Redirect **only `XDG_CONFIG_HOME`** to drop the user's global config and its MCP servers for a vanilla baseline. Do **NOT** redirect `XDG_DATA_HOME` (holds `auth.json` — the paid model won't authenticate) or `XDG_CACHE_HOME` (holds the model catalog — `ProviderModelNotFoundError`). `OPENCODE_CONFIG_DIR=<empty temp>` skips the project-level user config; `OPENCODE_CONFIG_CONTENT` sets the per-arm plugin array. This is the minimum isolation that works — heavier isolation breaks auth and model resolution.

## Required controls

- **Prompt-parity control.** Run a no-plugin arm whose prompt also says "brainstorm, plan, implement, review." This separates "asking for review" from "the plugin." If the plugin's only effect is reproducible by a better prompt, the honest thesis is narrower — say so. This control is non-negotiable; it is the first thing a skeptic will ask for.
- **Variance on the headline cell.** Run the bare baseline n=3. If it misses the key risk 3/3, that's a real signal. Publish the median; never cherry-pick from k runs.
- **Seed the workspace for tasks that assume existing code.** A task like "add OAuth to my Express app" stalls in an empty temp dir — the model asks for files. Pass a `seed-dir` with a realistic pre-existing app. The seed must NOT hint at the task's solution (that contaminates the baseline upward).

## Honest framing (non-negotiable)

- Frame as **"recorded sessions," not "evaluation" or "benchmark"** — the word benchmark invites scrutiny n=1 can't survive.
- **Concede baseline competence up front.** Modern models write solid first drafts. Claiming otherwise loses the technical reader in paragraph one. The claim is the *process gap* (review happens at all), not a *quality gap*.
- **Feature the prompt-parity control prominently**, including in any summary table. Burying it is the difference between a credible artifact and marketing sludge.
- **State exact n per condition** and disclose that the treatment prompt differs (it invokes the workflow — that's how the plugin is used).
- Real transcripts only. If a result underwhelms, fix the product or narrow the framing — never edit the transcript.

## Common mistakes

| Mistake | Fix |
|---|---|
| Empty workspace for a task that assumes existing code | Seed the workspace; verify the model has files to modify |
| Redirecting all XDG dirs for "clean" isolation | Only `XDG_CONFIG_HOME`; the others hold auth + model catalog |
| Free model "returns nothing" | It's a rate limit, not a harness bug — use a paid model |
| `grep -c` in the verdict aborts the script under `set -e` on a zero (clean baseline) match | Guard the grep (`|| true`); exit on the run's real code |
| Omitting the prompt-parity control | A skeptic will assume the gain is just "you told it to review" |
| "Same prompt, only difference is the plugin" | The treatment prompt invokes the workflow — disclose it, don't claim parity |
| Publishing n=1 as a benchmark | Call them recorded sessions; state every n |

## Reference

- Harness + prompts + pre-registrations + raw transcripts: `tests/manual/with-without-eval/`
- Public artifact produced from it: `docs/src/content/docs/guides/with-without-systematic.mdx`
- Isolation lineage: `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md`
