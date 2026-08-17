# OpenCode Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | `task()` tool; `subagent_type` selects a specialist, `task_id` resumes a session | supported; parallel and background dispatch may be available | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `question` tool | supported | Present numbered options in chat and wait |
| Task tracking | `todowrite` | supported | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` for bundled skills; `skill` tool for non-Systematic skills | supported | Read the skill instructions listed by the active harness |

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

// Resume a prior specialist session:
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
