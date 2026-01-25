# @fro.bot/systematic

An OpenCode plugin providing systematic engineering workflows from the Compound Engineering Plugin (CEP), adapted for OpenCode.

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

### Review Agents

Specialized code review agents organized by category:

**Review:**

- `architecture-strategist` - Architectural review
- `security-sentinel` - Security review
- `code-simplicity-reviewer` - Complexity review
- `pattern-recognition-specialist` - Pattern analysis
- `performance-oracle` - Performance review

**Research:**

- `framework-docs-researcher` - Documentation research

## Tools

The plugin provides these tools to OpenCode:

| Tool | Description |
|------|-------------|
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

## Converting CEP Content

The CLI includes a converter for adapting Compound Engineering Plugin (CEP) content to OpenCode format.

### Convert a Skill

Skills are directories containing `SKILL.md` and supporting files:

```bash
npx @fro.bot/systematic convert skill /path/to/cep/skills/my-skill -o ./skills/my-skill
```

### Convert an Agent

Agents are markdown files that get OpenCode-compatible YAML frontmatter:

```bash
npx @fro.bot/systematic convert agent /path/to/cep/agents/review/my-agent.md -o ./agents/review/my-agent.md
```

### Convert a Command

Commands are markdown templates:

```bash
npx @fro.bot/systematic convert command /path/to/cep/commands/my-command.md -o ./commands/my-command.md
```

### Dry Run

Preview conversion without writing files:

```bash
npx @fro.bot/systematic convert skill /path/to/skill --dry-run
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
