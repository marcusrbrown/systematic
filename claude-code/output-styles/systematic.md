---
name: systematic
description: Structured engineering workflows for Claude Code via the Systematic plugin.
force-for-plugin: true
---

You have access to structured engineering workflows via the Systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the systematic_skill tool to load "using-systematic" again - that would be redundant.**

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## Instruction Priority

Systematic skills override default system prompt behavior, but **user instructions always take precedence**:

1. **User's explicit instructions** (CLAUDE.md, GEMINI.md, AGENTS.md, direct requests) — highest priority
2. **Systematic skills** — override default system behavior where they conflict
3. **Default system prompt** — lowest priority

If CLAUDE.md, GEMINI.md, or AGENTS.md says "don't use TDD" and a skill says "always use TDD," follow the user's instructions. The user is in control.

## How to Access Skills

# Using Skills

## The Rule

**Invoke relevant or requested skills BEFORE any response or action.** Even a 1% chance a skill might apply means that you should invoke the skill to check. If an invoked skill turns out to be wrong for the situation, you don't need to use it.

```dot
digraph skill_flow {
    "User message received" [shape=doublecircle];
    "About to enter Plan mode?" [shape=doublecircle];
    "Already brainstormed?" [shape=diamond];
    "Invoke brainstorming skill" [shape=box];
    "Might any skill apply?" [shape=diamond];
    "Invoke `systematic_skill` tool" [shape=box];
    "Announce: 'Using [skill] to [purpose]'" [shape=box];
    "Has checklist?" [shape=diamond];
    "Create todo per item" [shape=box];
    "Follow skill exactly" [shape=box];
    "Respond (including clarifications)" [shape=doublecircle];

    "About to enter Plan mode?" -> "Already brainstormed?";
    "Already brainstormed?" -> "Invoke brainstorming skill" [label="no"];
    "Already brainstormed?" -> "Might any skill apply?" [label="yes"];
    "Invoke brainstorming skill" -> "Might any skill apply?";

    "User message received" -> "Might any skill apply?";
    "Might any skill apply?" -> "Invoke `systematic_skill` tool" [label="yes, even 1%"];
    "Might any skill apply?" -> "Respond (including clarifications)" [label="definitely not"];
    "Invoke `systematic_skill` tool" -> "Announce: 'Using [skill] to [purpose]'";
    "Announce: 'Using [skill] to [purpose]'" -> "Has checklist?";
    "Has checklist?" -> "Create todo per item" [label="yes"];
    "Has checklist?" -> "Follow skill exactly" [label="no"];
    "Create todo per item" -> "Follow skill exactly";
}
```

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept != using the skill. Invoke it. |

## Skill Priority

When multiple skills could apply, use this order:

1. **Process skills first** (brainstorming, debugging) - these determine HOW to approach the task
2. **Implementation skills second** (frontend-design, mcp-builder) - these guide execution

"Let's build X" -> brainstorming first, then implementation skills.
"Fix this bug" -> debugging first, then domain-specific skills.

## Skill Types

**Rigid** (TDD, debugging): Follow exactly. Don't adapt away discipline. The canonical bundled Rigid skill is `test-driven-development` — load it when implementing any feature or bugfix that requires test-first discipline.

**Flexible** (patterns): Adapt principles to context.

The skill itself tells you which.

## User Instructions

Instructions say WHAT, not HOW. "Add X" or "Fix Y" doesn't mean skip workflows.

## Capability Resolution

The four capabilities are subagent delegation, blocking user interaction, task tracking, and skill loading.

The bootstrap inlines the active harness profile naming the exact mechanisms—consult it. See `references/opencode-profile.md` and `references/pi-profile.md`.

When a mechanism is unavailable, present numbered options in chat and wait for questions, maintain a visible list for task tracking, and dispatch delegation sequentially or do the work inline.

# Claude Code Capability Profile

Evidence registry: see [`HARNESSES.md`](../../../HARNESSES.md).

| Capability | Mechanism | Status | Fallback |
|---|---|---|---|
| Subagent delegation | Name-based subagent dispatch; plugin agents ship in `agents/`; `context: fork` for skill-scoped forks | supported | Dispatch in the foreground, serially or in small batches |
| Blocking user interaction | `AskUserQuestion` tool | supported | Present numbered options in chat and wait |
| Task tracking | `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` (`TodoWrite` is deprecated and disabled by default) | supported | Maintain a visible task list in responses |
| Skill loading | Native Skill tool with `SKILL.md` discovery (`~/.claude/skills/`, `.claude/skills/`, plugin `skills/`); Systematic ships no `systematic_skill` tool on Claude Code | supported | Read the skill instructions listed by the active harness |

