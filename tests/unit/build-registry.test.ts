import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts/build-registry.ts')
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist/registry')

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

  it('writes normalized target paths for agents', () => {
    const result = runRegistryScript(['--version', '1.2.3'])

    expect(result.exitCode).toBe(0)

    const packumentPath = path.join(
      OUTPUT_DIR,
      'components',
      'agent-design-implementation-reviewer.json',
    )
    const packument = JSON.parse(fs.readFileSync(packumentPath, 'utf-8')) as {
      versions: Record<
        string,
        { files?: Array<{ target: string }> | undefined }
      >
    }
    const files = packument.versions['1.2.3'].files ?? []

    expect(files.length).toBeGreaterThan(0)
    expect(files[0].target).toContain('.opencode/agent/')
    expect(files[0].target).not.toContain('.opencode/agents/')
  })
})
