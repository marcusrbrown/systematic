# OMO + Systematic Combined Profile

This profile provides a **powerful combined system** that brings together:
- **Oh My OpenCode (OMO)** — Multi-agent orchestration, parallel research, and advanced tooling
- **Systematic** — Structured engineering workflows for disciplined execution

Best for engineers who want both raw agent power AND enforced process discipline.

## What's Included

### Systematic (11 skills, 24 agents, 9 commands)
- **Structured Workflows** — Brainstorm, plan, review, execute systematically
- **Specialized Agents** — Architecture, security, performance, design, data integrity experts
- **Zero Configuration** — Works immediately; inject into your system prompt

### Oh My OpenCode (Orchestrator + 9 agents)
- **Sisyphus** — Master orchestrator agent (Claude Opus 4.5)
- **Explore** — Codebase search and analysis
- **Librarian** — Repository research and documentation lookup
- **Oracle** — Strategic reasoning and deep debugging
- **Metis** — Pre-planning analysis (finds hidden requirements)
- **Multimodal-Looker** — Image and visual analysis
- **Momus** — Plan reviewer and quality auditor
- **Atlas** — Research and documentation agent
- **Build Agent** — Controlled via Sisyphus (available as subagent)

### Harmonization
- Prometheus (Planner) is **disabled** — Systematic's `/workflows:plan` is superior
- Metis (Consultant) is **enabled** — Pre-planning analysis complements Systematic planning
- Playwright and agent-browser both available — Choose your browser automation
- OMO category models are configured — Fast models for quick tasks, powerful models for complex work

## Quick Start

### Launch with this Profile

```bash
ocx opencode -p omo
```

Or set as default:

```bash
export OCX_PROFILE=omo
ocx opencode
```

### Verify Installation

In any OpenCode conversation:

```
/systematic:using-systematic
```

This loads Systematic's skills guide. Then check OMO:

```
@Sisyphus Check that all agents are available and report their status
```

## Workflow Comparison

### Typical OMO-only Flow
```
@explore → Search code
@librarian → Research docs
@oracle → Reason about solution
@sisyphus → Execute
```

### Typical Systematic-only Flow
```
/systematic:brainstorming → Design
/workflows:plan → Create detailed plan
/workflows:review → Architectural review
/workflows:work → Disciplined execution
```

### Combined OMO + Systematic Flow (Recommended)
```
1. /systematic:brainstorming → Explore design space
2. @Metis → Find hidden requirements
3. /workflows:plan → Create executable plan
4. @Sisyphus with parallel agents → Execute with OMO power:
   - @explore → Codebase search
   - @librarian → Documentation research
   - Custom agents for implementation
5. /workflows:review → Code review with specialists
```

## Architecture

### When to Use Each

| Need | Tool | Why |
|------|------|-----|
| Systematic exploration | `/systematic:brainstorming` | Structured dialogue, captures requirements |
| Finding hidden issues | `@Metis` | Pre-planning expert finds gaps |
| Detailed planning | `/workflows:plan` | Multi-phase plans with resource allocation |
| Codebase research | `@Sisyphus` + `@explore` | Parallel search across files |
| Strategic reasoning | `@oracle` | Deep analysis and debugging |
| Code review | `/workflows:review` | Specialized architectural agents |
| Parallel work | `@Sisyphus` | Orchestrates multi-agent execution |
| Fast trivial work | `task(category='quick')` | Haiku model, cost-optimized |
| Complex reasoning | `task(category='ultrabrain')` | GPT-5.3-codex with xhigh reasoning |
| Visual/UI work | `task(category='visual-engineering')` | Gemini 3 Pro for design |

### The Three Loops

**Systematic Loop** (Process)
```
Brainstorm → Plan → Review → Work → Document
```

**OMO Loop** (Parallelization)
```
Sisyphus orchestrates → Agents work in parallel → Results merge
```

**Combined Loop** (Best of both)
```
Systematic brainstorm/plan
  ↓
Sisyphus + agents execute (research, implement, test in parallel)
  ↓
Systematic review
  ↓
Results documented in compound-docs
```

## Key Skills (Systematic)