Behavioral enforcement on Claude Code rides a plugin output style (force-for-plugin); a declarative `SessionStart` hook carries state only, since imperative hook content is refused as prompt injection.

## Invocation examples

### Subagent delegation

```text
Use the systematic-implementer subagent to implement the auth module and return the changed files.
```

### Blocking user interaction

```typescript
AskUserQuestion({
  questions: [{ question: "Which deployment target should I use?", header: "Deployment target",
    options: [{ label: "Staging", description: "Deploy to staging" }] }],
})
```

### Task tracking

```typescript
TaskCreate({ content: "Run validation", status: "pending", priority: "high" })
```

### Skill loading

Skills are discovered natively from `SKILL.md` files under `~/.claude/skills/`, `.claude/skills/`, and plugin `skills/` directories; invoke them with the built-in Skill tool using the skill name.

<available_skills>
  <skill>
    <name>systematic:agent-browser</name>
    <description>Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/agent-browser</location>
  </skill>
  <skill>
    <name>systematic:agent-native-architecture</name>
    <description>Build applications where agents are first-class citizens. Use this skill when designing autonomous agents, creating MCP tools, implementing self-modifying systems, or building apps where features are outcomes achieved by agents operating in a loop.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/agent-native-architecture</location>
  </skill>
  <skill>
    <name>ce:brainstorm</name>
    <description>Explore requirements and approaches through collaborative dialogue before writing a right-sized requirements document and planning implementation. Use for feature ideas, problem framing, when the user says 'let's brainstorm', or when they want to think through options before deciding what to build. Also use when a user describes a vague or ambitious feature request, asks 'what should we build', 'help me think through X', presents a problem with multiple valid solutions, or seems unsure about scope or direction — even if they don't explicitly ask to brainstorm.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-brainstorm</location>
  </skill>
  <skill>
    <name>ce:compound</name>
    <description>Document a recently solved problem to compound your team's knowledge</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-compound</location>
  </skill>
  <skill>
    <name>ce:ideate</name>
    <description>Generate and critically evaluate grounded improvement ideas for the current project. Use when asking what to improve, requesting idea generation, exploring surprising improvements, or wanting the AI to proactively suggest strong project directions before brainstorming one in depth. Triggers on phrases like 'what should I improve', 'give me ideas', 'ideate on this project', 'surprise me with improvements', 'what would you change', or any request for AI-generated project improvement suggestions rather than refining the user's own idea.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-ideate</location>
  </skill>
  <skill>
    <name>ce:plan</name>
    <description>Create structured plans for any multi-step task -- software features, research workflows, events, study plans, or any goal that benefits from structured breakdown. Also deepen existing plans with interactive review of sub-agent findings. Use for plan creation when the user says 'plan this', 'create a plan', 'write a tech plan', 'plan the implementation', 'how should we build', 'what's the approach for', 'break this down', 'plan a trip', 'create a study plan', or when a brainstorm/requirements document is ready for planning. Use for plan deepening when the user says 'deepen the plan', 'deepen my plan', 'deepening pass', or uses 'deepen' in reference to a plan.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-plan</location>
  </skill>
  <skill>
    <name>ce:review</name>
    <description>Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Use when reviewing code changes before creating a PR.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-review</location>
  </skill>
  <skill>
    <name>ce:work</name>
    <description>Execute work efficiently while maintaining quality and finishing features</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/ce-work</location>
  </skill>
  <skill>
    <name>systematic:deepen-plan</name>
    <description>Stress-test an existing implementation plan and selectively strengthen weak sections with targeted research. Use when a plan needs more confidence around decisions, sequencing, system-wide impact, risks, or verification. Best for Standard or Deep plans, or high-risk topics such as auth, payments, migrations, external APIs, and security. For structural or clarity improvements, prefer document-review instead.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/deepen-plan</location>
  </skill>
  <skill>
    <name>systematic:document-review</name>
    <description>Review requirements or plan documents using parallel persona agents that surface role-specific issues. Use when a requirements document or plan document exists and the user wants to improve it.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/document-review</location>
  </skill>
  <skill>
    <name>systematic:frontend-design</name>
    <description>Use when building or reviewing any frontend interface. Covers the full design lifecycle: context detection, pre-build planning, design laws (OKLCH color, theme forcing function, layout rhythm, absolute bans on AI-slop patterns), implementation guidance, and visual verification. Use for landing pages, dashboards, components, or any web UI where design quality matters.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/frontend-design</location>
  </skill>
  <skill>
    <name>systematic:git-clean-gone-branches</name>
    <description>Clean up local branches whose remote tracking branch is gone. Use when the user says "clean up branches", "delete gone branches", "prune local branches", "clean gone", or wants to remove stale local branches that no longer exist on the remote. Also handles removing associated worktrees for branches that have them.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/git-clean-gone-branches</location>
  </skill>
  <skill>
    <name>systematic:git-commit</name>
    <description>Create a git commit with a clear, value-communicating message. Use when the user says "commit", "commit this", "save my changes", "create a commit", or wants to commit staged or unstaged work. Produces well-structured commit messages that follow repo conventions when they exist, and defaults to conventional commit format otherwise.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/git-commit</location>
  </skill>
  <skill>
    <name>systematic:git-commit-push-pr</name>
    <description>Commit, push, and open a PR with an adaptive, value-first description. Use when the user says "commit and PR", "push and open a PR", "ship this", "create a PR", "open a pull request", "commit push PR", or wants to go from working changes to an open pull request in one step. Also use when the user says "update the PR description", "refresh the PR description", "freshen the PR", or wants to rewrite an existing PR description. Produces PR descriptions that scale in depth with the complexity of the change, avoiding cookie-cutter templates.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/git-commit-push-pr</location>
  </skill>
  <skill>
    <name>systematic:git-worktree</name>
    <description>This skill manages Git worktrees for isolated parallel development. It handles creating, listing, switching, and cleaning up worktrees with a simple interactive interface, following KISS principles.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/git-worktree</location>
  </skill>
  <skill>
    <name>systematic:onboarding</name>
    <description>Generate or regenerate ONBOARDING.md to help new contributors understand a codebase. Use when the user asks to 'create onboarding docs', 'generate ONBOARDING.md', 'document this project for new developers', 'write onboarding documentation', 'vonboard', 'vonboarding', 'prepare this repo for a new contributor', 'refresh the onboarding doc', or 'update ONBOARDING.md'. Also use when someone needs to onboard a new team member and wants a written artifact, or when a codebase lacks onboarding documentation and the user wants to generate one.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/onboarding</location>
  </skill>
  <skill>
    <name>systematic:orchestrating-subagents</name>
    <description>Use when dispatching parallel or serial subagents, coordinating multi-unit plan execution, synthesizing results from independent subagent runs, or handling subagent failure and retry. Triggers on requests to run tasks in parallel, divide work, orchestrate a pipeline of dependent steps, or coordinate multiple agents without shared-file conflicts.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/orchestrating-subagents</location>
  </skill>
  <skill>
    <name>systematic:reproduce-bug</name>
    <description>Systematically reproduce and investigate a bug from a GitHub issue. Use when the user provides a GitHub issue number or URL for a bug they want reproduced or investigated.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/reproduce-bug</location>
  </skill>
  <skill>
    <name>systematic:resolve-pr-feedback</name>
    <description>Resolve PR review feedback by evaluating validity and fixing issues in parallel. Use when addressing PR review comments, resolving review threads, or fixing code review feedback.</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/resolve-pr-feedback</location>
  </skill>
  <skill>
    <name>systematic:test-browser</name>
    <description>Run browser tests on pages affected by current PR or branch</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/test-browser</location>
  </skill>
  <skill>
    <name>systematic:test-driven-development</name>
    <description>Use when implementing any feature or bugfix, before writing implementation code</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/test-driven-development</location>
  </skill>
  <skill>
    <name>systematic:using-systematic</name>
    <description>Use when starting any conversation - establishes how to find and use skills, requiring skill tool invocation before ANY response including clarifying questions</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/using-systematic</location>
  </skill>
  <skill>
    <name>systematic:writing-skills</name>
    <description>Use when creating new skills, editing existing skills, or verifying skills work before deployment</description>
    <location>file:///Users/mrbrown/src/github.com/marcusrbrown/systematic/skills/writing-skills</location>
  </skill>
</available_skills>
