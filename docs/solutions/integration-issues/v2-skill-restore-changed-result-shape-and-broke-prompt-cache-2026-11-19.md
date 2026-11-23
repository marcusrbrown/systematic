---
title: The v2 skill restore changed the result shape after a restart and broke the prompt-cache prefix
date: 2026-11-19
category: integration-issues
module: opencode-v2-adapter
problem_type: integration_issue
component: tooling
symptoms:
  - 'On OpenCode 2.3.2 with an OpenAI Responses model, the prompt-cache prefix broke at a systematic_skill function_call_output after every process restart or --session resume, on both the WebSocket and HTTP transports'
  - 'About 8-11k extra uncached tokens per restart; a v1/v2 comparison showed v2 using 16.6% more uncached tokens per task, and 47.4% more with each first request excluded'
  - 'Live requests sent output as [{"type":"input_text","text":"<skill_content ..."}]; after a restart the same text went out as the plain string "<skill_content ..."'
  - 'No error or warning, and the unit tests that checked the restored text passed'
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - opencode-v2
  - prompt-cache
  - responses-api
  - context-hook
  - systematic-skill
  - function-call-output
  - process-restart
applies_when:
  - 'A plugin rewrites tool results in a context or transform hook, and the rewrite depends on process-local state such as an in-memory store'
  - 'A session continues in a new process, or a store entry is evicted, so the same history is rebuilt without that state'
  - 'The provider caches by the exact bytes of the request prefix'
---

# The v2 skill restore changed the result shape after a restart and broke the prompt-cache prefix

## Problem

On OpenCode v2, `systematic_skill` puts the full skill text back into each model request from a per-process store. The restore always rewrote the result as a `content` array, while the host itself sends a single text result as a string. Whether a request carried the array or the string therefore depended on whether this process still held the store entry. The bytes of an old tool result changed after every restart, so the provider's prompt cache stopped at that item and re-sent everything after it.

## Symptoms

- With GPT-6.2 Sol over the Responses API, cache reads stopped at the first `systematic_skill` result after a restart or `--session` resume. For example, one request read 30,464 of 39,070 prompt tokens from cache instead of about 39k.
- The same `call_id` was `"output": [{ "type": "input_text", "text": "<skill_content …" }]` live and `"output": "<skill_content …"` after the restart. The text was identical.
- It reproduced on both transports and with Magic Context disabled.
- v1 hosts were unaffected: they send a string in both cases and never run this hook.

## What Didn't Work

- **Disabling only the suspected plugin.** Denying Magic Context with a `plugin.use` policy still reproduced the break, and that was read as proof of a host bug. Systematic's own `context` hook was still running.
- **Attributing it to the host from source reading.** The report filed upstream ([anomalyco/opencode#64794](https://github.com/anomalyco/opencode/issues/64794)) blamed two different host paths for the live and rebuilt requests. The maintainers' bot showed that core builds every request from stored session state through one path, and that a plain plugin tool sends the same string live and after a restart. The report was corrected and closed.
- **Header differences between v1 and v2.** Adding the missing WebSocket handshake headers changed nothing. They were tested against a rarer, unrelated miss.

The cause showed up only once a plain tool was compared with the same tool plus a `context` hook doing Systematic's rewrite. The plain tool stayed a string. With the hook, the live request turned into an array.

## Solution

Fixed in #1459 (v3.35.3). `restorePart` used to assign a new `content` result whenever the store had an entry:

```ts
part.result = { type: 'content', value: [{ type: 'text', text: full }] }
```

It now goes through `restoredResult` (`src/lib/opencode-v2-skills.ts:177`). The helper (`src/lib/opencode-v2-skills.ts:187-205`) does three things:
- It keeps the incoming kind: `text` stays `text`, and `content` stays `content`.
- It returns the result unchanged when it already holds the full text.
- It leaves error results alone.

A result the host did cut is still restored in full, in the same kind it arrived in.

The regression tests:

- **Unit test.** The test in `tests/unit/opencode-v2-skills.test.ts` throws `the context hook is not registered` (`tests/unit/opencode-v2-skills.test.ts:809`) if the hook is missing, then runs the hook over repeated requests. It covers uncut text (unchanged), cut text (restored as `text`) and cut content (restored as `content`). The error case is at `tests/unit/opencode-v2-skills.test.ts:727`. The old tests checked that cut content was restored but never that an uncut result kept its shape.
- **Wire test.** The test in `tests/integration/opencode-v2.test.ts:2106` drives a real v2 host against a scripted `/responses` provider. It loads a skill, sends a follow-up, stops the host, starts a new one on the same session, and prompts again. It reads the raw values with `functionCallOutputs` (`tests/integration/opencode-v2.test.ts:295`) and asserts that the three requests carrying that call (the continuation, the follow-up and the one after the restart) each send exactly the full skill text as a string.

With 3.35.3 the same v1/v2 comparison showed 0 shape changes across 189 tool outputs, and v2's uncached tokens per task fell below v1's.

## Why This Works

The host sends a `content` result as an array and a `text` result as a string, and it stores a single text part as `text` ([`lowerToolResultOutput`, v2.3.2](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/ai/src/protocols/open-responses.ts#L641-L652)). The store is a per-process `Map` (`src/lib/skill-tool.ts:43`) capped by `RESTORE_MAX_ENTRIES` (`src/lib/opencode-v2-skills.ts:80`). The hook is registered with `ctx.session.hook('context', restore)` (`src/lib/opencode-v2-skills.ts:305`) and runs on every request.

The old rewrite therefore made the request bytes depend on a cache that a restart empties. The new output depends only on the result the host persisted, plus the full text, so a store hit and a store miss produce the same bytes whenever the host did not cut the result.

## Prevention

- A hook that rewrites outgoing history must be a function of persisted state. If a process-local cache only upgrades content, keep the host's shape and return the original object when there is nothing to upgrade.
- Test the wire value, not flattened text. Compare the raw `function_call_output.output` across a live request, a follow-up and a restarted host, and compare it with the expected full text so that a value that is stable but wrong also fails.
- A unit test for a hook should fail when the hook is not registered.
- To isolate a cache regression, turn off every plugin's `context` and transform hooks, your own included, before blaming the host. Give upstream a plain-plugin repro rather than a cause inferred from reading code.
- Text the host cut at its output limit survives a restart too: every `systematic_skill` load is kept in the plugin's `ctx.storage` by session, calling message and call id (newest 32 records, 7 days, one 2 s budget per write and its cleanup) and read back when the in-memory store misses and the result has the host's cut shape (#1461). The fix keeps an uncut skill's bytes the same whether or not the store has the entry. That removes this cause of a prefix break; it does not guarantee a provider cache hit.

## Related Issues

- #1459 (fix), #1461 (over-limit restore after a restart)
- [OpenCode truncates plugin tool output before any hook runs](plugin-tool-output-truncated-before-after-hook-2026-09-26.md) explains why the v2 restore lives in the `context` hook.
- [Testing host prune from a plugin](../best-practices/testing-host-prune-from-a-plugin-2026-10-20.md) covers inspecting the provider request after a host-side change, with an in-run control.
- [Host-contract evidence is CI-owned](../workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md) explains why the wire test counts only where the v2 suite actually ran.
