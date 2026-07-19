<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/banner.svg">
  <img alt="Systematic - Structured Engineering Workflows for AI Coding Agents" src="./assets/banner.svg" width="100%">
</picture>

<br><br>

[![Build Status](https://img.shields.io/github/actions/workflow/status/marcusrbrown/systematic/main.yaml?style=flat-square&label=build&labelColor=1a1a2e&color=4FD1C5)](https://github.com/marcusrbrown/systematic/actions)
[![npm version](https://img.shields.io/npm/v/@fro.bot/systematic?style=flat-square&label=npm&labelColor=1a1a2e&color=E91E8C)](https://www.npmjs.com/package/@fro.bot/systematic)
[![Docs](https://img.shields.io/badge/docs-fro.bot/systematic-4FD1C5?style=flat-square&labelColor=1a1a2e)](https://fro.bot/systematic)
[![License](https://img.shields.io/badge/license-MIT-F5A623?style=flat-square&labelColor=1a1a2e)](LICENSE)

<br>

**[Docs](https://fro.bot/systematic/)** · **[npm](https://www.npmjs.com/package/@fro.bot/systematic)** · **[GitHub](https://github.com/marcusrbrown/systematic)**

</div>

---

AI coding tools are fast at generating code, but they don't preserve engineering discipline by default. They skip planning, forget standards, miss review steps, and fail to capture what was learned. Systematic exists to turn those one-off interactions into a repeatable workflow.

## Why Systematic?

You want AI that follows your process, not just your prompts. You want repeatable engineering habits encoded into the environment. You want the system to get better after each task.

## What You Get

Systematic is a compound-engineering workflow: brainstorm, plan, work, review — each phase a structured skill that guides the AI through requirements exploration, implementation planning, execution, and code review, capturing what was learned along the way. It ships 31 bundled skills and 37 specialized agents for architecture, security, performance, design, and code review.

The workflow runs on three harnesses from one source: [OpenCode](https://opencode.ai/), [Pi](https://github.com/earendil-works/pi-coding-agent), and Claude Code. Each gets a native install path; skill and agent content is identical across all three.

## Quick Install

**OpenCode**:

```json
{ "plugin": ["@fro.bot/systematic@latest"] }
```

Add that to `~/.config/opencode/opencode.json` and restart OpenCode.

**Pi**:

```bash
npx @fro.bot/systematic setup --harness pi
```

**Claude Code**:

```bash
claude plugin marketplace add marcusrbrown/systematic
claude plugin install systematic@systematic
```

See the [installation guide](https://fro.bot/systematic/getting-started/installation/) for what carries over per harness and where parity honestly ends.

**`npx skills`** — portable skill content for any AI harness (Cursor, Copilot, …), content only, no tool registration:

```bash
npx skills add marcusrbrown/systematic
```

## First Workflow

Once installed, run a full engineering cycle on any feature:

```
/ce:brainstorm "add dark mode toggle"
/ce:plan
/ce:work
/ce:review
```

Each step invokes a structured skill that guides the AI through the appropriate phase — requirements exploration, implementation planning, execution, and code review.

## First-Run Checklist

- [ ] Your harness (OpenCode, Pi, or Claude Code) installed
- [ ] Systematic installed via the harness's path above
- [ ] Restart the harness
- [ ] Run `/ce:brainstorm` on something you're building
- [ ] Verify: the skill loads and displays usage instructions

## Learn More

- [Documentation](https://fro.bot/systematic/)
- [Skills Catalog](https://fro.bot/systematic/reference/skills/)
- [Agents Catalog](https://fro.bot/systematic/reference/agents/)
- [Configuration Reference](https://fro.bot/systematic/reference/configuration/)
- [Architecture](./ARCHITECTURE.md)

## License

[MIT](LICENSE) © Marcus R. Brown
