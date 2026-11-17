---
name: running-with-without-evals
description: Use when producing or refreshing a "with vs without Systematic" demo, an A/B plugin evaluation, or any recorded-session comparison of OpenCode behavior with and without a plugin loaded, or between two builds or skill-text trees of the same plugin — for a public page, a credibility artifact, or internal validation.
---

# Running With/Without Evals

## Overview

A with/without eval captures real `opencode run` transcripts on the same task, once with a plugin loaded and once without, to show what the plugin actually changes. The output is **recorded sessions**, not a benchmark.

**Core principle:** the result is only worth publishing if it would survive a hostile reader who has the transcripts. That means pre-registering the bar before you run, keeping a clean baseline, including the control that could disprove your thesis, and conceding what the baseline already does well.

The reusable harness lives at `tests/manual/with-without-eval/run-arm.sh`. Reuse it; don't reinvent the isolation.

## When to use

- Building or refreshing the `with-without-systematic` demo page
- Validating that a plugin/skill change actually moves model behavior
- Comparing two skill-text trees (a candidate edit against the shipped text) through the real host; see [Comparing two skill-text trees](#comparing-two-skill-text-trees)
- Producing a credibility artifact for public promotion

## When NOT to use

- You need statistical claims — this is n=1–3 recorded sessions, not a benchmark. Don't dress it up as one.
- The task is trivial (the baseline will look fine and the eval proves nothing)
- The ask is a skill edit. Test it with `writing-skills` RED/GREEN scenarios first, and build an eval only when someone asked to measure ([Size a skill refresh to the ask](../../../docs/solutions/workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md))

## The method

1. **Pre-register first.** Write the task, the models, and the publishable-delta bar to a `PRE-REGISTRATION*.md` BEFORE any run. State the no-ship condition (if the bar isn't cleared, ship an honest decision guide, not a staged win). Committing this first is what lets you claim the result wasn't retrofitted.
2. **Run each arm** via `run-arm.sh <baseline|treatment> <model> <prompt-file> <out-dir> [seed-dir]`. Baseline = `--pure` + empty plugin array; treatment = plugin loaded. Use a **paid model** — free models rate-limit and the failure masquerades as empty output.
3. **Verify the baseline is clean and the treatment loaded** — the script checks `systematic_skill` is absent (baseline) / present (treatment). A contaminated baseline is a dishonest demo.
4. **Add the controls that matter** (see below) before drawing conclusions.
5. **Have Oracle review the methodology and the drafted page** before publishing. Council for the design if the matrix is non-trivial.

## Isolation recipe (the part that bites)

`run-arm.sh` runs both arms under a **private temp `HOME`** (with `XDG_CONFIG_HOME` inside it). Systematic reads its config through `HOME`, not `XDG_CONFIG_HOME`: `<homedir>/.config/opencode` (`os.homedir()`) plus the `OPENCODE_CONFIG_DIR` directory (`src/lib/search-user-config.ts:872-883`, called from `src/lib/config.ts:3519`). Redirecting only `XDG_CONFIG_HOME` would leave the user's `systematic.jsonc`, including any `agents.<name>.model` overlay, in the treatment arm. The private `HOME` also drops OpenCode's global `opencode.json`, its MCP servers and the `~/.agents` and `~/.claude` skill dirs from both arms.

The script pins `XDG_DATA_HOME` (holds `auth.json`, or the paid model won't authenticate) and `XDG_CACHE_HOME` (holds the model catalog, or `ProviderModelNotFoundError`) to the real paths and reads `auth.json` in place. `OPENCODE_CONFIG_CONTENT` sets the per-arm plugin array.

**The trade-off.** A private `HOME` flattens the owner's per-agent routing: every subagent runs the arm model. The script writes `<out-dir>/<arm>.models.txt` with the model of every child session, so state in the result which models ran and that routing was flattened. An eval that must run the owner's real routing needs a different harness.

**Auth.** The script loads no auth plugins, so OAuth-only providers (for example `anthropic`) do not resolve from `auth.json`. Check with `opencode models <provider>` before a paid run. For those, export `CLIPROXY_API_KEY` to opt in to the CLIProxy route: both arms point the `anthropic` and `openai` providers at `https://cliproxy.fro.bot/v1` (model ids stay `anthropic/claude-sonnet-5-5`), the key lives only in a mode-0600 `auth.json` in a private data dir deleted on exit, and the script fails the run if `<out-dir>` contains the key (`key_leak_files`). Paid calls use only the routes the owner has approved. This is configuration isolation, not a sandbox: agent shell commands run as the same user and can read that `auth.json` or reach the network, and the scan catches only the literal key. Use a key scoped to evals.

Read [An eval of a multi-agent workflow must run the real system](../../../docs/solutions/best-practices/an-eval-of-a-multi-agent-workflow-must-run-the-real-system-2026-11-16.md) before you evaluate a workflow that dispatches subagents.

## Comparing two skill-text trees

`run-arm.sh` computes the plugin path from its own location (`REPO_ROOT`, then `$REPO_ROOT/dist/index.js`), and it treats any arm name other than `baseline` as a treatment arm. To compare two trees, build each in its own checkout or worktree and run that checkout's copy of the script. Give each run its own output directory: the transcript is named `<arm>.jsonl`, so two runs into one directory overwrite each other. Keep the model, prompt, seed and config identical, and pre-register which tree is the reference. The script's `baseline` arm is not a "shipped tree" arm: it runs with no plugin at all.

Set the attempt time limit from observed wall times before the run, because a limit that binds harder on the candidate tree turns a signal into a null. See the linked doc above.

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
| Redirecting all XDG dirs for "clean" isolation | Private `HOME` + `XDG_CONFIG_HOME`; pin `XDG_DATA_HOME`/`XDG_CACHE_HOME` to the real paths (auth + model catalog) |
| Free model "returns nothing" | It's a rate limit, not a harness bug — use a paid model |
| `grep -c` in the verdict aborts the script under `set -e` on a zero (clean baseline) match | Guard the grep (`|| true`); exit on the run's real code |
| Omitting the prompt-parity control | A skeptic will assume the gain is just "you told it to review" |
| "Same prompt, only difference is the plugin" | The treatment prompt invokes the workflow — disclose it, don't claim parity |
| Publishing n=1 as a benchmark | Call them recorded sessions; state every n |

## Reference

- Harness + prompts + pre-registrations + raw transcripts: `tests/manual/with-without-eval/`
- Public artifact produced from it: `docs/src/content/docs/guides/with-without-systematic.mdx`
- What an eval of a multi-agent workflow must hold fixed: [An eval of a multi-agent workflow must run the real system](../../../docs/solutions/best-practices/an-eval-of-a-multi-agent-workflow-must-run-the-real-system-2026-11-16.md)
- Pre-registering an evaluation of a model-driven tool: [Evaluate a model-driven tool with a pre-registered protocol](../../../docs/solutions/best-practices/pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md)
