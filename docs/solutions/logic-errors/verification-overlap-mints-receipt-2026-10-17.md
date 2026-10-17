---
title: A verification that overlapped another local call could still mint a receipt
date: 2026-10-17
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "A verification receipt was minted for a run during which another local call changed the worktree"
  - "A write that changed the tree and was restored before the verification's after-hook left the after-snapshot matching the start, so admission passed"
  - "Verification admission checked workspace identity only, so nothing compared other local calls against the verification's window"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [workflow-guard, verification-receipt, concurrency, in-flight-tracking, call-id, receipt-admission, tool-execute-hooks, request-boundary]
---

# A verification that overlapped another local call could still mint a receipt

## Problem

In the OpenCode guard adapter (`src/lib/opencode-workflow-guard.ts`), a verification receipt could describe a run that another local call changed underneath. A verification started, a parallel local write changed the tree, the tree was restored, and the verification's after-hook saw the starting tree and minted a receipt even though part of the run read the changed tree (#1131, fixed in #1142). Terms such as unit, receipt and readback are defined in [the snapshot-limits doc](./worktree-snapshot-limits-disable-guard-2026-10-15.md).

## Symptoms

- A verification such as `bun test` minted a receipt although a `write`, `edit`, `apply_patch` or `bash` call ran during it.
- The guard compares revisions, not history: a change that was restored before the after-hook left nothing to compare.

## What Didn't Work

- **Capturing the start facts when the pending operation is stored.** That happens after `prepareOperation` awaits its before-snapshot and remote intent, so a call could start and finish during those awaits unseen. The capture now happens in the same synchronous step as the call's own increment.
- **Deduplicating the increment for a repeated call ID.** A repeated ID can be a second execution, so every local before-hook that reaches `prepareOperation` advances the sequence, and so does a rejected one whose session and local tool name can be read.
- **A set of in-flight call IDs.** The first after-hook for a repeated ID removed the shared entry while the second execution was still running, and a verification that started next minted.
- **A count per call ID.** A replayed after-hook decremented the count to zero before the replay was recognised, which hid the second execution again. Nothing tells a replayed after-hook from the second execution's own, so a count cannot be made replay-safe.
- **Advancing only the sequence for an unparseable before-hook.** A verification that started while that call was still running saw no in-flight call and an unchanged sequence.
- **Guidance to rerun "in a later request if a call is still running".** The request boundary stops tracking that call, so the advice pointed at the gap.

## Solution

Each session runtime keeps two pieces of state. Neither is persisted.

```ts
type LocalCallState = 'running' | 'returned' | 'ambiguous'

// in createSessionRuntime
let localCallSequence = 0
const inFlightLocalCalls = new Map<string, LocalCallState>()
```

The key is `digestCall(ledger, host.callID)`, which uses the call ID only, never the arguments.

When an observer is configured, `beginLocalCall` is the first step of `prepareOperation` for a call to one of the four local tools. It runs before the observation gate and before any `await` in `prepareOperation`. Calls that the guard then skips (inactive session, snapshot block, timeout) are still counted, because they still run.

```ts
// comments omitted
function beginLocalCall(callDigest: string): LocalCallStart {
  localCallSequence += 1
  const start: LocalCallStart = {
    sequenceAtStart: localCallSequence,
    otherInFlightAtStart: [...inFlightLocalCalls].some(
      ([key, state]) => key !== callDigest && state !== 'returned',
    ),
  }
  inFlightLocalCalls.set(
    callDigest,
    inFlightLocalCalls.has(callDigest) ? 'ambiguous' : 'running',
  )
  return start
}
```

An after-hook releases only a call ID that was seen once. A replay, an unknown ID, or an ID seen more than once changes nothing:

```ts
// comments omitted
function endLocalCall(callDigest: string): void {
  if (inFlightLocalCalls.get(callDigest) === 'running') {
    inFlightLocalCalls.set(callDigest, 'returned')
  }
}
```

A local before-hook the parser rejects, but whose session and local tool name can still be read, advances the sequence and is held under a key no real call digest can take:

```ts
// comments omitted
function beginUnparsedLocalCall(): void {
  localCallSequence += 1
  inFlightLocalCalls.set(`unparsed:${localCallSequence}`, 'ambiguous')
}
```

The request boundary (`abandonPending`, run from the system transform) clears the in-flight map. The host has no cleanup hook for a call that throws, is denied or is interrupted, so without the clear one failed call would seal every later verification. The sequence is never reset.

Admission sits in `completeOperationObservation`, after the final ownership check and with no `await` before the receipt is observed:

```ts
// comments omitted
if (!ownsOperation(pending)) return sealAndIgnore(callDigest, pending)
if (
  finalObservation.operation === 'verification' &&
  overlappedAnotherLocalCall(pending)
) {
  return sealAndIgnore(callDigest, pending)
}
const observed = await observeClassifiedOperation(finalObservation)
```

`overlappedAnotherLocalCall` is true when another call was in flight at the start or when the sequence has moved since. A sealed verification mints nothing, records no cause, and leaves the guard available. The guidance in `skills/using-systematic/SKILL.md` tells the agent to rerun it alone once every local call from that request has returned.

## Why This Works

- **Two checks cover each other's blind spot.** A call that starts and finishes inside the window moves the sequence but was not in flight at the start. A call that was already running at the start and finishes inside the window does not move the sequence. Either check alone misses one of these orderings.
- **The start facts are taken in one synchronous step.** The increment, the read of other in-flight calls and the call's own entry all happen before the first `await` in `prepareOperation`, so nothing can interleave between them. OpenCode 1.19.0 awaits `tool.execute.before` before it runs the tool, so the call is recorded before it can write.
- **Ambiguous IDs are held, not counted down.** When executions sharing an ID cannot be told apart, the only safe release point is a host boundary that ends all of them. This over-seals until the next request.
- **The gate applies to verification only.** Commit and implementation receipts still attest the final state, as described in [the timeout doc](./transient-timeout-disables-workflow-guard-2026-10-15.md). The gate runs in the parent's after-hook, so a child session's verification that rolls up into the parent is minted without it.

Accepted limits, listed in `ARCHITECTURE.md`:

- The rule is strict. Read-only `bash`, another verification, and a write to a different worktree all seal a verification.
- It is an observation gate for the tools it counts, not a control against an agent trying to get past it. Not tracked:
  - other sessions and writers outside the session;
  - child task sessions: rollup mints a child's verification with no overlap check;
  - tools other than `write`, `edit`, `apply_patch` and `bash`;
  - processes a finished call left running in the background;
  - a call still running when the request boundary clears the map;
  - an unparseable before-hook whose tool name cannot be read.
- A call ID seen twice, a call that threw, was denied or was interrupted, and an unparsed before-hook keep sealing verifications until the next request.

## Prevention

- A gate on what happened during a window needs two facts: a monotonic counter compared at the end, and a capture of what was already running at the start.
- Capture both before the first `await`, as [the version-fence doc](../best-practices/async-commit-aba-version-fence-2026-10-15.md) describes.
- Do not release state on an identifier the model controls. Call IDs correlate hooks ([the truncated-output doc](../integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md)), but they do not identify an execution. When executions cannot be told apart, hold the key until a host boundary.
- Input the parser rejects can still execute. When the session and tool can still be read, give it a conservative entry rather than dropping it.
- Recovery guidance must not send the agent into the window the mechanism stops tracking.
- Pin each state transition with a test that fails when the transition is removed. The tests live in `describe('a verification that overlaps another local call')` in `tests/unit/opencode-workflow-guard.test.ts`:
  - Raw `tool.execute.before` and `tool.execute.after` calls interleave the hooks the way parallel tool calls do.
  - `deferredStep` holds a verification's before-snapshot or after-snapshot while another call runs.
  - `expectSealed` checks that no receipt is minted, the guard stays available, and a duplicate after-hook takes no snapshot and mints nothing.
  - Calling `experimental.chat.system.transform` between calls crosses the request boundary.
  - Duplicate, replayed and reused call IDs each have their own test.
  - Removing the sequence check, the start-of-window in-flight check, the ambiguous state or the unparsed entry each fails at least one named test.

## Related Issues

- #1131 (the defect), fixed in #1142.
- [An async read that commits on return must detect any change made while it waited](../best-practices/async-commit-aba-version-fence-2026-10-15.md): the same capture-before-await rule applied to status refreshes.
- [A transient command timeout turned the workflow guard unavailable](./transient-timeout-disables-workflow-guard-2026-10-15.md): skipped calls, and the final-state attestation model this rule narrows for verification.
- [Worktree snapshot limits turned workflow guard enforcement off](./worktree-snapshot-limits-disable-guard-2026-10-15.md): calls skipped while a unit is blocked, which still count here.
- [OpenCode truncates plugin tool output before any hook runs](../integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md): correlating hooks by session and call ID.
- [Receipt guard missed worktree-targeted child operations](../integration-issues/worktree-targeted-receipt-observation-2026-08-02.md): workspace and target identity, which this rule does not replace.
