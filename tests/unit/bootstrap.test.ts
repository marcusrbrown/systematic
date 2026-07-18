import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyBootstrapContent,
  composeSystemPromptWithBootstrap,
  computeBootstrapContentSafe,
  getBootstrapContent,
  INTERNAL_AGENT_SIGNATURES,
  readHarnessProfile,
} from '../../src/lib/bootstrap.ts'

/**
 * Reconstruct the production skip predicate from src/index.ts:91-97 using the
 * exported INTERNAL_AGENT_SIGNATURES constant. This mirrors the inline check
 * in the experimental.chat.system.transform hook without duplicating the data.
 *
 * If the production logic changes shape (e.g., joins with a different
 * separator, or stops lowercasing), both the production code and this helper
 * must be updated together.
 */
function shouldSkipBootstrap(system: readonly string[]): boolean {
  const existingSystem = system.join('\n').toLowerCase()
  return INTERNAL_AGENT_SIGNATURES.some((sig) =>
    existingSystem.includes(sig.toLowerCase()),
  )
}

function normalizeBootstrapSnapshot(
  content: string,
  skillsDir: string,
): string {
  const normalized = content.replaceAll(skillsDir, '<SKILLS_DIR>')
  expect(normalized).toContain('<SKILLS_DIR>')
  expect(normalized).not.toContain(skillsDir)
  return normalized
}

// ---------------------------------------------------------------------------
// getBootstrapContent
// ---------------------------------------------------------------------------

