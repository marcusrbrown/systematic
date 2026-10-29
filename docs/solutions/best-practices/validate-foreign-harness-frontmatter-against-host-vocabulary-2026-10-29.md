---
title: Validate foreign-harness frontmatter against the target host's vocabulary before passing it on
date: 2026-10-29
category: best-practices
module: config-handler
problem_type: design_pattern
component: configuration
severity: medium
applies_when:
  - "An adapter turns frontmatter written for one harness into config for another"
  - "The target host hard-fails on values it does not recognize"
  - "The target host cannot honor a field at all"
root_cause: missing_validation
resolution_type: code_fix
tags: [cross-harness, frontmatter, skills-as-commands, discovered-skills, validation, opencode-v1, opencode-v2]
---

# Validate foreign-harness frontmatter against the target host's vocabulary before passing it on

## Context

Systematic registers each discovered user skill (from `.opencode/skills`, `.claude/skills`, `.agents/skills` and their global equivalents) as a slash command. Bundled skills pass `agent`, `model` and `subtask` through in `loadSkillAsCommand` (`src/lib/asset-plan.ts`). Discovered skills did not: `loadDiscoveredSkillAsCommand` returned only a template and a description, so the three fields were lost (#1241).

Many discovered skills are written for Claude Code. Its skills docs (https://code.claude.com/docs/en/skills) define `context: fork`, `agent` (`Explore`, `Plan`, `general-purpose` or a `.claude/agents/` type) and `model` (`/model` values or `inherit`). OpenCode uses the same key names for `agent` and `model`, but the values they accept name different things.

## Guidance

When an adapter imports frontmatter written for another harness:

1. **Keep untrusted values out of the output until a host has judged them.** The planned command carries no routing. The declared values travel in `AssetPlan.discoveredRouting` (`src/lib/asset-plan.ts`), and each host decides what it can honor.
2. **Validate each field against the host's vocabulary.** `applyDiscoveredRouting` (`src/lib/config-handler.ts`) runs after the agent and command merges. The rules are in its docstring and the code below.
3. **Map semantics where they correspond.** `context: fork` sets `subtask: true` where the skill frontmatter is parsed, and overrides an explicit `subtask: false`.
4. **Drop an invalid value with a diagnostic, never an error.** One `[systematic]` warning per skill and field, deduped across hook reruns. A dropped field leaves the valid ones alone, and a same-named user command that won the merge is neither routed nor reported on.
5. **When the host cannot honor a field at all, drop it with a note.** `installCommands` in `src/lib/opencode-v2-commands.ts` reports each discovered skill's declared fields once and registers the command without them. Bundled commands that declare routing are still refused by `declaredRouting` in the same file, because Systematic wrote that routing itself and a refusal tells its author.
6. **Check what the host does with the same frontmatter before calling a drop a bug.** OpenCode v1 builds native skill commands from name, description, template and hints only (`packages/opencode/src/command/index.ts` at v1.19.4), so honoring routing for a skill goes beyond the host's own behavior.

"`agent` only with a subtask" is Systematic's policy, following Claude Code's rule that `agent` applies only with fork. It is not a v1 host constraint. At v1.19.4 the host accepts `cmd.agent` without a subtask and treats a subagent-mode agent as a subtask unless `subtask` is `false` (`packages/opencode/src/session/prompt.ts`, in the command handler).

## Why This Matters

Both naive options fail, in opposite directions.

- **Pass-through breaks working v1 skills** (unknown agent or alias, below).
- **Blanket refusal breaks working v2 skills** (below).

## When to Apply

- An adapter reads frontmatter or config that another harness authored and writes it into this host's config.
- A field shares its key name with the host's but not its value space (`agent`, `model`). The `tools` field is another case; see the related doc below.
- Not for first-party bundled content, which is written in the host's vocabulary. Bundled routing passes through unvalidated on v1 and is refused on v2, so an authoring mistake shows up at the host.

## Examples

### Unvalidated pass-through (closed PR #1253)

The converter copied `agent`, `model` and `subtask` onto every discovered command unchanged, expecting v2 to apply its existing refusal. For a typical Claude-style skill:

```yaml
context: fork
agent: Explore
model: inherit
```

- **v1:** one bad field fails the whole command. `subtask: true` is fine. `agent: Explore` throws `Agent not found: "Explore". Available agents: …`. `model: inherit` throws `Model not found: inherit/.`, because `Provider.parseModel` turns a value without `/` into a provider with an empty model id (`packages/opencode/src/session/prompt.ts` and `packages/opencode/src/provider/provider.ts` at v1.19.4). `model: sonnet` fails the same way, as `Model not found: sonnet/.`.
- **v2:** a plugin command cannot choose an agent or a model, and `buildCommand` refuses a command whose plan carries routing. Every discovered `context: fork` skill would stop working, though each runs fine on the invoking session.

### Validated (the fix, #1254)

```ts
// applyDiscoveredRouting in src/lib/config-handler.ts, annotated
const { agent, model, subtask } = declared
if (agent !== undefined) {
  // agentProblem: only when subtask === true, and the name is in knownAgentNames:
  // the four built-ins (build, plan, general, explore) and every other key of the
  // final config.agent, minus any key with disable: true, which also removes a
  // built-in. Matching is exact and case-sensitive.
  const problem = agentProblem(agent, subtask === true, known)
  if (problem === undefined) command.agent = agent
  else drop(name, 'agent', problem)
}
if (model !== undefined) {
  // modelProblem: provider/model with both sides non-empty. The shape does not
  // prove the model exists; the host owns that check.
  const problem = modelProblem(model)
  if (problem === undefined) command.model = model
  else drop(name, 'model', problem)
}
// subtask passes through as declared, false included
if (subtask !== undefined) command.subtask = subtask
```

The same skill on v1 becomes `{ subtask: true }` with two warnings, for example `[systematic] skill "review" sets agent "Explore", which is not an OpenCode agent; it is ignored. Write an OpenCode command to route it.` On v2 it runs on the invoking session with one note.

Tests that pin the behavior, by name:

- `tests/unit/config-handler.test.ts`: "context: fork alone becomes subtask: true", "fork with a Claude agent type drops the agent with a diagnostic", "agent matching is exact and case-sensitive", "an agent without a subtask is dropped with a diagnostic", "a disabled agent is not a known agent", "a model alias is dropped with a diagnostic", "dropping one field keeps the valid ones", "running the hook twice reports each dropped field once", "a same-named user command is neither routed nor reported on".
- `tests/unit/opencode-v2-commands.test.ts`, describe "a discovered skill that declares routing": "is not refused: it prompts normally and one diagnostic is reported".
- `tests/integration/opencode-v2.test.ts`, against a real v2 host: "a discovered skill that declares routing is not refused: it prompts on the invoking session and one diagnostic is reported".

### Known limits

- No test runs a routed discovered skill on a live v1 host. `tests/integration/skill-command-probe.test.ts` runs discovered skills on the pinned host but covers `!`-snippets, not routing fields. The v1 routing tests assert the emitted config (`tests/unit/config-handler.test.ts`, `routing fields`).
- An agent that a plugin registers after Systematic's config hook is not in `config.agent` yet, so it is dropped with a warning.
- If `agent` is dropped and `subtask` is `true`, the skill still runs as a subtask, under the invoking session's agent (`cmd.agent ?? input.agent` in `packages/opencode/src/session/prompt.ts` at v1.19.4).

## Related

- [`cross-harness-tools-frontmatter-divergence-2026-08-16.md`](../integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md): the same `tools:` frontmatter means different things on OpenCode and Pi.
- [`stop-patching-after-second-review-round-2026-10-15.md`](../workflow-issues/stop-patching-after-second-review-round-2026-10-15.md): why v2 plugin commands stopped emulating routing (#1239).
- `docs/src/content/docs/guides/skills-as-commands.mdx`: the user-facing rules.
