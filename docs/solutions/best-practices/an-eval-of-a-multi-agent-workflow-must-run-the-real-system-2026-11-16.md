---
title: An eval of a multi-agent workflow must run the real system, not a rewritten one
date: 2026-11-16
category: best-practices
module: skill-evals
problem_type: best_practice
component: testing_framework
severity: medium
symptoms:
  - "Reviewer subagents in an eval ran on a model the arm never named"
  - "A fix for config leakage forced every subagent onto one model"
  - "The treatment arm loaded the method in every attempt, and most attempts were cut off by the time limit"
  - "A first screen ran in a workspace without the files the fixtures read, so most attempts hit failed tool calls"
applies_when:
  - "Evaluating a workflow that dispatches subagents, such as ce:review, through the real OpenCode host"
  - "Comparing two skill-text trees, or a plugin on against off, with recorded sessions"
  - "Setting the attempt time limit or the credential route for a paid campaign"
  - "Replaying a seeded session in a sandboxed workspace"
tags:
  - evals
  - isolation
  - model-routing
  - time-limit
  - survivor-bias
  - fixtures
  - billing
related_components:
  - development_workflow
---

# An eval of a multi-agent workflow must run the real system, not a rewritten one

## Context

An evaluation of a skill edit ran `ce:review` through the real OpenCode host, with a skill-text tree under test in one arm. Before it measured anything, a leaked config overlay, a flattened model routing, a time limit and an incomplete workspace each changed the system under test. Every one of them still produced numbers.

## Guidance

1. **Look for the existing eval skill and harness first, and keep its description honest.** `.agents/skills/running-with-without-evals/SKILL.md` and `tests/manual/with-without-eval/run-arm.sh` already existed and were not loaded until the second day. Its description covered "with and without a plugin" demos, so a comparison of two skill-text trees did not match it. The description now names that case.

2. **Run the user's real per-agent model routing, or say plainly that you did not.** Systematic finds its user config the way OpenCode finds its own: `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is an absolute path, else `<homedir>/.config/opencode` through `os.homedir()` (`opencodeUserConfigDir` in `src/lib/opencode-config-dir.ts`), and it adds the `OPENCODE_CONFIG_DIR` directory. The eval in this note ran before Systematic honoured `XDG_CONFIG_HOME`: it read only `<homedir>/.config/opencode`, so redirecting `XDG_CONFIG_HOME` hid OpenCode's config and left the user's `systematic.jsonc` in place. A redirect of `XDG_CONFIG_HOME` now moves both, but no one variable is enough. `HOME` is the fallback when `XDG_CONFIG_HOME` is unset, empty or relative, and `OPENCODE_CONFIG_DIR` reaches the user's config on its own. Isolate `HOME`, every XDG root and `OPENCODE_CONFIG_DIR`, and pin only the roots the run needs, such as the data root that holds `auth.json`, on purpose. There are two options: keep the real config and report each child model, or use a private `HOME` and report that routing was flattened. The second removes the variable and the system with it, because a multi-agent workflow on one model is a different workflow. `run-arm.sh` now takes the second: both arms run under a private `HOME` and each arm writes `<arm>.models.txt` with the model of every child session (see the skill's [isolation recipe](../../../.agents/skills/running-with-without-evals/SKILL.md#isolation-recipe-the-part-that-bites)). An eval that must run the owner's real routing needs a different harness.

3. **Read the child sessions' models from the transcript before you read any result.** In the `--format json` event stream, each `task` tool event carries `state.metadata.model` with the child's `providerID` and `modelID`. A dry run of `ce:review` showed six reviewer dispatches per arm on `openai/gpt-6.1-terra`, a model from the leaked overlay. That one check would have caught the leak before any paid attempt.

4. **Size the attempt time limit from observed wall times on the treatment arm, and never score only what finishes.** The first held-out read ran a fire cell at 300 seconds. All 6 treatment attempts loaded `synthesis` early (calls 2 to 6), against 0 of 3 baseline attempts. Five of the six then ran past the limit doing the review work. A timeout is never counted, so the one counted attempt was the fastest of six, and the pre-registered keep rule ended in a null. The stage excluded 5 of 15 scheduled attempts, over the one-quarter stop rule, and all 5 were treatment attempts. Across the rerun, tuning and held-out campaigns, review attempts timed out 8 of 41 times in the baseline arm and 12 of 32 in the treatment arm, which is the signature of a limit that binds harder on the treatment.

   The follow-up gave review fixtures a 900-second limit in both arms and read a new twin set, so it is not a rerun of the first attempts. All 12 scheduled attempts completed and counted. The longest took 578 seconds, and 8 of the 12 ran past 300 seconds. The treatment hit the fire cell in 2 of 3 attempts against 0 of 3 for the baseline. Set the limit from timings before the read, give both arms the same one, and declare any replacement budget before the run. Source: the closed metacogs#109 branch, `evals/spikes/systematic-reflection/README.md`, sections "Held-out run", "Deviation 3" and "Held-out run 2".

5. **Name the credential route in the run's own configuration and refuse every other.** A dry run went to a provider route nobody had authorised and spent real money. The harness that followed accepted exactly two routes, the providers already in `auth.json` and a CLIProxy key, and refused the `opencode/*` hosted route. A brief that says "the configured provider" leaves the choice to whoever runs it. Name the route, and have the run script fail on any other. A private data directory holding a copy of a key protects nothing from the same user, whatever its file mode, so scope the key. The screen's 24 runs all used the CLIProxy route, and a scan of each run's artifacts for the key found none (`auth: cliproxy` and `key_leak_files: 0` in each run's `meta.json`).

