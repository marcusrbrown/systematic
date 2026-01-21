import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const DIST_DIR = path.resolve(import.meta.dirname, '../../dist')
const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

describe('plugin loading', () => {
  test('plugin file exists at dist/index.js', () => {
    const pluginPath = path.join(DIST_DIR, 'index.js')
    expect(fs.existsSync(pluginPath)).toBe(true)
  })

  test('cli file exists at dist/cli.js', () => {
    const cliPath = path.join(DIST_DIR, 'cli.js')
    expect(fs.existsSync(cliPath)).toBe(true)
  })

  test('plugin is valid JavaScript', async () => {
    const pluginPath = path.join(DIST_DIR, 'index.js')
    const result = Bun.spawnSync(['node', '--check', pluginPath])
    expect(result.exitCode).toBe(0)
  })

  test('cli is valid JavaScript', async () => {
    const cliPath = path.join(DIST_DIR, 'cli.js')
    const result = Bun.spawnSync(['node', '--check', cliPath])
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

  test('bootstrap.md exists at top level', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'bootstrap.md'))).toBe(true)
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
    const agentFiles = fs
      .readdirSync(agentsDir)
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
  const CLI_PATH = path.join(DIST_DIR, 'cli.js')

  test('cli --help returns usage info', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, '--help'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('systematic')
    expect(output).toContain('init')
    expect(output).toContain('list')
    expect(output).toContain('config')
  })

  test('cli --version returns version', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, '--version'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toMatch(/systematic v\d+\.\d+\.\d+/)
  })

  test('cli list skills shows bundled skills', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, 'list', 'skills'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('brainstorming')
    expect(output).toContain('bundled')
  })

  test('cli list agents shows bundled agents', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, 'list', 'agents'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('architecture-strategist')
    expect(output).toContain('bundled')
  })

  test('cli list commands shows bundled commands', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, 'list', 'commands'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('/sys:plan')
    expect(output).toContain('bundled')
  })

  test('cli config path shows paths', () => {
    const result = Bun.spawnSync(['node', CLI_PATH, 'config', 'path'])
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('User:')
    expect(output).toContain('Project:')
  })
})
