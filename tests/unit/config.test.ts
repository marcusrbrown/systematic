import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLED_SKILL_NAMES } from '../../src/lib/bundled-names.js'
import {
  buildCapabilitySnapshot,
  serializeCapabilitySnapshot,
} from '../../src/lib/capability-snapshot.js'
import {
  computeDroppedNames,
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
  loadConfigWithSources,
  warnDroppedNames,
} from '../../src/lib/config.js'

const OBSERVED_AT = '2026-08-13T12:34:56.000Z'

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

    describe('read-only observation metadata', () => {
      test('reports source presence and field-specific authority without values', () => {
        writeUserConfig({
          bootstrap: { enabled: false },
          workflow_guard: { mode: 'protected' },
          skills_as_commands: false,
          agents: {
            'correctness-reviewer': {
              model: 'openai/secret-model',
              permission: { bash: 'deny' },
            },
          },
        })

        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({
            bootstrap: { enabled: true },
            workflow_guard: { mode: 'disabled' },
            skills_as_commands: true,
            agents: {
              'correctness-reviewer': { temperature: 0.4 },
            },
          }),
        )

        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({
            skills_as_commands: false,
            categories: { review: { temperature: 0.7 } },
          }),
        )

        try {
          const result = loadConfigWithSources(testDir)

          expect(result.metadata.sources).toEqual([
            { kind: 'custom', presence: 'present' },
            { kind: 'project', presence: 'present' },
            { kind: 'user', presence: 'present' },
          ])
          expect(result.metadata.authorities).toEqual(
            expect.arrayContaining([
              { fieldPath: 'bootstrap.enabled', sourceKind: 'project' },
              { fieldPath: 'skills_as_commands', sourceKind: 'custom' },
              { fieldPath: 'workflow_guard.mode', sourceKind: 'user' },
            ]),
          )
          expect(result.metadata.authorities).not.toContainEqual({
            fieldPath: 'workflow_guard.mode',
            sourceKind: 'project',
          })
          expect(result.metadata.protectedFields).toContainEqual({
            fieldPath: 'workflow_guard',
            outcome: 'blocked',
            sourceKind: 'project',
          })
          expect(JSON.stringify(result.metadata)).not.toContain('secret-model')
          expect(JSON.stringify(result.metadata)).not.toContain('permission')
          expect(result.config.skills_as_commands).toBe(false)
          expect(result.config.bootstrap.enabled).toBe(true)
          expect(result.config.workflow_guard.mode).toBe('protected')
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
          fs.rmSync(customDir, { recursive: true, force: true })
        }
      })

      test('reports malformed source metadata only in opt-in mode', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        const projectConfigPath = path.join(projectConfigDir, 'systematic.json')
        fs.writeFileSync(projectConfigPath, '{invalid json')

        const result = loadConfigWithSources(testDir, {
          invalidSource: 'report',
        })

        expect(result.metadata.sources).toContainEqual({
          errorCode: 'parse-failed',
          kind: 'project',
          presence: 'invalid',
        })
        expect(JSON.stringify(result.metadata)).not.toContain(projectConfigPath)
        expect(() => loadConfig(testDir)).toThrow(projectConfigPath)
      })

      test('deduplicates symlink-equivalent config sources without leaking paths', () => {
        const realProjectDir = path.join(testDir, 'real-project')
        const realConfigDir = path.join(realProjectDir, '.opencode')
        const aliasedProjectDir = path.join(testDir, 'aliased-project')
        const aliasedCustomDir = path.join(testDir, 'aliased-custom')
        fs.mkdirSync(realConfigDir, { recursive: true })
        fs.writeFileSync(
          path.join(realConfigDir, 'systematic.json'),
          JSON.stringify({ skills_as_commands: false }),
        )
        fs.symlinkSync(realProjectDir, aliasedProjectDir, 'dir')
        fs.symlinkSync(realConfigDir, aliasedCustomDir, 'dir')
        process.env.OPENCODE_CONFIG_DIR = aliasedCustomDir

        try {
          const result = loadConfigWithSources(aliasedProjectDir)
          expect(result.metadata.sources).toEqual([
            { kind: 'custom', presence: 'present' },
            { kind: 'user', presence: 'absent' },
          ])

          const serialized = serializeCapabilitySnapshot(
            buildCapabilitySnapshot({
              argv: ['systematic', 'capabilities'],
              clock: () => Date.parse(OBSERVED_AT),
              config: result.metadata,
              package: { name: '@fro.bot/systematic', version: '1.2.3' },
              roots: [],
            }),
          )
          expect(serialized).not.toContain(realProjectDir)
          expect(serialized).not.toContain(aliasedProjectDir)
          expect(serialized).not.toContain(aliasedCustomDir)
        } finally {
          delete process.env.OPENCODE_CONFIG_DIR
        }
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

    test('has workflow_guard observe mode and debug disabled by default', () => {
      expect(DEFAULT_CONFIG.workflow_guard).toEqual({
        mode: 'observe',
        debug: false,
      })
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

    test('project workflow_guard is stripped by the trust boundary', () => {
      writeProjectConfig({
        workflow_guard: { mode: 'disabled', debug: true },
      })

      expect(() => loadConfig(testDir)).not.toThrow()
      expect(loadConfig(testDir).workflow_guard).toEqual(
        DEFAULT_CONFIG.workflow_guard,
      )
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

    test('user workflow_guard values survive empty project and custom configs', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({
          workflow_guard: { mode: 'protected', debug: true },
        })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({}),
        )

        const result = loadConfig(testDir)

        expect(result.workflow_guard).toEqual({
          mode: 'protected',
          debug: true,
        })
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    })

    test('custom workflow_guard partially overrides only the specified fields', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir

      try {
        writeUserConfig({
          workflow_guard: { mode: 'protected', debug: true },
        })
        writeProjectConfig({})
        fs.writeFileSync(
          path.join(customDir, 'systematic.json'),
          JSON.stringify({ workflow_guard: { mode: 'disabled' } }),
        )

        const result = loadConfig(testDir)

        expect(result.workflow_guard).toEqual({
          mode: 'disabled',
          debug: true,
        })
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

  describe('removed bundled skill names (warn-and-ignore)', () => {
    function writeProjectConfig(config: Record<string, unknown>): void {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify(config),
      )
    }

    test('disabled_skills with "orchestrating-swarms" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['orchestrating-swarms'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('orchestrating-swarms')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "claude-permissions-optimizer" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['claude-permissions-optimizer'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain(
        'claude-permissions-optimizer',
      )
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "claude-permissions-optimizer" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "writing-systematic-skills" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['writing-systematic-skills'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('writing-systematic-skills')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "writing-systematic-skills" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with a genuinely-unknown name still throws the actionable schema error', () => {
      writeProjectConfig({ disabled_skills: ['never-existed-skill'] })

      expect(() => loadConfig(testDir)).toThrow('disabled_skills')
      expect(() => loadConfig(testDir)).toThrow('never-existed-skill')
    })

    test('mixed removed and valid disabled_skills: removed name dropped-with-warning, valid name retained', () => {
      writeProjectConfig({
        disabled_skills: ['orchestrating-swarms', 'ce:review'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_skills).not.toContain('orchestrating-swarms')
      expect(result.disabled_skills).toContain('ce:review')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_skills with "rclone" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['rclone'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('rclone')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "rclone" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('mixed valid and removed disabled_skills ("test-driven-development", "setup"): valid honored, removed warned', () => {
      writeProjectConfig({
        disabled_skills: ['test-driven-development', 'setup'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_skills).toContain('test-driven-development')
      expect(result.disabled_skills).not.toContain('setup')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "setup" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('"todos" is present in the bundled skill names (merged todo-create/todo-triage/todo-resolve)', () => {
      expect(BUNDLED_SKILL_NAMES).toContain('todos')
    })

    test('disabled_skills with "todo-create" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_skills: ['todo-create'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_skills).not.toContain('todo-create')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "todo-create" in `disabled_skills` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with "security-sentinel" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['security-sentinel'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('security-sentinel')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "security-sentinel" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('mixed valid and removed disabled_agents ("correctness-reviewer", "performance-oracle"): valid honored, removed warned', () => {
      writeProjectConfig({
        disabled_agents: ['correctness-reviewer', 'performance-oracle'],
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.disabled_agents).toContain('correctness-reviewer')
      expect(result.disabled_agents).not.toContain('performance-oracle')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "performance-oracle" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with qualified removed agent "review/security-sentinel" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['review/security-sentinel'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('review/security-sentinel')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "review/security-sentinel" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })

    test('disabled_agents with qualified removed agent "design/figma-design-sync" drops the name, warns, and loads without throwing', () => {
      writeProjectConfig({ disabled_agents: ['design/figma-design-sync'] })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      let result: ReturnType<typeof loadConfig> | undefined
      expect(() => {
        result = loadConfig(testDir)
      }).not.toThrow()

      expect(result?.disabled_agents).not.toContain('design/figma-design-sync')
      expect(warnSpy).toHaveBeenCalledWith(
        '[systematic] "design/figma-design-sync" in `disabled_agents` is no longer a bundled name and will be ignored. Remove it from your config to silence this warning. See https://fro.bot/systematic/guides/v3-migration/ for migration guidance.',
      )
      warnSpy.mockRestore()
    })
  })

  describe('removed bundled agent categories (warn-and-ignore)', () => {
    test('categories.docs is dropped and warns about its v3.0.0 removal', () => {
      writeUserConfig({ categories: { docs: { model: 'openai/gpt-4' } } })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.categories).not.toHaveProperty('docs')
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(
        /categories\.docs.*removed in v3\.0\.0.*https:\/\/fro\.bot\/systematic\/guides\/v3-migration\//,
      )
      warnSpy.mockRestore()
    })

    test('valid categories remain after removing categories.docs', () => {
      writeUserConfig({
        categories: {
          docs: { model: 'openai/gpt-4' },
          review: { model: 'anthropic/claude-sonnet-4' },
        },
      })
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      const result = loadConfig(testDir)

      expect(result.categories).toEqual({
        review: { model: 'anthropic/claude-sonnet-4' },
      })
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('JSONC precedence', () => {
    test('only systematic.json exists -- loads it (backward compat)', () => {
      writeUserConfig({ disabled_skills: ['ce:plan'] })

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:plan')
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('only systematic.jsonc exists -- loads it correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // This is a comment\n  "disabled_skills": ["ce:review"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toContain('ce:review')
    })

    test('JSONC with comments and standard JSON structure parses correctly', () => {
      const filePath = userConfigPath().replace(/\.json$/, '.jsonc')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(
        filePath,
        '{\n  // Comment explaining why this skill is disabled\n  "disabled_skills": ["ce:plan"]\n}\n',
      )

      const result = loadConfig(testDir)
      expect(result.disabled_skills).toEqual(['ce:plan'])
    })

    test('both jsonc and json exist -- .jsonc is loaded, .json is ignored', () => {
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

  describe('removed-name drop and warn', () => {
    // These tests exercise the drop+warn helpers directly with synthetic inputs.
    // The production removed-names list is empty (the mechanism ships before any
    // name is actually removed), so the real load path cannot be exercised
    // end-to-end without injecting synthetic removed names. The helpers are
    // exported for exactly this purpose.

    test('computeDroppedNames returns names absent from the allowed set', () => {
      const allowed = new Set(['ce:plan', 'ce:review'])
      const result = computeDroppedNames(['ce:plan', 'gone-skill'], allowed)
      expect(result).toEqual(['gone-skill'])
    })

    test('computeDroppedNames returns empty array when all names are in the allowed set', () => {
      const allowed = new Set(['ce:plan', 'ce:review'])
      const result = computeDroppedNames(['ce:plan', 'ce:review'], allowed)
      expect(result).toEqual([])
    })

    test('computeDroppedNames returns empty array for empty input', () => {
      const allowed = new Set(['ce:plan'])
      const result = computeDroppedNames([], allowed)
      expect(result).toEqual([])
    })

    test('computeDroppedNames returns all names when allowed set is empty', () => {
      const allowed = new Set<string>()
      const result = computeDroppedNames(['gone-a', 'gone-b'], allowed)
      expect(result).toEqual(['gone-a', 'gone-b'])
    })

    test('warnDroppedNames emits a [systematic] warning naming each dropped entry', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        warnDroppedNames(['gone-skill'], 'disabled_skills', new Set())
        const calls = warnSpy.mock.calls as unknown[][]
        expect(calls).toHaveLength(1)
        const msg = (calls[0] as unknown[])[0] as string
        expect(msg).toContain('[systematic]')
        expect(msg).toContain('gone-skill')
        expect(msg).toContain('disabled_skills')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames emits no warning when dropped list is empty', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        warnDroppedNames([], 'disabled_skills', new Set())
        expect(warnSpy.mock.calls).toHaveLength(0)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames deduplicates within a single call via the provided warned set', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const warned = new Set<string>()
        // Two entries with the same name -- should warn only once
        warnDroppedNames(
          ['gone-skill', 'gone-skill'],
          'disabled_skills',
          warned,
        )
        expect(warnSpy.mock.calls).toHaveLength(1)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames does not suppress a different entry across separate calls (no sticky global state)', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // First load invocation
        const warned1 = new Set<string>()
        warnDroppedNames(['gone-skill-a'], 'disabled_skills', warned1)

        // Second independent load invocation uses a fresh warned set
        const warned2 = new Set<string>()
        warnDroppedNames(['gone-skill-b'], 'disabled_skills', warned2)

        const calls = warnSpy.mock.calls as unknown[][]
        expect(calls).toHaveLength(2)
        expect((calls[0] as unknown[])[0] as string).toContain('gone-skill-a')
        expect((calls[1] as unknown[])[0] as string).toContain('gone-skill-b')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames does not suppress the same entry in a second independent load (no cross-load suppression)', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // First load invocation
        const warned1 = new Set<string>()
        warnDroppedNames(['gone-skill'], 'disabled_skills', warned1)

        // Second independent load -- fresh warned set, same entry should warn again
        const warned2 = new Set<string>()
        warnDroppedNames(['gone-skill'], 'disabled_skills', warned2)

        expect(warnSpy.mock.calls).toHaveLength(2)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('warnDroppedNames names each dropped entry individually when multiple are dropped', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const warned = new Set<string>()
        warnDroppedNames(['gone-a', 'gone-b'], 'disabled_agents', warned)
        const calls = warnSpy.mock.calls as unknown[][]
        const combined = calls
          .map((c) => (c as unknown[])[0] as string)
          .join('\n')
        expect(combined).toContain('gone-a')
        expect(combined).toContain('gone-b')
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('empty removed-name lists produce no stale-name warning and no behavior change (invariant)', () => {
      // With empty removed lists, the production schema behaves identically to before.
      // A valid config still loads; no stale-name warning is emitted.
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir, { recursive: true })
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          JSON.stringify({ disabled_skills: ['ce:plan'] }),
        )

        const result = loadConfig(testDir)
        expect(result.disabled_skills).toContain('ce:plan')

        const staleWarnings = (warnSpy.mock.calls as unknown[][]).filter(
          (args) =>
            typeof (args as unknown[])[0] === 'string' &&
            ((args as unknown[])[0] as string).includes(
              'no longer a bundled name',
            ),
        )
        expect(staleWarnings).toHaveLength(0)
      } finally {
        warnSpy.mockRestore()
      }
    })

    test('unknown name still throws the actionable schema error (warning path does not swallow it)', () => {
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['never-existed-skill'] }),
      )

      expect(() => loadConfig(testDir)).toThrow(/never-existed-skill/)
    })

    test('merge precedence is unchanged when a valid name is present alongside other config', () => {
      // Verifies that the drop+warn step does not disturb merge precedence for
      // other fields. Project bootstrap.enabled:true overrides user false.
      writeUserConfig({ bootstrap: { enabled: false } })

      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ bootstrap: { enabled: true } }),
      )

      const result = loadConfig(testDir)
      expect(result.bootstrap.enabled).toBe(true)
    })

    test('raw config object is not mutated by the drop step', () => {
      // loadConfigWithSources returns the raw config in overlays; the drop must
      // not mutate it. We verify by checking that the returned config reflects
      // the drop while the raw source config (accessible via a second load) is
      // still intact. Since we cannot directly inspect the raw config object
      // from outside, we verify the effective config is correct and that a
      // second load produces the same result (no mutation side-effect).
      const projectConfigDir = path.join(testDir, '.opencode')
      fs.mkdirSync(projectConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(projectConfigDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:plan'] }),
      )

      const result1 = loadConfig(testDir)
      const result2 = loadConfig(testDir)
      expect(result1.disabled_skills).toEqual(result2.disabled_skills)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // Unit 2 (plan 2026-09-04-002-feat-model-config-profiles): profile
  // selection and the four-entry merge chain (user base -> active profile
  // -> project -> custom).
  // ════════════════════════════════════════════════════════════════════════
  describe('profile selection', () => {
    let warnings: string[]
    let warningSink: (message: string) => void

    beforeEach(() => {
      warnings = []
      warningSink = (message: string) => warnings.push(message)
    })

    function writeProjectConfig(config: Record<string, unknown>): string {
      const dir = path.join(testDir, '.opencode')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, 'systematic.json')
      fs.writeFileSync(filePath, JSON.stringify(config))
      return filePath
    }

    function withCustomConfig<T>(
      config: Record<string, unknown>,
      fn: (customDir: string) => T,
    ): T {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-profile-custom-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir
      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify(config),
      )
      try {
        return fn(customDir)
      } finally {
        delete process.env.OPENCODE_CONFIG_DIR
        fs.rmSync(customDir, { recursive: true, force: true })
      }
    }

    // Case 1: no selector anywhere.
    test('case 1: no source sets profile → base configuration, no warning', () => {
      writeUserConfig({
        profiles: {
          personal: { agents: { 'correctness-reviewer': { model: 'a/a' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBeNull()
      expect(result.metadata.profileFallback).toBeNull()
      expect(warnings).toEqual([])
    })

    // Case 2: user default only.
    test('case 2: user default profile only → that profile is active', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'anthropic/claude-a' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('personal')
      expect(result.metadata.profileSelectorSource).toBe('user')
      expect(result.metadata.profileFallback).toBeNull()
      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'anthropic/claude-a',
      })
      expect(warnings).toEqual([])
    })

    // Case 3: project selector over user default.
    test('case 3: project profile selector wins over user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('work')
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'a/work',
      })
      expect(warnings).toEqual([])
    })

    // Case 4: custom over both.
    test('case 4: custom profile selector wins over project and user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
          work: { agents: { 'correctness-reviewer': { model: 'a/work' } } },
          ci: { agents: { 'correctness-reviewer': { model: 'a/ci' } } },
        },
      })
      writeProjectConfig({ profile: 'work' })

      withCustomConfig({ profile: 'ci' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('ci')
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.config.agents?.['correctness-reviewer']).toEqual({
          model: 'a/ci',
        })
        expect(warnings).toEqual([])
      })
    })

    // Case 5: project names an undefined profile, user default is defined and valid.
    test('case 5: project selects a missing profile, falls back to defined user default with one warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('personal')
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: 'personal',
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
      expect(warnings[0]).toContain('personal')
    })

    // Case 6: project names undefined, user default is also a name that's undefined.
    test('case 6: project selects a missing profile and user default is also missing → base, one warning', () => {
      writeUserConfig({
        profile: 'also-ghost',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
      expect(warnings[0]).toContain('also-ghost')
    })

    // Case 7: project names undefined, no user default at all.
    test('case 7: project selects a missing profile and the user has no default → base, one warning', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'ghost' })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ghost')
    })

    // Case 8: custom names undefined, user default defined and valid.
    test('case 8: custom selects a missing profile, falls back to defined user default', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withCustomConfig({ profile: 'ghost' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBe('personal')
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: 'personal',
        })
        expect(warnings).toHaveLength(1)
      })
    })

    // Case 9: custom names undefined, default undefined.
    test('case 9: custom selects a missing profile and default is missing → base', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      withCustomConfig({ profile: 'ghost' }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toEqual({
          requested: 'ghost',
          usedDefault: null,
        })
        expect(warnings).toHaveLength(1)
      })
    })

    // Case 10: user default itself is undefined (no loop).
    test("case 10: user's own default names a missing profile → base, one warning, no loop", () => {
      writeUserConfig({
        profile: 'ghost',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('user')
      expect(result.metadata.profileFallback).toEqual({
        requested: 'ghost',
        usedDefault: null,
      })
      expect(warnings).toHaveLength(1)
    })

    // Case 11: explicit null wins outright, no warning.
    test('case 11a: project profile: null overrides user default → base, no warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: null })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileSelectorSource).toBe('project')
      expect(result.metadata.profileFallback).toBeNull()
      expect(warnings).toEqual([])
    })

    test('case 11b: custom profile: null overrides a project name → base, no warning', () => {
      writeUserConfig({
        profile: 'personal',
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      writeProjectConfig({ profile: 'personal' })

      withCustomConfig({ profile: null }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.metadata.activeProfile).toBeNull()
        expect(result.metadata.profileSelectorSource).toBe('custom')
        expect(result.metadata.profileFallback).toBeNull()
        expect(warnings).toEqual([])
      })
    })

    // Project `profiles` is protected: stripped, one warning, its bundles are
    // never selectable even if the project also sets `profile`.
    test('project-defined profiles map is stripped with one warning and is never selectable', () => {
      writeUserConfig({
        profiles: {
          personal: {
            agents: { 'correctness-reviewer': { model: 'a/personal' } },
          },
        },
      })
      const projectConfigPath = writeProjectConfig({
        profile: 'sneaky',
        profiles: {
          sneaky: { agents: { 'correctness-reviewer': { model: 'a/sneaky' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      // The project's own 'sneaky' bundle is not in the user's profiles map,
      // so selecting it is exactly the "missing name, no user default" path.
      expect(result.metadata.activeProfile).toBeNull()
      expect(result.metadata.profileFallback).toEqual({
        requested: 'sneaky',
        usedDefault: null,
      })
      expect(result.config.agents?.['correctness-reviewer']).toBeUndefined()

      const profilesWarning = warnings.find((w) => w.includes('`profiles`'))
      expect(profilesWarning).toBeDefined()
      expect(profilesWarning).toContain(projectConfigPath)
      // Exactly one warning about the stripped `profiles` map, plus exactly
      // one about the missing selector fallback -- not more.
      expect(warnings).toHaveLength(2)
    })

    // Merge order: base -> profile -> project -> custom, verifying the
    // four-entry chain composes additively for disjoint fields and later
    // wins for the same field.
    test('merge order: base model A, profile model B, project temperature 0.2, custom model C → effective model C + temperature 0.2', () => {
      writeUserConfig({
        profile: 'p',
        agents: { 'correctness-reviewer': { model: 'a/A' } },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })
      writeProjectConfig({
        agents: { 'correctness-reviewer': { temperature: 0.2 } },
      })

      withCustomConfig(
        { agents: { 'correctness-reviewer': { model: 'a/C' } } },
        () => {
          const result = loadConfigWithSources(testDir, { warningSink })

          expect(result.config.agents?.['correctness-reviewer']).toEqual({
            model: 'a/C',
            temperature: 0.2,
          })
        },
      )
    })

    test('merge order without custom: base model A, profile model B, project temperature 0.2 → effective model B + temperature 0.2', () => {
      writeUserConfig({
        profile: 'p',
        agents: { 'correctness-reviewer': { model: 'a/A' } },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })
      writeProjectConfig({
        agents: { 'correctness-reviewer': { temperature: 0.2 } },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        model: 'a/B',
        temperature: 0.2,
      })
    })

    // Regression: a profile bundle can only ever carry routing fields
    // (ProfileOverlaySchema forbids mode/color/steps/hidden/disable), so
    // switching which profile is active must never change an agent's
    // visibility, permissions, mode, or existence (R7/R10).
    test('profile switch preserves non-routing fields the profile cannot itself carry (disable/hidden/mode/steps)', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': {
            disable: true,
            hidden: true,
            mode: 'subagent',
            steps: 3,
            model: 'a/x',
          },
        },
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'b/y' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']).toEqual({
        disable: true,
        hidden: true,
        mode: 'subagent',
        steps: 3,
        model: 'b/y',
      })
    })

    // Regression: a profile setting only `pi.thinking` must not wipe a base
    // `pi.model` -- R3b requires a profile to be able to set a qualifier
    // alone when the model resolves from a lower layer, including when that
    // lower layer is itself a harness block.
    test('profile pi block merges one level deep: base pi.model survives a profile pi.thinking-only fragment', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': { pi: { model: 'p/m' } },
        },
        profiles: {
          p: {
            agents: { 'correctness-reviewer': { pi: { thinking: 'high' } } },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']?.pi).toEqual({
        model: 'p/m',
        thinking: 'high',
      })
    })

    // Regression: a profile's explicit opencode.model: null must win (opt
    // out of the block's model) while the base block's variant survives.
    test('profile opencode block merges one level deep: explicit model: null wins, base variant survives', () => {
      writeUserConfig({
        profile: 'p',
        agents: {
          'correctness-reviewer': {
            opencode: { model: 'o/m', variant: 'high' },
          },
        },
        profiles: {
          p: {
            agents: {
              'correctness-reviewer': { opencode: { model: null } },
            },
          },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.agents?.['correctness-reviewer']?.opencode).toEqual({
        model: null,
        variant: 'high',
      })
    })

    // Regression: same field-additive guarantee for categories, using a
    // non-routing field (color) the profile schema cannot carry at all.
    test('profile switch preserves a category color field the profile cannot itself carry', () => {
      writeUserConfig({
        profile: 'p',
        categories: { review: { color: 'primary', model: 'a/review-old' } },
        profiles: {
          p: { categories: { review: { model: 'a/review-new' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.categories?.review).toEqual({
        color: 'primary',
        model: 'a/review-new',
      })
    })

    // Non-regression: the pinned custom-replaces-project whole-replace
    // semantics (preserveFieldsAbsentFromNext's narrower field set for
    // non-profile overrides) must be untouched by the profile-layer change.
    test('non-regression: custom config category overlay still replaces project same-key overlay (steps dropped)', () => {
      writeProjectConfig({
        categories: { review: { steps: 8, temperature: 0.1 } },
      })

      withCustomConfig({ categories: { review: { temperature: 0.7 } } }, () => {
        const result = loadConfigWithSources(testDir, { warningSink })
        expect(result.config.categories?.review).toEqual({
          temperature: 0.7,
        })
      })
    })

    test('active profile categories overlay merges into the effective config', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: { categories: { review: { model: 'a/review-model' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.categories?.review).toEqual({
        model: 'a/review-model',
      })
    })

    test('overlays.agents sourcePath for a profile-sourced value points at the user config file', () => {
      const userConfigPath = writeUserConfig({
        profile: 'p',
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.overlays.agents['correctness-reviewer']?.sourcePath).toBe(
        userConfigPath,
      )
    })

    // Code review fix: ConfigSource is now a discriminated union
    // (FileConfigSource | ProfileBundleConfigSource) instead of a
    // `trust: 'user'` file source plus an `isProfileBundle` boolean flag.
    // This test pins the metadata-facing guarantee that change protects:
    // the profile pseudo-source must never be double-counted as a fourth
    // 'user' entry in `sources`/`authorities`, regardless of how many
    // fields the active profile sets.
    test('an active profile never appears as its own entry in metadata sources or authorities', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: {
            agents: { 'correctness-reviewer': { model: 'a/B', variant: 'v2' } },
            categories: { review: { model: 'a/C', temperature: 0.5 } },
          },
        },
        bootstrap: { enabled: true },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.metadata.activeProfile).toBe('p')
      // Exactly the three file-backed sources -- never a fourth entry for
      // the profile bundle, and never a 'profile' kind leaking into the
      // metadata-facing ConfigSourceKind-only shape.
      expect(result.metadata.sources).toEqual([
        { kind: 'custom', presence: 'absent' },
        { kind: 'project', presence: 'absent' },
        { kind: 'user', presence: 'present' },
      ])
      expect(result.metadata.sources).toHaveLength(3)
      for (const source of result.metadata.sources) {
        expect(source.kind).not.toBe('profile')
      }
      // The one authority this config sets (bootstrap.enabled) is correctly
      // attributed to 'user' -- not fabricated as a 'profile' sourceKind,
      // which ConfigSourceKind doesn't even have as a valid value.
      expect(result.metadata.authorities).toContainEqual({
        fieldPath: 'bootstrap.enabled',
        sourceKind: 'user',
      })
      for (const authority of result.metadata.authorities) {
        expect(authority.sourceKind).not.toBe('profile')
      }
    })

    test('the pre-existing three-entry pi_subagents merge and metadata sources are unaffected by an active profile', () => {
      writeUserConfig({
        profile: 'p',
        profiles: {
          p: { agents: { 'correctness-reviewer': { model: 'a/B' } } },
        },
        pi_subagents: { agents: { x: { thinking: 'high' } } },
      })

      const result = loadConfigWithSources(testDir, { warningSink })

      expect(result.config.pi_subagents?.agents?.x).toEqual({
        thinking: 'high',
      })
      expect(result.metadata.sources).toEqual([
        { kind: 'custom', presence: 'absent' },
        { kind: 'project', presence: 'absent' },
        { kind: 'user', presence: 'present' },
      ])
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // Unit 3 (plan 2026-09-04-002-feat-model-config-profiles): the loader's
  // post-merge qualifier-requires-model check, backed by
  // src/lib/routing-resolver.ts. Uses real bundled review-category agents
  // ('correctness-reviewer', 'security-reviewer') since the check only
  // walks targets that resolve to a real bundled agent.
  // ════════════════════════════════════════════════════════════════════════
  describe('routing invariants (post-merge qualifier check)', () => {
    let warnings: string[]
    let warningSink: (message: string) => void

    beforeEach(() => {
      warnings = []
      warningSink = (message: string) => warnings.push(message)
    })

    test('agents.x.variant with no model at any layer throws, naming the agent and opencode', () => {
      writeUserConfig({
        agents: { 'correctness-reviewer': { variant: 'high' } },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /correctness-reviewer/,
      )
      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /opencode/,
      )
    })

    test('agents.x.pi.thinking with no model at any layer throws, naming the agent and pi', () => {
      writeUserConfig({
        agents: {
          'correctness-reviewer': { pi: { thinking: 'high' } },
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /correctness-reviewer/,
      )
      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /pi\.thinking/,
      )
    })

    test('a qualifier with an explicit model: null still throws (null is a model, but this agent has variant with no model at all)', () => {
      // Sanity check the error path is reachable at all through the full
      // loader (not just directly in the resolver): a category-level
      // variant with no model anywhere for this specific agent.
      writeUserConfig({
        categories: { review: { variant: 'high' } },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /opencode/,
      )
    })

    // The 'workflow' category has exactly four bundled agents
    // (bug-reproduction-validator, pr-comment-resolver, spec-flow-analyzer,
    // systematic-implementer) -- small enough to give every member an
    // explicit model in the "valid" case, unlike 'review' (~18 agents).
    test('category variant with no category model is fine when every agent in that category resolves its own model', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          'systematic-implementer': { model: 'a/d' },
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('category variant with no category model errors for the one agent in that category with no model anywhere', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          // 'systematic-implementer' is in 'workflow' too but sets no model
          // anywhere -- it inherits the category's variant with nothing to
          // attach it to.
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /systematic-implementer/,
      )
    })

    // Code review fix: a disabled agent must never block config load on a
    // missing model -- it is never emitted to OpenCode at all, so a
    // category-level qualifier with nothing for it to attach to is moot.
    test('a disabled agent (via disabled_agents) with no model anywhere does not block load', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        disabled_agents: ['systematic-implementer'],
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          // 'systematic-implementer' is disabled and sets no model anywhere.
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('a disabled agent (via agents.<key>.disable) with no model anywhere does not block load', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          'spec-flow-analyzer': { model: 'a/c' },
          'systematic-implementer': { disable: true },
        },
      })

      expect(() =>
        loadConfigWithSources(testDir, { warningSink }),
      ).not.toThrow()
    })

    test('an enabled agent in the same category without a model still errors', () => {
      writeUserConfig({
        categories: { workflow: { variant: 'high' } },
        disabled_agents: ['systematic-implementer'],
        agents: {
          'bug-reproduction-validator': { model: 'a/a' },
          'pr-comment-resolver': { model: 'a/b' },
          // 'spec-flow-analyzer' is enabled and sets no model -- must still error.
        },
      })

      expect(() => loadConfigWithSources(testDir, { warningSink })).toThrow(
        /spec-flow-analyzer/,
      )
    })

    describe('R5: legacy pi_subagents.thinking deprecation warning', () => {
      test('legacy thinking present, no pi block → resolves, one warning', () => {
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'a/m' } },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        const result = loadConfigWithSources(testDir, { warningSink })

        expect(result.config.agents?.['correctness-reviewer']?.model).toBe(
          'a/m',
        )
        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
        expect(legacyWarnings[0]).toContain(
          'agents.correctness-reviewer.pi.thinking',
        )
      })

      test('both legacy and pi block set and disagreeing → pi block wins, warning still emitted once', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': {
              model: 'a/m',
              pi: { thinking: 'high' },
            },
          },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
      })

      test('two targets with legacy thinking → two warnings, one each', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': { model: 'a/m' },
            'security-reviewer': { model: 'a/n' },
          },
          pi_subagents: {
            agents: {
              'correctness-reviewer': { thinking: 'low' },
              'security-reviewer': { thinking: 'medium' },
            },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('pi_subagents'),
        )
        expect(legacyWarnings).toHaveLength(2)
        expect(
          legacyWarnings.some((w) => w.includes('correctness-reviewer')),
        ).toBe(true)
        expect(
          legacyWarnings.some((w) => w.includes('security-reviewer')),
        ).toBe(true)
      })

      test('the same target is only walked once per load → still exactly one warning', () => {
        // The target is reachable via BOTH the agent-key walk AND the
        // category-driven walk (its category also has an overlay), which
        // could in principle produce duplicate entries if collectRoutingTargets
        // didn't dedupe by category/key.
        writeUserConfig({
          agents: { 'correctness-reviewer': { model: 'a/m' } },
          categories: { review: { temperature: 0.2 } },
          pi_subagents: {
            agents: { 'correctness-reviewer': { thinking: 'low' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        const legacyWarnings = warnings.filter((w) =>
          w.includes('correctness-reviewer'),
        )
        expect(legacyWarnings).toHaveLength(1)
      })

      test('no legacy thinking anywhere → no deprecation warning', () => {
        writeUserConfig({
          agents: {
            'correctness-reviewer': { model: 'a/m', pi: { thinking: 'high' } },
          },
        })

        loadConfigWithSources(testDir, { warningSink })

        expect(warnings.filter((w) => w.includes('pi_subagents'))).toHaveLength(
          0,
        )
      })
    })
  })
})

describe('pi_subagents merge and trust', () => {
  let testDir: string
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pisub-test-'))
    originalOsHomedir = os.homedir
    os.homedir = () => path.join(testDir, 'home')
  })

  afterEach(() => {
    if (originalOsHomedir) os.homedir = originalOsHomedir
    fs.rmSync(testDir, { recursive: true, force: true })
    delete process.env.OPENCODE_CONFIG_DIR
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

  function writeProjectConfig(config: Record<string, unknown>): string {
    const projectConfigDir = path.join(testDir, '.opencode')
    fs.mkdirSync(projectConfigDir, { recursive: true })
    const filePath = path.join(projectConfigDir, 'systematic.json')
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }

  test('user config pi_subagents.categories/agents merge into effective config', () => {
    writeUserConfig({
      pi_subagents: {
        categories: { research: { thinking: 'high' } },
        agents: { 'repo-research-analyst': { max_turns: 10 } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents).toEqual({
      categories: { research: { thinking: 'high' } },
      agents: { 'repo-research-analyst': { max_turns: 10 } },
    })
  })

  test('defaults to empty categories/agents maps with no config files', () => {
    const result = loadConfig(testDir)
    expect(result.pi_subagents).toEqual({ categories: {}, agents: {} })
  })

  test('project-sourced thinking/tools/skills are stripped from merged pi_subagents', () => {
    writeProjectConfig({
      pi_subagents: {
        agents: {
          'repo-research-analyst': {
            thinking: 'high',
            tools: '*',
            skills: true,
            max_turns: 5,
          },
        },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ max_turns: 5 })
  })

  test('project-sourced category thinking/tools/skills are stripped; max_turns retained', () => {
    writeProjectConfig({
      pi_subagents: {
        categories: {
          research: {
            thinking: 'medium',
            tools: 'read',
            skills: 'ce:plan',
            max_turns: 5,
          },
        },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.categories?.research).toEqual({
      max_turns: 5,
    })
  })

  test('project cannot resurrect a stripped field by omission when user set it', () => {
    // Project same-key overlay should not erase a higher-trust protected field.
    writeUserConfig({
      pi_subagents: {
        agents: { 'repo-research-analyst': { thinking: 'high', max_turns: 1 } },
      },
    })
    writeProjectConfig({
      pi_subagents: {
        agents: { 'repo-research-analyst': { max_turns: 20 } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ thinking: 'high', max_turns: 20 })
  })

  test('project config setting only protected fields is stripped down to an empty overlay (no throw)', () => {
    writeProjectConfig({
      pi_subagents: { agents: { x: { thinking: 'low' } } },
    })

    expect(() => loadConfigWithSources(testDir)).not.toThrow()
    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.agents?.x).toEqual({})
  })

  test('user/custom config directory may set thinking/tools/skills freely', () => {
    const customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pisub-custom-'),
    )
    process.env.OPENCODE_CONFIG_DIR = customDir
    fs.writeFileSync(
      path.join(customDir, 'systematic.json'),
      JSON.stringify({
        pi_subagents: {
          agents: { x: { thinking: 'high', tools: '*', skills: true } },
        },
      }),
    )

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.agents?.x).toEqual({
      thinking: 'high',
      tools: '*',
      skills: true,
    })

    fs.rmSync(customDir, { recursive: true, force: true })
  })

  test('per-agent pi_subagents value overrides category value at merge time (both present in effective config)', () => {
    writeUserConfig({
      pi_subagents: {
        categories: { research: { thinking: 'low', max_turns: 3 } },
        agents: { 'repo-research-analyst': { thinking: 'high' } },
      },
    })

    const result = loadConfigWithSources(testDir)
    expect(result.config.pi_subagents?.categories?.research).toEqual({
      thinking: 'low',
      max_turns: 3,
    })
    expect(
      result.config.pi_subagents?.agents?.['repo-research-analyst'],
    ).toEqual({ thinking: 'high' })
  })

  test('invalid pi_subagents shape fails validation before merge', () => {
    const projectConfigPath = writeProjectConfig({
      pi_subagents: { agents: { x: { thinking: 'turbo' } } },
    })

    expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
  })

  test('unknown pi_subagents field fails validation under strict schema', () => {
    const projectConfigPath = writeProjectConfig({
      pi_subagents: { agents: { x: { bogus: true } } },
    })

    expect(() => loadConfigWithSources(testDir)).toThrow(projectConfigPath)
  })

  describe('scope-aware config chain (includeProject option)', () => {
    test('default (no options) includes project config', () => {
      writeProjectConfig({
        pi_subagents: { agents: { x: { max_turns: 7 } } },
      })

      const result = loadConfigWithSources(testDir)
      expect(result.config.pi_subagents?.agents?.x).toEqual({ max_turns: 7 })
    })

    test('includeProject: false ignores project config entirely, even when cwd has one', () => {
      writeUserConfig({
        pi_subagents: { agents: { x: { thinking: 'high' } } },
      })
      writeProjectConfig({
        pi_subagents: { agents: { x: { max_turns: 99 } } },
        disabled_skills: ['ce:plan'],
      })

      const result = loadConfigWithSources(testDir, { includeProject: false })
      // project-sourced max_turns must be entirely absent — not merged, not stripped-to-empty
      expect(result.config.pi_subagents?.agents?.x).toEqual({
        thinking: 'high',
      })
      expect(result.config.disabled_skills).not.toContain('ce:plan')
    })

    test('includeProject: false still loads user and custom config', () => {
      const customDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-pisub-scope-'),
      )
      process.env.OPENCODE_CONFIG_DIR = customDir
      writeUserConfig({ disabled_skills: ['ce:brainstorm'] })
      fs.writeFileSync(
        path.join(customDir, 'systematic.json'),
        JSON.stringify({ disabled_skills: ['ce:work'] }),
      )
      writeProjectConfig({ disabled_skills: ['ce:plan'] })

      const result = loadConfigWithSources(testDir, { includeProject: false })
      expect(result.config.disabled_skills).toContain('ce:brainstorm')
      expect(result.config.disabled_skills).toContain('ce:work')
      expect(result.config.disabled_skills).not.toContain('ce:plan')

      fs.rmSync(customDir, { recursive: true, force: true })
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
