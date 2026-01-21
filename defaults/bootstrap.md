# Systematic Bootstrap

You have access to the Systematic plugin which provides enhanced workflow capabilities.

## Available Tools

- `systematic_use_skill` - Load and read a skill to guide your work
- `systematic_find_skills` - List all available skills
- `systematic_find_agents` - List all available review agents
- `systematic_find_commands` - List all available commands

## Getting Started

Use `systematic_find_skills` to discover available skills. Key skills include:

- **using-systematic** - How to find and use skills (invoke this first)
- **brainstorming** - Collaborative design workflow
- **writing-plans** - Create implementation plans
- **test-driven-development** - TDD workflow
- **systematic-debugging** - Root cause investigation
- **verification-before-completion** - Evidence before claims
- **executing-plans** - Batch execution with checkpoints
- **using-git-worktrees** - Isolated workspace creation
- **writing-skills** - Create new skills

## Skill Resolution Priority

Skills are resolved in this order:
1. **Project skills** - `.opencode/skills/` in current project
2. **User skills** - `~/.config/opencode/skills/`
3. **Bundled skills** - Provided by this plugin

Project and user skills can override bundled skills.

## Commands

Commands are shortcuts that invoke skills. Use `systematic_find_commands` to list them:

- `/sys-plan` - Start planning with brainstorming
- `/sys-work` - Execute an implementation plan
- `/sys-review` - Run verification before completion
- `/sys-debug` - Debug an issue systematically
- `/sys-tdd` - Implement with TDD
- `/sys-worktree` - Create isolated workspace

## Review Agents

Review agents provide specialized code review. Use `systematic_find_agents` to list them:

- **architecture-strategist** - Architectural review
- **security-sentinel** - Security review
- **code-simplicity-reviewer** - Complexity review
- **framework-docs-researcher** - Documentation research
- **pattern-recognition-specialist** - Pattern analysis
- **performance-oracle** - Performance review
