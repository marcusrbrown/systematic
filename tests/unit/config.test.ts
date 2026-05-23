import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
  loadConfigWithSources,
} from '../../src/lib/config.js'

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
            disabled_skills: ['ce:plan'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')
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
        writeUserConfig({ disabled_agents: ['correctness-reviewer'] })

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
        expect(result.disabled_skills).toEqual([])
        expect(result.disabled_commands).toEqual([])
      })
    })

    describe('both configs', () => {
      test('project config overrides user config', () => {
        writeUserConfig({ disabled_skills: ['ce:brainstorm'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:compound'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:brainstorm')
        expect(result.disabled_skills).toContain('ce:compound')
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
            disabled_skills: ['ce:plan', 'ce:review', 'ce:plan'],
          }),
        )

        const result = loadConfig(testDir)
        const uniqueSkills = new Set(result.disabled_skills)
        expect(uniqueSkills.size).toBe(result.disabled_skills.length)
      })

      test('combines user and project disabled_skills arrays', () => {
        writeUserConfig({ disabled_skills: ['ce:plan'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_skills: ['ce:review'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')
        expect(result.disabled_skills).toContain('ce:review')
      })

      test('combines user and project disabled_agents arrays', () => {
        writeUserConfig({ disabled_agents: ['correctness-reviewer'] })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            disabled_agents: ['security-reviewer'],
          }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
        expect(result.disabled_agents).toContain('security-reviewer')
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
              'correctness-reviewer': {
                model: 'openai/gpt-5',
                variant: 'large-context',
              },
            },
          },
          {
            categories: {
              review: { model: 'openai/gpt-5', variant: 'small' },
            },
          },
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
              model: 'openai/gpt-5',
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
          model: 'openai/gpt-5',
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

      test('preserves multiple bundled agent overlays across source priorities', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { temperature: 0.1 } },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            agents: { 'security-reviewer': { temperature: 0.2 } },
          }),
        )

        const result = loadConfigWithSources(testDir)

        expect(result.config.agents).toEqual({
          'correctness-reviewer': { temperature: 0.1 },
          'security-reviewer': { temperature: 0.2 },
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
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:compound'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('ce:work')
      expect(config.disabled_skills).toContain('ce:compound')

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
      writeUserConfig({ disabled_skills: ['ce:brainstorm'] })

      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:compound'] }),
      )

      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )

      const config = loadConfig(testDir)

      expect(config.disabled_skills).toContain('ce:brainstorm')
      expect(config.disabled_skills).toContain('ce:compound')
      expect(config.disabled_skills).toContain('ce:work')

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

  describe('schema validation', () => {
    function writeProjectConfig(config: Record<string, unknown>): string {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
      fs.writeFileSync(projectConfigPath, JSON.stringify(config))
      return projectConfigPath
    }

    test('valid config loads identically — happy path regression', () => {
      writeProjectConfig({
        disabled_skills: ['ce:plan'],
        disabled_agents: ['security-reviewer'],
        bootstrap: { enabled: false },
      })
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:plan')
      expect(result.disabled_agents).toContain('security-reviewer')
      expect(result.bootstrap.enabled).toBe(false)
    })

    test('disabled_skills as string is rejected with field name and source path in error', () => {
      const configPath = writeProjectConfig({ disabled_skills: 'not-an-array' })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })

    test('unknown top-level field is rejected by strict-mode schema with field name in error', () => {
      const configPath = writeProjectConfig({ agnts: {} })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('agnts')
    })

    test('malformed agents.<key>.model is rejected with nested field path in error', () => {
      const configPath = writeProjectConfig({
        agents: { 'correctness-reviewer': { model: {} } },
      })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow(
        'agents.correctness-reviewer.model',
      )
    })

    test('bootstrap.enabled as string is rejected with field path in error', () => {
      const configPath = writeProjectConfig({ bootstrap: { enabled: 'yes' } })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('bootstrap.enabled')
    })

    test('empty config loads with all Zod defaults applied', () => {
      writeProjectConfig({})
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual([])
      expect(result.disabled_agents).toEqual([])
      expect(result.disabled_commands).toEqual([])
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('configs accepted by old hand-rolled validators now reject unknown top-level fields', () => {
      // Before schema validation was wired into the loader, any JSON object was
      // accepted without field-level checking. Unknown top-level fields silently
      // became no-ops. This test captures the expected behavior change: strict Zod
      // validation now runs on every loaded config source, making unknown fields
      // a hard error rather than a silent no-op.
      const configPath = writeProjectConfig({
        disabled_skills: [],
        unknownField: true,
      })
      expect(() => loadConfig(testDir)).toThrow(configPath)
      expect(() => loadConfig(testDir)).toThrow('unknownField')
    })

    test('user config schema validation failure names the user config file in error', () => {
      const userConfigFilePath = writeUserConfig({ disabled_skills: 'wrong' })
      expect(() => loadConfig(testDir)).toThrow(userConfigFilePath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })

    test('typo on agents key produces a message pointing at the documentation URL', () => {
      const configPath = writeProjectConfig({
        agents: { 'security-reviwer': { temperature: 0.1 } },
      })
      let errorMessage = ''
      try {
        loadConfig(testDir)
      } catch (err) {
        errorMessage = (err as Error).message
      }
      expect(errorMessage).toContain(configPath)
      expect(errorMessage).toContain('security-reviwer')
      expect(errorMessage).toContain(
        'https://fro.bot/systematic/reference/configuration#typed-validation',
      )
    })

    test('typo on disabled_agents value produces a message pointing at the documentation URL', () => {
      const configPath = writeProjectConfig({
        disabled_agents: ['security-reviwer'],
      })
      let errorMessage = ''
      try {
        loadConfig(testDir)
      } catch (err) {
        errorMessage = (err as Error).message
      }
      expect(errorMessage).toContain(configPath)
      // disabled_agents is an enum array — Zod reports a value-level error, not unrecognized_keys.
      // The error should still name the file and the invalid field path.
      expect(errorMessage).toContain('disabled_agents')
    })

    describe('enrichUnrecognizedKeyIssues — verbose enum suppression and multi-key handling', () => {
      const DOCS_URL =
        'https://fro.bot/systematic/reference/configuration#typed-validation'

      // #385 — suppress verbose enum list in disabled_agents / disabled_skills errors

      test('typo in disabled_agents produces a short message with the bad value and docs URL, not the full enum list', () => {
        writeProjectConfig({ disabled_agents: ['security-reviwer'] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('security-reviwer')
        expect(errorMessage).toContain('disabled_agents')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must NOT dump the full valid-name list inline
        expect(errorMessage).not.toContain('adversarial-reviewer')
        expect(errorMessage).not.toContain('architecture-strategist')
      })

      test('typo in disabled_skills produces a short message with the bad value and docs URL', () => {
        writeProjectConfig({ disabled_skills: ['typed-config-validatoin'] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typed-config-validatoin')
        expect(errorMessage).toContain('disabled_skills')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must NOT dump the full valid-name list inline
        expect(errorMessage).not.toContain('ce:plan')
        expect(errorMessage).not.toContain('ce:brainstorm')
      })

      test('valid disabled_agents entry passes through enrichment unchanged', () => {
        writeProjectConfig({ disabled_agents: ['correctness-reviewer'] })
        expect(() => loadConfig(testDir)).not.toThrow()
        const result = loadConfig(testDir)
        expect(result.disabled_agents).toContain('correctness-reviewer')
      })

      // #386 — surface every unknown key in unrecognized_keys hints

      test("multiple typo'd agent keys produce a hint listing all of them", () => {
        writeProjectConfig({ agents: { 'typo-a': {}, 'typo-b': {} } })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toContain('typo-b')
        expect(errorMessage).toContain('Unrecognized keys')
      })

      test("single typo'd agent key still produces singular form", () => {
        writeProjectConfig({ agents: { 'typo-a': {} } })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toMatch(/Unrecognized key '/)
        expect(errorMessage).not.toMatch(/Unrecognized keys '/)
      })

      test("three typo'd agent keys produce a comma-separated list", () => {
        writeProjectConfig({
          agents: { 'typo-a': {}, 'typo-b': {}, 'typo-c': {} },
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('typo-a')
        expect(errorMessage).toContain('typo-b')
        expect(errorMessage).toContain('typo-c')
        expect(errorMessage).toContain('Unrecognized keys')
      })

      // Finding 2 — mixed issues regression
      test('mixed agents typo and disabled_agents typo each produce their own enriched hint', () => {
        // Both unrecognized_keys (agents) and invalid_value (disabled_agents) in one config
        writeProjectConfig({
          agents: { 'typo-a': {}, 'typo-b': {} },
          disabled_agents: ['security-reviwer'],
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        // Both issues are now surfaced in the message. We verify the message
        // contains the docs URL (confirming enrichment fired) and is not a raw
        // enum dump (which would be thousands of chars).
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(1000)
        // Must not dump the full enum list
        expect(errorMessage).not.toContain('adversarial-reviewer')
      })

      // Finding 3 — non-string disabled_agents entry edge case
      test('non-string disabled_agents entry produces a short generic hint', () => {
        // null is not a valid string entry — exercises the fallback branch where
        // resolveValueAtPath returns a non-string value
        writeProjectConfig({ disabled_agents: [null] })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (err) {
          errorMessage = (err as Error).message
        }
        expect(errorMessage).toContain('disabled_agents')
        expect(errorMessage).toContain(DOCS_URL)
        expect(errorMessage.length).toBeLessThan(500)
        // Must not dump the full valid-name list inline
        expect(errorMessage).not.toContain('oracle')
        expect(errorMessage).not.toContain('correctness-reviewer')
      })

      // #391 — surface every issue in the human-readable message

      test('surfaces every issue when multiple Zod issues are returned', () => {
        writeProjectConfig({
          agents: { 'typo-agent-name': { color: 'primary' } },
          disabled_agents: ['security-reviwer'],
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (e) {
          errorMessage = (e as Error).message
        }
        // Both issues must surface in the human-readable message.
        expect(errorMessage).toContain('typo-agent-name')
        expect(errorMessage).toContain('security-reviwer')
        // Multi-line format with bullet prefix when multiple issues exist.
        expect(errorMessage).toMatch(/\n {2}-/)
      })

      test('preserves single-line format when only one issue is returned', () => {
        writeProjectConfig({
          agents: { 'typo-agent-name': { color: 'primary' } },
        })
        let errorMessage = ''
        try {
          loadConfig(testDir)
        } catch (e) {
          errorMessage = (e as Error).message
        }
        // No bullet prefix; backward-compat one-line format.
        expect(errorMessage).not.toMatch(/\n {2}-/)
        expect(errorMessage).toContain('typo-agent-name')
      })
    })
  })

  describe('merge precedence after schema validation', () => {
    function writeProjectConfig(config: Record<string, unknown>): void {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify(config),
      )
    }

    test('user bootstrap.enabled:false is preserved when project config is empty', () => {
      // Regression: when result.data (Zod-hydrated) is propagated to
      // ConfigSource.config, Zod's default for bootstrap.enabled is true, so an
      // empty project config {} produces { bootstrap: { enabled: true } }. The
      // spread `...projectConfig?.bootstrap (= { enabled: true })` then clobbers
      // the user's explicit enabled: false. The loader must propagate the raw
      // parsed JSONC instead so the merge sees `undefined` for unset fields.
      writeUserConfig({ bootstrap: { enabled: false } })
      writeProjectConfig({})

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(false)
    })

    test('user disabled_skills are preserved when project config is empty', () => {
      // disabled_skills has a Zod default of []. An empty project config
      // produces result.data.disabled_skills = [] which then gets merged
      // into the union set — that is safe because mergeArraysUnique([], [])
      // stays empty. But the user's value was already in the merge chain,
      // so this test double-checks the array path remains correct.
      writeUserConfig({ disabled_skills: ['ce:ideate'] })
      writeProjectConfig({})

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:ideate')
    })

    test('3-source: user bootstrap.enabled:false preserved through project {} and custom {}', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({ bootstrap: { enabled: false } })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({}),
        )

        const result = loadConfig(testDir)
        expect(result.bootstrap.enabled).toBe(false)
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('high-priority explicit project override still wins over user setting', () => {
      // The fix must NOT over-correct: if the project explicitly sets
      // bootstrap.enabled:true, that should still override user's false.
      writeUserConfig({ bootstrap: { enabled: false } })
      writeProjectConfig({ bootstrap: { enabled: true } })

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('invalid user config type is rejected by schema validation', () => {
      // Schema validation must still run even though we propagate rawConfig.
      const userConfigFilePath = writeUserConfig({
        disabled_skills: 'not-an-array',
      })

      expect(() => loadConfig(testDir)).toThrow(userConfigFilePath)
      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
    })
  })

  describe('JSONC precedence', () => {
    test('AE3: only systematic.json exists — loads it (backward compat)', () => {
      writeUserConfig({ disabled_skills: ['ce:plan'] })

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:plan')
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('AE2: only systematic.jsonc exists — loads it correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // This is a comment\n  "disabled_skills": ["ce:review"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:review')
    })

    test('AE2: JSONC with comments and standard JSON structure parses correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // Comment explaining why this skill is disabled\n  "disabled_skills": ["ce:plan"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('AE1: both jsonc and json exist — .jsonc is loaded, .json is ignored', () => {
      const jsoncPath = userConfigPath().replace(/\.json$/, '.jsonc')
      const jsonPath = userConfigPath()
      fs.mkdirSync(path.dirname(jsoncPath), { recursive: true })

      fs.writeFileSync(
        jsonPath,
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )
      fs.writeFileSync(jsoncPath, '{\n  "disabled_skills": ["ce:review"]\n}\n')

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:review'])
    })

    test('project jsonc takes precedence over project json', () => {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })

      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.jsonc'),
        JSON.stringify({ disabled_skills: ['ce:review'] }),
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:review'])
    })

    test('custom config jsonc takes precedence over custom config json', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ disabled_skills: ['ce:plan'] }),
        )
        fs.writeFileSync(
          path.join(customDir, 'systematic.jsonc'),
          JSON.stringify({ disabled_skills: ['ce:review'] }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toEqual(['ce:review'])
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('getConfigPaths returns .jsonc path when .jsonc exists', () => {
      const jsoncPath = path.join(
        os.homedir(),
        '.config/opencode/systematic.jsonc',
      )
      fs.mkdirSync(path.dirname(jsoncPath), { recursive: true })
      fs.writeFileSync(jsoncPath, '{}')

      const paths = getConfigPaths(testDir)
      expect(paths.userConfig).toBe(jsoncPath)
    })

    test('getConfigPaths returns .json fallback when neither exists', () => {
      const paths = getConfigPaths(testDir)
      expect(paths.userConfig).toBe(
        path.join(os.homedir(), '.config/opencode/systematic.json'),
      )
    })

    test('malformed jsonc throws parse error with file path', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{invalid jsonc')

      expect(() => loadConfig(testDir)).toThrow(filePath)
      expect(() => loadConfig(testDir)).toThrow(/parse error/i)
    })

    test('accepts $schema field in JSONC config without raising configSchemaError', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        [
          '// Top-level user config',
          '{',
          '  "$schema": "https://fro.bot/systematic/schemas/v2/systematic-config.schema.json",',
          '  "disabled_skills": []',
          '}',
        ].join('\n'),
      )

      expect(() => loadConfig(testDir)).not.toThrow()
      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual([])
    })
  })
})

// The TYPED_VALIDATION_DOCS_URL constant in src/lib/config.ts is surfaced
// directly to end users in validation error messages. These tests catch two
// classes of drift on that URL: the host and base-path (correct DNS target)
// and the fragment (a heading that actually exists in the rendered docs).

describe('TYPED_VALIDATION_DOCS_URL', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const CONFIG_TS = path.resolve(__dirname, '../../src/lib/config.ts')
  const CONFIG_MDX = path.resolve(
    __dirname,
    '../../docs/src/content/docs/reference/configuration.mdx',
  )

  /**
   * Extract the literal URL string assigned to TYPED_VALIDATION_DOCS_URL
   * from the source file. Reading the source avoids coupling the test to
   * the module export shape and matches how other constants in this file
   * are validated.
   */
  function readTypedValidationDocsUrl(): string {
    const source = fs.readFileSync(CONFIG_TS, 'utf-8')
    const match = source.match(
      /TYPED_VALIDATION_DOCS_URL\s*=\s*\n?\s*'([^']+)'/,
    )
    if (!match) {
      throw new Error('Could not locate TYPED_VALIDATION_DOCS_URL in config.ts')
    }
    return match[1]
  }

  test('URL points at fro.bot/systematic (host drift regression)', () => {
    // The subdomain form `systematic.fro.bot` does not resolve in DNS.
    // The production site is served from `https://fro.bot/systematic/`
    // (matches `site` + `base` in docs/astro.config.mjs).
    const url = readTypedValidationDocsUrl()
    expect(url).toMatch(/^https:\/\/fro\.bot\/systematic\//)
    expect(url).toContain('#typed-validation')
  })

  /**
   * Derive heading slugs from MDX content using Starlight's conservative
   * slugify rules: lowercase, spaces → hyphens, strip non-alphanumeric-or-hyphen.
   */
  function slugify(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
  }

  function extractHeadingSlugs(mdx: string): Set<string> {
    const slugs = new Set<string>()
    for (const line of mdx.split('\n')) {
      const m = line.match(/^#{1,6}\s+(.+)$/)
      if (m) {
        slugs.add(slugify(m[1].trim()))
      }
    }
    return slugs
  }

  test('configuration.mdx contains a heading that slugifies to "typed-validation"', () => {
    expect(fs.existsSync(CONFIG_MDX)).toBe(true)
    const mdx = fs.readFileSync(CONFIG_MDX, 'utf-8')
    const slugs = extractHeadingSlugs(mdx)
    expect(slugs.has('typed-validation')).toBe(true)
  })
})
