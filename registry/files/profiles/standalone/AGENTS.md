# Standalone Systematic Profile

This profile provides **Systematic's structured engineering workflows** — brainstorming, planning, code review, and disciplined execution — without additional agents or plugins.

## What's Included

- **11 bundled skills** — Pre-built workflows for systematic engineering
- **24 specialized agents** — Architecture, security, performance, and design specialists
- **9 commands** — Workflow shortcuts and automation tools
- **Zero configuration** — Works immediately after enabling the profile

## Quick Start

### Launch OpenCode with this Profile

```bash
ocx opencode -p standalone
```

Or set as default:

```bash
export OCX_PROFILE=standalone
ocx opencode
```

### Verify Installation

In any OpenCode conversation, invoke:

```
/systematic:using-systematic
```

This skill teaches you how to discover and use all available Systematic skills.

## Core Workflows

### 1. Brainstorming
Before implementing features, explore requirements systematically:

```
/systematic:brainstorming
```

This guides collaborative design thinking and requirement clarification.

### 2. Planning
Turn requirements into detailed implementation plans:

```
/workflows:plan
```

Produces multi-phase roadmaps with resource allocation and risk assessment.

### 3. Code Review
Run architectural code reviews with specialized agents:

```
/workflows:review
```

Invokes agents focused on architecture, security, simplicity, and patterns.

### 4. Execution
Execute planned work methodically:

```
/workflows:work
```

Keeps work focused and verifiable against the plan.

### 5. Autonomous Engineering
Full workflow from plan to execution:

```
/systematic:lfg
```

## Key Skills

| Skill | Use Case |
|-------|----------|
| `using-systematic` | Bootstrap — learn how to use Systematic |
| `brainstorming` | Explore features before planning |
| `git-worktree` | Isolated parallel development with git |
| `frontend-design` | Production-grade UI implementation |
| `agent-native-architecture` | Design systems where agents are first-class |
| `create-agent-skills` | Author new skills for your workflow |

## Specialized Agents

### Design Agents
- `design-implementation-reviewer` — Verify implementations match design specs
- `design-iterator` — Iterative UI/UX refinement
- `figma-design-sync` — Detect visual differences from Figma

### Research Agents
- `best-practices-researcher` — External research for any technology
- `framework-docs-researcher` — Framework documentation and examples
- `git-history-analyzer` — Git archaeology and pattern discovery
- `learnings-researcher` — Institutional knowledge from past solutions
- `repo-research-analyst` — Repository analysis and conventions

### Review Agents
- `architecture-strategist` — Architectural code review
- `code-simplicity-reviewer` — YAGNI and simplicity enforcement
- `security-sentinel` — Security audits and vulnerability assessment
- `performance-oracle` — Performance bottleneck identification
- Plus 10 more specialized reviewers (Rails, TypeScript, data integrity, deployment, patterns, etc.)

### Workflow Agents
- `bug-reproduction-validator` — Systematic bug verification
- `spec-flow-analyzer` — User flow and requirement analysis
- `pr-comment-resolver` — Address PR review comments

## Configuration

Customize this profile by editing `ocx.jsonc`:

```jsonc
{
  // Add or override registries
  "registries": {
    "systematic": { "url": "https://fro.bot/systematic" }
  },

  // Control which project files OpenCode sees
  "exclude": ["**/CLAUDE.md"],
  "include": ["**/AGENTS.md"]
}
```

## Philosophy

**Systematic is opinionated about process, not tools.**

- ✅ Embrace structured workflows
- ✅ Use specialized agents for focused reviews
- ✅ Document decisions and learnings
- ✅ Maintain code quality through deliberate process

- ❌ No magic. Process is explicit.
- ❌ No surprises. Workflows are transparent.
- ❌ No scattered context. Instructions are centralized.

## References

- [Systematic Documentation](https://fro.bot/systematic)
- [OpenCode Documentation](https://opencode.ai/docs/)
- [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin) — Original workflows
- [Source Code](https://github.com/marcusrbrown/systematic)

## License

MIT © Marcus R. Brown
