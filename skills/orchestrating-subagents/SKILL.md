---
name: orchestrating-subagents
description: Use when dispatching parallel or serial subagents in OpenCode, coordinating multi-unit plan execution, synthesizing results from independent subagent runs, or handling subagent failure and retry. Triggers on requests to run tasks in parallel, divide work across subagents, orchestrate a pipeline of dependent steps, or coordinate multiple agents without shared-file conflicts.
---

# Orchestrating Subagents

Dispatch, coordinate, and synthesize results from OpenCode subagents using the `task()` primitive.

## The Portable Primitive

Every subagent dispatch goes through `task()`:

```typescript
task({
  subagent_type: "systematic-implementer",
  description: "Implement auth module",
  prompt: "...",
})
```

**Required parameters:**
- `subagent_type` — the registered agent name (e.g., `systematic-implementer`, `best-practices-researcher`)
- `description` — 3–5 word label shown in the UI
- `prompt` — full instructions for the subagent

**Optional:**
- `task_id` — resume a prior subagent session instead of creating a new one
- `command` — the slash command that triggered this task

Foreground dispatch (no `background` parameter) blocks until the subagent returns its result. **This is the default and works on all OpenCode versions.**

## Background Dispatch (Experimental)

Background dispatch is gated by a runtime flag. It is **not available by default**.

```typescript
// Only use when the runtime exposes background support
task({
  subagent_type: "systematic-implementer",
  description: "Implement auth module",
  prompt: "...",
  background: true,   // experimental — see below
})
```

**When background is available:** `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (or the umbrella `OPENCODE_EXPERIMENTAL=true`) must be set. When enabled, `background: true` runs the subagent asynchronously. OpenCode automatically injects the result into the parent session as a synthetic message when the subagent completes. You are notified; you do not poll.

**When background is unavailable:** Passing `background: true` returns an error. Fall back to foreground dispatch — dispatch subagents serially or in small foreground batches instead.

**Check before assuming:** Rely on whether `background: true` is accepted (i.e., the env flag is set). If it returns an error, use foreground dispatch only.

## Serial vs Parallel Dispatch

### Serial (default, always safe)

Dispatch one subagent, wait for its result, then dispatch the next. Use when:
- Units have dependencies (unit B needs unit A's output)
- Units touch overlapping files
- You need to verify each result before proceeding

```typescript
const researchResult = task({
  subagent_type: "best-practices-researcher",
  description: "Research caching patterns",
  prompt: "Research Redis caching best practices for Rails APIs...",
})

// Use research output to guide implementation
task({
  subagent_type: "systematic-implementer",
  description: "Implement caching",
  prompt: `Implement caching based on this research:\n\n${researchResult}`,
})
```

### Parallel (foreground batches)

Dispatch multiple foreground subagents in the same turn. OpenCode runs them concurrently when dispatched together. Use when:
- Units are fully independent (no shared files, no dependency on each other's output)
- You have passed the Parallel Safety Check (see below)

```typescript
// Dispatch independent review subagents together
task({ subagent_type: "security-sentinel", description: "Security review", prompt: "..." })
task({ subagent_type: "performance-oracle", description: "Performance review", prompt: "..." })
task({ subagent_type: "correctness-reviewer", description: "Correctness review", prompt: "..." })
// All three run; orchestrator synthesizes results after all complete
```

## Parallel Safety Check

Before dispatching units in parallel, verify:

1. **No file overlap** — build a file-to-unit map from each unit's declared files. Any file appearing in 2+ units means overlap → use serial dispatch instead.
2. **No git index contention** — parallel subagents must not stage files (`git add`), create commits, or run the full test suite. If the current workflow owns git operations, the orchestrator handles staging and committing after all parallel units complete; otherwise, synthesize results and file lists and leave staging/committing to the caller or user.
3. **No test interference** — concurrent test runs pick up each other's in-progress changes. Instruct parallel subagents not to run the project test suite.

If any check fails, downgrade to serial dispatch. Log the reason (e.g., "Units 2 and 4 share `config/routes.rb` — using serial dispatch").

## Subagent Constraints for Parallel Work

When dispatching units in parallel, include these instructions in each subagent's prompt:

> Do not stage files (`git add`), create commits, or run the project test suite. Leave staging and committing to the orchestrator or caller.

## Result Synthesis

After subagents complete, the orchestrator synthesizes results:

1. **Wait for all** — in a parallel batch, wait for every subagent to finish before acting on any result.
2. **Check for file collisions** — compare actual files modified by all subagents in the batch (not just declared files). If 2+ subagents modified the same file, only the last writer's version survives. If the workflow owns git operations, resolve by staging non-colliding files first, then re-running the affected units serially; otherwise, report the collision list to the caller.
3. **Review each diff** — verify changes match the unit's declared scope.
4. **Run targeted tests** — run the narrowest test command relevant to the changed files.
5. **Stage and commit per unit (if the workflow owns git operations)** — in dependency order, stage only that unit's files and commit with a conventional message. If git operations belong to the caller or user, synthesize the result list and file inventory instead.

## Failure and Retry

- If a subagent returns an error or its output is incomplete, diagnose before dispatching dependent units.
- Do not dispatch dependent units on a broken tree.
- Retry a failed unit by dispatching a new `task()` call with a corrected prompt, or resume the prior session with `task_id`.
- For background tasks (when available): wait for the automatic completion notification (the result is injected into the parent session). Do not poll or sleep. Retry by dispatching a new `task()` with a corrected prompt, or resume with `task_id`.

## Quick Reference

| Scenario | Approach |
|---|---|
| Units have dependencies | Serial foreground dispatch |
| Units share files | Serial foreground dispatch |
| Units are independent, no file overlap | Parallel foreground dispatch |
| Background available + long-running work | Parallel background dispatch; results are pushed back to the parent on completion (no polling) |
| Background unavailable | Foreground only — serial or batched |
| Subagent fails | Diagnose, fix prompt, retry with new `task()` or resume with `task_id` |
| File collision detected post-parallel | Stage non-colliding files (if workflow owns git ops), re-run colliding units serially |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Polling or sleeping to wait for a background subagent | Background results are pushed into the parent session automatically; never poll or sleep |
| Parallel subagents staging or committing | Instruct subagents not to stage/commit; the current workflow owner handles git ops when applicable, otherwise synthesize file inventory and results for the caller or user |
| Dispatching dependent units without waiting | Always wait for prerequisites to complete and verify their output |
| Ignoring file overlap in parallel batches | Run the Parallel Safety Check before every parallel dispatch |
| Using `background: true` without the experimental flag enabled | Only use background when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`; otherwise dispatch foreground |
