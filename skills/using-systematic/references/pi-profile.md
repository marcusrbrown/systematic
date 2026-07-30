# Pi Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | Bounded built-in delegate via `systematic_delegate({agent, task})`; optional mature delegation via [pi-subagents](https://github.com/tintinweb/pi-subagents) through opt-in persona export | built-in: degraded (sequential only); pi-subagents path: outside Systematic's bounded-delegate guarantees | Dispatch sequentially in dependency order or do the work inline |
| Blocking user interaction | No native blocking tool | degraded | Present numbered options in chat and wait |
| Task tracking | No native task-tracking mechanism | unavailable | Maintain a visible task list in responses |
| Skill loading | `systematic_skill` tool or Pi-native skill activation | supported | Read the skill instructions listed by the active harness |

## Invocation examples

### Subagent delegation (built-in)

```typescript
systematic_delegate({
  agent: "systematic-implementer",
  task: "Implement the auth module and return the changed files.",
})
```

`systematic_delegate` is sequential, capped at 20 turns, depth-1, and spawns its child with `noExtensions: true`. The `noExtensions` guarantee bounds `systematic_delegate`'s own recursion — it does not bound end-to-end delegation depth across a combined pi-subagents + Systematic path.

### Optional: pi-subagents delegation

Export Systematic personas for use with [pi-subagents](https://github.com/tintinweb/pi-subagents) (parallel/multi-model delegation). All writes are opt-in; nothing is exported at extension load.

Tested against pi-subagents v0.14.3 (verified contract as of July 29, 2026). Versions outside the tested range are unsupported but nonfatal.

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

`export`/`refresh`/`cleanup` hold an exclusive per-root mutation lock and fail closed if any path component between the selected scope's anchor and the agents directory is a symlink or not a directory. A manifest (`.systematic-personas.json`) tracks ownership by filename and content hash; cleanup and stale-file removal only delete a file whose on-disk content still matches its recorded hash, refusing otherwise. Manifest hashes are drift evidence, not a cryptographic authenticity guarantee.

Systematic's own config (`systematic.json`/`.jsonc`) is the durable source of truth for exported personas; the generated files and their manifest are a disposable projection that `export`/`refresh`/`cleanup` regenerate or remove, and `refresh` intentionally overwrites manifest-owned generated files that diverge from current config — run `preview` first to see what would change. See the [pi-subagents pairing guide](https://fro.bot/systematic/guides/pi-subagents/) for the config precedence, trust boundaries, and a canonical example.

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
