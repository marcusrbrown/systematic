---
title: A reusable workflow's pinned helper and each installed client move separately, so guard the helper, and state the client floor the cutover leaves
date: 2026-11-20
category: integration-issues
module: ce-connect
problem_type: integration_issue
component: infrastructure
symptoms:
  - "A foreign caller that pinned the callee commit would have installed a helper with no `verify-provenance` operation and rendered fetch words with no repository, so its own runs could not be fetched"
  - "Before a release includes the change, an installed skill refuses a run of Systematic's scheduled wrapper as `not-a-connect-run`"
  - "A whole-body scan of the report for bare fetch words would fail a correct run whose candidate summary quotes a bare fetch bullet"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [ce-connect, reusable-workflow, version-skew, pinned-dependency, capability-probe, cutover, fetch-words, concurrency-group]
---

# A reusable workflow's pinned helper and each installed client move separately, so guard the helper, and state the client floor the cutover leaves

## Problem

Making `connect.yaml` callable from other repositories put three deployments behind one workflow file, and they do not move together:

- **The callee commit.** The workflow a caller pins.
- **The helper the callee installs from npm.** `SYSTEMATIC_VERSION` is an exact release (`.github/workflows/connect.yaml:73`, `SYSTEMATIC_VERSION`; `.github/workflows/connect.yaml:203-215`, `Install helper`). Renovate bumps it after a release is tagged, so a release's tag commit names the previous release (`docs/src/content/docs/guides/cross-project-connections.mdx:575`).
- **The skill on the user's machine.** It fetches the run's record with whatever version the user installed.

