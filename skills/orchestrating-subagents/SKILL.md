---
name: orchestrating-subagents
description: Use when dispatching parallel or serial subagents, coordinating multi-unit plan execution, synthesizing results from independent subagent runs, or handling subagent failure and retry. Triggers on requests to run tasks in parallel, divide work, orchestrate a pipeline of dependent steps, or coordinate multiple agents without shared-file conflicts.
metadata:
  harness-portability: neutral-v1
---

# Orchestrating Subagents

Dispatch, coordinate, and synthesize results from subagents using the harness's delegation mechanism (see the active harness profile).

## The Portable Primitive

Every subagent dispatch should carry the same bounded brief, expressed through the active harness's delegation mechanism:

```text
Specialist: systematic-implementer
Objective: Implement the auth module
Scope: Make only the changes needed for the auth module.
Workspace: /absolute/path/to/expected-repository-or-worktree
Return: List the changed files and summarize the implementation.
```

**Required brief elements:**
- **Specialist** — the registered agent or persona best suited to the work (for example, an implementer or researcher)
- **Objective** — a concise statement of the outcome
- **Scope** — full instructions, boundaries, dependencies, and files in scope
- **Workspace** — for any write-capable dispatch, the explicit expected repository or worktree root
- **Return** — the result format expected from the specialist

**Optional brief elements:**
- **Session reference** — resume a prior specialist session instead of creating a new one, where the harness supports session reuse
- **Trigger context** — the command or workflow that initiated the dispatch

A foreground dispatch blocks until the specialist returns its result. Use the active harness profile to determine whether foreground, background, or other dispatch modes are available. Run independent dispatches concurrently where the harness supports it; otherwise dispatch sequentially in dependency order.

## Background Dispatch (When Available)

Background dispatch may be gated by a runtime capability or feature flag. Check the active harness profile and rely on whether the mechanism accepts background work.

When background dispatch is available, it runs asynchronously and the harness reports the result to the parent session when the specialist completes. Do not poll or sleep.

When background dispatch is unavailable, fall back to foreground dispatch—serially or in small foreground batches.

## Serial vs Parallel Dispatch

### Serial (default, always safe)

