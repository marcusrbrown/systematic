---
title: "Testing host prune from a plugin: read the request after the mutation, with an in-run control"
date: 2026-10-20
category: best-practices
module: integration-test-harness
problem_type: best_practice
component: testing_framework
severity: medium
root_cause: test_isolation
resolution_type: test_fix
applies_when:
  - "a plugin test asserts on what the model receives after the host rewrites session history"
  - "the test runs on the isolated OpenCode fixture host"
  - "a helper looks up a tool result across every captured provider request"
tags: [opencode, compaction-prune, integration-test, negative-control, real-host-test, mock-provider, false-green]
---

# Testing host prune from a plugin: read the request after the mutation, with an in-run control

## Context

Issue #1028 needed a real-host test showing that a pruned `systematic_skill` result still reaches the model. Any one of three gaps would have let the test pass without the fix:

- **The fixture host never prunes.** The isolated fixture sets `OPENCODE_DISABLE_PRUNE=1` (`tests/integration/fixtures/opencode-host.ts:223`). OpenCode documents this flag as "Disable pruning of old data" ([`cli.mdx`, line 696 at v1.19.3](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/web/src/content/docs/cli.mdx#L696)). With it set, `compaction.prune: true` in config has no effect.
- **The assertion came too early.** Prune only touches parts from two prompts back. See [Pruning](../integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md#pruning). An assertion on prompt 3 sees nothing from prompt 1 pruned yet.
- **The lookup helper read the request from before the mutation.** `toolResultContent` (`tests/integration/skill-delivery.test.ts:213-228`) scans every captured request in arrival order. It returns the content of the first `role: "tool"` message whose `tool_call_id` matches, and that is always the copy from before prune. An assertion through it passes with or without the fix.

## Guidance

A test that checks what the model sees after the host changes session history (prune, compaction, or another transform) needs all four of these:

1. **Turn the host behavior on for one host.** Check the fixture env for flags that disable the behavior under test. Override them for that host only. The fixture spreads `overrides` after its defaults, so the override wins:

   ```ts
   // Fixture sets OPENCODE_DISABLE_PRUNE=1; set it to '0' for this host.
   { OPENCODE_DISABLE_PRUNE: '0' },
   ```

2. **Read only the requests made after the mutation.** Record the request count before the asserting prompt, then take the newest match from that point on:

   ```ts
   const requestsBeforePrompt4 = model.requests.length
   await prompt('Short follow-up four.')

   const skillContent = latestToolResultContent(
     model.requests,
     skillCallID,
     requestsBeforePrompt4,
   )
   ```

3. **Put the negative control in the same request.** Load another result that the host mutates and the fix leaves alone. It must still show the mutation, which proves prune was active for that request:

   ```ts
   expect(skillContent).toContain(CE_REVIEW_FINAL_LINE)
   expect(skillContent).not.toContain(PRUNED_PLACEHOLDER)
   // Negative control: prune was active, and only the skill was spared.
   expect(fillerContent).toContain(PRUNED_PLACEHOLDER)
   ```

4. **Read storage back when the change is request-only.** Before the mutation, check that the stored result holds what you expect. After the asserting prompt, check that storage still holds the host's version:

   ```ts
   // The plugin never writes the change back: storage still says pruned.
   const afterPrompt4 = await storedToolPart(client, fixture, sessionID, skillCallID)
   expect(compactedStamp(afterPrompt4)).toBeDefined()
   ```

The host mutates asynchronously, so wait for it with `pollUntil(ready, deadlineMs)` in the same test file. That is a bounded poll. Key its `ready` predicate on the `callID`s you need marked.

## Why This Matters

A test that passes without the fix signals coverage that isn't there. The in-run control is also the only thing that separates "the fix worked" from "the host never mutated". Without it, every gap above looks like a pass.

## When to Apply

- Real-host tests of a plugin hook that depends on the host rewriting earlier messages.
- Test helpers that search all captured requests for a result that can change between requests in one session.

## Examples

**Before (illustrative).** A three-prompt schedule with an unscoped lookup:

```ts
// prompt 1: load the skill; prompt 2: read fillers; prompt 3: assert
const content = toolResultContent(model.requests, skillCallID)
expect(content).toContain(CE_REVIEW_FINAL_LINE) // passes with or without the hook
```

By prompt 3 nothing from prompt 1 has been pruned, and the helper returns the first request in any case. A negative control written the same way fails, because the filler's first match still holds its full body.

**After.** Scenario f in `tests/integration/skill-delivery.test.ts` runs four prompts with prune enabled. It polls storage until the skill and filler A are marked, asserts on prompt 4's requests only, and reads storage back afterwards.

## Related

- [OpenCode truncates plugin tool output before any hook runs](../integration-issues/plugin-tool-output-truncated-before-after-hook-2026-09-26.md): its Pruning section covers the limits of prune and its timing.
- [Isolate harness subprocess and packaged-runtime fixtures](../integration-issues/isolated-opencode-subprocess-fixtures-2026-05-14.md): where the fixture env is built and how `extraEnv` overrides it.
- [A capability that works has not yet named its cause](../workflow-issues/a-capability-that-works-has-not-named-its-cause-2026-08-24.md): the general case for a negative control.
- #1178: the fix and scenario f.
