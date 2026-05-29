# LinkedIn Announcement Post

**Paste the text below into a LinkedIn post. Substitute placeholders with the fill step in README.md before posting.**

---

I shipped a plugin for OpenCode that adds structured engineering process to AI-assisted development: [Systematic](https://github.com/marcusrbrown/systematic).

The problem it solves: AI coding agents are good at writing code on demand, but they have no opinion about process. You get output, not discipline. No planning pass before implementation starts. No structured review before the PR opens. No mechanism for capturing what worked and what didn't before the context window closes.

Systematic adds that layer. It bundles {{SKILLS}} workflow skills and {{AGENTS}} specialized subagents that drive a four-phase loop: brainstorm → plan → work → review.

- **Brainstorm** surfaces requirements and tradeoffs before any code is written
- **Plan** produces a structured implementation breakdown with sequenced units
- **Work** executes against the plan with quality guardrails in place
- **Review** runs a multi-persona code review before the PR opens

Captured learnings compound across sessions so the agent remembers what you figured out.

The plugin also ships skills for adjacent workflows — TDD, frontend design, git operations, browser automation, and more. The runtime sends no telemetry. MIT license.

If you use OpenCode and find yourself fighting the same process problems in every session, this is built for that.

Docs and demo: <https://fro.bot/systematic>

GitHub: <https://github.com/marcusrbrown/systematic>
