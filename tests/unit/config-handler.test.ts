import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import {
  createConfigHandler,
  formatAgentDescription,
  toTitleCase,
} from '../../src/lib/config-handler.js'
import { formatFrontmatter } from '../../src/lib/frontmatter.js'

describe('config-handler', () => {
  let testDir: string
  let bundledDir: string
  let projectDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-config-test-'))
    bundledDir = path.join(testDir, 'bundled')
    projectDir = path.join(testDir, 'project')
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')

    fs.mkdirSync(path.join(bundledDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(bundledDir, 'agents'), { recursive: true })
    fs.mkdirSync(path.join(bundledDir, 'commands'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, '.opencode/systematic/skills'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(projectDir, '.opencode/systematic/agents'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(projectDir, '.opencode/systematic/commands'), {
      recursive: true,
    })
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    delete process.env.OPENCODE_CONFIG_DIR
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function createSkill(dir: string, name: string, description: string): void {
    const skillDir = path.join(dir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: ${description}
---
# ${name}

Skill content for ${name}.`,
    )
  }

  function createAgent(
    dir: string,
    name: string,
    frontmatterOrDescription: string | Record<string, unknown>,
  ): void {
    const frontmatter =
      typeof frontmatterOrDescription === 'string'
        ? { name, description: frontmatterOrDescription }
        : frontmatterOrDescription

    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `${formatFrontmatter(frontmatter)}\n# ${name}\n\nAgent prompt for ${name}.`,
    )
  }

  function createCategorizedAgent(
    category: string,
    name: string,
    frontmatterOrDescription: string | Record<string, unknown>,
  ): void {
    const categoryDir = path.join(bundledDir, 'agents', category)
    fs.mkdirSync(categoryDir, { recursive: true })
    createAgent(categoryDir, name, frontmatterOrDescription)
  }

  function writeSystematicConfig(value: Record<string, unknown>): void {
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, '.opencode/systematic.json'),
      JSON.stringify(value),
    )
  }

  function writeSystematicJsoncConfig(value: string): void {
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.opencode/systematic.jsonc'), value)
  }

  function writeCustomSystematicConfig(value: Record<string, unknown>): void {
    const customDir = path.join(testDir, 'custom-config')
    process.env.OPENCODE_CONFIG_DIR = customDir
    fs.mkdirSync(customDir, { recursive: true })
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      JSON.stringify(value),
    )
  }

  function createCommand(dir: string, name: string, description: string): void {
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---
name: ${name}
description: ${description}
---
# ${name}

Command template for ${name}.`,
    )
  }

  describe('toTitleCase', () => {
    test('converts kebab-case to Title-Case', () => {
      expect(toTitleCase('architecture-strategist')).toBe(
        'Architecture-Strategist',
      )
    })

    test('handles single word', () => {
      expect(toTitleCase('oracle')).toBe('Oracle')
    })

    test('handles empty string', () => {
      expect(toTitleCase('')).toBe('')
    })

    test('handles single-character segments', () => {
      expect(toTitleCase('a-b-c')).toBe('A-B-C')
    })

    test('handles numbers in segments', () => {
      expect(toTitleCase('v2-api-agent')).toBe('V2-Api-Agent')
    })

    test('preserves already-capitalized characters after first', () => {
      expect(toTitleCase('REST-API')).toBe('REST-API')
      expect(toTitleCase('AI-reviewer')).toBe('AI-Reviewer')
    })
  })

  describe('formatAgentDescription', () => {
    test('appends branding suffix with title-cased name', () => {
      expect(
        formatAgentDescription(
          'code-simplicity-reviewer',
          'Reviews code for simplicity',
        ),
      ).toBe(
        'Reviews code for simplicity (Code-Simplicity-Reviewer - Systematic)',
      )
    })

    test('uses fallback when description is undefined', () => {
      expect(formatAgentDescription('test-agent', undefined)).toBe(
        'test-agent agent (Test-Agent - Systematic)',
      )
    })

    test('uses fallback when description is empty', () => {
      expect(formatAgentDescription('test-agent', '')).toBe(
        'test-agent agent (Test-Agent - Systematic)',
      )
    })

    test('does not double-brand if suffix already present', () => {
      const alreadyBranded = 'Some description (Test-Agent - Systematic)'
      expect(formatAgentDescription('test-agent', alreadyBranded)).toBe(
        alreadyBranded,
      )
    })
  })

  describe('createConfigHandler', () => {
    test('returns a function', () => {
      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })
      expect(typeof handler).toBe('function')
    })

    test('collects bundled agents into config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'test-agent', 'A test agent')

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent).toBeDefined()
      expect(config.agent?.['test-agent']).toBeDefined()
      expect(config.agent?.['test-agent']?.description).toBe(
        'A test agent (Test-Agent - Systematic)',
      )
    })

    test('collects bundled commands into config', async () => {
      createCommand(
        path.join(bundledDir, 'commands'),
        'test-command',
        'A test command',
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command).toBeDefined()
      expect(config.command?.['systematic:test-command']).toBeDefined()
      expect(config.command?.['systematic:test-command']?.description).toBe(
        '(Systematic) A test command',
      )
      expect(config.command?.['systematic:test-command']?.template).toContain(
        'Command template for test-command',
      )
    })

    test('collects skills as commands with systematic: prefix', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'test-skill', 'A test skill')

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command).toBeDefined()
      expect(config.command?.['systematic:test-skill']).toBeDefined()
      expect(config.command?.['systematic:test-skill']?.description).toBe(
        '(Systematic - Skill) A test skill',
      )
      expect(config.command?.['systematic:test-skill']?.template).toContain(
        '<skill-instruction>',
      )
      expect(config.command?.['systematic:test-skill']?.template).toContain(
        '</skill-instruction>',
      )
      expect(config.command?.['systematic:test-skill']?.template).toContain(
        'Skill content for test-skill',
      )
    })

    test('registers colon-prefixed skills without systematic: prefix', async () => {
      const skillDir = path.join(bundledDir, 'skills', 'ce-plan')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: ce:plan
description: Plan workflow skill
---
# CE Plan

Skill content for ce:plan.`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['ce:plan']).toBeDefined()
      expect(config.command?.['systematic:ce:plan']).toBeUndefined()
      expect(config.command?.['ce:plan']?.description).toBe(
        '(Systematic - Skill) Plan workflow skill',
      )
    })

    test('preserves existing config entries', async () => {
      createAgent(
        path.join(bundledDir, 'agents'),
        'bundled-agent',
        'Bundled agent',
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'existing-agent': {
            description: 'Already exists',
            prompt: 'Existing prompt',
          },
        },
        command: {
          'existing-command': {
            description: 'Already exists',
            template: 'Existing template',
          },
        },
      }
      await handler(config)

      expect(config.agent?.['existing-agent']).toBeDefined()
      expect(config.agent?.['bundled-agent']).toBeDefined()
      expect(config.command?.['existing-command']).toBeDefined()
    })

    test('existing config overrides bundled content (preserves user config)', async () => {
      createAgent(
        path.join(bundledDir, 'agents'),
        'test-agent',
        'Bundled description',
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'test-agent': { description: 'User override', prompt: 'User prompt' },
        },
      }
      await handler(config)

      expect(config.agent?.['test-agent']?.description).toBe('User override')
    })

    test('includes color field in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'colored', {
        name: 'colored',
        description: 'Agent with color',
        color: '#FF5733',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.colored?.color).toBe('#FF5733')
    })

    test('includes steps field in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'stepping', {
        name: 'stepping',
        description: 'Agent with steps',
        steps: 10,
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.stepping?.steps).toBe(10)
    })

    test('includes tools field in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'tooled', {
        name: 'tooled',
        description: 'Agent with tools',
        tools: { bash: true, read: true },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.tooled?.tools).toEqual({ bash: true, read: true })
    })

    test('includes permission object in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'secure', {
        name: 'secure',
        description: 'Agent with permissions',
        permission: {
          edit: 'ask',
          bash: 'deny',
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.secure?.permission?.edit).toBe('ask')
      expect(config.agent?.secure?.permission?.bash).toBe('deny')
    })

    test('includes disable field in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'disabled-agent', {
        name: 'disabled-agent',
        description: 'Disabled agent',
        disable: true,
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['disabled-agent']?.disable).toBe(true)
    })

    test('extracts all agent frontmatter fields into config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'full-agent', {
        name: 'full-agent',
        description: 'A full agent',
        model: 'gpt-4',
        temperature: 0.7,
        top_p: 1,
        steps: 10,
        color: '#ff0000',
        mode: 'subagent',
        tools: { bash: true, read: false },
        permission: { edit: 'ask' },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      const agent = config.agent?.['full-agent']
      expect(agent).toBeDefined()
      expect(agent?.description).toBe('A full agent (Full-Agent - Systematic)')
      expect(agent?.model).toBe('openai/gpt-4')
      expect(agent?.temperature).toBe(0.3)
      expect(agent?.top_p).toBe(1)
      expect(agent?.steps).toBe(10)
      expect(agent?.color).toBe('#ff0000')
      expect(agent?.mode).toBe('subagent')
      expect(agent?.tools).toEqual({ bash: true, read: false })
      expect(agent?.permission).toEqual({ edit: 'ask' })
    })

    test('includes agent field in command config', async () => {
      fs.writeFileSync(
        path.join(bundledDir, 'commands', 'routed.md'),
        `---
name: routed
description: Command with agent
agent: oracle
---
Use oracle for this task.`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:routed']?.agent).toBe('oracle')
    })

    test('includes model field in command config', async () => {
      fs.writeFileSync(
        path.join(bundledDir, 'commands', 'modeled.md'),
        `---
name: modeled
description: Command with model
model: gpt-4
---
Use gpt-4 for this task.`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:modeled']?.model).toBe('openai/gpt-4')
    })

    test('includes subtask field in command config', async () => {
      fs.writeFileSync(
        path.join(bundledDir, 'commands', 'subtasked.md'),
        `---
name: subtasked
description: Command as subtask
subtask: true
---
Run as subtask.`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:subtasked']?.subtask).toBe(true)
    })

    test('extracts all command frontmatter fields into config', async () => {
      fs.writeFileSync(
        path.join(bundledDir, 'commands', 'full-command.md'),
        `---
name: full-command
description: A full command
agent: oracle
model: gpt-4
subtask: true
---
Full command template.`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      const command = config.command?.['systematic:full-command']
      expect(command).toBeDefined()
      expect(command?.description).toBe('(Systematic) A full command')
      expect(command?.agent).toBe('oracle')
      expect(command?.model).toBe('openai/gpt-4')
      expect(command?.subtask).toBe(true)
      expect(command?.template).toContain('Full command template')
    })

    test('skills with userInvocable: false are not loaded as commands', async () => {
      const skillDir = path.join(bundledDir, 'skills', 'hidden-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: hidden-skill
description: A hidden skill
user-invocable: false
---
# Hidden Skill Content`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:hidden-skill']).toBeUndefined()
    })

    test('skills include subtask field in command config', async () => {
      const skillDir = path.join(bundledDir, 'skills', 'forked-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: forked-skill
description: A forked skill
context: fork
---
# Forked Skill Content`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:forked-skill']?.subtask).toBe(true)
    })

    test('skills include agent and model fields in command config', async () => {
      const skillDir = path.join(bundledDir, 'skills', 'routed-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: routed-skill
description: A routed skill
agent: oracle
model: gpt-4
---
# Routed Skill Content`,
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.command?.['systematic:routed-skill']?.agent).toBe('oracle')
      expect(config.command?.['systematic:routed-skill']?.model).toBe('gpt-4')
    })

    test('applies built-in temperature and source model defaults for categorized agents', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.1)
      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
    })

    test('uncategorized bundled agent receives no source model default', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'uncategorized', {
        name: 'uncategorized',
        description: 'No category agent',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.uncategorized?.temperature).toBeDefined()
      expect(config.agent?.uncategorized?.model).toBeUndefined()
    })

    test('zero config emits source model defaults for all categorized agents', async () => {
      createCategorizedAgent('design', 'design-agent', {
        name: 'design-agent',
        description: 'Design agent',
      })
      createCategorizedAgent('docs', 'docs-agent', {
        name: 'docs-agent',
        description: 'Docs agent',
      })
      createCategorizedAgent('document-review', 'doc-review-agent', {
        name: 'doc-review-agent',
        description: 'Document review agent',
      })
      createCategorizedAgent('research', 'research-agent', {
        name: 'research-agent',
        description: 'Research agent',
      })
      createCategorizedAgent('review', 'review-agent', {
        name: 'review-agent',
        description: 'Review agent',
      })
      createCategorizedAgent('workflow', 'workflow-agent', {
        name: 'workflow-agent',
        description: 'Workflow agent',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['design-agent']?.model).toBe('openai/gpt-5.5')
      expect(config.agent?.['docs-agent']?.model).toBe('openai/gpt-5.4-mini')
      expect(config.agent?.['doc-review-agent']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
      expect(config.agent?.['research-agent']?.model).toBe('openai/gpt-5.5')
      expect(config.agent?.['review-agent']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
      expect(config.agent?.['workflow-agent']?.model).toBe(
        'openai/gpt-5.4-mini',
      )

      // No fallback_models key leaks into any emitted agent
      for (const [, agent] of Object.entries(config.agent ?? {})) {
        expect(agent).not.toHaveProperty('fallback_models')
      }
    })

    test('source defaults replace bundled markdown model for categorized agents', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
        model: 'openai/gpt-3.5-turbo',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // Source default wins over bundled markdown model
      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
    })

    test('source defaults do not emit for uncategorized agents even with markdown model', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'standalone', {
        name: 'standalone',
        description: 'No category agent',
        model: 'openai/gpt-4',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // Uncategorized agents keep their markdown model since no source default applies
      expect(config.agent?.standalone?.model).toBe('openai/gpt-4')
    })

    test('project config overlay with non-sensitive fields preserves source model', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeSystematicConfig({
        categories: { review: { temperature: 0.55 } },
        agents: { 'correctness-reviewer': { hidden: true } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // Source model preserved even when project config sets non-sensitive fields
      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.55)
      expect(config.agent?.['correctness-reviewer']?.hidden).toBe(true)
    })

    test('high-trust exact model: null opt-out removes source default', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: {
          'correctness-reviewer': { model: null },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // model: null removes source default — agent inherits parent model
      expect(config.agent?.['correctness-reviewer']?.model).toBeUndefined()
    })

    test('high-trust category model: null opt-out removes source default for category members', async () => {
      createCategorizedAgent('review', 'first-reviewer', {
        name: 'first-reviewer',
        description: 'First reviewer',
      })
      createCategorizedAgent('review', 'second-reviewer', {
        name: 'second-reviewer',
        description: 'Second reviewer',
      })
      writeCustomSystematicConfig({
        categories: {
          review: { model: null },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['first-reviewer']?.model).toBeUndefined()
      expect(config.agent?.['second-reviewer']?.model).toBeUndefined()
    })

    test('exact model string overrides category model: null opt-out', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        categories: { review: { model: null } },
        agents: {
          'correctness-reviewer': {
            model: 'openrouter/anthropic/claude-sonnet-4',
          },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // Exact overlay string model beats category null opt-out
      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'openrouter/anthropic/claude-sonnet-4',
      )
    })

    test('high-trust exact model overrides source default', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: {
          'correctness-reviewer': {
            model: 'openrouter/anthropic/claude-sonnet-4',
          },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'openrouter/anthropic/claude-sonnet-4',
      )
    })

    test('high-trust category model overrides source defaults for every agent in that category', async () => {
      createCategorizedAgent('review', 'first-reviewer', {
        name: 'first-reviewer',
        description: 'First reviewer',
      })
      createCategorizedAgent('review', 'second-reviewer', {
        name: 'second-reviewer',
        description: 'Second reviewer',
      })
      writeCustomSystematicConfig({
        categories: {
          review: { model: 'openai/gpt-4o' },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['first-reviewer']?.model).toBe('openai/gpt-4o')
      expect(config.agent?.['second-reviewer']?.model).toBe('openai/gpt-4o')
    })

    test('category overlay with non-model fields preserves source model', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        categories: {
          review: { temperature: 0.55 },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.55)
    })

    test('native same-name replacement receives no Systematic source model default', async () => {
      createCategorizedAgent('review', 'native-replaced', {
        name: 'native-replaced',
        description: 'Bundled description',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'native-replaced': {
            description: 'Native owns this key',
            prompt: 'Native prompt',
          },
        },
      }
      await handler(config)

      expect(config.agent?.['native-replaced']?.model).toBeUndefined()
      expect(config.agent?.['native-replaced']?.description).toBe(
        'Native owns this key',
      )
    })

    test('built-in temperature overrides bundled markdown unless category or exact overlay is stronger', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
        temperature: 0.9,
      })
      createCategorizedAgent('review', 'security-reviewer', {
        name: 'security-reviewer',
        description: 'Security reviewer',
        temperature: 0.9,
      })
      writeSystematicConfig({
        categories: { review: { temperature: 0.25 } },
        agents: { 'correctness-reviewer': { temperature: 0.05 } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.05)
      expect(config.agent?.['security-reviewer']?.temperature).toBe(0.25)
    })

    test('emits exact configured model and supported overlay fields including variant', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      createCategorizedAgent('review', 'other-reviewer', {
        name: 'other-reviewer',
        description: 'Other reviewer',
      })
      writeCustomSystematicConfig({
        agents: {
          'correctness-reviewer': {
            model: 'openrouter/anthropic/claude-sonnet-4',
            variant: 'large-context',
            top_p: 0.8,
            mode: 'subagent',
            color: '#123abc',
            steps: 12,
            hidden: true,
          },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      const agent = config.agent?.['correctness-reviewer']
      expect(agent?.model).toBe('openrouter/anthropic/claude-sonnet-4')
      expect(agent?.variant).toBe('large-context')
      expect(agent?.top_p).toBe(0.8)
      expect(agent?.mode).toBe('subagent')
      expect(agent?.color).toBe('#123abc')
      expect(agent?.steps).toBe(12)
      expect(agent?.hidden).toBe(true)
      // other-reviewer (review category) gets source model default
      expect(config.agent?.['other-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
    })

    test('accepts and emits variant without model', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: { 'correctness-reviewer': { variant: 'small' } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.variant).toBe('small')
      // review-category agent still gets source model default even when variant is set via high-trust config
      expect(config.agent?.['correctness-reviewer']?.model).toBe(
        'anthropic/claude-opus-4.7',
      )
    })

    test('managed skills shortcut emits ordered deny-all then allow-selected rules', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'ce:review', 'Review skill')
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: { 'correctness-reviewer': { skills: ['ce:review'] } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.permission?.skill).toEqual(
        {
          '*': 'deny',
          'ce:review': 'allow',
        },
      )
    })

    describe('auth-aware source model resolution', () => {
      test('no auth.json emits array[0] for review category', async () => {
        createCategorizedAgent('review', 'correctness-reviewer', {
          name: 'correctness-reviewer',
          description: 'Reviews correctness',
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)

        expect(config.agent?.['correctness-reviewer']?.model).toBe(
          'anthropic/claude-opus-4.7',
        )
      })

      test('openai auth selects openai/gpt-5.5 for review category', async () => {
        createCategorizedAgent('review', 'correctness-reviewer', {
          name: 'correctness-reviewer',
          description: 'Reviews correctness',
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
          getAuthenticatedProviders: () => new Set(['openai']),
        })

        const config: Config = {}
        await handler(config)

        expect(config.agent?.['correctness-reviewer']?.model).toBe(
          'openai/gpt-5.5',
        )
      })

      test('first-match wins with multiple providers', async () => {
        createCategorizedAgent('review', 'correctness-reviewer', {
          name: 'correctness-reviewer',
          description: 'Reviews correctness',
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
          getAuthenticatedProviders: () =>
            new Set(['github-copilot', 'anthropic']),
        })

        const config: Config = {}
        await handler(config)

        // anthropic is first matching provider in review array
        expect(config.agent?.['correctness-reviewer']?.model).toBe(
          'anthropic/claude-opus-4.7',
        )
      })

      test('user category model override still wins with auth', async () => {
        createCategorizedAgent('review', 'correctness-reviewer', {
          name: 'correctness-reviewer',
          description: 'Reviews correctness',
        })
        writeCustomSystematicConfig({
          categories: { review: { model: 'openai/gpt-4o' } },
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
          getAuthenticatedProviders: () => new Set(['openai']),
        })

        const config: Config = {}
        await handler(config)

        expect(config.agent?.['correctness-reviewer']?.model).toBe(
          'openai/gpt-4o',
        )
      })

      test('user exact model override wins over auth-aware resolution', async () => {
        createCategorizedAgent('review', 'correctness-reviewer', {
          name: 'correctness-reviewer',
          description: 'Reviews correctness',
        })
        writeCustomSystematicConfig({
          agents: {
            'correctness-reviewer': {
              model: 'openrouter/anthropic/claude-sonnet-4',
            },
          },
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
          getAuthenticatedProviders: () => new Set(['openai']),
        })

        const config: Config = {}
        await handler(config)

        expect(config.agent?.['correctness-reviewer']?.model).toBe(
          'openrouter/anthropic/claude-sonnet-4',
        )
      })

      test('getAuthenticatedProviders invoked exactly once per config', async () => {
        let callCount = 0
        const spyGetAuthProviders = () => {
          callCount++
          return new Set<string>()
        }

        createCategorizedAgent('review', 'agent-one', {
          name: 'agent-one',
          description: 'First agent',
        })
        createCategorizedAgent('review', 'agent-two', {
          name: 'agent-two',
          description: 'Second agent',
        })
        createCategorizedAgent('design', 'agent-three', {
          name: 'agent-three',
          description: 'Third agent',
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
          getAuthenticatedProviders: spyGetAuthProviders,
        })

        const config: Config = {}
        await handler(config)

        expect(callCount).toBe(1)
      })
    })

    test('managed empty skills emits deny-all and omitted skills inherit weaker behavior', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'ce:review', 'Review skill')
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      createCategorizedAgent('review', 'security-reviewer', {
        name: 'security-reviewer',
        description: 'Security reviewer',
      })
      writeCustomSystematicConfig({
        categories: { review: { skills: ['ce:review'] } },
        agents: { 'correctness-reviewer': { skills: [] } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.permission?.skill).toEqual(
        {
          'ce:review': 'allow',
          '*': 'deny',
        },
      )
      expect(config.agent?.['security-reviewer']?.permission?.skill).toEqual({
        '*': 'deny',
        'ce:review': 'allow',
      })
    })

    test('permission rules concatenate weakest to strongest so exact skills override category skills', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'skill-a', 'Skill A')
      createSkill(path.join(bundledDir, 'skills'), 'skill-b', 'Skill B')
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        categories: {
          review: { skills: ['skill-a', 'skill-b'] },
        },
        agents: { 'correctness-reviewer': { skills: ['skill-a'] } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.permission?.skill).toEqual(
        {
          'skill-b': 'allow',
          '*': 'deny',
          'skill-a': 'allow',
        },
      )
    })

    test('exact permission.skill can override category skills and exact skills can override category permission.skill', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'skill-a', 'Skill A')
      createCategorizedAgent('review', 'explicit-exact', {
        name: 'explicit-exact',
        description: 'Explicit exact',
      })
      createCategorizedAgent('review', 'managed-exact', {
        name: 'managed-exact',
        description: 'Managed exact',
      })
      writeCustomSystematicConfig({
        categories: {
          review: {
            skills: ['skill-a'],
            permission: { bash: 'deny' },
          },
        },
        agents: {
          'explicit-exact': {
            permission: { skill: { 'skill-a': 'deny' } },
          },
          'managed-exact': { skills: ['skill-a'] },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['explicit-exact']?.permission?.skill).toEqual({
        '*': 'deny',
        'skill-a': 'deny',
      })
      expect(config.agent?.['explicit-exact']?.permission?.bash).toEqual({
        '*': 'deny',
      })
      expect(config.agent?.['managed-exact']?.permission?.skill).toEqual({
        '*': 'deny',
        'skill-a': 'allow',
      })
    })

    test('exact managed skills override category permission.skill denial through last-match order', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'skill-a', 'Skill A')
      createCategorizedAgent('review', 'managed-exact', {
        name: 'managed-exact',
        description: 'Managed exact',
      })
      writeCustomSystematicConfig({
        categories: {
          review: {
            permission: { skill: { 'skill-a': 'deny' } },
          },
        },
        agents: {
          'managed-exact': { skills: ['skill-a'] },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['managed-exact']?.permission?.skill).toEqual({
        '*': 'deny',
        'skill-a': 'allow',
      })
    })

    test('category overlay skips native replacement and applies to other bundled agents', async () => {
      createCategorizedAgent('review', 'native-replacement', {
        name: 'native-replacement',
        description: 'Native replacement',
      })
      createCategorizedAgent('review', 'other-reviewer', {
        name: 'other-reviewer',
        description: 'Other reviewer',
      })
      writeSystematicConfig({ categories: { review: { temperature: 0.22 } } })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'native-replacement': { description: 'Native', prompt: 'Native' },
        },
      }
      await handler(config)

      expect(config.agent?.['native-replacement']?.description).toBe('Native')
      expect(config.agent?.['other-reviewer']?.temperature).toBe(0.22)
    })

    test('disabled exact overlay has no emitted config', async () => {
      createCategorizedAgent('workflow', 'helper', {
        name: 'helper',
        description: 'Helper',
      })
      writeSystematicConfig({ agents: { helper: { disable: true } } })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.helper).toBeUndefined()
    })

    test('assertSourceCategoryModelCoverage fires on missing category', async () => {
      // Create a categorized agent in a category not covered by source defaults
      // The existing bundled agents dir has 6 covered categories (design, docs,
      // document-review, research, review, workflow). An uncovered category would
      // cause a throw inside createConfigHandler, but we can't create an actual
      // uncovered directory in bundled agents. Instead, test that when the
      // assertion is called with an uncovered category, it fails.
      const { assertSourceCategoryModelCoverage: assertCoverage } =
        await import('../../src/lib/agent-overlays.js')

      expect(() => assertCoverage(['review', 'unknown-category'])).toThrow(
        /Source category model defaults missing intentional coverage for/,
      )
      expect(() => assertCoverage(['review', 'unknown-category'])).toThrow(
        /unknown-category/,
      )
    })

    test('invalid overlay leaves config surfaces unmodified', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: { 'correctness-reviewer': { skills: ['missing-skill'] } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config = {
        agent: { native: { description: 'Native', prompt: 'Native' } },
        command: { native: { description: 'Native', template: 'Native' } },
        skills: { paths: ['/existing/skills'] },
        mcp: { local: { type: 'local', command: ['echo'] } },
      } as unknown as Config
      const before = structuredClone(config)

      await expect(handler(config)).rejects.toThrow(/missing-skill/)

      expect(config).toEqual(before)
    })

    test('loads project config from systematic.jsonc with comments', async () => {
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeSystematicJsoncConfig(
        '{\n  // JSONC config with comment\n  "categories": {\n    "review": { "temperature": 0.33 }\n  }\n}\n',
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.33)
    })

    test('malformed systematic.json surfaces schema validation error from config loader', async () => {
      writeSystematicConfig({ disabled_skills: 'not-an-array' })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      const expectedConfigPath = path.join(
        projectDir,
        '.opencode/systematic.json',
      )
      await expect(handler(config)).rejects.toThrow(expectedConfigPath)
      await expect(handler(config)).rejects.toThrow('disabled_skills')
    })
  })
})
