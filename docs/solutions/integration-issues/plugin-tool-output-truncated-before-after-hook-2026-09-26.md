---
title: OpenCode truncates plugin tool output before any hook runs
date: 2026-09-26
category: integration-issues
module: systematic-plugin
problem_type: integration_issue
component: tooling
symptoms:
  - "systematic_skill output for a large skill ends with `...N bytes truncated...` and a 'Full output saved to' hint"
  - "ce:review (71 KB) and ce:plan (63 KB) reach the model cut off mid-instructions"
  - "Unit tests on the tool's returned string pass while the model still sees a preview"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [opencode, plugin-tool, truncation, tool-execute-after, systematic-skill, host-contract]
---

# OpenCode truncates plugin tool output before any hook runs

## Problem

`systematic_skill` built the full skill body, but OpenCode truncated the tool output before the model saw it, so large skills arrived cut off mid-instructions.

## Symptoms

- The tool result ended with `\n\n...N bytes truncated...\n\n`, then `The tool call succeeded but the output was truncated. Full output saved to: <path>` and advice to grep, read with offset/limit, or delegate to an explore agent.
- Loading `ce:plan` through the tool stopped in the middle of its workflow.
- Tests that checked the string `execute` returned all passed. The truncation happens after `execute` returns.

## What Didn't Work

- **Returning `metadata.truncated: false`.** In OpenCode v1.18.32, `tool/registry.ts` `fromPlugin` runs `truncate.output(...)` on every plugin tool result and then overwrites `metadata.truncated` with its own result. Only built-in tools defined with `Tool.define` honor a preset `truncated` value.
- **Raising `tool_output.max_lines` / `max_bytes`.** This works, but it's a global config change that affects every tool, and the user didn't want it.
- **Rebuilding the text in `tool.execute.after` from the preview.** The tail is already gone by then.
- **Re-reading the skill file in the after hook.** It works as a fallback, but it adds a disk read and can drift from the text the permission check approved.
- **Correlating `before` and `execute` by matching args.** This breaks under parallel calls.

## Solution

Keep the exact output in `execute`, keyed by `sessionID` + `callID`, and restore it in `tool.execute.after`. At runtime `callID` reaches plugin `execute`, because OpenCode's `tool/registry.ts` `fromPlugin` spreads its `Tool.Context` into the plugin context. The installed `ToolContext` type omits it, so read it with a runtime check (`src/lib/skill-tool.ts`):

```ts
await context.ask({ permission: 'skill', patterns: [matchedSkill.prefixedName], always: [matchedSkill.prefixedName], metadata: {} })

if (outputStore) {
  const contextRecord: unknown = context
  if (
    isRecord(contextRecord) &&
    typeof contextRecord.sessionID === 'string' && contextRecord.sessionID !== '' &&
    typeof contextRecord.callID === 'string' && contextRecord.callID !== ''
  ) {
    outputStore.put(contextRecord.sessionID, contextRecord.callID, output)
  }
}
return output
```

The store is a plain `Map` with a 32-entry cap (oldest evicted first) and a 5-minute TTL. `take` always deletes the entry. `restoreSkillOutput` only replaces the output when every guard passes, and it mutates the host's `metadata` object in place so other plugins' keys survive:

```ts
const full = store.take(sessionID, callID) // always consumed once identity matches
if (!full) return
if (options.userOutputLimitSet) return
if (!isRecord(output)) return
if (!isRecord(output.metadata) || output.metadata.truncated !== true) return
if (typeof output.output !== 'string') return
const lastMatch = [...output.output.matchAll(TRUNCATION_MARKER_RE)].at(-1) // /\n\n\.\.\.\d+ (?:lines|bytes) truncated\.\.\.\n\n/g
if (!lastMatch || lastMatch.index === undefined) return
if (!full.startsWith(output.output.slice(0, lastMatch.index))) return
output.output = full
output.metadata.truncated = false
delete output.metadata.outputPath
```

In `src/index.ts`, the existing after-hook wrapper runs the workflow guard first and the restore second, each in its own `try`. The config hook recomputes the user-limit flag on every call:

```ts
config: async (incomingConfig: Config): Promise<void> => {
  const configUnknown: unknown = incomingConfig
  userOutputLimitSet =
    isRecord(configUnknown) &&
    isRecord(configUnknown.tool_output) &&
    (configUnknown.tool_output.max_lines !== undefined ||
      configUnknown.tool_output.max_bytes !== undefined)
  return configHandler(incomingConfig)
},
```

OpenCode's default limits (2,000 lines, 50 KiB) are constants in `truncate.ts` and never appear in config. A defined `tool_output` limit therefore means the user set it, and the plugin respects it.

## Why This Works

At v1.18.32 the host call order for a plugin tool is `execute` → `truncate.output` → `tool.execute.after`. The last hook receives one mutable output object, which the host then persists and sends to the model unchanged. The after hook never sees the full text, but the plugin produced that text a moment earlier and can keep it. The after hook runs only when `execute` returned, so denied permissions and errors never leave entries behind. The prefix check means another plugin that rewrote the output is never overwritten.

Slash-command templates don't go through this path: `SessionPrompt.command` turns them into user-message text and doesn't truncate them.

## Prevention

- **Assert at the model boundary.** `tests/integration/skill-delivery.test.ts` runs the real pinned host with a mock OpenAI-compatible provider and checks the provider's inbound request:

  ```ts
  const content = toolResultContent(model.requests, 'ce-review-call')
  expect(content).toContain(CE_REVIEW_FINAL_LINE)
  expect(content).not.toContain(TRUNCATION_MARKER)
  ```

  The 71,517-byte `ce-review` file arrives as 73,764 bytes. With `tool_output.max_bytes` or `max_lines` set, the marker stays.
- **Assume host post-processing wins.** A plugin's own metadata can't opt out of it.
- **Recompute config-derived flags on every config hook call.** The first version only ever set the flag to `true`, so removing a limit never re-enabled restoration.
- **Mutate host-owned objects in place.** Merge metadata keys; never replace the object.
- **Re-check after every OpenCode pin bump.** The suite is listed in `scripts/host-contract-guard.ts`, so the required `host-contract` job catches marker or ordering changes.

## Related Issues

- #1029 (fix), #1028 (opt-in `compaction.prune` can still clear an older `systematic_skill` result; only the tool named `skill` is protected)
- [`workflow-guard-skipped-skills-over-32kb-2026-09-26.md`](workflow-guard-skipped-skills-over-32kb-2026-09-26.md), found while designing this fix
- [`opencode-plugin-hook-silent-defect-swallow-2026-05-19.md`](opencode-plugin-hook-silent-defect-swallow-2026-05-19.md)
- [`../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`](../workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md)