6. **Check that the workspace holds what the fixtures read, then count failed tool calls per attempt before any paid read.** Gate the run on it. The first baseline screen ran each seeded attempt in an empty `git init` directory. Of its 21 attempts, 19 had at least one failed tool call, and 110 calls failed in total: 54 refused as outside the project, 28 for a missing file, 26 for a shell command refused by a permission rule. The fix wrote a repository payload into each attempt's workspace and added an exclusion gate, `seeded_repo_missing`.

7. **Prove the sandbox lets the workflow's own commands run, at no cost, before a paid run.** Two environment refusals followed the workspace fix: 18 shell heredocs failed because zsh writes a heredoc's temp file under `$TMPPREFIX` (`/tmp/zsh` by default), outside the write sandbox, and 18 reads of installed skill files failed under `external_directory: deny`. Point `TMPPREFIX` into the attempt's directory, and allow only the directory skills load from. A scripted-provider run on the real host, which costs nothing, shows that a heredoc and both skill reads complete and that `/etc/hosts` is still refused.

A skill edit that needs only wording checks does not need an eval. Use `writing-skills` RED/GREEN scenarios, and build an eval only when someone asked to measure ([Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md)).

## Related

- [Wire an optional companion skill into a workflow skill](wire-an-optional-companion-skill-into-a-workflow-skill-2026-11-16.md) is the change this eval was measuring, and the cheaper check that settled its wording.
- [Size a skill refresh to the ask](../workflow-issues/size-a-skill-refresh-to-the-ask-2026-10-25.md) records how the measurement grew past the ask.
- [Evaluate a model-driven tool with a pre-registered protocol](pre-registered-evaluation-of-a-model-driven-tool-2026-11-09.md) covers outcome labels, seeds and judges for the same kind of eval.
- [Prove a dispatched subagent reached a plugin tool on a real host](prove-a-dispatched-subagent-reached-a-plugin-tool-on-a-real-host-2026-10-31.md) is the integration-test counterpart for a child session.
- [Eval fixtures need headroom](https://github.com/marcusrbrown/metacogs/blob/main/docs/solutions/best-practices/eval-fixture-headroom-baseline-screen-before-skill-arm-2026-10-29.md) (metacogs) covers screening a baseline before a treatment arm.
- `.agents/skills/running-with-without-evals/SKILL.md` and `tests/manual/with-without-eval/run-arm.sh` are the harness.
