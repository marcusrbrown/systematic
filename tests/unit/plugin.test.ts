import { beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _resetPluginSingleton } from '../../src/lib/plugin-singleton.js'

const SRC_DIR = path.resolve(import.meta.dirname, '../../src')
const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

describe('plugin loading', () => {
  // Reset singleton between cases so factory invocations across tests do not
  // share cached hooks. `globalThis` state otherwise leaks across the file.
  beforeEach(() => {
    _resetPluginSingleton()
  })

  test('plugin file exists at src/index.ts', () => {
    const pluginPath = path.join(SRC_DIR, 'index.ts')
    expect(fs.existsSync(pluginPath)).toBe(true)
  })

  test('cli file exists at src/cli.ts', () => {
    const cliPath = path.join(SRC_DIR, 'cli.ts')
    expect(fs.existsSync(cliPath)).toBe(true)
  })

  test('plugin module loads', async () => {
    const pluginPath = path.join(SRC_DIR, 'index.ts')
    const pluginModule = await import(pathToFileURL(pluginPath).href)
    expect(pluginModule.default).toBeDefined()
    expect(pluginModule.SystematicPlugin).toBeUndefined()
  })

  test('plugin snapshots bootstrap content at init instead of re-reading files per transform', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-plugin-'))
    const opencodeDir = path.join(tempDir, '.opencode')
    const bootstrapPath = path.join(tempDir, 'bootstrap.md')
    const configPath = path.join(opencodeDir, 'systematic.json')

    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(bootstrapPath, 'INITIAL bootstrap content')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        bootstrap: {
          enabled: true,
          file: bootstrapPath,
        },
      }),
    )

    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: {
          client: { app: { log: (entry: unknown) => Promise<void> } }
          directory: string
        }) => Promise<{
          'experimental.chat.system.transform': (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        }>
      }

      const plugin = await pluginModule.default({
        client: {
          app: {
            log: async () => {},
          },
        },
        directory: tempDir,
      })

      fs.writeFileSync(bootstrapPath, 'UPDATED bootstrap content')

      const output = { system: ['Existing system prompt'] }
      await plugin['experimental.chat.system.transform']({}, output)

      expect(output.system).toEqual([
        'Existing system prompt\n\nINITIAL bootstrap content',
      ])
      expect(output.system[0]).not.toContain('UPDATED bootstrap content')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('CI smoke test validates the workflow plugin export and registry drift contract', () => {
    const workflowPath = path.join(ROOT_DIR, '.github/workflows/main.yaml')
    const workflow = fs.readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain('const pluginFactory = m.default;')
    expect(workflow).toContain('await pluginFactory({')
    expect(workflow).not.toContain('m.SystematicPlugin')
    expect(workflow).toContain('bun run registry:drift')
  })

  test('package exposes distinct registry validation and drift commands', () => {
    const packageJsonPath = path.join(ROOT_DIR, 'package.json')
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    ) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['registry:validate']).toBe(
      'bun scripts/build-registry.ts --validate-only',
    )
    expect(packageJson.scripts?.['registry:drift']).toBe(
      'bun scripts/generate-registry.ts --check',
    )
  })

  test('cli runs under Bun', async () => {
    const cliPath = path.join(SRC_DIR, 'cli.ts')
    const result = Bun.spawnSync(['bun', cliPath, '--help'])
    expect(result.exitCode).toBe(0)
  })

  test('duplicate factory invocations return real hooks without warnings', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-singleton-'),
    )
    const opencodeDir = path.join(tempDir, '.opencode')
    fs.mkdirSync(opencodeDir, { recursive: true })

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }

    try {
      const pluginPath = path.join(SRC_DIR, 'index.ts')
      const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
        default: (args: {
          client: { app: { log: (entry: unknown) => Promise<void> } }
          directory: string
        }) => Promise<Record<string, unknown>>
      }

      const input = {
        client: {
          app: {
            log: async () => {},
          },
        },
        directory: tempDir,
      }

      const hooks1 = await pluginModule.default(input)
      const hooks2 = await pluginModule.default(input)
      const hooks3 = await pluginModule.default(input)

      // All invocations — including duplicates — get the real hook surface
      // (config + tool + transform). The singleton returns cached real hooks
      // instead of an empty object, so the OpenCode host never sees a stale
      // registration surface from duplicate config sources.
      for (const hooks of [hooks1, hooks2, hooks3]) {
        expect(hooks.tool).toBeDefined()
        expect(hooks.config).toBeDefined()
        expect(hooks['experimental.chat.system.transform']).toBeDefined()
      }

      // No duplicate warnings are emitted.
      const duplicateWarnings = warnings.filter((w) =>
        w.includes('duplicate factory invocation'),
      )
      expect(duplicateWarnings.length).toBe(0)
    } finally {
      console.warn = originalWarn
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('bundled content', () => {
  test('skills directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'skills'))).toBe(true)
  })

  test('agents directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'agents'))).toBe(true)
  })

  test('commands directory removed (commands converted to skills)', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'commands'))).toBe(false)
  })

  test('bundled skills have valid structure', () => {
    const skillsDir = path.join(ROOT_DIR, 'skills')
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const fullPath = path.join(skillsDir, f)
      return (
        fs.statSync(fullPath).isDirectory() &&
        fs.existsSync(path.join(fullPath, 'SKILL.md'))
      )
    })

    expect(skillDirs.length).toBeGreaterThan(0)

    for (const skillName of skillDirs) {
      const skillPath = path.join(skillsDir, skillName, 'SKILL.md')
      expect(fs.existsSync(skillPath)).toBe(true)
    }
  })

  test('bundled agents have valid structure', () => {
    const agentsDir = path.join(ROOT_DIR, 'agents')
    const reviewDir = path.join(agentsDir, 'review')
    const agentFiles = fs
      .readdirSync(reviewDir)
      .filter((f) => f.endsWith('.md'))

    expect(agentFiles.length).toBeGreaterThan(0)
  })

  test('bundled skills cover former commands', () => {
    const skillsDir = path.join(ROOT_DIR, 'skills')
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const stat = fs.statSync(path.join(skillsDir, f))
      return stat.isDirectory()
    })
    expect(skillDirs.length).toBeGreaterThan(0)
    expect(skillDirs).toContain('ce-brainstorm')
    expect(skillDirs).toContain('ce-plan')
    expect(skillDirs).toContain('ce-review')
    expect(skillDirs).toContain('ce-work')
    expect(skillDirs).toContain('ce-compound')
  })
})

describe('CLI functionality', () => {
  const CLI_PATH = path.join(SRC_DIR, 'cli.ts')

  test('cli --help returns usage info', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, '--help'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('systematic')
    expect(output).toContain('convert')
    expect(output).toContain('list')
    expect(output).toContain('config')
  })

  test('cli --version returns version', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, '--version'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toMatch(/systematic v\d+\.\d+\.\d+/)
  })

  test('cli list skills shows bundled skills', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'skills'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('ce:brainstorm')
  })

  test('cli list agents shows bundled agents', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'agents'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('architecture-strategist')
  })

  test('cli list commands exits successfully with empty result', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'commands'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('No commands found')
  })

  test('cli config path shows paths', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'config', 'path'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('User:')
    expect(output).toContain('Project:')
  })
})