On the commit this change landed, the pin was `"3.35.3"` (`.github/workflows/connect.yaml:73`). The helper usage line of `v3.35.3` and of `v3.36.0` lists no `verify-provenance` operation ([`src/ce-connect-helper.ts` at v3.36.0](https://github.com/marcusrbrown/systematic/blob/v3.36.0/src/ce-connect-helper.ts#L156)); on main it does (`src/ce-connect-helper.ts:167-168`, `CE_CONNECT_USAGE`). A repository other than Systematic that pinned this commit would get a helper that cannot prove a named fetch, and, from a helper that predates the `repo` field, a report whose fetch words are bare and resolve to Systematic (the render guard at `.github/workflows/connect.yaml:786-810`, `caller`, and the comment above it).

On the skill side, Systematic's own scheduled run moved to a wrapper, `connect-scheduled.yaml` (`.github/workflows/connect-scheduled.yaml:29`, `uses`), so its top-level `path` is the wrapper's. The v3.36.0 skill accepts only `connect.yaml` ([`fetch-and-import.md` at v3.36.0](https://github.com/marcusrbrown/systematic/blob/v3.36.0/skills/ce-connect/references/fetch-and-import.md?plain=1#L23)), so until a release includes the change, an earlier skill refuses a wrapper run as `not-a-connect-run`; earlier runs of `connect.yaml` still fetch on any version (`skills/ce-connect/references/fetch-and-import.md:260`; `docs/src/content/docs/guides/cross-project-connections.mdx:378`).

## Symptoms

- A foreign caller's report would carry bare fetch words that cannot reach the caller's own run, and a pinned helper without `verify-provenance` cannot back a named fetch (`skills/ce-connect/references/fetch-and-import.md:75`). Without a probe, that shows at fetch time, after a paid agent run.
- An installed skill from before the cutover cannot fetch Systematic's new runs.

## What Didn't Work

Alternatives considered and rejected:

- **Scanning the whole rendered body for bare fetch words.** Candidate text sits in fences and may quote anything, so a summary that quotes a bare `fetch:` bullet would fail a correct run. The guard skips fenced blocks and reads only the lines the renderer generates (`.github/workflows/connect.yaml:796-798`, `fence`; `tests/unit/connect-workflow.test.ts:2161-2182`, `does not read free text inside a fence`).
- **Dual mode, with `connect.yaml` runnable directly and by call.** A called run reports the caller's event, never `workflow_call` (CN-7 observation 1 in [`HARNESSES.md`](../../../HARNESSES.md)), so a called run and a direct run both report `schedule` or `workflow_dispatch`. Telling them apart needs a `vars` fallback, and `vars` in a called workflow is the caller's (CN-7 observation 5; the wrapper passes each one as an input, `.github/workflows/connect-scheduled.yaml:31-35`, `vars`). So `connect.yaml` stays `workflow_call` only (`tests/unit/connect-workflow.test.ts:110-112`).
- **Swapping the file names**, so the wrapper keeps `connect.yaml` and the callee gets a new path. That keeps old clients working, and it moves the churn instead: the file name is the constant the provenance check matches (`src/lib/connect-provenance.ts:37`, `WORKFLOW_FILE`), the file the Renovate manager reads (`.github/renovate.json5:45`, `managerFilePatterns`), a literal in eight test files and in the skill reference and guide (`skills/ce-connect/references/fetch-and-import.md:52`, `docs/src/content/docs/guides/cross-project-connections.mdx:569`). That cost buys back a window that closes when users install a release that includes the change, so the gap was accepted and documented instead (`docs/src/content/docs/guides/cross-project-connections.mdx:378`).

## Solution

### Two guards, for callers other than Systematic

Both guards skip Systematic's own runs, which keep bare fetch words (`.github/workflows/connect.yaml:224`, `.github/workflows/connect.yaml:787`; `tests/unit/connect-workflow.test.ts:2193-2199`).

**In `prepare`, a capability probe before any agent work.** The step lists the installed helper's usage line and requires the exact operation name, delimiters included (`.github/workflows/connect.yaml:217-234`, `Check helper capability`):

```bash
case "$usage" in
  *"|verify-provenance|"*) ;;
```

`.github/workflows/connect.yaml:227-228`. It probes the capability, not a version number. A helper that cannot print its usage fails closed (`tests/unit/connect-workflow.test.ts:2297-2301`), and stubs that hold the name only as a near miss or in prose are expected to fail (`tests/unit/connect-workflow.test.ts:2227-2237`, `tests/unit/connect-workflow.test.ts:2279-2286`).

**In `render`, a check that every generated fetch word names the caller.** It reads the helper's `fetches` list and the `- Fetch:` and index lines the renderer generates, outside fenced blocks (`.github/workflows/connect.yaml:781-811`). A word that does not start with `<caller>:` fails the job (`.github/workflows/connect.yaml:806-809`), before the report is copied, cached or uploaded (`.github/workflows/connect.yaml:813-814`; `tests/unit/connect-workflow.test.ts:2120-2125`, `tests/unit/connect-workflow.test.ts:2201-2216`). The caller's case is ignored (`tests/unit/connect-workflow.test.ts:2184-2191`).

Both messages name the fix: pin a newer callee commit whose `SYSTEMATIC_VERSION` carries named fetch words (`.github/workflows/connect.yaml:230`, `.github/workflows/connect.yaml:808`). Read `SYSTEMATIC_VERSION` at the commit you mean to pin, because a tag commit names the previous release.

### A floor for installed clients, stated in the docs

The workflow cannot guard a client on the user's machine, so the cutover leaves a floor and the docs name it: fetching a wrapper run needs a Systematic release that includes the change that made the wrapper call the reusable workflow (`docs/src/content/docs/guides/cross-project-connections.mdx:378`). Main's bare path accepts either top-level path (`skills/ce-connect/references/fetch-and-import.md:52`). The floor is described in words and carries no number, because no release has included the change yet. Add the version once one does.

### The concurrency group was renamed

The group went from `ce-connect-scheduled` in the old file ([`connect.yaml` at v3.36.0](https://github.com/marcusrbrown/systematic/blob/v3.36.0/.github/workflows/connect.yaml#L26)) to `ce-connect-callee` in the callee (`.github/workflows/connect.yaml:56-61`), and the wrapper sets none (`tests/unit/connect-scheduled-workflow.test.ts:166-176`). A group serializes only runs that share its name ([GitHub: using concurrency](https://docs.github.com/en/actions/using-jobs/using-concurrency)), so a run still going under the old name and the first run under the new one would not queue behind each other. Drain before the cutover.

### The cutover checklist

The procedure is in the plan for the change that moved the schedule (`docs/plans/2026-11-20-001-feat-reusable-connect-workflow-plan.md:421-422`). Run it again for any change that moves the scheduled run's path, its group or its cache key.

1. **Drain.** No run in flight and none queued.
2. **Record the state to compare against.** The newest `connect-v1-` cache key (`.github/workflows/connect.yaml:253-255`), the open report issue with its body and its manifest line. The cache is scoped to the caller repository's ref (CN-7 observation 4), so the default-branch cache carries over only if the key prefix, the report title and the author rule do not change.
3. **Merge, then dispatch once.**
4. **Check the first run.**
   - The `prepare` log says the cache restored from the recorded key, and the sweep progress continues instead of restarting.
   - The report matches the run's UTC date. The `post` job edits the open report in place only when its title date equals the run's UTC date, and otherwise creates a new report (`.github/workflows/connect.yaml:1199-1204`, `.github/workflows/connect.yaml:1223-1229`, `number`; the date comes from `.github/workflows/connect.yaml:105-113`, `Compute UTC date`). Then `Close superseded reports` carries the ticks onto the new report and closes the old one (`.github/workflows/connect.yaml:1244-1291`). Both outcomes are success. To check the in-place edit, dispatch on the same UTC date as the open report; either way, no second open report is left.
   - Ticks left on the report are accepted and logged.
   - A bare fetch word from a row written before the cutover still imports.
   - The run's top-level path is the wrapper's, which the bare path accepts.
   - The `Action inputs parsed` line shows `"hasModelOverride":true` ([share one composite agent step](../best-practices/share-one-composite-agent-step-between-the-headless-and-interactive-workflows-2026-11-13.md), item 9). The agent step passes `repo-skills: "false"` (`.github/workflows/connect.yaml:569`), and the guide says to confirm in the log that the caller's repository content is not loaded (`docs/src/content/docs/guides/cross-project-connections.mdx:584`).
5. **If a check fails, do not just revert the merge.** A revert undoes neither a cache save nor an issue edit. `render` saves the cache under `connect-v1-<run_id>-<attempt>` and confirms it before `post` starts (`.github/workflows/connect.yaml:667`, `.github/workflows/connect.yaml:904-930`, `.github/workflows/connect.yaml:1017`), and the restore matches the prefix `connect-v1-` (`.github/workflows/connect.yaml:253-255`). After a failed `post`, a reverted workflow can therefore restore the failed run's cache. Recover in this order:
   1. Pause scheduled and manual runs by disabling the workflow ([GitHub: disabling and enabling a workflow](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)).
   2. Check which caches and report edits actually landed: list the `connect-v1-` caches and read the open report's body and title.
   3. Reconcile. Keep the pre-cutover cache key recorded in step 2. Delete a cache saved by the failed run only after confirming its key carries that run's id; the workflow's recovery message uses `gh cache delete` but lists every `connect-v1-` cache (`.github/workflows/connect.yaml:293`), so delete that one cache id and not the whole list. The restored cache and the open report must agree: the report's manifest line must name a manifest the kept cache holds, because a tick under a manifest the cache lacks is reported as `manifest-missing` and not recorded (`src/lib/connect-ci.ts:1799-1803`, `src/lib/connect-ci.ts:1737-1745`; the report's marker is written at `.github/workflows/connect.yaml:1232`). If `post` already edited the report, restore the recorded body before re-enabling, or keep the cutover cache instead of deleting it; either way, carry any ticks made in the meantime to the report you keep.
   4. Only then revert the merge and re-enable the workflow.

## Why This Works

A guard that tests the contract the callee needs, an operation the helper lists and a fetch word that names the caller, turns a version skew into a red run that names its fix. Only the `prepare` probe stops paid work. The `render` guard runs after the agent step and after the hand-off upload (`.github/workflows/connect.yaml:649`, `.github/workflows/connect.yaml:667`, `.github/workflows/connect.yaml:781-811`), so it stops cache persistence and report publication, not the earlier work. The client floor is outside the workflow's reach, so it lives where the user reads: the guide and the skill reference. Draining covers what a rename breaks silently, which is that queueing stops spanning the two names.

## Prevention

- **Count the deployments.** List what runs from the checkout, from the pin and on each user's machine, and ask what each side sees while only one has moved ([the same lesson for a report carrier](report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md)).
- **Probe the capability, not the version.** Match the exact name with delimiters, test near misses, fail closed when usage is unreadable, and test the exemption too (`tests/unit/connect-workflow.test.ts:2311-2318`).
- **Scan only what the code generates**, outside fences.
- **Before moving a path that clients match on, list the clients.** Here: the provenance constant, the Renovate manager, the skill and the guide. State the floor in words before the merge.

## Related

- [A report carrier changed beside its renderer ran ahead of the renderer the workflow pins](report-carrier-ran-ahead-of-the-pinned-renderer-2026-11-20.md): the same pin-as-second-deployment hazard for the report's tick format. This doc covers the helper's operations and fetch words.
- [Prove that a run in another repository called your reusable workflow in a tested helper op](../best-practices/prove-a-cross-repo-run-called-your-workflow-in-a-tested-helper-op-2026-11-20.md): the `verify-provenance` operation the capability probe looks for.
- [Called-workflow GitHub context is the caller's: use `job.workflow_*` and inputs](../best-practices/called-workflow-github-context-is-the-callers-use-job-workflow-and-inputs-2026-11-20.md): why the callee's own settings, group and cache scope behave as they do.
- [Spike cross-owner workflow behaviour with push-triggered stub probes](../best-practices/spike-cross-owner-workflow-behaviour-with-push-triggered-stub-probes-2026-11-20.md): where the caller's event, cache scope and rerun behaviour were observed.
- [Bound the agent step below the job so a hung scheduled run still posts](../workflow-issues/bound-the-agent-step-below-the-job-so-a-scheduled-run-still-posts-2026-11-13.md): the same workflow, and what the later jobs do after the agent step.
