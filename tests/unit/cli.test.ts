import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.ts')

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-cli-test-'))
}

function runCli(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

describe('cli setup --harness', () => {
  it('help text documents both harness values', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['--help'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('setup --harness')
      expect(result.stdout).toContain('opencode|pi')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('happy path: setup --harness opencode configures project-local plugin', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'opencode'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('opencode.jsonc')
      expect(result.stdout).toMatch(/configured/i)

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, 'opencode.jsonc'), 'utf8'),
      ) as { plugin?: unknown[] }
      expect(written.plugin).toEqual(['@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('happy path: setup --harness pi configures .pi/settings.json', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'pi'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('.pi/settings.json')

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, '.pi/settings.json'), 'utf8'),
      ) as { packages?: unknown[] }
      expect(written.packages).toEqual(['npm:@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('idempotent: rerunning setup --harness pi reports already configured, no dup writes', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['setup', '--harness', 'pi'], cwd)
      const second = runCli(['setup', '--harness', 'pi'], cwd)
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toMatch(/already configured/i)

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, '.pi/settings.json'), 'utf8'),
      ) as { packages?: unknown[] }
      expect(written.packages).toEqual(['npm:@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('coexistence: .opencode/opencode.jsonc wins over a root opencode.json', () => {
    const cwd = mkTempCwd()
    try {
      fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
      fs.mkdirSync(path.join(cwd, '.opencode'))
      fs.writeFileSync(
        path.join(cwd, '.opencode/opencode.jsonc'),
        '{ "plugin": [] }',
      )
      const result = runCli(['setup', '--harness', 'opencode'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        path.join(cwd, '.opencode/opencode.jsonc'),
      )
      expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
        '{}',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('isolation: setup --harness pi never writes opencode config', () => {
    const cwd = mkTempCwd()
    try {
      fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
      runCli(['setup', '--harness', 'pi'], cwd)
      expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
        '{}',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('missing --harness value fails clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('unknown --harness value fails clearly with nonzero exit, no writes, and stderr (not stdout) usage', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'bogus'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
      expect(result.stderr).toContain('Available: opencode, pi')
      expect(result.stdout).not.toContain('Available: opencode, pi')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('extra positional args after harness value fail clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(
        ['setup', '--harness', 'opencode', 'extra-arg'],
        cwd,
      )
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('missing --harness flag entirely fails clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('no --global flag exists (rejected as unknown extra arg)', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'opencode', '--global'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