describe('getBootstrapContent', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-bootstrap-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function makeBundledSkillsDir(usingSystematicBody?: string): string {
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(bundledSkillsDir, { recursive: true })
    if (usingSystematicBody !== undefined) {
      fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'))
      fs.writeFileSync(
        path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'),
        usingSystematicBody,
      )
    }
    return bundledSkillsDir
  }

  test('pins the default bootstrap bytes before profile inlining', () => {
    const skillsDir = path.resolve(process.cwd(), 'skills')
    const content = getBootstrapContent(
      {
        bootstrap: { enabled: true },
        disabled_skills: [],
      },
      { bundledSkillsDir: skillsDir },
    )

    expect(
      normalizeBootstrapSnapshot(content as string, skillsDir),
    ).toMatchInlineSnapshot(`
      "<SYSTEMATIC_WORKFLOWS>
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

      \`\`\`dot
      digraph skill_flow {
          "User message received" [shape=doublecircle];
          "About to enter Plan mode?" [shape=doublecircle];
          "Already brainstormed?" [shape=diamond];
          "Invoke brainstorming skill" [shape=box];
          "Might any skill apply?" [shape=diamond];
          "Invoke \`systematic_skill\` tool" [shape=box];
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
          "Might any skill apply?" -> "Invoke \`systematic_skill\` tool" [label="yes, even 1%"];
          "Might any skill apply?" -> "Respond (including clarifications)" [label="definitely not"];
          "Invoke \`systematic_skill\` tool" -> "Announce: 'Using [skill] to [purpose]'";
          "Announce: 'Using [skill] to [purpose]'" -> "Has checklist?";
          "Has checklist?" -> "Create todo per item" [label="yes"];
          "Has checklist?" -> "Follow skill exactly" [label="no"];
          "Create todo per item" -> "Follow skill exactly";
      }
      \`\`\`

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

      **Rigid** (TDD, debugging): Follow exactly. Don't adapt away discipline. The canonical bundled Rigid skill is \`test-driven-development\` — load it when implementing any feature or bugfix that requires test-first discipline.

      **Flexible** (patterns): Adapt principles to context.

      The skill itself tells you which.

      ## User Instructions

      Instructions say WHAT, not HOW. "Add X" or "Fix Y" doesn't mean skip workflows.

      ## Capability Resolution

      The four capabilities are subagent delegation, blocking user interaction, task tracking, and skill loading.

      The bootstrap inlines the active harness profile naming the exact mechanisms—consult it. See \`references/opencode-profile.md\` and \`references/pi-profile.md\`.

      When a mechanism is unavailable, present numbered options in chat and wait for questions, maintain a visible list for task tracking, and dispatch delegation sequentially or do the work inline.

      **Skills naming:**
      - Systematic bundled skills use the \`systematic:\` prefix (e.g., \`systematic:onboarding\`)
      - Workflow skills with their own namespace keep it (e.g., \`ce:brainstorm\`)
      - Skills can also be invoked without prefix if unambiguous

      **Skills usage:**
      - Use \`systematic_skill\` to load Systematic bundled skills
      - Use the \`skill\` tool for non-Systematic skills

      **Skills location:**
      Bundled skills ship with the Systematic plugin and are discoverable via \`systematic_skill\`.

      <available_skills>
        <skill>
          <name>systematic:agent-browser</name>
          <description>Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.</description>
          <location>file://<SKILLS_DIR>/agent-browser</location>
        </skill>
        <skill>
          <name>systematic:agent-native-architecture</name>
          <description>Build applications where agents are first-class citizens. Use this skill when designing autonomous agents, creating MCP tools, implementing self-modifying systems, or building apps where features are outcomes achieved by agents operating in a loop.</description>
          <location>file://<SKILLS_DIR>/agent-native-architecture</location>
        </skill>
        <skill>
          <name>ce:brainstorm</name>
          <description>Explore requirements and approaches through collaborative dialogue before writing a right-sized requirements document and planning implementation. Use for feature ideas, problem framing, when the user says 'let's brainstorm', or when they want to think through options before deciding what to build. Also use when a user describes a vague or ambitious feature request, asks 'what should we build', 'help me think through X', presents a problem with multiple valid solutions, or seems unsure about scope or direction — even if they don't explicitly ask to brainstorm.</description>
          <location>file://<SKILLS_DIR>/ce-brainstorm</location>
        </skill>
        <skill>
          <name>ce:compound</name>
          <description>Document a recently solved problem to compound your team's knowledge</description>
          <location>file://<SKILLS_DIR>/ce-compound</location>
        </skill>
        <skill>
          <name>ce:ideate</name>
          <description>Generate and critically evaluate grounded improvement ideas for the current project. Use when asking what to improve, requesting idea generation, exploring surprising improvements, or wanting the AI to proactively suggest strong project directions before brainstorming one in depth. Triggers on phrases like 'what should I improve', 'give me ideas', 'ideate on this project', 'surprise me with improvements', 'what would you change', or any request for AI-generated project improvement suggestions rather than refining the user's own idea.</description>
          <location>file://<SKILLS_DIR>/ce-ideate</location>
        </skill>
        <skill>
          <name>ce:plan</name>
          <description>Create structured plans for any multi-step task -- software features, research workflows, events, study plans, or any goal that benefits from structured breakdown. Also deepen existing plans with interactive review of sub-agent findings. Use for plan creation when the user says 'plan this', 'create a plan', 'write a tech plan', 'plan the implementation', 'how should we build', 'what's the approach for', 'break this down', 'plan a trip', 'create a study plan', or when a brainstorm/requirements document is ready for planning. Use for plan deepening when the user says 'deepen the plan', 'deepen my plan', 'deepening pass', or uses 'deepen' in reference to a plan.</description>
          <location>file://<SKILLS_DIR>/ce-plan</location>
        </skill>
        <skill>
          <name>ce:review</name>
          <description>Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Use when reviewing code changes before creating a PR.</description>
          <location>file://<SKILLS_DIR>/ce-review</location>
        </skill>
        <skill>
          <name>ce:work</name>
          <description>Execute work efficiently while maintaining quality and finishing features</description>
          <location>file://<SKILLS_DIR>/ce-work</location>
        </skill>
        <skill>
          <name>systematic:deepen-plan</name>
          <description>Stress-test an existing implementation plan and selectively strengthen weak sections with targeted research. Use when a plan needs more confidence around decisions, sequencing, system-wide impact, risks, or verification. Best for Standard or Deep plans, or high-risk topics such as auth, payments, migrations, external APIs, and security. For structural or clarity improvements, prefer document-review instead.</description>
          <location>file://<SKILLS_DIR>/deepen-plan</location>
        </skill>
        <skill>
          <name>systematic:document-review</name>
          <description>Review requirements or plan documents using parallel persona agents that surface role-specific issues. Use when a requirements document or plan document exists and the user wants to improve it.</description>
          <location>file://<SKILLS_DIR>/document-review</location>
        </skill>
        <skill>
          <name>systematic:frontend-design</name>
          <description>Use when building or reviewing any frontend interface. Covers the full design lifecycle: context detection, pre-build planning, design laws (OKLCH color, theme forcing function, layout rhythm, absolute bans on AI-slop patterns), implementation guidance, and visual verification. Use for landing pages, dashboards, components, or any web UI where design quality matters.</description>
          <location>file://<SKILLS_DIR>/frontend-design</location>
        </skill>
        <skill>
          <name>systematic:git-clean-gone-branches</name>
          <description>Clean up local branches whose remote tracking branch is gone. Use when the user says "clean up branches", "delete gone branches", "prune local branches", "clean gone", or wants to remove stale local branches that no longer exist on the remote. Also handles removing associated worktrees for branches that have them.</description>
          <location>file://<SKILLS_DIR>/git-clean-gone-branches</location>
        </skill>
        <skill>
          <name>systematic:git-commit</name>
          <description>Create a git commit with a clear, value-communicating message. Use when the user says "commit", "commit this", "save my changes", "create a commit", or wants to commit staged or unstaged work. Produces well-structured commit messages that follow repo conventions when they exist, and defaults to conventional commit format otherwise.</description>
          <location>file://<SKILLS_DIR>/git-commit</location>
        </skill>
        <skill>
          <name>systematic:git-commit-push-pr</name>
          <description>Commit, push, and open a PR with an adaptive, value-first description. Use when the user says "commit and PR", "push and open a PR", "ship this", "create a PR", "open a pull request", "commit push PR", or wants to go from working changes to an open pull request in one step. Also use when the user says "update the PR description", "refresh the PR description", "freshen the PR", or wants to rewrite an existing PR description. Produces PR descriptions that scale in depth with the complexity of the change, avoiding cookie-cutter templates.</description>
          <location>file://<SKILLS_DIR>/git-commit-push-pr</location>
        </skill>
        <skill>
          <name>systematic:git-worktree</name>
          <description>This skill manages Git worktrees for isolated parallel development. It handles creating, listing, switching, and cleaning up worktrees with a simple interactive interface, following KISS principles.</description>
          <location>file://<SKILLS_DIR>/git-worktree</location>
        </skill>
        <skill>
          <name>systematic:onboarding</name>
          <description>Generate or regenerate ONBOARDING.md to help new contributors understand a codebase. Use when the user asks to 'create onboarding docs', 'generate ONBOARDING.md', 'document this project for new developers', 'write onboarding documentation', 'vonboard', 'vonboarding', 'prepare this repo for a new contributor', 'refresh the onboarding doc', or 'update ONBOARDING.md'. Also use when someone needs to onboard a new team member and wants a written artifact, or when a codebase lacks onboarding documentation and the user wants to generate one.</description>
          <location>file://<SKILLS_DIR>/onboarding</location>
        </skill>
        <skill>
          <name>systematic:orchestrating-subagents</name>
          <description>Use when dispatching parallel or serial subagents, coordinating multi-unit plan execution, synthesizing results from independent subagent runs, or handling subagent failure and retry. Triggers on requests to run tasks in parallel, divide work, orchestrate a pipeline of dependent steps, or coordinate multiple agents without shared-file conflicts.</description>
          <location>file://<SKILLS_DIR>/orchestrating-subagents</location>
        </skill>
        <skill>
          <name>systematic:reproduce-bug</name>
          <description>Systematically reproduce and investigate a bug from a GitHub issue. Use when the user provides a GitHub issue number or URL for a bug they want reproduced or investigated.</description>
          <location>file://<SKILLS_DIR>/reproduce-bug</location>
        </skill>
        <skill>
          <name>systematic:resolve-pr-feedback</name>
          <description>Resolve PR review feedback by evaluating validity and fixing issues in parallel. Use when addressing PR review comments, resolving review threads, or fixing code review feedback.</description>
          <location>file://<SKILLS_DIR>/resolve-pr-feedback</location>
        </skill>
        <skill>
          <name>systematic:test-browser</name>
          <description>Run browser tests on pages affected by current PR or branch</description>
          <location>file://<SKILLS_DIR>/test-browser</location>
        </skill>
        <skill>
          <name>systematic:test-driven-development</name>
          <description>Use when implementing any feature or bugfix, before writing implementation code</description>
          <location>file://<SKILLS_DIR>/test-driven-development</location>
        </skill>
        <skill>
          <name>systematic:using-systematic</name>
          <description>Use when starting any conversation - establishes how to find and use skills, requiring skill tool invocation before ANY response including clarifying questions</description>
          <location>file://<SKILLS_DIR>/using-systematic</location>
        </skill>
        <skill>
          <name>systematic:writing-skills</name>
          <description>Use when creating new skills, editing existing skills, or verifying skills work before deployment</description>
          <location>file://<SKILLS_DIR>/writing-skills</location>
        </skill>
      </available_skills>
      </SYSTEMATIC_WORKFLOWS>"
    `)
  })

  test('default config returns content with SYSTEMATIC_WORKFLOWS wrapper', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('</SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Bootstrap body content here.')
    expect(content).toContain('**Skills naming:**')
    expect(content).toContain('Use the `skill` tool for non-Systematic skills')
    expect(content).not.toContain('**Tool Mapping for OpenCode:**')
  })

  test('custom usage template is included when provided without changing the default OpenCode template', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, {
      bundledSkillsDir,
      usageTemplate: '**Pi-native guidance:**\n- use systematic_skill\n',
    })

    expect(content).not.toBeNull()
    expect(content).toContain('**Pi-native guidance:**')
    expect(content).not.toContain(
      'Use the `skill` tool for non-Systematic skills',
    )
  })

  test('inlines a profile after usage guidance and before the catalog', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    fs.mkdirSync(path.join(bundledSkillsDir, 'catalog-skill'))
    fs.writeFileSync(
      path.join(bundledSkillsDir, 'catalog-skill', 'SKILL.md'),
      '---\nname: catalog-skill\ndescription: Catalog entry\n---\nBody.',
    )
    const profile = 'PROFILE BLOCK'
    const content = getBootstrapContent(
      { bootstrap: { enabled: true }, disabled_skills: [] },
      {
        bundledSkillsDir,
        usageTemplate: 'USAGE TEMPLATE',
        profileBlock: profile,
      },
    )

    expect(content).not.toBeNull()
    const output = content as string
    expect(output.indexOf('USAGE TEMPLATE')).toBeLessThan(
      output.indexOf(profile),
    )
    expect(output.indexOf(profile)).toBeLessThan(
      output.indexOf('<available_skills>'),
    )
    expect(output.indexOf(profile)).toBeLessThan(
      output.indexOf('</SYSTEMATIC_WORKFLOWS>'),
    )
  })

  test('reports missing harness profiles to stderr and returns null', () => {
    const bundledSkillsDir = makeBundledSkillsDir()
    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      expect(readHarnessProfile(bundledSkillsDir, 'missing')).toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors[0]?.join(' ')).toContain('missing-profile.md')
      expect(errors[0]?.join(' ')).toContain('ENOENT')
    } finally {
      console.error = originalError
    }
  })

  test('reports profile read failures to stderr and still returns null', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBundled body',
    )
    const profileDir = path.join(
      bundledSkillsDir,
      'using-systematic/references/opencode-profile.md',
    )
    fs.mkdirSync(profileDir, { recursive: true })
    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      expect(readHarnessProfile(bundledSkillsDir, 'opencode')).toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors[0]?.join(' ')).toContain(profileDir)
      expect(errors[0]?.join(' ')).toContain('EISDIR')

      const content = getBootstrapContent(
        { bootstrap: { enabled: true }, disabled_skills: [] },
        { bundledSkillsDir },
      )
      expect(content).not.toBeNull()
      expect(content).not.toContain('PROFILE BLOCK')
    } finally {
      console.error = originalError
    }
  })

  test('resolves the claude-code harness profile', () => {
    const bundledSkillsDir = path.resolve(process.cwd(), 'skills')
    const profile = readHarnessProfile(bundledSkillsDir, 'claude-code')
    expect(profile).not.toBeNull()
    expect(profile as string).toContain('Claude Code Capability Profile')
  })

  test('real harness profiles do not contain bootstrap replacement sentinels', () => {
    const profilesDir = path.resolve(
      process.cwd(),
      'skills/using-systematic/references',
    )
    for (const name of ['opencode', 'pi', 'claude-code']) {
      const profile = fs.readFileSync(
        path.join(profilesDir, `${name}-profile.md`),
        'utf8',
      )
      expect(profile).not.toContain('<SYSTEMATIC_WORKFLOWS>')
      expect(profile).not.toContain('</SYSTEMATIC_WORKFLOWS>')
    }
  })

  test('pins the production-shaped OpenCode bootstrap with its profile inlined', () => {
    const bundledSkillsDir = path.resolve(process.cwd(), 'skills')
    const content = getBootstrapContent(
      { bootstrap: { enabled: true }, disabled_skills: [] },
      {
        bundledSkillsDir,
        profileBlock:
          readHarnessProfile(bundledSkillsDir, 'opencode') ?? undefined,
      },
    )
    expect(content).not.toBeNull()
    expect(
      normalizeBootstrapSnapshot(content as string, bundledSkillsDir),
    ).toMatchSnapshot()
  })

  test('preserves marker-shaped profile text during Pi-style composition', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const profile = 'literal <SYSTEMATIC_WORKFLOWS> marker text'
    const bootstrap = getBootstrapContent(
      { bootstrap: { enabled: true }, disabled_skills: [] },
      { bundledSkillsDir, profileBlock: profile },
    ) as string

    const composed = composeSystemPromptWithBootstrap(
      'Earlier prompt',
      bootstrap,
    )
    expect(composed).toContain(profile)
    expect(
      composeSystemPromptWithBootstrap(composed as string, bootstrap),
    ).toBe(composed)
  })

  test('applyBootstrapContent does not duplicate an inlined profile on rerun', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBootstrap body content here.',
    )
    const profile = 'PROFILE BLOCK'
    const bootstrap = getBootstrapContent(
      { bootstrap: { enabled: true }, disabled_skills: [] },
      { bundledSkillsDir, profileBlock: profile },
    ) as string
    const output = { system: ['Earlier prompt'] }

    applyBootstrapContent(output, bootstrap)
    applyBootstrapContent(output, bootstrap)

    expect(output.system[0].split(profile)).toHaveLength(2)
    expect(output.system[0].split('<SYSTEMATIC_WORKFLOWS>')).toHaveLength(2)
  })

  test('config.bootstrap.enabled = false returns null', () => {
    const bundledSkillsDir = makeBundledSkillsDir('body')
    const config = {
      bootstrap: { enabled: false, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    expect(getBootstrapContent(config, { bundledSkillsDir })).toBeNull()
  })

  test('custom config.bootstrap.file returns the file contents verbatim when it exists', () => {
    const bundledSkillsDir = makeBundledSkillsDir('bundled body')
    const customPath = path.join(testDir, 'custom-bootstrap.md')
    fs.writeFileSync(customPath, 'CUSTOM bootstrap override content')

    const config = {
      bootstrap: { enabled: true, file: customPath },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).toBe('CUSTOM bootstrap override content')
    // Must NOT be wrapped with <SYSTEMATIC_WORKFLOWS> when using a custom file.
    expect(content).not.toContain('<SYSTEMATIC_WORKFLOWS>')
  })

  test('custom config.bootstrap.file with ~/ prefix expands to the home directory', () => {
    const bundledSkillsDir = makeBundledSkillsDir('bundled body')
    // Write a file in the real home dir (use a timestamped filename to avoid conflicts)
    const homeFilename = `.systematic-test-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    const realHomePath = path.join(os.homedir(), homeFilename)
    fs.writeFileSync(realHomePath, 'HOME-DIR bootstrap')
    try {
      const config = {
        bootstrap: { enabled: true, file: `~/${homeFilename}` },
        disabled_skills: [] as string[],
        disabled_agents: [] as string[],
        disabled_commands: [] as string[],
      }
      expect(getBootstrapContent(config, { bundledSkillsDir })).toBe(
        'HOME-DIR bootstrap',
      )
    } finally {
      fs.unlinkSync(realHomePath)
    }
  })

  test('custom config.bootstrap.file pointing to nonexistent path falls through to the bundled skill', () => {
    // CORRECTNESS: bootstrap.ts:40-47 does not return early when the custom
    // file is missing — it falls through to the bundled using-systematic path.
    // This test locks in that intentional fallback. Change only with a
    // behavior change (e.g., return null on missing custom file).
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBundled body',
    )
    const config = {
      bootstrap: {
        enabled: true,
        file: path.join(testDir, 'does-not-exist.md'),
      },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })
    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Bundled body')
  })

  test('returns null when using-systematic/SKILL.md is missing from bundledSkillsDir', () => {
    const bundledSkillsDir = makeBundledSkillsDir() // no SKILL.md
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    expect(getBootstrapContent(config, { bundledSkillsDir })).toBeNull()
  })

  test('strips YAML frontmatter from the bundled skill content', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\ndescription: Test skill\n---\n\nActual body content.',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('Actual body content.')
    expect(content).not.toContain('---')
    expect(content).not.toContain('description: Test skill')
  })

  test('skill-usage template does not embed bundledSkillsDir as a raw path', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nbody',
    )
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }
    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    // The skill-usage prose must not embed the raw path. Slice from the
    // heading up to the catalog block (or end of string if no catalog).
    const skillUsageHeading = '**Skills naming:**'
    const skillUsageStart = (content ?? '').indexOf(skillUsageHeading)
    expect(skillUsageStart).toBeGreaterThan(-1)
    const afterHeading = (content ?? '').slice(skillUsageStart)
    const catalogStart = afterHeading.indexOf('<available_skills>')
    const skillUsageProse =
      catalogStart >= 0 ? afterHeading.slice(0, catalogStart) : afterHeading
    expect(skillUsageProse).not.toContain(bundledSkillsDir)
    expect(content).toContain(
      'Bundled skills ship with the Systematic plugin and are discoverable via `systematic_skill`.',
    )
  })
})

describe('harness profile size budget', () => {
  test('keeps both inlined profiles below the compact bootstrap budget', () => {
    const profilesDir = path.resolve(
      process.cwd(),
      'skills/using-systematic/references',
    )
    const sizes = ['opencode', 'pi'].map((name) => {
      const contents = fs.readFileSync(
        path.join(profilesDir, `${name}-profile.md`),
        'utf8',
      )
      return { name, size: contents.length }
    })

    // Keep each profile under ~600 tokens so every session gets capability
    // routing without making the bootstrap disproportionately large.
    for (const { name, size } of sizes) {
      expect(size, `${name} profile size`).toBeLessThan(4000)
    }
  })
})

// ---------------------------------------------------------------------------
// Verbose skill catalog in default bootstrap
// ---------------------------------------------------------------------------

describe('getBootstrapContent — verbose skill catalog', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-catalog-'),
    )
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function makeSkillsDir(
    skills: Array<{ name: string; description: string; extra?: string }>,
  ): string {
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'),
      '---\nname: using-systematic\ndescription: Use when starting any conversation\n---\nBootstrap body.',
    )
    for (const skill of skills) {
      const dir = path.join(bundledSkillsDir, skill.name)
      fs.mkdirSync(dir, { recursive: true })
      const extra = skill.extra ?? ''
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: ${skill.description}${extra}\n---\nBody.`,
      )
    }
    return bundledSkillsDir
  }

  test('default bootstrap contains <available_skills> with skill name, description, and file URL', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      { name: 'ce:plan', description: 'Create structured plans' },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<available_skills>')
    expect(content).toContain('</available_skills>')
    // Skills appear with prefixed names
    expect(content).toContain('<name>systematic:git-commit</name>')
    expect(content).toContain('<description>Create a git commit</description>')
    expect(content).toContain('<location>file://')
    expect(content).toContain('git-commit')
    // ce:plan already has a colon so it keeps its name
    expect(content).toContain('<name>ce:plan</name>')
  })

  test('disabled skills are absent from the default bootstrap catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      { name: 'ce:plan', description: 'Create structured plans' },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: ['git-commit'] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).not.toContain('<name>systematic:git-commit</name>')
    expect(content).toContain('<name>ce:plan</name>')
  })

  test('skills with disableModelInvocation are absent from the default bootstrap catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
      {
        name: 'internal-tool',
        description: 'Internal only',
        extra: '\ndisable-model-invocation: true',
      },
    ])
    const config = {
      bootstrap: { enabled: true, file: undefined },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<name>systematic:git-commit</name>')
    expect(content).not.toContain('<name>systematic:internal-tool</name>')
  })

  test('custom bootstrap file content is returned verbatim without verbose catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
    ])
    const customPath = path.join(testDir, 'custom-bootstrap.md')
    fs.writeFileSync(customPath, 'CUSTOM bootstrap content — no catalog here')

    const config = {
      bootstrap: { enabled: true, file: customPath },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).toBe('CUSTOM bootstrap content — no catalog here')
    expect(content).not.toContain('<available_skills>')
  })

  test('missing custom bootstrap path falls through to default bootstrap with catalog', () => {
    const bundledSkillsDir = makeSkillsDir([
      { name: 'git-commit', description: 'Create a git commit' },
    ])
    const config = {
      bootstrap: {
        enabled: true,
        file: path.join(testDir, 'does-not-exist.md'),
      },
      disabled_skills: [] as string[],
      disabled_agents: [] as string[],
      disabled_commands: [] as string[],
    }

    const content = getBootstrapContent(config, { bundledSkillsDir })

    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('<available_skills>')
    expect(content).toContain('<name>systematic:git-commit</name>')
  })
})

