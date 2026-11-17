---
title: OpenCode v2 2.2.7 `agent.list` stopped waiting for plugins, so a test that listed agents at startup saw a partial list
date: 2026-11-16
category: test-failures
module: opencode-v2-integration-tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "Three tests in `tests/integration/opencode-v2.test.ts` failed on the OpenCode v2 2.2.7 bump (#1391) and passed on 2.2.6"
  - "The agent list returned right after the host started held only the agents loaded so far"
root_cause: async_timing
resolution_type: test_fix
severity: medium
tags: [opencode-v2, agent-list, plugin-loading, host-contract, renovate, integration-tests, race-condition]
---

# OpenCode v2 2.2.7 `agent.list` stopped waiting for plugins, so a test that listed agents at startup saw a partial list

## Problem

A real-host test starts an OpenCode v2 server with the packaged Systematic plugin, then calls `client.agent.list` to check that the bundled agents are present. On 2.2.6 the call returned after the plugin had loaded. On 2.2.7 it returns what is loaded at that moment, which on a freshly started server may not include the plugin's agents. The Renovate bump to 2.2.7 (#1391) failed three tests in CI.

## Symptoms

- The three failing tests all list agents through the helper `listAgents` right after the host starts (`tests/integration/opencode-v2.test.ts:515`, `tests/integration/opencode-v2.test.ts:544` and `tests/integration/opencode-v2.test.ts:664`, each a `listAgents` call).
- Nothing in `src/` calls `agent.list`, so the plugin was not at fault and #1395 changed only the test helper.

## Solution

The `listAgents` helper calls `provider.list` for the project location first, then `agent.list` (`tests/integration/opencode-v2.test.ts:497-507`, `listAgents`):

```ts
const location = { directory: fixture.projectDir }
// `agent.list` returns only the agents loaded so far while plugins are
// still loading; `provider.list` waits for them, so call it first.
await client.provider.list({ location })
const listed = await client.agent.list({ location })
```

The fix in #1395 was checked against real hosts. Before the change the three tests failed on 2.2.7. After it they passed on 2.2.7 in six runs, and the whole file passed on 2.2.7 and on 2.2.6 (45 of 45 each). Removing the `provider.list` call made the three tests fail again on 2.2.7.

## Why This Works

Upstream removed the plugin wait from the server's request handlers in anomalyco/opencode#62796 (merged 2026-11-09). Its description gives the design: plugins load in the background and clients pick up late entries from `*.updated` events, so a request reads what is loaded now. The same change says clients that need a plugin's entries make sure the plugin has loaded before they call, and that the upstream SDK tests poll for the entry they need.

`provider.list` worked as the barrier in the runs above. That is an observation, not a documented contract: the upstream description lists `provider.list` among the handlers it stopped waiting in, and this repo did not establish why the call still waited on 2.2.7. It says nothing about later releases.

## Prevention

- After starting a host, wait for the plugin entry the test needs, with a deadline. If the `provider.list` barrier stops working on a later release, poll `agent.list` until a known bundled agent appears, which is what upstream says SDK callers have to do now.
- Record the barrier as observed behavior on 2.2.6 and 2.2.7, not as a readiness contract. The comment on it in `listAgents` is the only record of why a `provider.list` call sits before an `agent.list` call.

## Related Issues

- #1391 (the 2.2.7 bump), #1395 (the test fix).
- anomalyco/opencode#62796 (`fix(server): stop waiting for plugins in request handlers`).
- [`version-pinned-evidence-must-be-reproven-2026-08-16.md`](../workflow-issues/version-pinned-evidence-must-be-reproven-2026-08-16.md): why evidence from one host version is not evidence at another.
