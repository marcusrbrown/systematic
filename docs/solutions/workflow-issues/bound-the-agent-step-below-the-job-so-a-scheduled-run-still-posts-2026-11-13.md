---
title: Bound the agent step below the job so a hung scheduled run still reads its record and posts
date: 2026-11-13
category: workflow-issues
module: ce-connect
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "A scheduled workflow runs an agent step whose result a later step in the same job reads"
  - "An action is configured with `timeout: 0`, so the step has no limit of its own"
  - "A workflow finds its own earlier output by title and author"
  - "A job hands files to later jobs through artifacts or a cache and must survive a failed-jobs rerun"
symptoms:
  - "A run cancelled by hand about 2.5 minutes into the agent step skipped every later step, cancelled `render` and `post`, and posted nothing"
  - "`gh issue list --json author` shows `app/github-actions` for an issue the REST API reports as `github-actions[bot]`"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags: [github-actions, timeout-minutes, continue-on-error, scheduled-workflow, ce-connect, artifacts, actionlint, report-author]
last_refreshed: 2026-11-13
---

# Bound the agent step below the job so a hung scheduled run still reads its record and posts

## Context

The `run` job of `.github/workflows/connect.yaml` has the action step, then a `Read run record` step, then hand-off steps. The jobs after it, `render` and `post`, write the report. The shared agent action (`.github/actions/fro-bot-agent/action.yml`) runs `fro-bot/agent` with `timeout: 0`, so the step had no limit of its own.

Run 43368318366 was cancelled by hand about 2.5 minutes into the agent step. Every later step in the job was skipped, `render` and `post` were cancelled, and no report was posted. A hung scheduled run would end the same way and leave no trace beyond a red job. A job-level `timeout-minutes` cancels the job, so it skips the later steps in the same way; that case was not run.

## Guidance

Give the agent step a timeout of its own that is shorter than the job's, and let the step fail without failing the job.

```yaml
run:
  timeout-minutes: 50
  steps:
    - name: Run ce:connect
      id: agent
      continue-on-error: true
      timeout-minutes: ${{ fromJSON(vars.FRO_BOT_CONNECT_STEP_TIMEOUT || '40') }}
      uses: ./.fro-bot-actions/.github/actions/fro-bot-agent
    - name: Read run record
      env:
        AGENT_OUTCOME: ${{ steps.agent.outcome }}
```

The step ends as a failed step when its timeout fires, and the job goes on (`.github/workflows/connect.yaml:471-479`, `continue-on-error` and `timeout-minutes`). The next step reads the helper's invocation record, not the step's exit, and decides the outcome from it (`.github/workflows/connect.yaml:511-555`, `Read run record`). The reader (`.github/workflows/connect.yaml:527-540`, `phase` and `outcome`) has three cases. A record with this run's marker in phase `begun` becomes the outcome `no-final-line` and is posted. A record with this run's marker in phase `terminal` keeps its own outcome. A missing record, a symlink or a record with another run's marker fails the step red, and nothing is posted. The `render` and `post` jobs run on the record, post the report, and a last `Settle result` step in `post` turns the workflow red so the failure stays visible.

Keep the step's bound below the job's. The `prepare` job rejects a `FRO_BOT_CONNECT_STEP_TIMEOUT` that is not a whole number of minutes below the job limit (`.github/workflows/connect.yaml:101-111`, `job_limit`), so a variable cannot lift the step past the backstop. The tests pin the expression and its fallback below the job timeout (`tests/unit/connect-workflow.test.ts:158-164`, `STEP_TIMEOUT_EXPRESSION`).

**Write the numeric field as `fromJSON(vars.X || '40')`.** actionlint's type check rejects the bare form for a numeric field. On a scratch copy of the workflow with the `queue:` line removed (actionlint 1.7.12 does not know that key), `timeout-minutes: ${{ vars.FRO_BOT_CONNECT_STEP_TIMEOUT || 40 }}` fails with `type of expression at "float number value" must be number but found type string`, and the `fromJSON(... || '40')` form passes.

**Match a workflow's own reports by exact author login.** The report lookup in `prepare` and `post` accepts only issues whose REST `user.login` is in the `REPORT_AUTHORS` list (`.github/workflows/connect.yaml:46`, `REPORT_AUTHORS`; `.github/workflows/connect.yaml:288-294`, `reports`). A report posted with the job token is `github-actions[bot]` in REST and `app/github-actions` in `gh issue list --json author`; both were seen for issue #1389. Use the form of the API the lookup reads. Anyone can open an issue with a matching title, so the title rule alone is not enough: the body of a report is read back for the operator's ticks. The test pins the list to the one login (`tests/unit/connect-workflow.test.ts:247-251`, `REPORT_AUTHORS`).

## Why This Matters

With the bound, a hang produces a posted report that says the run ended without a final line, and a red workflow, instead of a cancelled job with nothing posted.

### Live proof

Run 43475406631 was a dispatch with `FRO_BOT_CONNECT_STEP_TIMEOUT` set to `2`. Its log has `The action 'Run ce:connect' has timed out after 2 minutes.`, and the later steps then ran as designed. CN-6 in `HARNESSES.md` holds the full record.

## When to Apply

- Any scheduled job in which a trusted step after an agent step reads the agent's output. Put the bound on the agent step and decide the outcome from a record, not from the exit status.
- Any workflow that matches its own earlier issues, comments or releases by title. Add the author.
- Any workflow that passes files between jobs and may be rerun with only the failed jobs.

## Examples

**Artifact names and the cache save (not observed live).** These guards are backed by the workflow and its tests, not by a failing run.

`actions/cache/save` exits 0 when it saved nothing, so its outcome proves nothing. The `Confirm ledger cache` step restores the same key with `lookup-only: true`, and a miss counts as a failed save (`.github/workflows/connect.yaml:798-812`, `Confirm ledger cache`).

A rerun of only the failed jobs raises `run_attempt`, while skipped jobs keep the artifacts they uploaded under the old attempt. A job that rebuilt the artifact name from `github.run_attempt` would look for a name that does not exist. So each producing job outputs the name it uploaded under, and the consuming job reads that output (`.github/workflows/connect.yaml:67`, `handoff`; `.github/workflows/connect.yaml:382`, `handoff`; `.github/workflows/connect.yaml:415`, `needs.prepare.outputs.handoff`). The tests check each producer's output and each consumer's input (`tests/unit/connect-workflow.test.ts:2556-2573`, `producers`).

## Related

- [`green-job-is-not-proof-of-publication-2026-08-18.md`](../integration-issues/green-job-is-not-proof-of-publication-2026-08-18.md): a job's conclusion does not prove what it was meant to produce. Here the red `Settle result` step is the other half: the report is posted first, then the workflow reports the failure.
- [`post-commit-failure-left-the-committed-run-claiming-success-2026-11-09.md`](../logic-errors/post-commit-failure-left-the-committed-run-claiming-success-2026-11-09.md): the helper's own version of the same rule, that an artifact must say what happened after the commit point.
- #1393 (step timeout and report authors).
