---
title: Set a headless agent step up like the interactive one, and pin the sameness with a parity test
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
tags: [github-actions, fro-bot-agent, parity-test, workflow-tests, default-model, ce-connect, action-inputs]
last_refreshed: 2026-11-13
---

# Set a headless agent step up like the interactive one, and pin the sameness with a parity test

## Context

`.github/workflows/connect.yaml` runs the `fro-bot/agent` action on a schedule, and `.github/workflows/fro-bot.yaml` already runs the same action for review and autoheal. The first dispatch of the new workflow (run 43362146039) passed no `model:` input. The action fell back to its default model without any warning, and the run ended `Connect complete`.

The log shows the difference in one field. The `Action inputs parsed` line carried `"hasModelOverride":false` in run 43362146039 and `"hasModelOverride":true` in run 43365759373, after the fix. The default is `opencode/big-pickle` ([`execution-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/agent/execution-v2.ts#L232), `config?.model ?? DEFAULT_MODEL`; [`constants.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/packages/runtime/src/shared/constants.ts#L51-L54), `DEFAULT_MODEL`); the model name itself showed in the Fro Bot job summary, not in the log. The `"agent":"build (default)"` field appears in both runs and is no symptom: it is the label for a `null` `agent` input ([`execution-v2.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/features/agent/execution-v2.ts#L205-L206), `hasModelOverride`).

## Guidance

Set the new agent step up exactly like the proven one, and let a test name every difference.

1. **Mirror, then allow named differences.** The `Run ce:connect` step uses the same action ref as the `Run Fro Bot` step and the same `with` and `env` keys. Every difference is listed with its reason in an allowlist in `tests/unit/connect-workflow.test.ts`: `DIFFERING_INPUTS` (`tests/unit/connect-workflow.test.ts:281-290`), `DIFFERING_ENV` (`tests/unit/connect-workflow.test.ts:291-293`) and `DIFFERING_STEP_KEYS` (`tests/unit/connect-workflow.test.ts:295-303`). They name the read-only job token, `response-mode: none`, `output-mode: working-dir`, `dedup-window: "0"`, the pinned `systematic-version`, `continue-on-error`, the fixed prompt and the step `timeout-minutes`, plus keys that exist only because the step runs on a schedule with nothing to push (`trusted-head-sha`, `brokered-push-extra-paths`).
2. **Compare by key, not by line.** `mismatches` returns every key whose value differs between the two steps and is not in the allowlist (`tests/unit/connect-workflow.test.ts:325-337`, `mismatches`). A test for each of `with`, `env` and the step's own keys expects an empty list (`tests/unit/connect-workflow.test.ts:342-369`). A new input added to one step and not the other fails the test and names the key.
3. **Fail a stale allowlist.** One test checks that each allowlist entry exists in at least one of the two steps (`tests/unit/connect-workflow.test.ts:371-382`), so an entry for a removed input cannot linger and hide a later difference.
4. **Assert the shared form, not a rotating literal.** The model test expects the `model` value to equal what `fro-bot.yaml` uses, and to match `${{ vars.NAME }}` (`tests/unit/connect-workflow.test.ts:384-391`). The action pin is compared between the two files and to a pattern, never to a literal SHA (`tests/unit/connect-workflow.test.ts:170-175`, `AGENT_PIN`). A bump that updates both files passes; one that updates only one fails, which is the point.
5. **Leave a cache input out when it does nothing.** An earlier draft set `skip-cache: "true"`, and it was removed. The reasoning was that sessions are named, so one workflow never restores another's. The input does nothing in the pinned action either: it is parsed ([`inputs.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/harness/config/inputs.ts#L239-L240), `skipCache`) and no other source reads it, while the `SKIP_CACHE` environment variable is what gates restore and save ([`restore.ts`](https://github.com/fro-bot/agent/blob/1ffb6495501f12801f770fa0c0563d16450416e7/src/services/cache/restore.ts#L345), `SKIP_CACHE`). A test keeps it absent (`tests/unit/connect-workflow.test.ts:270-276`, `skip-cache`).
6. **Check the first dispatch's log.** After any dispatch that changes the agent step, read the `Action inputs parsed` line:

   ```bash
   gh run view <run-id> --log | grep 'Action inputs parsed'
   ```

   `"hasModelOverride":true` means the step's `model:` reached the action.

## Why This Matters

The test pins sameness, not correctness: it does not catch a difference that exists in both files.

## When to Apply

- A workflow adds a second step that runs an action another workflow already runs in production.
- An action's defaults are valid but wrong for your use (a model, a provider, a cache or a timeout).
- A workflow test would otherwise assert one literal per input, and so break on every pin bump.

## Examples

Before, the connect step passed no model and the action used its default:

```yaml
with:
  auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
  opencode-config: ${{ secrets.OPENCODE_CONFIG }}
```

After, it passes the same variable the Fro Bot step does:

```yaml
with:
  auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
  model: ${{ vars.FRO_BOT_MODEL }}
  opencode-config: ${{ secrets.OPENCODE_CONFIG }}
```

Removing the `model:` line again makes the input parity test fail with `['model']` and the model test fail with `Received: undefined` (checked by deleting the line, running `bun test tests/unit/connect-workflow.test.ts -t "agent step parity"`, and restoring the file).

## Related

- [`release-workflow-test-pins-action-sha-2026-10-14.md`](../test-failures/release-workflow-test-pins-action-sha-2026-10-14.md): assert the shared form, never a literal that Renovate rotates.
- Follow-up, not implemented: have `connect.yaml` reuse `fro-bot.yaml` (a reusable workflow or a composite action) instead of mirroring it. The parity test is the guard until then.
- #1386 (workflow), #1390 (step parity).
