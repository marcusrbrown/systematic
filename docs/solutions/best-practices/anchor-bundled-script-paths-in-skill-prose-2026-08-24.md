---
title: Anchor bundled-script invocations to the skill directory, in every block
date: 2026-08-24
category: best-practices
module: skill-authoring
problem_type: convention
component: tooling
severity: high
tags:
  - skill-authoring
  - bundled-scripts
  - path-resolution
  - skill-dir
  - claude-skill-dir
  - bash-tool
  - cross-harness
  - flatten-safety
applies_when:
  - Authoring skill prose that runs a bundled script through a shell tool
  - A skill ships to more than one harness from one source
  - Choosing between a bare relative path, a host-substituted variable, and a model-filled anchor
  - A bundled-script invocation resolves to a path with an unexpected leading slash
---

## Context

Five bundled skills invoked their helper scripts with bare relative paths — `bash
references/resolve-base.sh`, `bash scripts/worktree-manager.sh`, `node
scripts/inventory.mjs`. A shell resolves those against the agent's working directory,
which is the consumer's project, never the directory the skill installed into.

They failed everywhere, including in the repository that shipped them:

```
$ bash references/resolve-base.sh
bash: references/resolve-base.sh: No such file or directory
```

The scripts were fine. All seven existed beside their skills and shipped to every
harness. Only the path was wrong — and it was wrong on every harness rather than one,
which is likely why it survived: there was no working case to compare against.

The sharpest instance labelled the broken line as the correct approach, directly above
a working command labelled wrong:

```bash
# ✅ CORRECT - Always use the script
bash scripts/worktree-manager.sh create feature-name

# ❌ WRONG - Never do this directly
git worktree add .worktrees/feature-name -b feature-name main
```

## Guidance

Use a **model-filled** `SKILL_DIR` anchor. Set it in **every** fenced block that reads
it, and **terminate the assignment with a semicolon**.

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
bash "$SKILL_DIR/scripts/worktree-manager.sh" create feature-name
```

Three separate rules, each earning its place:

| Rule | Failure it prevents |
|---|---|
| Anchor instead of a bare relative path | Resolves against the project, not the skill; file not found |
| Set it in every block that reads it | Shell state does not persist between tool calls; empty expansion yields `/scripts/foo` |
| Terminate with `;` | A flattened block becomes `VAR="x" cmd`, the env-var-prefix form, where the shell expands `$VAR` from the outer scope *before* the assignment applies |

**Do not use a host-substituted skill-directory variable.** `${CLAUDE_SKILL_DIR}` is a
Claude-Code-only content substitution, not an environment variable, and expands to
nothing on every other host. A guarded call's `then` branch then silently never fires
off-Claude — a genuine silent skip rather than a visible failure. The model-filled
anchor works on every host precisely because it depends on no host variable: the agent
supplies the path from the base directory the harness states when the skill loads.

Guard the convention with a test rather than review attention. Four properties are
mechanically checkable: no bare relative invocation, every block that reads the anchor
also assigns it, every assignment terminates, and no skill depends on a
harness-specific skill-directory variable.

## Why This Matters

The flatten failure is the non-obvious one, and it reproduces in three lines:

```
multi-line (correct):        /tmp/demo/scripts/x.sh
flattened, no semicolon:     /scripts/x.sh
flattened, with semicolon:   /tmp/demo/scripts/x.sh
```

A first pass at the fix set the anchor once per file and looked correct. Fenced blocks
are copied and executed one at a time, so 24 invocations across 15 blocks still read an
unset variable — the same broken path in a new costume, reached by a different route.
The block-scoped rule is what makes each block independently runnable, which is the
actual requirement.

## When to Apply

Any skill that ships to more than one harness and executes a file that travels with it.

The pull toward a host variable is strong because it looks more precise than asking the
model to fill a path. It is more precise, on exactly one host. A convention that
degrades to a silent skip on the others is worse than one that depends on the agent
doing something it already does reliably.

## Examples

Broken, as shipped:

```bash
bash references/resolve-base.sh
# bash: references/resolve-base.sh: No such file or directory
```

Fixed, and verified end to end:

```bash
SKILL_DIR="/abs/path/to/skills/ce-review";
bash "$SKILL_DIR/references/resolve-base.sh"
# BASE:afc3e0bdbaf644342eac1cb10eb45363e9852b64
```

The regression the anchor alone does not prevent:

```bash
# $SKILL_DIR unset in this block
bash "$SKILL_DIR/references/resolve-base.sh"
# bash: /references/resolve-base.sh: No such file or directory
```

## Related

- [Entry-point scope decides what a plugin bundle can ship](./entry-point-scope-decides-what-a-plugin-can-ship-2026-08-24.md) — the packaging half of shipping an executable with bundled content
- [The same tools frontmatter is permissive on OpenCode and restrictive on Pi](../integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md) — the same class of defect in frontmatter rather than prose: one authored form, opposite meanings per harness