describe('using-systematic SKILL.md structural invariants', () => {
  // Point at the real bundled skills directory so these tests exercise the
  // actual shipped SKILL.md content, not a synthetic fixture.
  const realBundledSkillsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../skills',
  )

  const defaultConfig = {
    bootstrap: { enabled: true, file: undefined },
    disabled_skills: [] as string[],
    disabled_agents: [] as string[],
    disabled_commands: [] as string[],
  }

  test('bootstrap content contains the <SUBAGENT-STOP> marker', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    expect(content).toContain('<SUBAGENT-STOP>')
  })

  test('bootstrap content contains the ## Instruction Priority section', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    expect(content).toContain('## Instruction Priority')
  })

  test('<SUBAGENT-STOP> appears before <EXTREMELY-IMPORTANT> in bootstrap output', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    const str = content as string
    const subagentStop = str.indexOf('<SUBAGENT-STOP>')
    const extremelyImportant = str.indexOf('<EXTREMELY-IMPORTANT>')
    expect(subagentStop).toBeGreaterThan(-1)
    expect(extremelyImportant).toBeGreaterThan(-1)
    expect(subagentStop).toBeLessThan(extremelyImportant)
  })

  test('## Instruction Priority appears before ## How to Access Skills in bootstrap output', () => {
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()
    const str = content as string
    const instructionPriority = str.indexOf('## Instruction Priority')
    const howToAccess = str.indexOf('## How to Access Skills')
    expect(instructionPriority).toBeGreaterThan(-1)
    expect(howToAccess).toBeGreaterThan(-1)
    expect(instructionPriority).toBeLessThan(howToAccess)
  })

  test('post-injection: applyBootstrapContent preserves SUBAGENT-STOP before EXTREMELY-IMPORTANT in rendered output.system[0]', () => {
    // CORRECTNESS: pre-injection tests against getBootstrapContent() can pass
    // while applyBootstrapContent's assembly logic silently breaks the
    // subagent-visible invariant. This test exercises the actual injection
    // surface that subagent system prompts see.
    const content = getBootstrapContent(defaultConfig, {
      bundledSkillsDir: realBundledSkillsDir,
    })
    expect(content).not.toBeNull()

    const output = { system: ['You are a primary agent. Do the work.'] }
    applyBootstrapContent(output, content as string)

    const rendered = output.system[0]
    const subagentStop = rendered.indexOf('<SUBAGENT-STOP>')
    const extremelyImportant = rendered.indexOf('<EXTREMELY-IMPORTANT>')
    expect(subagentStop).toBeGreaterThan(-1)
    expect(extremelyImportant).toBeGreaterThan(-1)
    expect(subagentStop).toBeLessThan(extremelyImportant)
  })
})

