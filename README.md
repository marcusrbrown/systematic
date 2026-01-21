# @fro.bot/systematic

An OpenCode plugin providing systematic engineering workflows, skills, and review agents.

## Installation

```bash
npm install @fro.bot/systematic
```

Add to your OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "plugins": ["@fro.bot/systematic"]
}
```

## Features

### Skills

Systematic includes battle-tested engineering workflows:

| Skill | Description |
|-------|-------------|
| `using-systematic` | Bootstrap skill for discovering and using other skills |
| `brainstorming` | Collaborative design workflow |
| `writing-plans` | Create detailed implementation plans |
| `test-driven-development` | TDD with red-green-refactor cycle |
| `systematic-debugging` | Root cause investigation process |
| `verification-before-completion` | Evidence before claims |
| `executing-plans` | Batch execution with checkpoints |
| `using-git-worktrees` | Isolated workspace creation |
| `writing-skills` | Create new skills |

### Commands

Quick shortcuts to invoke skills:

- `/sys-plan` - Start planning with brainstorming
- `/sys-work` - Execute an implementation plan
- `/sys-review` - Run verification before completion
- `/sys-debug` - Debug an issue systematically
- `/sys-tdd` - Implement with TDD
- `/sys-worktree` - Create isolated workspace

### Review Agents

Specialized code review agents:

- `architecture-strategist` - Architectural review
- `security-sentinel` - Security review
- `code-simplicity-reviewer` - Complexity review
- `framework-docs-researcher` - Documentation research
- `pattern-recognition-specialist` - Pattern analysis
- `performance-oracle` - Performance review

## Tools

The plugin provides these tools to OpenCode:

| Tool | Description |
|------|-------------|
| `systematic_use_skill` | Load and read a skill |
| `systematic_find_skills` | List available skills |
| `systematic_find_agents` | List available agents |
| `systematic_find_commands` | List available commands |

## Skill Resolution

Skills are resolved in priority order:

1. **Project skills** - `.opencode/skills/` in current project
2. **User skills** - `~/.config/opencode/skills/`
3. **Bundled skills** - Provided by this plugin

Project and user skills can override bundled skills with the same name.

## Configuration

Create `~/.config/opencode/systematic.json` or `.opencode/systematic.json`:

```json
{
  "disabled_skills": [],
  "disabled_agents": [],
  "disabled_commands": []
}
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Typecheck
bun run typecheck

# Lint
bun run lint

# Run tests
bun test
```

## License

MIT
