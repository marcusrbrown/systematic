# OpenCode v2 Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | `subagent` tool; `agent` selects a specialist, `sessionID` continues a running or finished child; before 2.3.0, `background: true` runs it asynchronously | supported; from 2.3.0 every dispatch returns a handle and the answer arrives later as a `<subagent>` message; before that, foreground by default | Dispatch serially or in small batches |
| Blocking user interaction | `question` tool | supported | Present numbered options in chat and wait |
| Task tracking | `todowrite` tool | conditional: only offered when the host's experimental `todo` option is on | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` for bundled skills, with arguments; `skill` tool (by `id`) for non-Systematic skills | supported | Read the skill instructions listed by the active harness |
| Durable-output search | `systematic_search` tool over `docs/solutions/`; absent when `search.enabled` is false | supported | Grep `docs/solutions/` |

## Invocation examples

### Subagent delegation

```typescript
subagent({
  agent: "systematic-implementer",
  description: "Implement auth module",
  prompt: "Implement the auth module and return the changed files.",
})

// Background dispatch, before 2.3.0 (2.3.0 and later always return a handle at once):
subagent({
  agent: "repo-research-analyst",
  description: "Map fixture patterns",
  prompt: "…",
  background: true,
})

// Continue a prior specialist session (see Dispatch results and continuation):
subagent({ agent: "systematic-implementer", sessionID: "<prior-session-id>", description: "Resume the implementation task", prompt: "…" })
```

Skill text that names OpenCode's `task` tool with `subagent_type` means the `subagent` tool with `agent` on this host, and `task_id` means `sessionID`.

`agent` takes a bare agent stem — OpenCode registers bundled agents under
their filename stem, not a namespaced identifier. Prose that *refers* to an agent
uses the canonical `systematic:<category>:<name>` form instead, which the
content-integrity gate validates against real agent files. Leave `model` unset
unless the user names a model.

Both forms are enforced. Examples in bundled content must name agents this
package actually ships, so they work for every reader. A host may provide
additional agents through the user's own configuration; those are available at
runtime but must not appear in bundled examples.

### Dispatch results and continuation

From 2.3.0, `subagent` returns immediately with a handle, not the child's answer: a `sessionID` and `status: "running"`. Record the `sessionID` at dispatch, against the task it was given. The answer arrives later as a `<subagent sessionID="…" state="…">` message that starts a new parent turn, and the message body is the child's answer. Do not poll, sleep or dispatch the same work again while the child runs.

- `state="completed"` ends that round of work. `error` and `cancelled` are final failures. `state="running"` means the child went idle with background work still going: it is not final, so wait for the next `<subagent>` message.
- To follow up a running or finished child, call `subagent` again with its `sessionID`, plus `agent` (the specialist it was dispatched as), `description` and `prompt` (the follow-up only; the child keeps its context). The call returns a handle again and the reply arrives as another `<subagent>` message. The `sessionID` must name a child of the current session.
- A host or plugin may refuse a `sessionID` follow-up with an error. The refusal is final: do not retry the call, and error text that suggests starting a new task is not a reason to dispatch a new child. The calling workflow's own rules say what a refused follow-up costs.
- Before 2.3.0, a foreground dispatch returned the `<subagent sessionID="…" state="completed">` block inline, `background: true` returned a handle, and a follow-up behaved the same way. 2.3.0 always returns a handle and has no `background` input.

**Wait path.** From 2.3.0 a report wakes the parent: after a dispatch the parent may end its turn, and each `<subagent>` message starts a new parent turn. Before 2.3.0 a foreground dispatch blocks until the child answers, so there is nothing to wait for.

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
