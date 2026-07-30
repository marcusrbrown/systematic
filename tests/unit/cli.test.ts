import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MANIFEST_FILENAME } from '../../src/lib/pi-subagents-export.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.ts')

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-cli-test-'))
}

function runCli(
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env,
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

// ---------------------------------------------------------------------------
// CLI: pi-subagents command
// ---------------------------------------------------------------------------

describe('cli pi-subagents', () => {
  it('pi-subagents with no subcommand prints usage and exits nonzero', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(
        /usage|subcommand|preview|export|refresh|cleanup/i,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('pi-subagents with unknown subcommand exits nonzero', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'bogus'], cwd)
      expect(result.exitCode).not.toBe(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('backward compat: existing setup --harness pi still works', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'pi'], cwd)
      expect(result.exitCode).toBe(0)
      expect(fs.existsSync(path.join(cwd, '.pi', 'settings.json'))).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preview: exits 0 and writes nothing', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'preview'], cwd)
      expect(result.exitCode).toBe(0)
      // No .pi/agents directory created
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(false)
      // Output mentions the target path and some action words
      expect(result.stdout).toMatch(/\.pi[/\\]agents/i)
      expect(result.stdout).toMatch(/create|update|refuse/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preview --scope global: exits 0 and writes nothing, shows global path', () => {
    const cwd = mkTempCwd()
    const fakeGlobal = mkTempCwd()
    try {
      const result = runCli(
        ['pi-subagents', 'preview', '--scope', 'global'],
        cwd,
        { PI_CODING_AGENT_DIR: fakeGlobal },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(fakeGlobal)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(fakeGlobal, { recursive: true, force: true })
    }
  })

  it('export: writes persona files under .pi/agents/', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      const agentsDir = path.join(cwd, '.pi', 'agents')
      expect(fs.existsSync(agentsDir)).toBe(true)

      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) {
        expect(f).toMatch(/^systematic-[a-z0-9-]+\.md$/)
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export: prints per-file preview action lines before the mutation summary', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      const targetIdx = result.stdout.indexOf('Target:')
      const createIdx = result.stdout.indexOf('(create)')
      const summaryIdx = result.stdout.indexOf('Summary:')
      const exportedIdx = result.stdout.indexOf('Exported')

      // Preview renders per-file action lines (e.g. "+ foo.md  (create)")
      expect(createIdx).toBeGreaterThan(-1)
      // Preview renders a Summary line before the export mutates anything
      expect(summaryIdx).toBeGreaterThan(-1)
      // Ordering: target, then action lines, then summary, then mutation result
      expect(targetIdx).toBeGreaterThan(-1)
      expect(createIdx).toBeGreaterThan(targetIdx)
      expect(summaryIdx).toBeGreaterThan(createIdx)
      expect(exportedIdx).toBeGreaterThan(summaryIdx)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export idempotent: second run reports no changes', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const result2 = runCli(['pi-subagents', 'export'], cwd)
      expect(result2.exitCode).toBe(0)
      expect(result2.stdout).toMatch(/no changes|up.to.date|already/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export refuses to overwrite pre-existing unowned file', () => {
    const cwd = mkTempCwd()
    try {
      const agentsDir = path.join(cwd, '.pi', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(
        path.join(agentsDir, 'systematic-adversarial-reviewer.md'),
        'user content',
      )

      runCli(['pi-subagents', 'export'], cwd)
      // Export with pre-existing unowned file: either nonzero or ok with warning
      // Either way, the user file must be untouched
      expect(
        fs.readFileSync(
          path.join(agentsDir, 'systematic-adversarial-reviewer.md'),
          'utf-8',
        ),
      ).toBe('user content')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refresh: reports drift after manual file edit', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const agentsDir = path.join(cwd, '.pi', 'agents')
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      const first = files[0]
      expect(first).toBeDefined()
      if (!first) return
      const filePath = path.join(agentsDir, first)
      const original = fs.readFileSync(filePath, 'utf-8')
      fs.appendFileSync(filePath, '\n<!-- drift -->')

      const result = runCli(['pi-subagents', 'refresh'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/updated|refresh|restored/i)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('cleanup: removes all generated files and manifest, leaves user files', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const agentsDir = path.join(cwd, '.pi', 'agents')
      // Plant a user file
      fs.writeFileSync(path.join(agentsDir, 'my-agent.md'), 'user')

      const result = runCli(['pi-subagents', 'cleanup'], cwd)
      expect(result.exitCode).toBe(0)

      // All systematic-*.md gone
      const remaining = fs
        .readdirSync(agentsDir)
        .filter((f) => f !== 'my-agent.md')
      expect(remaining).toHaveLength(0)
      // User file survives
      expect(
        fs.readFileSync(path.join(agentsDir, 'my-agent.md'), 'utf-8'),
      ).toBe('user')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('default scope is project when --scope omitted', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--scope global writes to PI_CODING_AGENT_DIR/agents', () => {
    const cwd = mkTempCwd()
    const globalBase = mkTempCwd()
    try {
      const result = runCli(
        ['pi-subagents', 'export', '--scope', 'global'],
        cwd,
        { PI_CODING_AGENT_DIR: globalBase },
      )
      expect(result.exitCode).toBe(0)
      const agentsDir = path.join(globalBase, 'agents')
      expect(fs.existsSync(agentsDir)).toBe(true)
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      expect(files.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(globalBase, { recursive: true, force: true })
    }
  })

  it('export applies trusted custom-config-dir model overlay to matching exported persona', () => {
    const cwd = mkTempCwd()
    const customConfigDir = mkTempCwd()
    try {
      fs.writeFileSync(
        path.join(customConfigDir, 'systematic.json'),
        JSON.stringify({
          agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
        }),
      )

      const result = runCli(['pi-subagents', 'export'], cwd, {
        OPENCODE_CONFIG_DIR: customConfigDir,
      })
      expect(result.exitCode).toBe(0)

      const target = path.join(
        cwd,
        '.pi',
        'agents',
        'systematic-repo-research-analyst.md',
      )
      expect(fs.existsSync(target)).toBe(true)
      expect(fs.readFileSync(target, 'utf-8')).toMatch(
        /^model: "openai\/gpt-5"$/m,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(customConfigDir, { recursive: true, force: true })
    }
  })

  it('export fails closed on malformed pi_subagents config before writing anything', () => {
    const cwd = mkTempCwd()
    const customConfigDir = mkTempCwd()
    try {
      fs.writeFileSync(
        path.join(customConfigDir, 'systematic.json'),
        JSON.stringify({
          pi_subagents: { agents: { x: { thinking: 'turbo' } } },
        }),
      )

      const result = runCli(['pi-subagents', 'export'], cwd, {
        OPENCODE_CONFIG_DIR: customConfigDir,
      })
      expect(result.exitCode).not.toBe(0)
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(customConfigDir, { recursive: true, force: true })
    }
  })

  it('export with a remove-only plan (stale manifest-owned file, nothing to create/update) still invokes exportPersonas and removes the stale file', () => {
    const cwd = mkTempCwd()
    try {
      // Populate the manifest-owned persona set first via a real export.
      const first = runCli(['pi-subagents', 'export'], cwd)
      expect(first.exitCode).toBe(0)
      const agentsDir = path.join(cwd, '.pi', 'agents')

      // Inject a stale manifest entry (no longer curated) for a file that
      // exists on disk with a hash matching the manifest — this makes the
      // plan remove-only: no create/update/refuse actions, only `remove`.
      const manifestPath = path.join(agentsDir, MANIFEST_FILENAME)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        generatedAt: string
        agentsRoot: string
        files: { filename: string; hash: string; status: string }[]
      }
      const staleFilename = 'systematic-no-longer-curated.md'
      const staleContent = 'stale content'
      fs.writeFileSync(
        path.join(agentsDir, staleFilename),
        staleContent,
        'utf-8',
      )
      manifest.files.push({
        filename: staleFilename,
        hash: crypto.createHash('sha256').update(staleContent).digest('hex'),
        status: 'exported',
      })
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

      // Second export: every curated persona is already up to date (skip),
      // and the only action in the plan is the `remove` of the stale file.
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      // The stale file must actually be removed — proves exportPersonas ran
      // rather than short-circuiting on "no create/update/refuse" work.
      expect(fs.existsSync(path.join(agentsDir, staleFilename))).toBe(false)

      // The final mutation-result line must not claim "no changes", since a
      // removal did happen (per-file preview lines legitimately say
      // "(up to date)" for the still-current personas — only the terminal
      // summary sentence is under test here).
      expect(result.stdout).not.toContain(
        'All persona files are already up to date. No changes.',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
