import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { GENERATED_SURFACES } from '../../scripts/lib/generated-surfaces.js'

/**
 * `paths-ignore` removes code from the security scan, so every entry has to
 * earn its place. A generated bundle is safe to skip: its own code comes from
 * `src/` (scanned) and the rest is inlined third-party packages. Anything else
 * hides first-party code from CodeQL.
 */

const CONFIG_PATH = path.resolve(
  process.cwd(),
  '.github/codeql/codeql-config.yml',
)

/** Ignored for a reason other than "generated"; see the comment in the config. */
const NON_GENERATED_ALLOWLIST: readonly string[] = ['tests/manual']

function readIgnoredPaths(): string[] {
  const { JSON_SCHEMA } = yaml
  const config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'), {
    schema: JSON_SCHEMA,
  }) as { 'paths-ignore'?: string[] }
  return config['paths-ignore'] ?? []
}

/** Directory-prefix or glob match, the two forms a CodeQL path entry takes. */
function isIgnoredBy(entry: string, file: string): boolean {
  const normalized = entry.replace(/\/+$/, '')
  return (
    file === normalized ||
    file.startsWith(`${normalized}/`) ||
    new Bun.Glob(normalized).match(file)
  )
}

const generatedOutputs = GENERATED_SURFACES.flatMap((surface) =>
  surface.outputs.filter((output) => !output.includes('*')),
)

describe('codeql config paths-ignore', () => {
  test('every ignored path is a generated surface output or an allowlisted exception', () => {
    const allowed = new Set([...generatedOutputs, ...NON_GENERATED_ALLOWLIST])
    const unexpected = readIgnoredPaths().filter((entry) => !allowed.has(entry))
    expect(unexpected).toEqual([])
  })

  test('the generated bundles are ignored and exist', () => {
    const ignored = readIgnoredPaths()
    for (const bundle of [
      'skills/ce-connect/scripts/connect.mjs',
      'skills/ce-review/scripts/validate-review.mjs',
    ]) {
      expect(ignored).toContain(bundle)
      expect(fs.existsSync(path.resolve(process.cwd(), bundle))).toBe(true)
    }
  })

  test('no ignored entry covers a file under src/', () => {
    const ignored = readIgnoredPaths()
    const sourceFiles = [...new Bun.Glob('src/**/*.ts').scanSync('.')]
    expect(sourceFiles.length).toBeGreaterThan(0)
    const hidden = sourceFiles.filter((file) =>
      ignored.some((entry) => isIgnoredBy(entry, file)),
    )
    expect(hidden).toEqual([])
  })

  test('isIgnoredBy treats a bare directory entry as a prefix', () => {
    expect(isIgnoredBy('src', 'src/lib/a.ts')).toBe(true)
    expect(isIgnoredBy('src/**', 'src/lib/a.ts')).toBe(true)
    expect(isIgnoredBy('src-other', 'src/lib/a.ts')).toBe(false)
  })
})
