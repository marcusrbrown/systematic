---
title: "The fro-bot/agent action's runtime is not a plain runner: triggers, environment, .git, permissions and auth all differ"
date: 2026-11-13
category: integration-issues
module: ce-connect
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`Unsupported event type: push` and `Pull request is a draft`: the action skipped the spike runs"
  - "`Agent execution stopped: model provider authentication failed` with only `auth-json` set"
  - "`{\"ok\":false,\"op\":\"begin\",\"outcome\":\"failed\",\"reason\":\"state-root-refused\",\"detail\":\"checkout\"}` in a workspace with no checkout"
  - "A variable set in the agent step's `env:` was unset in the agent's shell, while `XDG_STATE_HOME` arrived"
root_cause: config_error
resolution_type: workflow_improvement
severity: medium
tags: [github-actions, fro-bot-agent, ce-connect, headless, env-allowlist, external-directory, state-root, opencode-v2]
last_refreshed: 2026-11-13
---

# The fro-bot/agent action's runtime is not a plain runner: triggers, environment, .git, permissions and auth all differ

## Problem

`.github/workflows/connect.yaml` runs `ce:connect` headless through the `fro-bot/agent` action (v0.140.2, [`1ffb6495`](https://github.com/fro-bot/agent/tree/1ffb6495501f12801f770fa0c0563d16450416e7), OpenCode v2 2.2.6). The skill and its helper were built against a plain shell and a local OpenCode session. Five assumptions from that setting failed under the action: which events it runs on, which environment variables reach the agent, whether the workspace is a checkout, where the agent may read, and which inputs authenticate the provider. Each cost a spike run on a temporary pull request (#1378), and each is cheap to design around once known.

## Symptoms

- Runs 43248361375 and 43255948537 (`push` events) and run 43259951125 (a draft pull request) ended with `Fro Bot skipped this event (unsupported_event): Unsupported event type: push` and `Fro Bot skipped this event (draft_pr): Pull request is a draft`.
- Run 43260271328 (`auth-json` only) ended `Agent execution stopped: model provider authentication failed.` Run 43260524551 added `opencode-config` and passed provider auth.
- Run 43267118777: the helper's `begin` answered `{"ok":false,"op":"begin","outcome":"failed","reason":"state-root-refused","detail":"checkout"}`. The state root sat under a workspace that no step had checked out.
- Same run: the agent's shell printed `XDG_STATE_HOME=/home/runner/work/systematic/systematic/state` and `SYSTEMATIC_CONNECT_RUN_MARKER=<unset>`. The runner's own `env:` listing for the step named both variables.

## What Didn't Work

- **Spiking from a branch with a `push` trigger.** The action does not handle `push`. The spike had to be a non-draft pull request with a `pull_request` trigger. Overriding `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` and `GITHUB_WORKSPACE` in the step's `env:` changed nothing.
- **Handing the run marker to the helper as an environment variable.** The helper reads a marker so it can tag its invocation record with the run; the first design passed it as `SYSTEMATIC_CONNECT_RUN_MARKER`. The agent's shell never saw it, so the helper would have written no record.
- **Assuming the v1 external-directory fix carries over.** [`opencode-v1-headless-external-directory-auto-reject-2026-11-09.md`](opencode-v1-headless-external-directory-auto-reject-2026-11-09.md) allows `external_directory` in the agent's frontmatter and in the user's host config. Under the action neither applies (see Solution 4).
- **Supplying only `auth-json`.** Provider auth failed (run 43260271328 above). The spike did not isolate why `opencode-config` is also needed.

## Solution

1. **Triggers.** The action handles `schedule` and `workflow_dispatch`; `push` is unsupported ([`skip-conditions.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/triggers/skip-conditions.ts#L9-L15)), and draft pull requests are skipped while its `skipDraftPRs` setting is on, which is the default ([`skip-conditions-pr.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/triggers/skip-conditions-pr.ts#L51-L57), [`types.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/triggers/types.ts#L176), `skipDraftPRs`). The workflow triggers on `schedule` and `workflow_dispatch` only (`.github/workflows/connect.yaml:18-21`). To spike a branch that is not on the default branch yet, open a ready pull request with a temporary `pull_request` trigger and close it afterwards.
2. **State travels in a file, not a variable.** The marker is written to `ci-run.json` in the state root by the `Write run marker` step (`.github/workflows/connect.yaml:458-467`), and the helper reads that file (`src/lib/connect-state.ts:1792`, `CI_RUN_FILE`). `tests/unit/connect-workflow.test.ts:537-550` fails if any step `env:` key names a marker or the old variable name reappears. `XDG_STATE_HOME` is the one variable the agent's shell needs; the layout step appends it to `$GITHUB_ENV` (`.github/workflows/connect.yaml:403-410`).
3. **The action leaves a `.git` directory in the workspace.** The directory is absent before the action step and present after it; the action's own log says the workspace is not a git repository. The helper treated any `.git` entry as a checkout and refused every state root under the workspace. The product fix, landed in #1380, counts a `.git` entry only when it is a regular file, a symlink, an entry that cannot be inspected, or a directory that holds `HEAD` (`src/lib/connect-config.ts:295-304`, `isGitEntry`). The same rule is why the `run` job checks out its own `.github/actions` into `.fro-bot-actions` and not at the workspace root: a real repository at the root holds a `HEAD`, and the helper would refuse every state root below it ([the composite learning](../best-practices/share-one-composite-agent-step-between-the-headless-and-interactive-workflows-2026-11-13.md)).
4. **Layout lives under the workspace.** The action's v2 config sets `external_directory` to `deny` for everything outside the working directory ([`ci-config-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/services/setup/ci-config-v2.ts#L246), `outsideEffect: 'deny'`) and strips `permission`, `permissions` and `tools` from the operator's `opencode-config` ([`ci-config-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/services/setup/ci-config-v2.ts#L86-L131), `stripOperatorPermissions`). The exceptions are run-scoped directories under `RUNNER_TEMP` and the skills directories. The agent's working directory is `$GITHUB_WORKSPACE`, so a layout that fits none of those exceptions has to live under it: the checkouts and the state root sit at `$GITHUB_WORKSPACE/connect/checkouts` and `$GITHUB_WORKSPACE/connect/state` (`.github/workflows/connect.yaml:403-410`), and `tests/unit/connect-workflow.test.ts:519-535` fails if a `run`-job step names `RUNNER_TEMP` or `runner.temp`.
5. **Auth needs two inputs.** The agent step passes both `auth-json` and `opencode-config` (`.github/workflows/connect.yaml:484-490`, `auth-json` and `opencode-config`).
6. **Least privilege holds.** The `run` job has `contents: read` only (`.github/workflows/connect.yaml:378-379`) and the step passes `response-mode: none` (`.github/workflows/connect.yaml:494`, `response-mode`). Run 43365759373's `run` job listed `Contents: read` and `Metadata: read` and ended `Connect complete`. The `render` job, under `permissions: {}`, confirmed repository visibility with the job token in the same run.

## Why This Works

The agent's shell does not inherit the action's environment. The action spawns the OpenCode server through a deny-by-default filter: a name survives only if it is in a fixed exact list (the `GITHUB_*` names it enumerates, `PATH`, `HOME` and similar) or starts with `OPENCODE_`, `RUNNER_`, `XDG_` or `LC_`, and a name that ends in `_TOKEN`, `_KEY`, `_SECRET` and a few similar suffixes is dropped even if it matches ([`filter-env.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/packages/runtime/src/agent/filter-env.ts#L7-L124), `EXACT_ALLOW_KEYS`, `ALLOW_PREFIXES` and `filterAgentEnv`; the server child's environment is built from it at [`server-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/packages/runtime/src/agent/server-v2.ts#L495), `filterAgentEnv`). `XDG_STATE_HOME` reached the agent because of its `XDG_` prefix, and `SYSTEMATIC_CONNECT_RUN_MARKER` matched nothing. How a variable was set (step `env:` or `$GITHUB_ENV`) was not the cause, and the spike never ran that split in isolation. The same filter fits a comment in the Fro Bot workflow that records `IS_SUNDAY_UTC` not reaching the agent (`.github/workflows/fro-bot.yaml:755-760`, `RUN_CONTEXT`). A file in the state root, which the helper reads from disk, does not depend on the filter.

Why the action leaves a `.git` directory is unknown.

A read-only job token is enough because the action with `response-mode: none` writes nothing to GitHub; the report is posted by a later job.

## Prevention

- Spike any headless skill through the action before building a workflow around it. Ask the agent to print `pwd`, a variable set in the step, one set through `$GITHUB_ENV`, and a directory listing; the answers settle the environment, working-directory and permission questions in one run.
- Treat every variable the agent's shell needs as a question about the allowlist. If its name is not in `EXACT_ALLOW_KEYS` and has none of the `ALLOW_PREFIXES`, send it in a file or in the prompt.
- Re-read `filter-env.ts` and `ci-config-v2.ts` at the new pin whenever the action ref changes. They are the two places where the action decides what the agent can see and read.
- Keep the layout and marker tests (`tests/unit/connect-workflow.test.ts:519-550`) so a refactor cannot move state back under `RUNNER_TEMP` or into an environment variable.

## Related Issues

- [`trusted-step-after-the-agent-needs-its-own-job-2026-11-09.md`](../security-issues/trusted-step-after-the-agent-needs-its-own-job-2026-11-09.md): the same job-isolation reasoning that keeps the credential-bearing step out of the `run` job.
- [`opencode-v1-headless-external-directory-auto-reject-2026-11-09.md`](opencode-v1-headless-external-directory-auto-reject-2026-11-09.md): the contrasting v1 external-directory fix.
- [`run-state-for-a-model-invoked-helper-2026-11-09.md`](../best-practices/run-state-for-a-model-invoked-helper-2026-11-09.md): why the helper needs a marker and a state root at all.
- #1378 (spike pull request), #1380 (helper `.git` rule and `ci-run.json`), #1386 (workflow).
