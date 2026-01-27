# Systematic

An OpenCode plugin providing systematic engineering workflows from the [Compound Engineering Plugin (CEP)](https://github.com/EveryInc/compound-engineering-plugin) Claude Code plugin, adapted for OpenCode.

## Installation

```bash
npm install @fro.bot/systematic
```

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@fro.bot/systematic"]
}
```

## Features

### Skills

Systematic includes battle-tested engineering workflows:

| Skill | Description |
|-------|-------------|
| `using-systematic` | Bootstrap skill for discovering and using other skills |
| `brainstorming` | Collaborative design workflow |
| `agent-browser` | Browser automation with Playwright |
| `agent-native-architecture` | Design systems for AI agents |
| `compound-docs` | Create and maintain compound documentation |
| `create-agent-skills` | Write new skills for AI agents |
| `file-todos` | Manage TODO items in files |
| `git-worktree` | Use git worktrees for isolated development |

### Commands

Quick shortcuts to invoke workflows:

**Workflows:**

- `/workflows:brainstorm` - Start collaborative brainstorming
- `/workflows:compound` - Build compound documentation
- `/workflows:plan` - Create implementation plans
- `/workflows:review` - Run code review with agents
- `/workflows:work` - Execute planned work

**Utilities:**

- `/agent-native-audit` - Audit code for agent-native patterns
- `/create-agent-skill` - Create a new skill
- `/deepen-plan` - Add detail to existing plans
- `/lfg` - Let's go - start working immediately

### Agents

Specialized agents organized by category:

**Review:**

- `architecture-strategist` - Architectural review
- `security-sentinel` - Security review
- `code-simplicity-reviewer` - Complexity review
- `pattern-recognition-specialist` - Pattern analysis
- `performance-oracle` - Performance review

**Research:**

- `framework-docs-researcher` - Documentation research

## Config Hook

Systematic uses OpenCode's `config` hook to automatically register bundled agents, commands, and skills directly into OpenCode's configuration. This means:

- **Zero configuration required** - All bundled content is available immediately after installing the plugin
- **No file copying** - Skills, agents, and commands ship with the npm package
- **Existing config preserved** - Your OpenCode configuration settings take precedence over bundled content

## Tools

The plugin provides these tools to OpenCode:

| Tool | Description |
|------|-------------|
| `systematic_skill` | Load Systematic bundled skills |

The bootstrap skill instructs OpenCode to use the native `skill` tool to load non-Systematic skills.

## Configuration

Create `~/.config/opencode/systematic.json` or `.opencode/systematic.json` to disable specific bundled content:

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
