# Pi Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | Bounded built-in delegate via `systematic_delegate({agent, task})`; optional mature delegation via [pi-subagents](https://github.com/tintinweb/pi-subagents): installed package personas, opt-in export for overlays | built-in: degraded (sequential only); pi-subagents path: outside Systematic's bounded-delegate guarantees | Dispatch sequentially in dependency order or do the work inline |
| Blocking user interaction | No native blocking tool | degraded | Present numbered options in chat and wait |
| Task tracking | No native task-tracking mechanism | unavailable | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` tool or Pi-native skill activation | supported | Read the skill instructions listed by the active harness |
| Durable-output search | `systematic_search` tool, delegates included; absent when `search.enabled` is false | supported | Grep `docs/solutions/` |

## Invocation examples

### Subagent delegation (built-in)

```typescript
systematic_delegate({
  agent: "repo-research-analyst",
  task: "Map how the auth module is wired and list the files involved.",
})
```

`systematic_delegate` takes the bare name; the pi-subagents `Agent` tool takes `systematic-<name>`.

`systematic_delegate` is sequential, capped at 20 turns, depth-1, and spawns its child with `noExtensions: true`. The `noExtensions` guarantee bounds `systematic_delegate`'s own recursion — it does not bound end-to-end delegation depth across a combined pi-subagents + Systematic path.

### Optional: pi-subagents delegation

[pi-subagents](https://github.com/tintinweb/pi-subagents) (parallel/multi-model delegation) 0.22 or newer loads 29 curated personas from the installed package as `systematic-<name>` agent types with plain defaults; a project-scope install only after the project is trusted, and its first session may omit them from the `Agent` description, though dispatch works. Any other type falls back to `general-purpose` with an "Unknown agent type" note: the persona did not run. Export is needed only to apply `systematic.json` overlays; a local file outranks the packaged one. Nothing is written at extension load.

`disabled_agents` and `agents.<name>.disable` do not reach packaged personas. Turn one off with `/agents → Disable`, or all with `packageAgents: false` in `subagents.json`.

The `Agent` tool runs in the background by default. Pass `run_in_background: false` to wait for the result.

Tested against pi-subagents 0.22.0 on Pi 1.3.0. Versions outside the tested range are unsupported but nonfatal.

Exact CLI form: `systematic pi-subagents <preview|export|refresh|cleanup> --scope project|global`. `--scope` is optional and defaults to `project`.

```bash
systematic pi-subagents preview [--scope project|global]
systematic pi-subagents export  [--scope project|global]
systematic pi-subagents refresh [--scope project|global]
systematic pi-subagents cleanup [--scope project|global]
```

- `project` (default) targets `<cwd>/.pi/agents/`.
- `global` targets `$PI_CODING_AGENT_DIR/agents/`, or `~/.pi/agent/agents/` if `$PI_CODING_AGENT_DIR` is unset.

The pi-subagents delegation path is **outside Systematic's bounded-delegate guarantees** and governed by pi-subagents' own configuration. `systematic_delegate` remains the bounded default.

Locking, ownership, config precedence and trust boundaries: see [`HARNESSES.md`](../../../HARNESSES.md) and the [pi-subagents pairing guide](https://fro.bot/systematic/guides/pi-subagents/).

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