Dispatch one specialist, wait for its result, then dispatch the next. Use when:
- Units have dependencies (unit B needs unit A's output)
- Units touch overlapping files
- You need to verify each result before proceeding

```text
First dispatch:
  Specialist: best-practices-researcher
  Objective: Research caching patterns
  Scope: Research Redis caching best practices for Rails APIs.
  Return: Summarize recommendations and constraints.

After the first result, dispatch:
  Specialist: systematic-implementer
  Objective: Implement caching
  Scope: Implement caching based on the research result below.
  Input: Include the first specialist's returned research.
  Workspace: /absolute/path/to/expected-repository-or-worktree
  Return: List changed files and summarize the implementation.
```

Use the first specialist's returned research to guide the dependent implementation dispatch.

### Parallel (independent dispatches)

Dispatch multiple independent specialists concurrently where the harness supports it. Use when:
- Units are fully independent (no shared files, no dependency on each other's output)
- You have passed the Parallel Safety Check (see below)

```text
Concurrent dispatch 1:
  Specialist: security-reviewer
  Objective: Perform a security review
  Scope: Review the proposed changes for security issues.
  Return: Findings with severity and file references.

Concurrent dispatch 2:
  Specialist: performance-reviewer
  Objective: Perform a performance review
  Scope: Review the proposed changes for performance issues.
  Return: Findings with severity and file references.

Concurrent dispatch 3:
  Specialist: correctness-reviewer
  Objective: Perform a correctness review
  Scope: Review the proposed changes for functional issues.
  Return: Findings with severity and file references.
```

All three review dispatches run independently; the orchestrator synthesizes their results after all complete.

## Parallel Safety Check

Before dispatching units in parallel, verify:

1. **No file overlap** — build a file-to-unit map from each unit's declared files. Any file appearing in 2+ units means overlap → use serial dispatch instead.
2. **No git index contention** — parallel specialists must not stage files (`git add`), create commits, or run the full test suite. If the current workflow owns git operations, the orchestrator handles staging and committing after all parallel units complete; otherwise, synthesize results and file lists and leave staging/committing to the caller or user.
3. **No test interference** — concurrent test runs pick up each other's in-progress changes. Instruct parallel specialists not to run the project test suite.

If any check fails, downgrade to serial dispatch. Log the reason (for example, "Units 2 and 4 share `config/routes.rb` — using serial dispatch").

## Subagent Constraints for Parallel Work

When dispatching units in parallel, include these instructions in each specialist's brief:

> Do not stage files (`git add`), create commits, or run the project test suite. Leave staging and committing to the orchestrator or caller.

## Workspace Attestation

For every write-capable dispatch, the specialist must verify and return its actual repository or worktree root using available repository tooling (for example, `git rev-parse --show-toplevel` when Git is available) and an inventory of changed files. The orchestrator must independently verify the expected worktree's status and diff, plus the source or primary checkout's status, before accepting the result; a path in the brief or a specialist's self-report is not evidence.

If writes landed in the wrong checkout, stop dependent dispatches, inspect both diffs, transfer only intended changes deliberately, and restore only confirmed accidental agent edits. Do not blindly copy or reset.

## Result Synthesis

After specialists complete, the orchestrator synthesizes results:

1. **Wait for all** — in a parallel batch, wait for every specialist to finish before acting on any result.
2. **Check for file collisions** — compare actual files modified by all specialists in the batch (not just declared files). If 2+ specialists modified the same file, only the last writer's version survives. If the workflow owns git operations, resolve by staging non-colliding files first, then re-running the affected units serially; otherwise, report the collision list to the caller.
3. **Review each diff** — verify changes match the unit's declared scope.
4. **Run targeted tests** — run the narrowest test command relevant to the changed files.
5. **Stage and commit per unit (if the workflow owns git operations)** — in dependency order, stage only that unit's files and commit with a conventional message. If git operations belong to the caller or user, synthesize the result list and file inventory instead.

## Failure and Retry

- If a specialist returns an error or its output is incomplete, diagnose before dispatching dependent units.
- Do not dispatch dependent units on a broken tree.
- Retry a failed unit by re-dispatching with a corrected brief, or resume the prior specialist session where the harness supports session reuse.
- For background work (when available): wait for the automatic completion notification (the result is delivered into the parent session). Do not poll or sleep. Retry by re-dispatching with a corrected brief, or resume the prior specialist session where the harness supports session reuse.

## Quick Reference

| Scenario | Approach |
|---|---|
| Units have dependencies | Serial foreground dispatch |
| Units share files | Serial foreground dispatch |
| Units are independent, no file overlap | Concurrent dispatch where supported; otherwise batched foreground dispatch |
| Background available + long-running work | Concurrent background dispatch; results are pushed back to the parent on completion (no polling) |
| Background unavailable | Foreground only — serial or batched |
| Specialist fails | Diagnose, correct the brief, then re-dispatch or resume the prior session where supported |
| File collision detected post-parallel | Stage non-colliding files (if workflow owns git ops), re-run colliding units serially |
| Write-capable dispatch | Include the expected root; require actual-root and changed-file attestation; independently verify both worktrees before acceptance |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Polling or sleeping to wait for background work | Background results are pushed into the parent session automatically; never poll or sleep |
| Parallel specialists staging or committing | Instruct specialists not to stage/commit; the current workflow owner handles git ops when applicable, otherwise synthesize file inventory and results for the caller or user |
| Dispatching dependent units without waiting | Always wait for prerequisites to complete and verify their output |
| Ignoring file overlap in parallel batches | Run the Parallel Safety Check before every parallel dispatch |
| Assuming background support without checking the active profile | Use background dispatch only when the active harness profile declares it available; otherwise dispatch in the foreground |