describe('shouldSkipBootstrap behavioral non-regression', () => {
  test('returns true for "You are a title generator" system prompt', () => {
    expect(
      shouldSkipBootstrap([
        'You are a title generator. Generate a short title.',
      ]),
    ).toBe(true)
  })

  test('returns true for "You are a helpful AI assistant tasked with summarizing conversations" system prompt', () => {
    expect(
      shouldSkipBootstrap([
        'You are a helpful AI assistant tasked with summarizing conversations. Be concise.',
      ]),
    ).toBe(true)
  })

  test('returns true for "Summarize what was done in this conversation" system prompt', () => {
    expect(
      shouldSkipBootstrap(['Summarize what was done in this conversation.']),
    ).toBe(true)
  })

  test('returns false for a primary-agent-shape prompt with no internal signatures', () => {
    expect(
      shouldSkipBootstrap([
        'You are a code review assistant for the marcusrbrown/systematic project. Review the diff carefully and provide actionable feedback.',
      ]),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// INTERNAL_AGENT_SIGNATURES skip heuristic (src/index.ts:91-97)
// ---------------------------------------------------------------------------

describe('INTERNAL_AGENT_SIGNATURES skip heuristic', () => {
  test('exports the 3 documented signatures', () => {
    expect(INTERNAL_AGENT_SIGNATURES).toEqual([
      'You are a title generator',
      'You are a helpful AI assistant tasked with summarizing conversations',
      'Summarize what was done in this conversation',
    ])
  })

  test('skips when any signature appears in the joined system prompt', () => {
    for (const sig of INTERNAL_AGENT_SIGNATURES) {
      expect(shouldSkipBootstrap([`Context\n\n${sig}\n\nRules...`])).toBe(true)
    }
  })

  test('is case-insensitive', () => {
    expect(shouldSkipBootstrap(['YOU ARE A TITLE GENERATOR'])).toBe(true)
    expect(shouldSkipBootstrap(['you are a title generator'])).toBe(true)
    expect(shouldSkipBootstrap(['You Are A Title Generator'])).toBe(true)
  })

  test('joins the system array with newline before matching', () => {
    // Signature split across array entries: if production joined with an empty
    // string, the substring would still match; but newline is the documented
    // separator, so this test pins the behavior.
    const split = ['You are a', 'title generator']
    const joined = split.join('\n').toLowerCase()
    expect(joined.includes('you are a title generator')).toBe(false) // split by \n
    expect(shouldSkipBootstrap(split)).toBe(false)
  })

  test('does not skip for unrelated prompts', () => {
    expect(
      shouldSkipBootstrap([
        'You are a helpful assistant doing domain work.',
        'Rules: follow the plan, write tests, stay scoped.',
      ]),
    ).toBe(false)
    expect(shouldSkipBootstrap([])).toBe(false)
    expect(shouldSkipBootstrap([''])).toBe(false)
  })

  test('FRAGILITY: a legitimate prompt containing a signature substring triggers skip', () => {
    // FRAGILITY: the skip heuristic uses substring matching on the joined
    // system prompt. A legitimate prompt that happens to contain a signature
    // phrase ("You are a title generator") will incorrectly skip bootstrap
    // injection. Documented as acceptable in docs/brainstorms/
    // 2026-04-18-infra-improvements-requirements.md (trade-off: refactoring to
    // a frontmatter-based opt-out is a separate design decision, deferred).
    //
    // If a future refactor moves to an explicit opt-out (e.g., frontmatter
    // flag or first-line marker), this test must be updated intentionally:
    // the legitimate prompt below should no longer trigger the skip.
    const legitimate = [
      'You are an agent building a UI for a CMS.',
      'Users can configure pages. You are a title generator panel designer.',
      'Generate layout recommendations.',
    ]
    expect(shouldSkipBootstrap(legitimate)).toBe(true)
  })
})

describe('computeBootstrapContentSafe', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-bootstrap-safe-'),
    )
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function makeBundledSkillsDir(usingSystematicBody?: string): string {
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(bundledSkillsDir, { recursive: true })
    if (usingSystematicBody !== undefined) {
      fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'))
      fs.writeFileSync(
        path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'),
        usingSystematicBody,
      )
    }
    return bundledSkillsDir
  }

  it('returns bootstrap content string for a valid bundled skills dir', () => {
    const bundledSkillsDir = makeBundledSkillsDir(
      '---\nname: using-systematic\n---\nBody content.',
    )
    const content = computeBootstrapContentSafe({ bundledSkillsDir })
    expect(content).not.toBeNull()
    expect(content).toContain('<SYSTEMATIC_WORKFLOWS>')
    expect(content).toContain('Body content.')
  })

  it('returns null (not throws) when using-systematic/SKILL.md is missing', () => {
    const bundledSkillsDir = makeBundledSkillsDir() // no SKILL.md
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir }),
    ).not.toThrow()
    expect(computeBootstrapContentSafe({ bundledSkillsDir })).toBeNull()
  })

  it('returns null (not throws) when bundledSkillsDir itself does not exist', () => {
    const missingDir = path.join(testDir, 'does-not-exist')
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir: missingDir }),
    ).not.toThrow()
    expect(
      computeBootstrapContentSafe({ bundledSkillsDir: missingDir }),
    ).toBeNull()
  })

  it('returns null (not throws) for a malformed/unreadable using-systematic SKILL.md fixture', () => {
    // Real temp-dir fixture: create using-systematic as a directory named
    // SKILL.md instead of a file, so fs.readFileSync throws EISDIR.
    const bundledSkillsDir = path.join(testDir, 'skills')
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'), {
      recursive: true,
    })
    expect(() =>
      computeBootstrapContentSafe({ bundledSkillsDir }),
    ).not.toThrow()
    expect(computeBootstrapContentSafe({ bundledSkillsDir })).toBeNull()
  })

  it('reports failures once and still returns null when the reporter throws', () => {
    const bundledSkillsDir = makeBundledSkillsDir()
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(bundledSkillsDir, 'using-systematic', 'SKILL.md'), {
      recursive: true,
    })

    let reportCalls = 0

    const result = computeBootstrapContentSafe({ bundledSkillsDir }, () => {
      reportCalls++
      throw new Error('reporter failure')
    })

    expect(reportCalls).toBe(1)
    expect(result).toBeNull()
  })
})

