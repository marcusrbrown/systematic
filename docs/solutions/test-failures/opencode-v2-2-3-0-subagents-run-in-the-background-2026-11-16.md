---
title: OpenCode v2 2.3.0 runs every subagent in the background, so a scripted parent that answered the tool result ended before the child reported
date: 2026-11-16
category: test-failures
module: opencode-v2-integration-tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "Tests in `tests/integration/opencode-v2.test.ts` failed on the OpenCode v2 2.3.0 bump (#1429) and passed on 2.2.7; a local run on 2.3.0 failed 12 of 45"
  - "The delegated-search proof failed with `no-tool-call` or `parent-answer-missing-path`, and the connect isolation proof failed with `no-parent-final`, `attempts-incomplete` or a `fetchHits` of 0"
root_cause: async_timing
resolution_type: test_fix
severity: medium
tags: [opencode-v2, subagent, background, host-contract, renovate, integration-tests, scripted-model]
---

# OpenCode v2 2.3.0 runs every subagent in the background, so a scripted parent that answered the tool result ended before the child reported

## Problem

The host-contract tests drive a parent session and a dispatched researcher child with a scripted model. On 2.2.7 the `subagent` tool blocked until the child finished and returned the child's answer as its tool result, so the scripted parent made one more request, answered with that result, and the session went idle with everything done. On 2.3.0 the same script ended the run early. The Renovate bump to 2.3.0 (#1429) failed the `Host Contract v2 shard 2/4` job.

## Symptoms

- The failures differ by test, but each one is the same cut: the delegated-search proof reports `no-tool-call` or `parent-answer-missing-path`, and the connect isolation proof reports `no-parent-final`, `attempts-incomplete` (the child had received 0 tool results) or a `fetchHits` of 0.
- A request log on 2.3.0 shows the parent's second request ends with a `tool` message that is not an answer: `The subagent is working in the background (sessionID: ses_…)`. The script answered that message with its final text, the session went idle, `session.wait` returned and the test stopped the host while the child was still working.
- Nothing in `src/` was at fault. The packed plugin, the guard and `systematic_search` all behaved the same on 2.3.0 once the test waited for the child.

## Solution

The scripts and the proof now handle both shapes (`tests/helpers/delegated-search-proof.ts`, `parentResultTextOf`):

```ts
export function parentResultTextOf(request: ChatRequest): string | undefined {
  const last = (request.messages ?? []).at(-1)
  const text = messageText(last)
  if (roleOf(last) === 'tool') return text
  if (roleOf(last) === 'user' && SUBAGENT_REPORT_PATTERN.test(text.trimStart()))
    return text
  return undefined
}
```

- The scripted parent answers a launch handle (`isSubagentLaunch`) with `PARENT-WAITING`, which carries no final marker. It answers the later `<subagent …>` report, or an inline tool result on a host that still answers inline, with the final marker and the paths or marker in that text.
- Both proofs accept a parent whose last request is the report, and reject one whose last request is still the launch handle (`no-parent-final`).
- The test waits for the parent's final answer before it reads the session (`tests/integration/opencode-v2.test.ts`, `awaitParentFinalAnswer`). `session.wait` returns at the first idle, which on 2.3.0 is before the report starts the next parent turn. The helper polls for the scripted final marker up to a deadline and falls through to the proof when it never appears.

The fix was checked against real hosts. Before the change 12 of 45 tests failed on 2.3.0. After it all 45 passed on 2.3.0 and on 2.2.7. Reverting the wait, or making the parent ignore the report, made the delegated tests fail again on 2.3.0, and the new unit tests fail on the second change.

## Why This Works

Upstream's anomalyco/opencode#63382 removed the `background` option from the `subagent` tool. Every call now returns a `sessionID` at once, and the parent gets a `<subagent>` message each time the child goes idle. The release notes for 2.3.0 list it as the headline change. A parent that needs the answer has to wait for that message; the test model has to do the same.

`opencode run` already waits for background jobs, so the headless test needed only the script change and no wait helper.

## Prevention

- When a host bump fails tests that dispatch a child, read the request log first. Count the parent's requests and look at the role and text of the last message in each. A launch handle where an answer used to be is this failure.
- Keep scripted parents tolerant of both an inline result and a later report. v1 and Pi still return inline, and the shared helpers serve all three hosts.
- Do not read a session right after `session.wait` when a child may still be running. Wait for something only the finished run produces.

## Related Issues

- #1429 (the 2.3.0 bump).
- anomalyco/opencode#63382 (`feat(core): always run subagents in the background`) and #63675 (reports with pending background work are tagged `state="running"`).
- [`opencode-v2-agent-list-stops-waiting-for-plugins-2026-11-16.md`](opencode-v2-agent-list-stops-waiting-for-plugins-2026-11-16.md): the 2.2.7 change that broke the same file in a different way.
