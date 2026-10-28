# OpenCode v2 Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | `subagent` tool; `agent` selects a specialist, `sessionID` resumes a session, `background: true` runs it asynchronously | supported; foreground by default | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `question` tool | supported | Present numbered options in chat and wait |
| Task tracking | `todowrite` tool | conditional: only offered when the host's experimental `todo` option is on | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` for bundled skills, with arguments; `skill` tool (by `id`) for non-Systematic skills | supported | Read the skill instructions listed by the active harness |

## Invocation examples

### Subagent delegation

```typescript
subagent({
  agent: "systematic-implementer",
  description: "Implement auth module",
  prompt: "Implement the auth module and return the changed files.",
})

// Background dispatch (run independent work concurrently; you are notified on completion):
subagent({
  agent: "repo-research-analyst",
  description: "Map fixture patterns",
  prompt: "…",
  background: true,
})

// Resume a prior specialist session:
subagent({ agent: "systematic-implementer", sessionID: "<prior-session-id>", description: "Resume the implementation task", prompt: "…" })
```

`agent` takes a bare agent stem — OpenCode registers bundled agents under
their filename stem, not a namespaced identifier. Prose that *refers* to an agent
uses the canonical `systematic:<category>:<name>` form instead, which the
content-integrity gate validates against real agent files. Leave `model` unset
unless the user names a model.

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
  todos: [{ content: "Run validation", status: "pending" }],
})
```

`status` is one of `pending`, `in_progress`, `completed`, `cancelled`. When `todowrite` is not offered, keep the task list in your responses instead.

### Skill loading

```typescript
systematic_skill({ name: "systematic:using-systematic" })
systematic_skill({ name: "systematic:reproduce-bug", arguments: "ISSUE-123" })
skill({ id: "external-skill" })
```

Pass `arguments` to `systematic_skill` only when the user supplied them; the `skill` tool takes no arguments.
