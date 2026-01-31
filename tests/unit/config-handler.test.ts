import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '@opencode-ai/sdk'
import { createConfigHandler } from '../../src/lib/config-handler.ts'
import {
  formatSkillCommandName,
  formatSkillDescription,
  wrapSkillTemplate,
} from '../../src/lib/skill-loader.ts'

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

  function createAgent(dir: string, name: string, description: string): void {
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---
name: ${name}
description: ${description}
---
# ${name}

Agent prompt for ${name}.`,
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
  })
})

describe('formatSkillCommandName', () => {
  test('adds systematic: prefix to plain name', () => {
    expect(formatSkillCommandName('brainstorming')).toBe(
      'systematic:brainstorming',
    )
  })

  test('does not double-prefix already prefixed name', () => {
    expect(formatSkillCommandName('systematic:brainstorming')).toBe(
      'systematic:brainstorming',
    )
  })

  test('handles empty string', () => {
    expect(formatSkillCommandName('')).toBe('systematic:')
  })
})

describe('formatSkillDescription', () => {
  test('adds (systematic - Skill) prefix to description', () => {
    expect(formatSkillDescription('A test skill', 'test')).toBe(
      '(systematic - Skill) A test skill',
    )
  })

  test('does not double-prefix already prefixed description', () => {
    expect(
      formatSkillDescription('(systematic - Skill) A test skill', 'test'),
    ).toBe('(systematic - Skill) A test skill')
  })

  test('uses fallback name when description is empty', () => {
    expect(formatSkillDescription('', 'my-skill')).toBe(
      '(systematic - Skill) my-skill skill',
    )
  })
})

describe('wrapSkillTemplate', () => {
  test('wraps content in skill-instruction tags', () => {
    const result = wrapSkillTemplate('/path/to/skill/SKILL.md', '# Skill Body')
    expect(result).toContain('<skill-instruction>')
    expect(result).toContain('</skill-instruction>')
    expect(result).toContain('# Skill Body')
  })

  test('includes base directory from skill path', () => {
    const result = wrapSkillTemplate(
      '/bundled/skills/brainstorming/SKILL.md',
      '# Content',
    )
    expect(result).toContain(
      'Base directory for this skill: /bundled/skills/brainstorming/',
    )
  })

  test('includes file reference note', () => {
    const result = wrapSkillTemplate('/path/to/skill/SKILL.md', '# Content')
    expect(result).toContain(
      'File references (@path) in this skill are relative to this directory',
    )
  })

  test('trims body content', () => {
    const result = wrapSkillTemplate(
      '/path/to/skill/SKILL.md',
      '  \n# Skill Body\n  ',
    )
    expect(result).toContain('# Skill Body')
    expect(result).not.toMatch(/\n\s+\n<\/skill-instruction>/)
  })
})
