import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
  loadConfigWithSources,
} from '../../src/lib/config.ts'

describe('config', () => {
  let testDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  function userConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'systematic.json')
  }

  function writeUserConfig(config: Record<string, unknown>): string {
    const filePath = userConfigPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  describe('loadConfig', () => {
    describe('no config files', () => {
      test('returns DEFAULT_CONFIG when no config files exist', () => {
        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
      })

      test('returned config has empty disabled arrays', () => {
        const result = loadConfig(testDir)
        expect(result.disabled_skills).toEqual([])
        expect(result.disabled_agents).toEqual([])
        expect(result.disabled_commands).toEqual([])
      })

      test('returned config has bootstrap enabled by default', () => {
        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(true)
      })
    })

    describe('project config only', () => {
      test('merges project config with defaults', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['skill-1'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('skill-1')
        expect(result.disabled_agents).toEqual([])
        expect(result.disabled_commands).toEqual([])
        expect(result.bootstrap).toEqual(DEFAULT_CONFIG.bootstrap)
      })

      test('project bootstrap overrides default', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              enabled: false,
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      })

      test('project bootstrap file overrides default', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              file: 'custom-bootstrap.md',
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.file).toBe('custom-bootstrap.md')
      })
    })

    describe('user config only', () => {
      test('merges user config with defaults', () => {
        writeUserConfig({ disabled_agents: ['agent-1'] })

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('agent-1')
        expect(result.disabled_skills).toEqual([])
        expect(result.disabled_commands).toEqual([])
      })
    })

    describe('both configs', () => {
      test('project config overrides user config', () => {
        writeUserConfig({ disabled_skills: ['user-skill'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['project-skill'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('user-skill')
        expect(result.disabled_skills).toContain('project-skill')
      })

      test('project bootstrap overrides user bootstrap', () => {
        writeUserConfig({ bootstrap: { enabled: true } })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: {
              enabled: false,
            },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      })
    })

    describe('array merging', () => {
      test('merges arrays without duplicates', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['skill-a', 'skill-b', 'skill-a'],
          }),
        )

        const result = loadConfig(testDir)
        const uniqueSkills = new Set(result.disabled_skills)
        expect(uniqueSkills.size).toBe(result.disabled_skills.length)
      })

      test('combines user and project disabled_skills arrays', () => {
        writeUserConfig({ disabled_skills: ['skill-a'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['skill-b'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('skill-a')
        expect(result.disabled_skills).toContain('skill-b')
      })

      test('combines user and project disabled_agents arrays', () => {
        writeUserConfig({ disabled_agents: ['agent-a'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_agents: ['agent-b'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('agent-a')
        expect(result.disabled_agents).toContain('agent-b')
      })

      test('combines user and project disabled_commands arrays', () => {
        writeUserConfig({ disabled_commands: ['cmd-a'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_commands: ['cmd-b'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_commands).toContain('cmd-a')
        expect(result.disabled_commands).toContain('cmd-b')
      })
    })

    describe('object merging (bootstrap)', () => {
      test('spreads bootstrap properties from user config', () => {
        writeUserConfig({ bootstrap: { file: 'user-bootstrap.md' } })

        const result = loadConfig(testDir)
        expect(result.bootstrap.file).toBe('user-bootstrap.md')
        expect(result.bootstrap.enabled).toBe(true)
      })

      test('project bootstrap fields override user bootstrap fields via spread merge', () => {
        writeUserConfig({
          bootstrap: { enabled: true, file: 'user-bootstrap.md' },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: { enabled: false },
          }),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
        expect(result.bootstrap.file).toBe('user-bootstrap.md')
      })
    })

    describe('malformed configs', () => {
      test('fails fast when project config has invalid JSONC', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, '{invalid json')

        expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
        expect(() => loadConfig(testDir)).toThrow(/parse error/i)
      })

      test('ignores project config if it does not exist', () => {
        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
      })
    })

    describe('agent and category overlays', () => {
      test('loads a user agent overlay with source and key provenance', () => {
        const userConfigPath = writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'openai/gpt-5' } },
        })

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { model: 'openai/gpt-5' },
        })
        expect(result.overlays.agents['correctness-reviewer']).toEqual({
          value: { model: 'openai/gpt-5' },
          sourcePath: userConfigPath,
          keyPath: 'agents.correctness-reviewer',
        })
      })

      test('preserves unrelated user category and project agent overlays', () => {
        writeUserConfig({
          categories: { review: { temperature: 0.2 } },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { temperature: 0.4 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.categories).toEqual({
          review: { temperature: 0.2 },
        })
        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.4 },
        })
      })

      test('project same-key overlays cannot erase user model policy', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              model: 'openai/gpt-5',
              temperature: 0.1,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(
          projectConfigPath,
          JSON.stringify({
            agents: {
              'correctness-reviewer': { temperature: 0.4 },
            },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.4, model: 'openai/gpt-5' },
        })
        expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
          projectConfigPath,
        )
      })

      test('project overlays cannot configure model, permission, or managed skills', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        for (const config of [
          {
            agents: {
              'correctness-reviewer': { model: 'openai/gpt-5' },
            },
          },
          { categories: { review: { model: 'openai/gpt-5' } } },
          {
            agents: {
              'correctness-reviewer': { permission: { bash: 'allow' } },
            },
          },
          { categories: { review: { skills: ['ce:review'] } } },
        ]) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(config))

          expect(() => loadConfigWithSources(testDir)).toThrow(
            projectConfigPath,
          )
          expect(() => loadConfigWithSources(testDir)).toThrow(
            /only valid in user config or OPENCODE_CONFIG_DIR config/,
          )
        }
      })

      test('project overlays reject model: null as security field violation', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        for (const config of [
          {
            agents: { 'correctness-reviewer': { model: null } },
          },
          { categories: { review: { model: null } } },
        ]) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(config))

          expect(() => loadConfigWithSources(testDir)).toThrow(
            projectConfigPath,
          )
          expect(() => loadConfigWithSources(testDir)).toThrow(
            /only valid in user config or OPENCODE_CONFIG_DIR config/,
          )
        }
      })

      test('user config model: null passes config loading', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: null } },
        })

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents?.['correctness-reviewer']?.model).toBeNull()
      })

      test('project same-key overlays preserve user permission policy fields', () => {
        writeUserConfig({
          categories: {
            review: {
              permission: { bash: 'deny' },
              skills: ['ce:review'],
              temperature: 0.1,
            },
          },
          agents: {
            'correctness-reviewer': {
              model: 'openai/gpt-5',
              permission: { read: 'deny' },
              temperature: 0.1,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            categories: { review: { temperature: 0.4 } },
            agents: { 'correctness-reviewer': { hidden: true } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.categories?.review).toEqual({
          temperature: 0.4,
          permission: { bash: 'deny' },
          skills: ['ce:review'],
        })
        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          hidden: true,
          permission: { read: 'deny' },
          model: 'openai/gpt-5',
        })
      })

      test('project overlays cannot configure variant in agents or categories', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')

        for (const config of [
          {
            agents: {
              'correctness-reviewer': { variant: 'large-context' },
            },
          },
          { categories: { review: { variant: 'small' } } },
        ]) {
          fs.writeFileSync(projectConfigPath, JSON.stringify(config))

          expect(() => loadConfigWithSources(testDir)).toThrow(
            projectConfigPath,
          )
          expect(() => loadConfigWithSources(testDir)).toThrow(
            /only valid in user config or OPENCODE_CONFIG_DIR config/,
          )
        }
      })

      test('project same-key overlay preserves variant from higher-trust config', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              variant: 'large-context',
              model: 'openai/gpt-5',
              temperature: 0.1,
            },
          },
          categories: {
            review: {
              variant: 'small',
              temperature: 0.2,
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'correctness-reviewer': { hidden: true } },
            categories: { review: { temperature: 0.5 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          hidden: true,
          variant: 'large-context',
          model: 'openai/gpt-5',
        })
        expect(result.config.categories?.review).toEqual({
          temperature: 0.5,
          variant: 'small',
        })
      })

      test('custom config category overlay replaces project same-key overlay', () => {
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir

        try {
          const projectConfigDir = path.join(testDir, '.opencode')
          fs.mkdirSync(projectConfigDir)
          fs.writeFileSync(
            path.join(projectConfigDir, 'systematic.json'),
            JSON.stringify({
              categories: {
                review: { steps: 8, temperature: 0.1 },
              },
            }),
          )

          const customConfigPath = path.join(customDir, 'systematic.json')
          fs.writeFileSync(
            customConfigPath,
            JSON.stringify({ categories: { review: { temperature: 0.7 } } }),
          )

          const result = loadConfigWithSources(testDir)

          expect(result.config.categories).toEqual({
            review: { temperature: 0.7 },
          })
          expect(result.overlays.categories.review?.sourcePath).toBe(
            customConfigPath,
          )
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('absent and empty overlay maps are valid no-ops', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({ agents: {}, categories: {} }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({})
        expect(result.config.categories).toEqual({})
        expect(result.overlays.agents).toEqual({})
        expect(result.overlays.categories).toEqual({})
      })

      test.each([
        ['agents container', { agents: null }, 'agents'],
        ['categories container', { categories: [] }, 'categories'],
        [
          'agent entry',
          { agents: { 'correctness-reviewer': 'openai/gpt-5' } },
          'agents.correctness-reviewer',
        ],
        [
          'category entry',
          { categories: { review: null } },
          'categories.review',
        ],
      ])('rejects invalid %s overlay values', (_name, config, keyPath) => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, JSON.stringify(config))

        expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
        expect(() => loadConfigWithSources(testDir)).toThrow(keyPath)
      })

      test('preserves unqualified and qualified alias keys across source priorities', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { temperature: 0.1 } },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'review/correctness-reviewer': { temperature: 0.2 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.1 },
          'review/correctness-reviewer': { temperature: 0.2 },
        })
      })
    })
  })

  describe('getConfigPaths', () => {
    test('returns user config path in .config/opencode/systematic.json', () => {
      const result = getConfigPaths(testDir)
      expect(result.userConfig).toBe(
        path.join(os.homedir(), '.config/opencode/systematic.json'),
      )
    })

    test('returns project config path in <projectDir>/.opencode/systematic.json', () => {
      const result = getConfigPaths(testDir)
      expect(result.projectConfig).toBe(
        path.join(testDir, '.opencode/systematic.json'),
      )
    })

    test('returns user dir path in .config/opencode/systematic/', () => {
      const result = getConfigPaths(testDir)
      expect(result.userDir).toBe(
        path.join(os.homedir(), '.config/opencode/systematic'),
      )
    })

    test('returns project dir path in <projectDir>/.opencode/systematic/', () => {
      const result = getConfigPaths(testDir)
      expect(result.projectDir).toBe(path.join(testDir, '.opencode/systematic'))
    })

    test('paths reference correct directories relative to project', () => {
      const customProjectDir = path.join(testDir, 'custom/project')
      const result = getConfigPaths(customProjectDir)

      expect(result.projectConfig).toContain('custom/project')
      expect(result.projectDir).toContain('custom/project')
      expect(result.userConfig).toContain(os.homedir())
      expect(result.userDir).toContain(os.homedir())
    })
  })

  describe('DEFAULT_CONFIG', () => {
    test('has disabled_skills as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_skills).toEqual([])
    })

    test('has disabled_agents as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_agents).toEqual([])
    })

    test('has disabled_commands as empty array', () => {
      expect(DEFAULT_CONFIG.disabled_commands).toEqual([])
    })

    test('has bootstrap.enabled set to true', () => {
      expect(DEFAULT_CONFIG.bootstrap.enabled).toBe(true)
    })

    test('has bootstrap.file undefined by default', () => {
      expect(DEFAULT_CONFIG.bootstrap.file).toBeUndefined()
    })
  })

  describe('OPENCODE_CONFIG_DIR environment variable', () => {
    afterEach(() => {
      delete process.env.OPENCODE_CONFIG_DIR
    })

    test('custom config from OPENCODE_CONFIG_DIR has highest priority', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['custom-skill'] }),
      )

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['project-skill'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('custom-skill')
      expect(config.disabled_skills).toContain('project-skill')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('empty string OPENCODE_CONFIG_DIR is treated as unset', () => {
      process.env.OPENCODE_CONFIG_DIR = ''

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBeUndefined()
      expect(paths.customDir).toBeUndefined()
    })

    test('whitespace-only OPENCODE_CONFIG_DIR is treated as unset', () => {
      process.env.OPENCODE_CONFIG_DIR = '   '

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBeUndefined()
      expect(paths.customDir).toBeUndefined()
    })

    test('non-existent OPENCODE_CONFIG_DIR path is handled gracefully', () => {
      process.env.OPENCODE_CONFIG_DIR = '/nonexistent/path/that/does/not/exist'

      expect(() => loadConfig(testDir)).not.toThrow()

      const config = loadConfig(testDir)
      expect(config.disabled_skills).toEqual([])
    })

    test('getConfigPaths includes customConfig and customDir when env var is set', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const paths = getConfigPaths(testDir)

      expect(paths.customConfig).toBe(path.join(customDir, 'systematic.json'))
      expect(paths.customDir).toBe(path.join(customDir, 'systematic'))
      expect(paths.userConfig).toBeTruthy()
      expect(paths.projectConfig).toBeTruthy()

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom config bootstrap settings override project and user', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ bootstrap: { enabled: false } }),
      )

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({
          bootstrap: { enabled: true, file: 'project.md' },
        }),
      )

      const config = loadConfig(testDir)

      expect(config.bootstrap.enabled).toBe(false)
      expect(config.bootstrap.file).toBe('project.md')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom disabled_skills merges with project and user config', () => {
      writeUserConfig({ disabled_skills: ['user-skill'] })

      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['project-skill'] }),
      )

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['custom-skill'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('user-skill')
      expect(config.disabled_skills).toContain('project-skill')
      expect(config.disabled_skills).toContain('custom-skill')

      fs.rmSync(customDir, { recursive: true, force: true })
    })

    test('custom config directory directory contents are loaded', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const customDirContents = path.join(customDir, 'systematic')
      fs.mkdirSync(customDirContents, { recursive: true })

      const paths = getConfigPaths(testDir)

      expect(paths.customDir).toBe(customDirContents)

      fs.rmSync(customDir, { recursive: true, force: true })
    })
  })
})
