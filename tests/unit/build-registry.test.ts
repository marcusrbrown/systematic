import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts/build-registry.ts')
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist/registry')

interface PackumentFile {
  path: string
  target: string
  integrity: string
}

interface PackumentVersion {
  files?: PackumentFile[]
}

interface Packument {
  versions: Record<string, PackumentVersion>
}

function runRegistryScript(args: string[]): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function readPackument(componentName: string): Packument {
  const packumentPath = path.join(
    OUTPUT_DIR,
    'components',
    `${componentName}.json`,
  )
  return JSON.parse(fs.readFileSync(packumentPath, 'utf-8')) as Packument
}

describe('build-registry script', () => {
  it('runs validation with explicit version', () => {
    const result = runRegistryScript(['--validate-only', '--version', '1.2.3'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Version: 1.2.3')
    expect(result.stdout).toContain('Validation passed.')
  })

  it('rejects invalid explicit version', () => {
    const result = runRegistryScript(['--validate-only', '--version', '1.2'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Invalid version format')
  })

  it('produces V2 string-shorthand targets for agents (no .opencode/ prefix)', () => {
    const result = runRegistryScript(['--version', '1.2.3'])

    expect(result.exitCode).toBe(0)

    const packument = readPackument('agent-design-implementation-reviewer')
    const files = packument.versions['1.2.3']?.files ?? []

    expect(files.length).toBeGreaterThan(0)
    const file = files[0]
    expect(file).toBeDefined()
    if (!file) return
    // V2: source path equals target path (string shorthand resolves to {path: x, target: x})
    expect(file.target).toBe(file.path)
    // V2 paths are repo-root-relative with no .opencode/ prefix and no singularization
    expect(file.target).toBe('agents/design/design-implementation-reviewer.md')
    expect(file.target).not.toContain('.opencode/')
    expect(file.target).not.toMatch(/^\.opencode\/agent\//)
  })

  it('produces V2 string-shorthand targets for skills (no .opencode/ prefix)', () => {
    const result = runRegistryScript(['--version', '1.2.3'])

    expect(result.exitCode).toBe(0)

    const packument = readPackument('agent-browser')
    const files = packument.versions['1.2.3']?.files ?? []

    expect(files.length).toBeGreaterThan(0)
    const skillMd = files.find((f) => f.path.endsWith('SKILL.md'))
    expect(skillMd).toBeDefined()
    if (!skillMd) return
    expect(skillMd.target).toBe(skillMd.path)
    expect(skillMd.target).toBe('skills/agent-browser/SKILL.md')
    expect(skillMd.target).not.toContain('.opencode/')
  })

  it('preserves {path, target} object form for profile entries (source != target)', () => {
    const result = runRegistryScript(['--version', '1.2.3'])

    expect(result.exitCode).toBe(0)

    const packument = readPackument('standalone')
    const files = packument.versions['1.2.3']?.files ?? []

    expect(files.length).toBeGreaterThan(0)
    const opencodeJsonc = files.find((f) => f.path.endsWith('opencode.jsonc'))
    expect(opencodeJsonc).toBeDefined()
    if (!opencodeJsonc) return
    // Profile installs to project root with a different target than the source path
    expect(opencodeJsonc.path).toBe(
      'registry/files/profiles/standalone/opencode.jsonc',
    )
    expect(opencodeJsonc.target).toBe('opencode.jsonc')
  })
})