describe('composeSystemPromptWithBootstrap', () => {
  it('preserves earlier extension marker bytes exactly when appending the Systematic snapshot', () => {
    const existing =
      'You are a primary agent. Earlier extension contribution: <SYSTEMATIC_WORKFLOWS>example</SYSTEMATIC_WORKFLOWS>'
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'

    const result = composeSystemPromptWithBootstrap(existing, bootstrap)

    expect(result).not.toBeNull()
    expect(result).toBe(`${existing}\n\n${bootstrap}`)
  })

  it('returns the existing prompt unchanged when it already ends with the same snapshot', () => {
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'
    const existing = `Earlier.\n\n${bootstrap}`

    const result = composeSystemPromptWithBootstrap(existing, bootstrap)

    expect(result).toBe(existing)
  })

  it('handles an empty existing prompt by using bootstrap content alone', () => {
    const bootstrap = '<SYSTEMATIC_WORKFLOWS>\nContent\n</SYSTEMATIC_WORKFLOWS>'
    const result = composeSystemPromptWithBootstrap('', bootstrap)
    expect(result).toBe(bootstrap)
  })

  it('returns the existing prompt unchanged when bootstrap content is null', () => {
    const existing = 'You are a primary agent. Earlier extension contribution.'
    const result = composeSystemPromptWithBootstrap(existing, null)
    expect(result).toBeNull()
  })
})
