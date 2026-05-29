# Discord Forum Post

**Channel:** TBD — join the OpenCode community Discord and identify the appropriate channel (likely a plugins, showcase, or community-projects channel) before posting. Do not post in a general/off-topic channel without verifying it is the right place.

**Substitute placeholders with the fill step in README.md before posting.**

---

**Title:** Systematic — an OpenCode plugin for structured engineering workflows

**Body:**

I built a plugin called [Systematic](https://github.com/marcusrbrown/systematic) that adds structured engineering process on top of OpenCode.

The short version: OpenCode is a capable agent but has no opinion about process. Systematic adds a four-phase workflow loop — brainstorm, plan, work, review — with dedicated skills driving each phase. The goal is to go from "ask the agent to write code" to "run a disciplined engineering session" without doing the process coordination yourself every time.

What's included:

- **{{SKILLS}} workflow skills** covering the core loop plus adjacent workflows: TDD, frontend design, git operations, browser automation, code review, PR creation, and more
- **{{AGENTS}} specialized subagents** for tasks that benefit from a dedicated context
- A `compound` skill for capturing learnings at the end of a session so they persist across future ones

The plugin runtime sends no telemetry. MIT license. Docs at [fro.bot/systematic](https://fro.bot/systematic) including a with-vs-without walkthrough at [fro.bot/systematic/guides/with-vs-without/](https://fro.bot/systematic/guides/with-vs-without/).

Happy to answer questions about how any of it works.
