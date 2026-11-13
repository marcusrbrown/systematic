---
title: Run a headless and an interactive agent step through one composite action, and pin what each caller must pass
date: 2026-11-13
category: best-practices
module: ce-connect
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A second workflow runs the same action as an existing, proven agent step"
  - "An action input that is left out falls back to a default that runs without any error"
  - "A workflow file is tested by reading its parsed YAML"
symptoms:
  - "The first scheduled dispatch ran the parent agent on the action's default model because the step passed no `model:` input"
  - "Nothing failed: the run ended green and posted a report"
root_cause: missing_validation
resolution_type: workflow_improvement
tags: [github-actions, fro-bot-agent, composite-action, workflow-tests, default-model, ce-connect, action-inputs]
last_refreshed: 2026-11-13
---

# Run a headless and an interactive agent step through one composite action, and pin what each caller must pass

## Context

`.github/workflows/connect.yaml` runs the `fro-bot/agent` action on a schedule, and `.github/workflows/fro-bot.yaml` runs the same action for review and autoheal. The first dispatch of the scheduled workflow (run 43362146039) passed no `model:` input. The action fell back to its default model without any warning, and the run ended `Connect complete`.

The log shows the difference in one field. The `Action inputs parsed` line carried `"hasModelOverride":false` in run 43362146039 and `"hasModelOverride":true` in run 43365759373, after the fix. The default is `opencode/big-pickle` ([`execution-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/agent/execution-v2.ts#L232), `config?.model ?? DEFAULT_MODEL`; [`constants.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/packages/runtime/src/shared/constants.ts#L51-L54), `DEFAULT_MODEL`); the model name itself showed in the Fro Bot job summary, not in the log. The `"agent":"build (default)"` field appears in both runs and is no symptom: it is the label for a `null` `agent` input ([`execution-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/agent/execution-v2.ts#L205-L206), `hasModelOverride`).

The two workflows were first kept alike by a test that compared their agent steps key by key. That guarded the model line, but it left two copies of the same setup and a test whose only job was to say they matched. Both workflows now run the action through one local composite action, so the shared setup exists once.

## Guidance

Put what the callers share in one composite action, and let tests pin what each caller must still pass.

1. **One composite owns the shared setup.** `.github/actions/fro-bot-agent/action.yml` holds the only `fro-bot/agent@` reference, its SHA pin and its `# vX.Y.Z` comment (the github-actions manager of Renovate reads that comment, and its default file patterns cover `.github/actions/**`), the `timeout: 0` and `repo-skills: "true"` inputs and the `OPENCODE_PROMPT_ARTIFACT` step env. Each caller bounds the step or the job itself. A test keeps those settings off both callers (`tests/unit/connect-workflow.test.ts:419`, `owns the runtime settings both callers share`).
2. **A composite cannot read `secrets` or `vars`.** The model and the two credentials arrive as required inputs, and each caller reads them from its own context. The runner does not enforce `required: true` on a composite input, so a caller that leaves `model:` out still runs, on the action's default model. A test therefore pins that both callers pass `${{ vars.FRO_BOT_MODEL }}` (`tests/unit/connect-workflow.test.ts:481`, `runs the parent agent on the model both callers read from FRO_BOT_MODEL`). Dropping `model:` from either caller fails it.
3. **Pass every input on, by the same name.** One test compares the composite's input names with the keys of its inner `with`, so an input added to one and not the other fails and names the key (`tests/unit/connect-workflow.test.ts:451`, `hands every input to the action under its own name, and nothing else`).
4. **Make an empty optional input act as an omitted one.** A composite always passes its `with` keys on, so an input a caller leaves out reaches the action as an empty string, and the runner applies an action's own default only to a key that is absent. The composite handles this two ways. It gives `response-mode` and `dedup-window`, the two inputs with a non-empty default in the action's `action.yaml`, the same default (`github` and `600000`), so the runner never hands the action an empty string where its default would have applied. For the rest it relies on the action: at the pinned SHA it reads `output-mode`, `systematic-version`, `trusted-head-sha` and `brokered-push-extra-paths` through `getInput(...).trim()` and treats an empty value as unset ([`inputs.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/harness/config/inputs.ts#L156-L170), `trustedHeadSha` through `brokeredPushExtraPaths`; [`inputs.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/harness/config/inputs.ts#L245-L256), `systematicVersion` and `dedupWindow`). A test pins the defaults (`tests/unit/connect-workflow.test.ts:382`, `SHARED_OPTIONAL_DEFAULTS`). After a pin bump, read that parse code again, because a pin that stops treating an empty value as unset breaks the callers silently.
5. **Pin the connect-only inputs as a whole.** The scheduled step passes the job token, `response-mode: none`, `output-mode: working-dir`, `dedup-window: "0"`, the pinned `systematic-version` and a fixed prompt. One test expects exactly those keys with exactly those values, so an input added to the step or dropped from it fails (`tests/unit/connect-workflow.test.ts:489`, `passes exactly the connect-only inputs, with their values and reasons`). The Fro Bot step keeps its own values, `trusted-head-sha`, `brokered-push-extra-paths` and the `output-mode` expression, in `tests/unit/fro-bot-workflow.test.ts`.
6. **Assert the shared form, not a rotating literal.** The pin is matched by pattern, never by a literal SHA, and one test lists every `uses:` in the workflows and local actions to expect the composite as the only place that names `fro-bot/agent@` (`tests/unit/connect-workflow.test.ts:394`, `holds the only fro-bot/agent reference in the workflows and local actions`). A second reference anywhere fails it.
7. **Check out the composite where it cannot disturb the layout.** A local action is read from the checkout, and the scheduled workflow has none. The `run` job takes a sparse checkout of `.github/actions` into `.fro-bot-actions`, with `sparse-checkout-cone-mode: false`, `persist-credentials: false` and `clean: false`, before the connect layout is created (`.github/workflows/connect.yaml:388`, `Check out the shared agent action`). Three of those choices matter:
   - **A subdirectory, not the workspace root.** A checkout at the root makes `$GITHUB_WORKSPACE` a repository with a `.git` directory that holds `HEAD`. The helper counts that as a checkout and refuses every state root below it with `state-root-refused` and the detail `checkout` (`src/lib/connect-config.ts:295`, `isGitEntry`). A test runs the real `prepareStateRoot` over both layouts: with the checkout in `.fro-bot-actions` the state root is accepted, and with the checkout at the workspace root it is refused (`tests/unit/connect-workflow.test.ts:2006-2016`, `prepareStateRoot` in `leaves the state root acceptable to the helper`).
   - **Cone mode off.** Cone mode always includes the files in the repository root. Without it, the pattern `/.github/actions/` lays down only the files under `.github/actions`. A test replays the way `actions/checkout` applies a non-cone pattern in a real git repository and lists what lands in the working tree (`tests/unit/connect-workflow.test.ts:1982`, `lay down nothing but the files under .github/actions`). The git directory still holds the tree objects of the commit, which name every file in the repository; the repository is public.
   - **No credential kept.** The step takes the job token, which is the default, and `persist-credentials: false` keeps it out of `.git/config`. The agent can read the workspace.
8. **Leave a cache input out when it does nothing.** An earlier draft set `skip-cache: "true"`, and it was removed. The reasoning was that sessions are named, so one workflow never restores another's. The input does nothing in the pinned action either: it is parsed ([`inputs.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/harness/config/inputs.ts#L239-L240), `skipCache`) and no other source reads it, while the `SKIP_CACHE` environment variable is what gates restore and save ([`restore.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/services/cache/restore.ts#L345), `SKIP_CACHE`). A test keeps it absent (`tests/unit/connect-workflow.test.ts:284`, `skip-cache`).
9. **Check the first dispatch's log.** After any dispatch that changes the agent step, read the `Action inputs parsed` line:

   ```bash
   gh run view <run-id> --log | grep 'Action inputs parsed'
   ```

   `"hasModelOverride":true` means the step's `model:` reached the action.

## Why This Matters

A missing `model:` ran green on the wrong model. With one composite there is no second copy to forget it in, and the tests name the two things a composite cannot do for its callers: pass the model, and pass the connect-only values. The tests do not catch a value that is wrong in both callers.

The composite is read from the checkout of the job that calls it. In the Fro Bot workflow that is the pull request head for pull request runs, and the job already runs `bun install` on that head before the agent step.

## When to Apply

- A workflow adds a second step that runs an action another workflow already runs in production.
- An action's defaults are valid but wrong for your use (a model, a provider, a cache or a timeout).
- A workflow test would otherwise assert one literal per input, and so break on every pin bump.

## Examples

Before, the scheduled step ran the action directly and passed no model:

```yaml
uses: fro-bot/agent@<sha> # v0.140.2
with:
  auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
  opencode-config: ${{ secrets.OPENCODE_CONFIG }}
```

After, it runs the composite and passes the same model variable the Fro Bot step does:

```yaml
uses: ./.fro-bot-actions/.github/actions/fro-bot-agent
with:
  auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
  model: ${{ vars.FRO_BOT_MODEL }}
  opencode-config: ${{ secrets.OPENCODE_CONFIG }}
```

Each of these mutations fails a named test (checked by making the change, running `bun test tests/unit/connect-workflow.test.ts tests/unit/fro-bot-workflow.test.ts`, and restoring the file): dropping `model:` from either caller, dropping `timeout: 0` or `OPENCODE_PROMPT_ARTIFACT` from the composite, adding a second `fro-bot/agent@` reference to a workflow, removing `persist-credentials: false`, turning cone mode on, moving the checkout to the workspace root, and moving the checkout after the layout step.

## Not verified

- Whether the post step of the nested `fro-bot/agent` action runs after the caller step's `timeout-minutes` cuts the step off. Only a live run can show it.
- How the runner fills the composite's input defaults. No log of the changed workflows exists yet. The first dispatch after this change should show `"hasModelOverride":true` and the same `response-mode` and `dedup-window` as before.

## Related

- [`release-workflow-test-pins-action-sha-2026-10-14.md`](../test-failures/release-workflow-test-pins-action-sha-2026-10-14.md): assert the shared form, never a literal that Renovate rotates.
- [`fro-bot-agent-action-runtime-differs-from-a-plain-runner-2026-11-13.md`](../integration-issues/fro-bot-agent-action-runtime-differs-from-a-plain-runner-2026-11-13.md): the `.git` directory the action leaves in the workspace, and why the layout lives under it.
- #1386 (workflow), #1390 (the step comparison this replaces).
