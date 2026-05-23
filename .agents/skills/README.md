# Project-Specific Skills

This directory holds skills scoped to the `systematic` repository. They are **not** bundled into the npm package and are not available to downstream Systematic users — they exist solely to support contributors working on this repo.

## This directory vs. `skills/`

| Directory | Scope | Shipped in npm? | Who uses it? |
|-----------|-------|-----------------|--------------|
| `.agents/skills/` | This repo only | No | Contributors to `systematic` |
| `skills/` | All Systematic users | Yes | Anyone who installs the package |

If a skill is useful only for maintaining or documenting this repo, it belongs here. If it's general-purpose and valuable to all Systematic users, it belongs in `skills/` and will ship with the package.

## How OpenCode discovers these skills

OpenCode follows the [agentskills.io](https://agentskills.io) spec. It auto-discovers skills from:

- `~/.agents/skills/` — user-level skills (available in all projects)
- `.agents/skills/` (project root) — project-level skills (available only in this repo)

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter. OpenCode registers them and makes them invocable via the `skill` tool.

## Current skills

| Skill | Description |
|-------|-------------|
| `generating-project-docs` | Create, refresh, or update project-level docs (`README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`) — derives all facts from the live repo |

## Adding a new skill here

1. **Decide scope** — project-specific (here) or bundle-worthy (`skills/` in repo root)?
2. **Create the directory** — `.agents/skills/<name>/SKILL.md`
3. **Add frontmatter:**
   ```yaml
   ---
   name: skill-name
   description: Use when [condition] — [what it does]
   argument-hint: "[optional-arg]"   # omit if no arguments
   ---
   ```
4. **Write the skill body** — follow the same conventions as bundled skills in `skills/`
5. **Update this README** — add a row to the "Current skills" table above

For skills that belong in the bundle (`skills/`), see the [writing-systematic-skills](../../skills/writing-systematic-skills/SKILL.md) skill for format rules and the content-integrity gate requirements.

## See also

- [`STRUCTURE.md`](../../STRUCTURE.md) — full project layout
- [`skills/`](../../skills/) — bundled skills shipped with the npm package
