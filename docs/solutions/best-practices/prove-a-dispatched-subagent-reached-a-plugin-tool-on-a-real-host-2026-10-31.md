---
title: Prove a dispatched subagent reached a plugin tool on a real host
date: 2026-10-31
category: best-practices
module: integration-test-harness
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "A plugin tool is wired into a subagent's prompt and the claim is that the child can use it"
  - "Adding a host or a host version to the real-host integration suites"
  - "A subagent that cannot call its tool would fall back to grep or guessing without failing"
tags:
  - integration-testing
  - subagent
  - mock-provider
  - negative-control
  - opencode
  - pi
---

# Prove a dispatched subagent reached a plugin tool on a real host

## Context

The researcher agent is told to call `systematic_search` and to fall back to grep when the tool is missing. A child that cannot reach the tool still answers, so nothing fails. So wiring the tool in is not enough: a real host has to show the child making the call.

Two earlier docs already cover a real host, a mock model and a negative control: [Test packaged harness extensions against the real Pi runtime](pi-real-runtime-integration-harness-2026-07-16.md) and [Testing host prune from a plugin](testing-host-prune-from-a-plugin-2026-10-20.md). What they do not cover is a dispatched child, and how to tell "the tool was not offered" from "the child chose not to call it".

## Guidance

Script the model and keep the host real. One state machine serves every host: the parent dispatches the researcher, the child calls the tool, the child answers, and the parent answers (`createDelegatedSearchScript`, `tests/helpers/delegated-search-proof.ts:468-506`).

1. **Make the content of the tool result and the parent's answer the pass gate.** The child calls the tool with a marker query against two planted documents (`DELEGATED_SEARCH_FIXTURE`, `tests/helpers/delegated-search-proof.ts:34-53`). Its tool message must start with `Search "`, must not be an error, and must head both planted hits with their `Kind:` and `Status:` labels (`checkChildResult` and `checkHitLabels`, `tests/helpers/delegated-search-proof.ts:256-305`). The parent's last request and the answer the host returns must both carry both paths (`checkParentFinal`, `tests/helpers/delegated-search-proof.ts:312-350`).
2. **Treat tool advertisement as a diagnostic, never as a pass.** `diagnoseMissingDelivery` names `tool-not-advertised` or `no-tool-call` after a failure, and the verdict is already a failure by then (`tests/helpers/delegated-search-proof.ts:217-229`).
3. **Add a negative control that must fail, and fail with the right name.** With `{ search: { enabled: false } }` the proof must return `tool-not-advertised`, and the child must still have been reached, so the failure is the missing tool and not a missed dispatch (`tests/integration/opencode-v1.test.ts:585-612`, `tests/integration/opencode-v2.test.ts:764-790`, `tests/integration/pi.test.ts:1131-1153`).
4. **Tell child from parent per host.** OpenCode v2 marks the child by its prompt text (`tests/integration/opencode-v2.test.ts:664-695`). Pi hides the child's tool events over RPC, so it reads the mock model's request log and identifies the child by the researcher's opening line, read from the agent file so the marker cannot drift (`researcherSystemMarker`, `tests/helpers/delegated-search-proof.ts:82-91`; `runDelegatedSearch`, `tests/integration/pi.test.ts:1069-1110`).

Cap the model's requests (`DELEGATED_SEARCH_REQUEST_CAP`, `tests/helpers/delegated-search-proof.ts:60`) so a looping script stops in seconds.

## Why This Matters

Without the content gate, a child that answered from grep would pass. Without the negative control, nothing shows the proof can fail. Without the final-answer check, a result could reach the parent's request and still be lost before the user sees it.

The proof has limits, and the header comment of the harness helper says so:

- It shows reach only. A scripted model makes the call, so it says nothing about a live model choosing to call the tool.
- The child searches `kind: all`, which the researcher prompt forbids (`agents/research/learnings-researcher.md:53`). The per-kind strategy is not exercised on these hosts.

## When to Apply

- Wiring a plugin tool into a subagent prompt, before claiming the child uses it.
- Adding an OpenCode or Pi version to the real-host suites. Run the probe first as a stop gate, before building on the claim.

## Examples

The negative control from the Pi suite, trimmed:

```ts
const verdict = evaluateDelegatedSearchProof(script.observation())
expect(verdict).toMatchObject({ ok: false, code: 'tool-not-advertised' })
// The child was reached, so the failure is the missing tool, not a
// delegation that never happened.
expect(script.observation().childRequests.length).toBeGreaterThan(0)
```

## Related

- [Test packaged harness extensions against the real Pi runtime](pi-real-runtime-integration-harness-2026-07-16.md)
- [Testing host prune from a plugin](testing-host-prune-from-a-plugin-2026-10-20.md): the in-run negative control this one extends.
- `docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md`: the CI jobs that run these suites.
