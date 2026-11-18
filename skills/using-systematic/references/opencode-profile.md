# OpenCode Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | `task()` tool; `subagent_type` selects a specialist, `task_id` continues a running or finished child session | supported; parallel and background dispatch may be available | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `question` tool | supported | Present numbered options in chat and wait |
| Task tracking | `todowrite` | supported | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` for bundled skills; `skill` tool for non-Systematic skills | supported | Read the skill instructions listed by the active harness |
| Durable-output search | `systematic_search` tool over `docs/solutions/`; absent when `search.enabled` is false | supported | Grep `docs/solutions/` |

## Invocation examples

### Subagent delegation

```typescript
task({
  subagent_type: "systematic-implementer",
  description: "Implement auth module",
  prompt: "Implement the auth module and return the changed files.",
})

// Background dispatch (run independent work concurrently; reconcile on completion):
task({
  subagent_type: "repo-research-analyst",
  description: "Map fixture patterns",
  prompt: "…",
  background: true,
})

// Continue a prior specialist session (see Dispatch results and continuation):
task({ subagent_type: "systematic-implementer", task_id: "<prior-session-id>", description: "Resume the implementation task", prompt: "…" })
```

`subagent_type` takes a bare agent stem — OpenCode registers bundled agents under
their filename stem, not a namespaced identifier. Prose that *refers* to an agent
uses the canonical `systematic:<category>:<name>` form instead, which the
content-integrity gate validates against real agent files.

Both forms are enforced. Examples in bundled content must name agents this
package actually ships, so they work for every reader. A host may provide
additional agents through the user's own configuration; those are available at
runtime but must not appear in bundled examples.

### Dispatch results and continuation

A foreground `task` returns the child's answer in the call result, inside a `<task id="…" state="…">` block; the block's body is the child's answer. Record that `id` at dispatch, against the task it was given. To continue the same child, call `task` again with it as `task_id`, plus `subagent_type`, `description` and `prompt` (the follow-up only; the child keeps its context). A `background: true` dispatch returns the same block with `state="running"`, which is not final.

**Wait path.** A foreground `task` (the default) blocks until the child answers, so there is nothing to wait for. `background: true` works only with the host's experimental background-subagents flag, and the call fails without it; where it is on, the final result arrives as a synthetic `<task>` message that starts a new parent turn, so the parent may end its turn. Where the flag is off or unknown, dispatch in the foreground.

### Blocking user interaction

```typescript
question({
  questions: [{ question: "Which deployment target should I use?", header: "Deployment target",
    options: [{ label: "Staging", description: "Deploy to staging" }] }],
})
```

### Task tracking

```typescript
todowrite({
  todos: [{ content: "Run validation", status: "pending", priority: "high" }],
})
```

### Skill loading

```typescript
systematic_skill({ name: "systematic:using-systematic" })
skill({ name: "external-skill" })
```
