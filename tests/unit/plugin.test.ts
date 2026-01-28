import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC_DIR = path.resolve(import.meta.dirname, '../../src')
const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

describe('plugin loading', () => {
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
    expect(pluginModule.SystematicPlugin).toBeDefined()
  })

  test('cli runs under Bun', async () => {
    const cliPath = path.join(SRC_DIR, 'cli.ts')
    const result = Bun.spawnSync(['bun', cliPath, '--help'])
    expect(result.exitCode).toBe(0)
  })
})

describe('bundled content', () => {
  test('skills directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'skills'))).toBe(true)
  })

  test('agents directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'agents'))).toBe(true)
  })

  test('commands directory exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'commands'))).toBe(true)
  })

  test('bundled skills have valid structure', () => {
    const skillsDir = path.join(ROOT_DIR, 'skills')
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const stat = fs.statSync(path.join(skillsDir, f))
      return stat.isDirectory()
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

  test('bundled commands have valid structure', () => {
    const commandsDir = path.join(ROOT_DIR, 'commands')
    const commandFiles = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))

    expect(commandFiles.length).toBeGreaterThan(0)
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
    expect(output).toContain('brainstorming')
  })

  test('cli list agents shows bundled agents', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'agents'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('architecture-strategist')
  })

  test('cli list commands shows bundled commands', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'list', 'commands'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('/workflows:plan')
  })

  test('cli config path shows paths', () => {
    const result = Bun.spawnSync(['bun', CLI_PATH, 'config', 'path'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('User:')
    expect(output).toContain('Project:')
  })
})
