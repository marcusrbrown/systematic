# Claude Code Capability Profile

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | Name-based subagent dispatch; plugin agents ship in `agents/`; `context: fork` for skill-scoped forks | supported | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `AskUserQuestion` tool | supported | Present numbered options in chat and wait |
| Task tracking | `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` (`TodoWrite` is deprecated and disabled by default) | supported | Maintain a visible task list in responses |
| Skill loading | Native Skill tool with `SKILL.md` discovery (`~/.claude/skills/`, `.claude/skills/`, plugin `skills/`); Systematic ships no `systematic_skill` tool on Claude Code | supported | Read the skill instructions listed by the active harness |

Behavioral enforcement on Claude Code rides a plugin output style (force-for-plugin); a declarative `SessionStart` hook carries state only, since imperative hook content is refused as prompt injection.

## Invocation examples

### Subagent delegation

```text
Use the systematic-implementer subagent to implement the auth module and return the changed files.
```

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
