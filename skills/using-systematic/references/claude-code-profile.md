# Claude Code Capability Profile

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | Name-based subagent dispatch; plugin agents ship in `agents/`; `context: fork` for skill-scoped forks; `SendMessage` continues a subagent by agent id | supported | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `AskUserQuestion` tool | supported | Present numbered options in chat and wait |
| Task tracking | `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` (`TodoWrite` is deprecated and disabled by default) | supported | Maintain a visible task list in responses |
| Skill loading | Native Skill tool with `SKILL.md` discovery (`~/.claude/skills/`, `.claude/skills/`, plugin `skills/`); Systematic ships no `systematic_skill` tool on Claude Code | supported | Read the skill instructions listed by the active harness |
| Durable-output search | `systematic-search` command in the plugin `bin/`; probe with `command -v systematic-search`; user-level config only | supported | Grep `docs/solutions/` |

Behavioral enforcement on Claude Code rides a plugin output style (force-for-plugin); a declarative `SessionStart` hook carries state only, since imperative hook content is refused as prompt injection.

## Invocation examples

### Subagent delegation

```text
Use the systematic-implementer subagent to implement the auth module and return the changed files.
```

Omit the `mode` parameter when dispatching subagents so the user's configured permission settings apply. Do not pass `mode: "auto"`: it overrides user-level settings like `bypassPermissions`.

### Dispatch results and continuation

Each subagent call starts a new instance, and the agent id comes with the dispatch result. Record it at dispatch, against the task it was given. Continue that subagent with `SendMessage` with `to` set to that agent id and the follow-up as the message: a finished subagent resumes in the background, and its reply arrives later as a report. The built-in Explore and Plan agents are one-shot and return no agent id, so they cannot be continued. Dispatching the same subagent by name again starts a new one, not a continuation.

**Wait path.** A subagent that Claude spawns from the main conversation starts in the background by default, and its report reaches the parent as a completion notification in a later turn, so the parent may end its turn. A `SendMessage` continuation resumes in the background the same way. In `claude -p` the run stays open for background subagents, up to a 10-minute idle cap, and drops work still unfinished then.

### Blocking user interaction

```typescript
AskUserQuestion({
  questions: [{ question: "Which deployment target should I use?", header: "Deployment target",
    options: [{ label: "Staging", description: "Deploy to staging" }] }],
})
```

### Task tracking

```typescript
TaskCreate({ content: "Run validation", status: "pending", priority: "high" })
```

### Skill loading

Skills are discovered natively from `SKILL.md` files under `~/.claude/skills/`, `.claude/skills/`, and plugin `skills/` directories; invoke them with the built-in Skill tool using the skill name.
