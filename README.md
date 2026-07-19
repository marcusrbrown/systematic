<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/banner.svg">
  <img alt="Systematic - Structured Engineering Workflows for OpenCode" src="./assets/banner.svg" width="100%">
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

Systematic is an [OpenCode](https://opencode.ai/) plugin — and, from v3, a [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension in the same package — that ships 31 bundled skills covering brainstorming, planning, implementation, review, and knowledge capture. It includes 37 specialized agents for architecture, security, performance, design, and code review. Installation is zero-configuration — the plugin registers everything via OpenCode's config hooks and works immediately on restart. OCX registry support is available for component-level installs when you only want specific pieces.

## Quick Install

**OpenCode plugin** — full integration (slash commands, `systematic_skill` tool, agent registration):

```json
{ "plugin": ["@fro.bot/systematic@latest"] }
```

Add that to `~/.config/opencode/opencode.json` and restart OpenCode.

**Pi coding agent** — same package, second harness (bundled skills, `systematic_skill`, persona delegation via `systematic_delegate`):

```bash
npx @fro.bot/systematic setup --harness pi
```

See the [Pi harness guide](https://fro.bot/systematic/guides/pi-harness/) for what carries over and where parity honestly ends.

**`npx skills`** — portable skill content for any AI harness (Claude Code, Cursor, Copilot, …):

```bash
npx skills add marcusrbrown/systematic
```

Use the plugin if you're on OpenCode and want the complete experience, the Pi setup command if you're on Pi, or `npx skills` if you want the skill Markdown files dropped into whatever harness you're running.

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

- [ ] [OpenCode](https://opencode.ai/) installed
- [ ] Add `@fro.bot/systematic@latest` to your `opencode.json` plugins list
- [ ] Restart OpenCode
- [ ] Run `/ce:brainstorm` on something you're building
- [ ] Verify: the `systematic_skill` tool appears in your tool list

## Learn More

- [Documentation](https://fro.bot/systematic/)
- [Skills Catalog](https://fro.bot/systematic/reference/skills/)
- [Agents Catalog](https://fro.bot/systematic/reference/agents/)
- [Configuration Reference](https://fro.bot/systematic/reference/configuration/)
- [Architecture](./ARCHITECTURE.md)

## License

[MIT](LICENSE) © Marcus R. Brown
