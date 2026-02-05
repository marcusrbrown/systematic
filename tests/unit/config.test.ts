import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfig,
} from '../../src/lib/config.ts'

describe('config', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

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
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const oldExists = fs.existsSync(userConfigDir)
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null

        if (oldExists && fs.existsSync(userConfigPath)) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              disabled_agents: ['agent-1'],
            }),
          )

          const result = loadConfig(testDir)
          expect(result.disabled_agents).toContain('agent-1')
          expect(result.disabled_skills).toEqual([])
          expect(result.disabled_commands).toEqual([])
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })
    })

    describe('both configs', () => {
      test('project config overrides user config', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              disabled_skills: ['user-skill'],
            }),
          )

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
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })

      test('project bootstrap overrides user bootstrap', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              bootstrap: {
                enabled: true,
              },
            }),
          )

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
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
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
            disabled_skills: ['skill-a', 'skill-b', 'skill-a'],
          }),
        )

        const result = loadConfig(testDir)
        const uniqueSkills = new Set(result.disabled_skills)
        expect(uniqueSkills.size).toBe(result.disabled_skills.length)
      })

      test('combines user and project disabled_skills arrays', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              disabled_skills: ['skill-a'],
            }),
          )

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
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })

      test('combines user and project disabled_agents arrays', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              disabled_agents: ['agent-a'],
            }),
          )

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
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })

      test('combines user and project disabled_commands arrays', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              disabled_commands: ['cmd-a'],
            }),
          )

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
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })
    })

    describe('object merging (bootstrap)', () => {
      test('spreads bootstrap properties from user config', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              bootstrap: {
                file: 'user-bootstrap.md',
              },
            }),
          )

          const result = loadConfig(testDir)
          expect(result.bootstrap.file).toBe('user-bootstrap.md')
          expect(result.bootstrap.enabled).toBe(true)
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })

      test('project bootstrap fields override user bootstrap fields via spread merge', () => {
        const userConfigDir = path.join(os.homedir(), '.config/opencode')
        const userConfigPath = path.join(userConfigDir, 'systematic.json')
        let userConfigBackup: string | null = null
        const oldUserExists = fs.existsSync(userConfigPath)

        if (oldUserExists) {
          userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
        }

        try {
          fs.mkdirSync(userConfigDir, { recursive: true })
          fs.writeFileSync(
            userConfigPath,
            JSON.stringify({
              bootstrap: {
                enabled: true,
                file: 'user-bootstrap.md',
              },
            }),
          )

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
          expect(result.bootstrap.file).toBe('user-bootstrap.md')
        } finally {
          if (userConfigBackup) {
            fs.writeFileSync(userConfigPath, userConfigBackup)
          } else if (fs.existsSync(userConfigPath)) {
            fs.unlinkSync(userConfigPath)
          }
        }
      })
    })

    describe('malformed configs', () => {
      test('ignores project config if it has invalid JSON', () => {
        const projectConfigDir = path.join(testDir, '.opencode')
        fs.mkdirSync(projectConfigDir)
        fs.writeFileSync(
          path.join(projectConfigDir, 'systematic.json'),
          '{invalid json',
        )

        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
      })

      test('ignores project config if it does not exist', () => {
        const result = loadConfig(testDir)
        expect(result).toEqual(DEFAULT_CONFIG)
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
      const userConfigDir = path.join(os.homedir(), '.config/opencode')
      const userConfigPath = path.join(userConfigDir, 'systematic.json')
      let userConfigBackup: string | null = null
      const oldUserExists = fs.existsSync(userConfigPath)

      if (oldUserExists) {
        userConfigBackup = fs.readFileSync(userConfigPath, 'utf-8')
      }

      try {
        const customDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'systematic-custom-'),
        )
        process.env.OPENCODE_CONFIG_DIR = customDir

        fs.mkdirSync(userConfigDir, { recursive: true })
        fs.writeFileSync(
          userConfigPath,
          JSON.stringify({ disabled_skills: ['user-skill'] }),
        )

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
      } finally {
        if (userConfigBackup) {
          fs.writeFileSync(userConfigPath, userConfigBackup)
        } else if (fs.existsSync(userConfigPath)) {
          fs.unlinkSync(userConfigPath)
        }
      }
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
