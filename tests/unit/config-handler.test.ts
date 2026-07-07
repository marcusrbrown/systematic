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

    test('later Systematic hook overwrites earlier Systematic output while preserving native config', async () => {
      fs.mkdirSync(path.join(bundledDir, 'agents', 'workflow'), {
        recursive: true,
      })
      createAgent(
        path.join(bundledDir, 'agents', 'workflow'),
        'systematic-implementer',
        'Bundled systematic implementer',
      )

      createSkill(path.join(bundledDir, 'skills'), 'test-skill', 'A test skill')
      createSkill(
        path.join(bundledDir, 'skills'),
        'ce:review',
        'A review skill',
      )
      createCommand(
        path.join(bundledDir, 'commands'),
        'test-command',
        'A test command',
      )

      writeCustomSystematicConfig({
        agents: {
          'systematic-implementer': {
            temperature: 0.25,
          },
        },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'systematic-implementer': {
            description:
              'Global Systematic output (Systematic-Implementer - Systematic)',
            prompt: 'global prompt',
          },
          'native-agent': {
            description: 'Native agent',
            prompt: 'native prompt',
          },
        },
        command: {
          'systematic:test-command': {
            description: '(Systematic) Previous command output',
            template: 'previous command template',
          },
          'native-command': {
            description: 'Native command',
            template: 'native command template',
          },
        },
      }

      await handler(config)

      expect(config.agent?.['systematic-implementer']?.description).toContain(
        '(Systematic-Implementer - Systematic)',
      )
      expect(config.agent?.['systematic-implementer']?.prompt).toContain(
        'Agent prompt for systematic-implementer.',
      )
      expect(config.agent?.['systematic-implementer']?.temperature).toBe(0.25)
      expect(config.agent?.['native-agent']).toEqual({
        description: 'Native agent',
        prompt: 'native prompt',
      })

      expect(config.command?.['systematic:test-command']?.description).toBe(
        '(Systematic) A test command',
      )
      expect(config.command?.['systematic:test-command']?.template).toContain(
        'Command template for test-command',
      )
      expect(config.command?.['native-command']).toEqual({
        description: 'Native command',
        template: 'native command template',
      })
      expect(config.command?.['systematic:test-skill']?.description).toBe(
        '(Systematic - Skill) A test skill',
      )
    })

    test('preserves native entries with Systematic-looking descriptions while replacing emitted Systematic output', async () => {
      fs.mkdirSync(path.join(bundledDir, 'agents', 'workflow'), {
        recursive: true,
      })
      createAgent(
        path.join(bundledDir, 'agents', 'workflow'),
        'systematic-implementer',
        'Bundled systematic implementer',
      )

      createSkill(path.join(bundledDir, 'skills'), 'test-skill', 'A test skill')
      fs.mkdirSync(path.join(bundledDir, 'skills', 'ce-plan'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(bundledDir, 'skills', 'ce-plan', 'SKILL.md'),
        `---
name: ce:plan
description: A plan skill
---
# ce-plan

Skill content for ce:plan.`,
      )
      createCommand(
        path.join(bundledDir, 'commands'),
        'test-command',
        'A test command',
      )

      writeCustomSystematicConfig({
        agents: {},
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {
        agent: {
          'native-agent': {
            description: 'Native agent (Native-Agent - Systematic)',
            prompt: 'native prompt',
          },
          'systematic-implementer': {
            description:
              'Old Systematic output (Systematic-Implementer - Systematic)',
            prompt: 'old systematic prompt',
          },
        },
        command: {
          'native-command': {
            description: '(Systematic) Native command',
            template: 'native command template',
          },
          'ce:plan': {
            description: '(Systematic - Skill) Old plan command',
            template: 'old plan template',
          },
          'systematic:legacy-command': {
            description: '(Systematic) Old command',
            template: 'old command template',
          },
          'systematic:legacy-skill': {
            description: '(Systematic - Skill) Old skill command',
            template: 'old skill template',
          },
          'systematic:test-command': {
            description: '(Systematic) Old command',
            template: 'old command template',
          },
          'systematic:test-skill': {
            description: '(Systematic - Skill) Old skill command',
            template: 'old skill template',
          },
        },
      }

      await handler(config)

      expect(config.agent?.['native-agent']).toEqual({
        description: 'Native agent (Native-Agent - Systematic)',
        prompt: 'native prompt',
      })
      expect(config.agent?.['systematic-implementer']?.description).toContain(
        '(Systematic-Implementer - Systematic)',
      )
      expect(config.agent?.['systematic-implementer']?.prompt).toContain(
        'Agent prompt for systematic-implementer.',
      )
      expect(config.command?.['native-command']).toEqual({
        description: '(Systematic) Native command',
        template: 'native command template',
      })
      expect(config.command?.['ce:plan']?.description).toBe(
        '(Systematic - Skill) A plan skill',
      )
      expect(config.command?.['ce:plan']?.template).toContain(
        'Skill content for ce:plan',
      )
      expect(config.command?.['systematic:legacy-command']).toBeUndefined()
      expect(config.command?.['systematic:legacy-skill']).toBeUndefined()
      expect(config.command?.['systematic:test-command']?.description).toBe(
        '(Systematic) A test command',
      )
      expect(config.command?.['systematic:test-command']?.template).toContain(
        'Command template for test-command',
      )
      expect(config.command?.['systematic:test-skill']?.description).toBe(
        '(Systematic - Skill) A test skill',
      )
    })

    test('preserves native command collisions over emitted Systematic command keys', async () => {
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

      const nativeCommand = {
        description: 'Native command override',
        template: 'native template',
      }
      const config: Config = {
        command: {
          'systematic:test-command': nativeCommand,
        },
      }

      await handler(config)

      expect(config.command?.['systematic:test-command']).toBe(nativeCommand)
    })

    test('preserves native agent collisions over emitted Systematic agent keys', async () => {
      fs.mkdirSync(path.join(bundledDir, 'agents', 'workflow'), {
        recursive: true,
      })
      createAgent(
        path.join(bundledDir, 'agents', 'workflow'),
        'systematic-implementer',
        'Bundled systematic implementer',
      )

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const nativeAgent = {
        description: 'Native agent override',
        prompt: 'native prompt',
      }
      const config: Config = {
        agent: {
          'systematic-implementer': nativeAgent,
        },
      }

      await handler(config)

      expect(config.agent?.['systematic-implementer']).toBe(nativeAgent)
    })

    test('replaces prior Systematic skill paths and keeps unrelated paths containing the same segment', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'test-skill', 'A test skill')

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config = {
        skills: {
          paths: [
            '/Users/me/.config/opencode/systematic/skills',
            '/Users/me/.cache/opencode/packages/@fro.bot/systematic@2.14.1/node_modules/@fro.bot/systematic/skills',
            '/Users/me/projects/systematic/skills/custom',
            '/Users/me/.local/share/opencode/skills',
          ],
        },
      } as Config & { skills?: { paths?: string[] } }

      await handler(config)

      expect(config.skills?.paths).toEqual([
        '/Users/me/projects/systematic/skills/custom',
        '/Users/me/.local/share/opencode/skills',
        path.join(bundledDir, 'skills'),
      ])
    })

    test('keeps a prior Systematic-emitted agent when the same key is disabled (no replacement emitted)', async () => {
      // When the bundled agent is in `disabled_agents`, the local hook does
      // NOT emit a replacement key. The drop predicate must return false so
      // the prior Systematic-emitted entry survives — replacing it with
      // nothing would leave the user with neither the previous output nor a
      // current one. Asserts the explicit `bundledAgentKeys` guard short-
      // circuits before `isSystematicAgentConfig` decides to drop.
      createAgent(
        path.join(bundledDir, 'agents'),
        'adversarial-reviewer',
        'Bundled adversarial-reviewer',
      )
      writeSystematicConfig({ disabled_agents: ['adversarial-reviewer'] })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const priorEmitted = {
        description: 'Prior emission (Disabled-Tool - Systematic)',
        prompt: 'prior prompt',
      }
      const config: Config = {
        agent: {
          'adversarial-reviewer': priorEmitted,
        },
      }

      await handler(config)

      expect(config.agent?.['adversarial-reviewer']).toBe(priorEmitted)
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
      expect(agent?.temperature).toBe(0.7)
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
      createCategorizedAgent('review', 'security-reviewer', {
        name: 'security-reviewer',
        description: 'Explicit exact',
      })
      createCategorizedAgent('review', 'performance-reviewer', {
        name: 'performance-reviewer',
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
          'security-reviewer': {
            permission: { skill: { 'skill-a': 'deny' } },
          },
          'performance-reviewer': { skills: ['skill-a'] },
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

      expect(config.agent?.['security-reviewer']?.permission?.skill).toEqual({
        '*': 'deny',
        'skill-a': 'deny',
      })
      expect(config.agent?.['security-reviewer']?.permission?.bash).toEqual({
        '*': 'deny',
      })
      expect(config.agent?.['performance-reviewer']?.permission?.skill).toEqual(
        {
          '*': 'deny',
          'skill-a': 'allow',
        },
      )
    })

    test('exact managed skills override category permission.skill denial through last-match order', async () => {
      createSkill(path.join(bundledDir, 'skills'), 'skill-a', 'Skill A')
      createCategorizedAgent('review', 'performance-reviewer', {
        name: 'performance-reviewer',
        description: 'Managed exact',
      })
      writeCustomSystematicConfig({
        categories: {
          review: {
            permission: { skill: { 'skill-a': 'deny' } },
          },
        },
        agents: {
          'performance-reviewer': { skills: ['skill-a'] },
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

      expect(config.agent?.['performance-reviewer']?.permission?.skill).toEqual(
        {
          '*': 'deny',
          'skill-a': 'allow',
        },
      )
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
      createCategorizedAgent('workflow', 'lint', {
        name: 'lint',
        description: 'Helper',
      })
      writeSystematicConfig({ agents: { lint: { disable: true } } })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.lint).toBeUndefined()
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

    test('discovery completes before user-overlay validation throws', async () => {
      // When `validateAgentOverlays` rejects a user overlay (here: an unknown
      // skill reference), the config hook must have already invoked
      // `client.config.providers()` for availability discovery. This protects
      // the lifecycle ordering: discover first, validate second. Future
      // validators that need the availability picture must be able to assume
      // it's already computed by the time validation runs.
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
      })
      writeCustomSystematicConfig({
        agents: { 'correctness-reviewer': { skills: ['missing-skill'] } },
      })

      const providersCalls: number[] = []
      const trackingClient = {
        config: {
          providers: async () => {
            providersCalls.push(Date.now())
            return {
              data: { providers: [], default: {} },
              error: undefined,
            }
          },
        },
      }

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
        client: trackingClient as Parameters<
          typeof createConfigHandler
        >[0]['client'],
      })

      // The handler should still throw because the overlay is invalid; but
      // the assertion below is that discovery already happened before the
      // throw site.
      await expect(handler({})).rejects.toThrow(/missing-skill/)

      // Spy fired exactly once, BEFORE the throw — proves discovery is no
      // longer gated behind user-overlay validation.
      expect(providersCalls.length).toBe(1)
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

    test('explicit frontmatter temperature is preserved (fill-if-absent)', async () => {
      // An agent with explicit temperature: 0.5 in frontmatter must keep 0.5
      // after applyAgentOverlays — the runtime must not overwrite it with the
      // inferred value. This is the RED test: it fails before the fill-if-absent
      // change because the current code unconditionally overwrites.
      createAgent(path.join(bundledDir, 'agents'), 'test-agent', {
        name: 'test-agent',
        description: 'A test agent',
        temperature: 0.5,
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      // 0.5 is not the inferred value for 'test-agent' (which would be 0.3),
      // so this assertion fails before the fill-if-absent change.
      expect(config.agent?.['test-agent']?.temperature).toBe(0.5)
    })

    test('agent without explicit temperature falls back to inferred value', async () => {
      // An agent with no temperature in frontmatter must still resolve to the
      // inferBuiltInTemperature value — the fallback path must remain intact.
      // 'security-sentinel' matches the review/security regex → inferred 0.1.
      createAgent(path.join(bundledDir, 'agents'), 'security-sentinel', {
        name: 'security-sentinel',
        description: 'Security review agent',
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['security-sentinel']?.temperature).toBe(0.1)
    })

    test('user overlay temperature overrides explicit frontmatter temperature (precedence preserved)', async () => {
      // Proves the overlay layer is untouched: user overlay > explicit frontmatter.
      // Agent has explicit temperature: 0.5 in frontmatter; user overlay sets 0.9.
      // The resolved value must be 0.9 (overlay wins).
      createCategorizedAgent('review', 'correctness-reviewer', {
        name: 'correctness-reviewer',
        description: 'Reviews correctness',
        temperature: 0.5,
      })
      writeSystematicConfig({
        agents: { 'correctness-reviewer': { temperature: 0.9 } },
      })

      const handler = createConfigHandler({
        directory: projectDir,
        bundledSkillsDir: path.join(bundledDir, 'skills'),
        bundledAgentsDir: path.join(bundledDir, 'agents'),
        bundledCommandsDir: path.join(bundledDir, 'commands'),
      })

      const config: Config = {}
      await handler(config)

      expect(config.agent?.['correctness-reviewer']?.temperature).toBe(0.9)
    })

    describe('discovered skills as commands', () => {
      function writeDiscoveredSkill(
        dir: string,
        name: string,
        opts: {
          description?: string
          disableModelInvocation?: boolean
        } = {},
      ): void {
        const skillDir = path.join(dir, name)
        fs.mkdirSync(skillDir, { recursive: true })
        const description = opts.description ?? `Description for ${name}`
        const extraFrontmatter =
          opts.disableModelInvocation === true
            ? 'disable-model-invocation: true\n'
            : ''
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          `---
name: ${name}
description: ${description}
${extraFrontmatter}---
# ${name}

Discovered body for ${name}.`,
        )
      }

      test('model-invocable discovered skill becomes a shim command', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'foo', {
          description: 'A discovered skill',
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)

        const command = config.command?.foo
        expect(command).toBeDefined()
        expect(command?.description).toBe(
          '(Systematic - Skill) A discovered skill',
        )
        expect(command?.template).toContain('skill tool')
        expect(command?.template).toContain('<user-request>\n$ARGUMENTS')
      })

      test('command-only discovered skill (disable-model-invocation) inlines the body', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'bar', {
          description: 'A command-only skill',
          disableModelInvocation: true,
        })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)

        const command = config.command?.bar
        expect(command).toBeDefined()
        expect(command?.description).toBe(
          '(Systematic - Skill) A command-only skill',
        )
        expect(command?.template).toContain('<skill-instruction>')
        expect(command?.template).toContain('Discovered body for bar')
        expect(command?.template).not.toContain('skill tool')
      })

      test('user-defined command of the same name survives untouched (R4)', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'foo')

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {
          command: {
            foo: {
              description: 'User command',
              template: 'User template',
            },
          },
        }
        await handler(config)

        expect(config.command?.foo?.description).toBe('User command')
        expect(config.command?.foo?.template).toBe('User template')
      })

      test('skills_as_commands: false disables discovered emission but keeps bundled', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'foo')
        createSkill(
          path.join(bundledDir, 'skills'),
          'bundled-skill',
          'A bundled skill',
        )
        writeSystematicConfig({ skills_as_commands: false })

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)

        expect(config.command?.foo).toBeUndefined()
        expect(config.command?.['systematic:bundled-skill']).toBeDefined()
      })

      test('running the handler twice yields identical config.command (idempotent)', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'foo')

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)
        const firstRun = JSON.parse(JSON.stringify(config.command))

        await handler(config)
        const secondRun = JSON.parse(JSON.stringify(config.command))

        expect(secondRun).toEqual(firstRun)
        expect(Object.keys(config.command ?? {})).toEqual(['foo'])
      })

      test('bundled systematic:/ce: commands still emitted with discovery enabled', async () => {
        writeDiscoveredSkill(path.join(projectDir, '.opencode/skills'), 'foo')
        createSkill(
          path.join(bundledDir, 'skills'),
          'ce:review',
          'A review skill',
        )

        const handler = createConfigHandler({
          directory: projectDir,
          bundledSkillsDir: path.join(bundledDir, 'skills'),
          bundledAgentsDir: path.join(bundledDir, 'agents'),
          bundledCommandsDir: path.join(bundledDir, 'commands'),
        })

        const config: Config = {}
        await handler(config)

        expect(config.command?.['ce:review']).toBeDefined()
        expect(config.command?.foo).toBeDefined()
      })
    })
  })
})
