import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readOpencodeDevDependencyPins,
  readOpencodeSdkPin,
} from '../../scripts/lib/opencode-pin.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = []

function makeTempDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pin-'))
  TEMP_ROOTS.push(tmp)
  return tmp
}

function writePackageJson(dir: string, contents: unknown): string {
  const full = path.join(dir, 'package.json')
  fs.writeFileSync(full, JSON.stringify(contents), 'utf-8')
  return full
}

function writeDevDependencies(
  dir: string,
  devDependencies: Record<string, unknown>,
): string {
  return writePackageJson(dir, { devDependencies })
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('readPackageJson error branches (via readOpencodeSdkPin)', () => {
  test('throws when the package.json file does not exist', () => {
    const dir = makeTempDir()
    const missingPath = path.join(dir, 'package.json')

    expect(() => readOpencodeSdkPin(missingPath)).toThrow(/Failed to read/)
  })

  test('throws when the package.json file is not valid JSON', () => {
    const dir = makeTempDir()
    const pkgPath = path.join(dir, 'package.json')
    fs.writeFileSync(pkgPath, '{ not valid json', 'utf-8')

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(/Failed to parse/)
  })

  test('throws when the parsed package.json is not a JSON object (an array)', () => {
    const dir = makeTempDir()
    const pkgPath = path.join(dir, 'package.json')
    fs.writeFileSync(pkgPath, '[]', 'utf-8')

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(
      /does not contain a JSON object/,
    )
  })
})

describe('readOpencodeSdkPin', () => {
  test('returns the exact @opencode-ai/sdk devDependency from the real package.json', () => {
    const realPackageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, unknown> }
    const expected = realPackageJson.devDependencies?.['@opencode-ai/sdk']
    if (typeof expected !== 'string') {
      throw new Error(
        'expected package.json devDependencies["@opencode-ai/sdk"] to be a string',
      )
    }
    expect(readOpencodeSdkPin()).toBe(expected)
  })

  test('throws when devDependencies is missing entirely', () => {
    const dir = makeTempDir()
    const pkgPath = writePackageJson(dir, {})

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(
      /is missing a devDependencies object/,
    )
  })

  test('throws when devDependencies is not an object', () => {
    const dir = makeTempDir()
    const pkgPath = writePackageJson(dir, { devDependencies: [] })

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(
      /is missing a devDependencies object/,
    )
  })

  test('throws "not listed in" when the sdk entry is missing', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/plugin': '9.9.0',
    })

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(/not listed in/)
  })

  test('throws "must be an exact version" when the sdk entry is a range', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '^9.9.0',
      '@opencode-ai/plugin': '9.9.0',
    })

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(
      /must be an exact version/,
    )
  })
})

describe('readOpencodeDevDependencyPins', () => {
  test('returns matching sdk and plugin devDependency versions', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '9.9.1',
      '@opencode-ai/plugin': '9.9.1',
    })

    expect(readOpencodeDevDependencyPins(pkgPath)).toEqual({
      sdk: '9.9.1',
      plugin: '9.9.1',
    })
  })

  test('the equality check fails when sdk and plugin devDependencies disagree', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '9.9.1',
      '@opencode-ai/plugin': '9.9.0',
    })

    const { sdk, plugin } = readOpencodeDevDependencyPins(pkgPath)
    expect(sdk).not.toBe(plugin)
  })
})

describe('re-exports stay in sync with the helper', () => {
  test('scripts/run-evals.ts EXPECTED_OPENCODE_VERSION equals the helper value', async () => {
    const { EXPECTED_OPENCODE_VERSION } = await import(
      '../../scripts/run-evals.ts'
    )
    expect(EXPECTED_OPENCODE_VERSION).toBe(readOpencodeSdkPin())
  })

  test('tests/integration/fixtures/receipt-workflow-host.ts EXACT_OPENCODE_VERSION equals the helper value', async () => {
    const { EXACT_OPENCODE_VERSION } = await import(
      '../integration/fixtures/receipt-workflow-host.ts'
    )
    expect(EXACT_OPENCODE_VERSION).toBe(readOpencodeSdkPin())
  })
})

describe('R1: no hardcoded OpenCode pin literal', () => {
  function isExcludedDir(dirPath: string): boolean {
    return path.basename(dirPath) === 'node_modules'
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function collectTsFiles(rootDir: string): string[] {
    const results: string[] = []

    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      const fullPath = path.join(rootDir, entry.name)
      if (entry.isDirectory()) {
        if (!isExcludedDir(fullPath)) {
          results.push(...collectTsFiles(fullPath))
        }
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        results.push(fullPath)
      }
    }

    return results
  }

  test('the pinned version string appears nowhere under scripts/ or tests/', () => {
    const pin = readOpencodeSdkPin()
    const files = [
      ...collectTsFiles(path.join(REPO_ROOT, 'scripts')),
      ...collectTsFiles(path.join(REPO_ROOT, 'tests')),
    ]

    expect(files.length).toBeGreaterThan(0)

    const pinPattern = new RegExp(`(?<![\\d.])${escapeRegExp(pin)}(?![\\d.])`)
    const offenders = files.filter((file) =>
      pinPattern.test(fs.readFileSync(file, 'utf8')),
    )

    if (offenders.length > 0) {
      throw new Error(
        `Found the hardcoded OpenCode pin "${pin}" in: ${offenders
          .map((file) => path.relative(REPO_ROOT, file))
          .join(
            ', ',
          )}. Read it via readOpencodeSdkPin() / readOpencodeDevDependencyPins() from scripts/lib/opencode-pin.ts instead.`,
      )
    }

    expect(offenders).toEqual([])
  })
})
