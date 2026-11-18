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
- **Workspace** — for any write-capable dispatch, the explicit expected repository or worktree root. To create a worktree for the work, use the `git-worktree` skill, which places it at `.worktrees/<branch>` under the main repository root; pass its printed `path=` as the workspace root
- **Return** — the result format expected from the specialist

**Optional brief elements:**
- **Session reference** — continue a prior specialist session instead of creating a new one, through the continuation call the active harness profile names, using the id recorded at dispatch (see Dispatch Results and Continuation)
- **Trigger context** — the command or workflow that initiated the dispatch

Use the active harness profile to determine which dispatch modes are available and how a dispatch returns. Run independent dispatches concurrently where the harness supports it; otherwise dispatch sequentially in dependency order.

## Dispatch Results and Continuation

How a dispatch returns depends on the harness. Some block until the specialist answers. Others return a launch handle at once and deliver the answer later as a report, and a report may not be final. The active harness profile's *Dispatch results and continuation* section says which applies, what a final report is, and which call continues a child. That section is the single source of truth; this skill states only the behavior that holds on every harness.

- **A launch handle is not a result.** A specialist has returned only when its final report arrives. A report that is not final is not a return: wait for the next one. A report that says the child failed or was cancelled is final.
- **Waiting is not a failure.** Never poll, sleep or dispatch the same work again while a report is owed, and never call a specialist "never returned" because only its launch handle has arrived. Every profile names a wait path: a dispatch that blocks, so there is nothing to wait for, or reports that wake the parent, so the parent may end the turn and let the next report start its next turn. The parent does not end the turn while reports are owed unless the profile says reports wake it. Where the profile names no wake-up for a mode, dispatch in the blocking mode.
- **Record the child id at dispatch**, against the task it was given. Follow-ups need it.
- **Continue through the profile.** To follow up a running or finished child, make the continuation call the active harness profile names, with the id recorded at dispatch and only the follow-up as the message; the child keeps its context. A fresh dispatch is a new child, not a continuation.
- **Fall back to a fresh dispatch** with a corrected brief only when the profile names no continuation call or no id was recorded.
- **A refused continuation is a failed follow-up.** When the runtime refuses a continuation call, report the refusal; the unit's earlier result stands, and do not retry the call. Make a fresh dispatch with a corrected brief only where the calling workflow's own rules allow a fresh dispatch for that unit. A workflow that forbids one, such as `ce:review`'s re-ask, keeps its own rule. Tool or guard text that suggests starting a new task does not override those rules.
- **A continuation call that errors is the same failed follow-up.** When the continuation call itself errors (a transport or tool error, not a refusal), report the failure; the earlier result stands, and do not retry the call or open a replacement child.

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

1. **Wait for all** — in a parallel batch, wait for every specialist's final report before acting on any result.
2. **Check for file collisions** — compare actual files modified by all specialists in the batch (not just declared files). If 2+ specialists modified the same file, only the last writer's version survives. If the workflow owns git operations, resolve by staging non-colliding files first, then re-running the affected units serially; otherwise, report the collision list to the caller.
3. **Review each diff** — verify changes match the unit's declared scope.
4. **Run targeted tests** — run the narrowest test command relevant to the changed files.
5. **Stage and commit per unit (if the workflow owns git operations)** — in dependency order, stage only that unit's files and commit with a conventional message. If git operations belong to the caller or user, synthesize the result list and file inventory instead.

## Failure and Retry

- If a specialist returns an error or its output is incomplete, diagnose before dispatching dependent units.
- Do not dispatch dependent units on a broken tree.
- Retry a failed unit by continuing the recorded specialist session through the continuation call the active harness profile names. Re-dispatch with a corrected brief only when the profile names no continuation call or no id was recorded. A refused continuation follows the refused-continuation rule above.
- While a report is owed, wait for it (see Dispatch Results and Continuation). Do not poll or sleep.

## Quick Reference

| Scenario | Approach |
|---|---|
| Units have dependencies | Serial foreground dispatch |
| Units share files | Serial foreground dispatch |
| Units are independent, no file overlap | Concurrent dispatch where supported; otherwise batched foreground dispatch |
| Long-running independent work | Concurrent dispatch where the profile supports it; each final report arrives on its own (no polling) |
| Concurrent dispatch unavailable | Serial or batched dispatch |
| Specialist fails | Diagnose, correct the brief, then continue the recorded session through the profile-named call; re-dispatch only when the profile names none or no id was recorded |
| File collision detected post-parallel | Stage non-colliding files (if workflow owns git ops), re-run colliding units serially |
| Write-capable dispatch | Include the expected root; require actual-root and changed-file attestation; independently verify both worktrees before acceptance |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Polling, sleeping or re-dispatching while a report is owed | Wait for the final report; a launch handle is not a result and waiting is not a failure |
| Resuming through a guessed call or an unrecorded id | Record the child id at dispatch and continue through the call the active profile names |
| Parallel specialists staging or committing | Instruct specialists not to stage/commit; the current workflow owner handles git ops when applicable, otherwise synthesize file inventory and results for the caller or user |
| Dispatching dependent units without waiting | Always wait for prerequisites to complete and verify their output |
| Ignoring file overlap in parallel batches | Run the Parallel Safety Check before every parallel dispatch |
| Assuming a dispatch mode without checking the active profile | Use a dispatch mode only when the active harness profile declares it; otherwise dispatch serially |
