# Pi Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | `systematic_delegate({agent, task})` with bundled personas | degraded; execution is sequential only | Dispatch sequentially in dependency order or do the work inline |
| Blocking user interaction | No native blocking tool | degraded | Present numbered options in chat and wait |
| Task tracking | No native task-tracking mechanism | unavailable | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` tool or Pi-native skill activation | supported | Read the skill instructions listed by the active harness |

## Invocation examples

### Subagent delegation

```typescript
systematic_delegate({
  agent: "systematic-implementer",
  task: "Implement the auth module and return the changed files.",
})
```

### Blocking user interaction

```text
1. Deploy to staging
2. Deploy to production

Reply with the number of your choice.
```

### Task tracking

```text
Task list:
- [ ] Implement the auth module
- [ ] Run validation
```

### Skill loading

```typescript
systematic_skill({ name: "systematic:using-systematic" })
```
