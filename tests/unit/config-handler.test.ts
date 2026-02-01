import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import { createConfigHandler } from '../../src/lib/config-handler.ts'
import { formatFrontmatter } from '../../src/lib/frontmatter.ts'

describe('config-handler', () => {
  let testDir: string
  let bundledDir: string
  let projectDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-config-test-'))
    bundledDir = path.join(testDir, 'bundled')
    projectDir = path.join(testDir, 'project')

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
      expect(config.agent?.['test-agent']?.description).toBe('A test agent')
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
      expect(config.command?.['test-command']).toBeDefined()
      expect(config.command?.['test-command']?.description).toBe(
        'A test command',
      )
      expect(config.command?.['test-command']?.template).toContain(
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
        '(systematic - Skill) A test skill',
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

    test('includes maxSteps field in agent config', async () => {
      createAgent(path.join(bundledDir, 'agents'), 'stepping', {
        name: 'stepping',
        description: 'Agent with maxSteps',
        maxSteps: 10,
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.stepping?.maxSteps).toBe(10)
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
        maxSteps: 10,
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
      expect(agent?.description).toBe('A full agent')
      expect(agent?.model).toBe('openai/gpt-4')
      expect(agent?.temperature).toBe(0.7)
      expect(agent?.top_p).toBe(1)
      expect(agent?.maxSteps).toBe(10)
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

      expect(config.command?.routed?.agent).toBe('oracle')
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

      expect(config.command?.modeled?.model).toBe('openai/gpt-4')
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

      expect(config.command?.subtasked?.subtask).toBe(true)
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

      const command = config.command?.['full-command']
      expect(command).toBeDefined()
      expect(command?.description).toBe('A full command')
      expect(command?.agent).toBe('oracle')
      expect(command?.model).toBe('openai/gpt-4')
      expect(command?.subtask).toBe(true)
      expect(command?.template).toContain('Full command template')
    })
  })
})