| Skill | Command | Use Case |
|-------|---------|----------|
| `using-systematic` | `/systematic:using-systematic` | Bootstrap — learn Systematic |
| `brainstorming` | `/systematic:brainstorming` | Explore features, requirements |
| `git-worktree` | `/systematic:git-worktree` | Isolated parallel development |
| `frontend-design` | `/systematic:frontend-design` | Production-grade UI implementation |
| `create-agent-skills` | `/systematic:create-agent-skill` | Author new skills |

## Key Commands

### Systematic Workflows
```
/workflows:brainstorm    # Collaborative design
/workflows:plan          # Detailed multi-phase planning
/workflows:review        # Architectural code review
/workflows:work          # Disciplined execution
/workflows:compound      # Document solved problems
/systematic:lfg          # Full autonomous workflow
```

### OMO Capabilities
```
@Sisyphus <task>         # Orchestrate multi-agent work
@explore <query>         # Search codebase
@librarian <topic>       # Research documentation
@oracle <problem>        # Strategic reasoning
@Metis <spec>            # Find hidden requirements
task(category='quick')   # Fast trivial tasks (Haiku)
task(category='visual-engineering')  # UI design (Gemini)
task(category='ultrabrain')  # Deep reasoning (GPT-5.3)
```

## Specialized Agents

### Systematic Design Agents
- `design-implementation-reviewer` — Verify against design specs
- `design-iterator` — Iterative UI/UX refinement
- `figma-design-sync` — Detect visual differences

### Systematic Research Agents
- `best-practices-researcher` — External research
- `framework-docs-researcher` — Framework documentation
- `git-history-analyzer` — Git archaeology
- `learnings-researcher` — Institutional knowledge
- `repo-research-analyst` — Repository analysis

### Systematic Review Agents (12 total)
- `architecture-strategist` — Architectural review
- `code-simplicity-reviewer` — YAGNI enforcement
- `security-sentinel` — Security audits
- `performance-oracle` — Performance analysis
- Plus: data integrity, DHH Rails, TypeScript, pattern recognition, deployment, etc.

### OMO Orchestrators
- **Sisyphus** — Master orchestrator, long-form reasoning
- **Metis** — Pre-planning consultant, finds hidden issues
- **Momus** — Plan reviewer and quality auditor
- **Oracle** — Strategic reasoning, debugging

### OMO Research Agents
- **Explore** — Fast codebase search
- **Librarian** — Documentation and examples
- **Atlas** — General research agent

### OMO Visual Agent
- **Multimodal-Looker** — Images, screenshots, diagrams

## Configuration

The profile comes pre-configured with:

- **Category models** — Optimal model per task type:
  - `quick` → Haiku (fast/cheap)
  - `visual-engineering` → Gemini 3 Pro (UI excellence)
  - `ultrabrain` → GPT-5.3-codex (deep reasoning)
  - `unspecified-high` → Opus 4.6 (powerful general)

- **Disabled features**:
  - Prometheus Planner (use Systematic's better planning)
  - OMO's `plan` command (use `/workflows:plan` instead)

- **Enabled features**:
  - Metis for pre-planning analysis
  - Both Playwright and agent-browser
  - All Systematic skills and agents

### Customizing

Edit the profile's files:

```bash
ocx config edit -p omo
```

Add your own overrides:

```jsonc
{
  "agents": {
    "Sisyphus": {
      "model": "anthropic/claude-opus-4"
    }
  },
  "categories": {
    "visual-engineering": {
      "model": "anthropic/claude-opus-4-6"
    }
  }
}
```

## Philosophy

**This profile believes:**

1. **Structure beats chaos** — Systematic enforces process discipline
2. **Parallelization beats sequentialism** — OMO agents work together efficiently
3. **Specialized experts beat generalists** — Each agent has a focused role
4. **Transparency beats magic** — Workflows are explicit and reviewable
5. **Flexibility beats dogmatism** — You can override and customize everything

## References

- [Systematic Documentation](https://fro.bot/systematic)
- [Oh My OpenCode Documentation](https://github.com/code-yeongyu/oh-my-opencode)
- [OpenCode Documentation](https://opencode.ai/docs/)
- [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin) — Original CEP

## License

MIT © Marcus R. Brown + Contributors
