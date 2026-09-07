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

// The devDependency fixture values below ("9999.0.0", "9999.0.1") are
// deliberately unpinnable sentinel versions: they exercise the parser
// against fake package.json content and never need to equal the real pin.
// A realistic-looking literal here would collide with this very file's own
// R1 guard the moment a Renovate bump reached it -- see
// tests/unit/opencode-availability.test.ts for the full rationale.
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
      '@opencode-ai/plugin': '9999.0.0',
    })

    expect(() => readOpencodeSdkPin(pkgPath)).toThrow(/not listed in/)
  })

  test('throws "must be an exact version" when the sdk entry is a range', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '^9999.0.0',
      '@opencode-ai/plugin': '9999.0.0',
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
      '@opencode-ai/sdk': '9999.0.1',
      '@opencode-ai/plugin': '9999.0.1',
    })

    expect(readOpencodeDevDependencyPins(pkgPath)).toEqual({
      sdk: '9999.0.1',
      plugin: '9999.0.1',
    })
  })

  test('the equality check fails when sdk and plugin devDependencies disagree', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '9999.0.1',
      '@opencode-ai/plugin': '9999.0.0',
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
      const offenderList = offenders
        .map((file) => path.relative(REPO_ROOT, file))
        .join(', ')
      throw new Error(
        `Found the hardcoded OpenCode pin "${pin}" in: ${offenderList}. ` +
          'If this code genuinely needs the real pin, read it via ' +
          'readOpencodeSdkPin() / readOpencodeDevDependencyPins() from ' +
          'scripts/lib/opencode-pin.ts instead of hardcoding it. If this is ' +
          'an arbitrary fixture value that never needed to be the real pin (e.g. ' +
          "a parameterised test helper's `pin` argument), use an unpinnable " +
          'sentinel version such as 9999.0.0 instead of a realistic-looking ' +
          'version literal.',
      )
    }

    expect(offenders).toEqual([])
  })
})

describe('R2: fixture pin literals stay in the unpinnable sentinel range', () => {
  /**
   * R1 only forbids the *current* real pin literal, so a fixture using a
   * different realistic-looking version (the exact failure mode this file's
   * git history already hit once in PR #928, and again via PR #944) still
   * passes R1 today and only breaks later, once a future Renovate bump
   * reaches that literal. R2 closes that gap by refusing to let those
   * fixture files use anything other than an unpinnable "9999.x" sentinel
   * for an OpenCode-shaped version in the first place, so there is no
   * literal left for a future pin to ever collide with.
   */
  const SENTINEL_PREFIX = '9999.'

  /**
   * Files whose OpenCode-shaped version literals are, by design, always
   * arbitrary fixture values -- never a value that is compared against the
   * real pin. This is deliberately an explicit allowlist rather than every
   * file R1 scans: most files under scripts/ and tests/ never mention an
   * OpenCode version at all, and some legitimately need the real one (e.g.
   * tests/integration/eval-runner.test.ts reads it via
   * `EXPECTED_OPENCODE_VERSION`) or a real historical reference in a
   * comment (e.g. tests/integration/opencode.test.ts's "OpenCode 1.17.18
   * host contract" note) -- see this repo's PR #947 sweep for the full
   * accounting of what was and wasn't sentinel-ised and why.
   */
  const ALLOWLISTED_FIXTURE_FILES = [
    'tests/unit/opencode-availability.test.ts',
    'tests/unit/eval-contract.test.ts',
    'tests/unit/eval-redaction.test.ts',
    'tests/unit/opencode-pin.test.ts',
  ]

  /**
   * Matches an OpenCode-shaped version literal only where it appears
   * immediately after a marker that makes it a pin/version *value* --
   * `pin:`, `opencodeVersion:`, `sdk:`/`plugin:` (bare or as a quoted
   * `@opencode-ai/sdk`/`@opencode-ai/plugin` devDependency key),
   * `opencode-ai@`, or a `SENTINEL_PIN =` / `SENTINEL_MISMATCH_PIN =`
   * constant declaration -- rather than banning every `\d+\.\d+\.\d+`
   * literal in the file. A blanket ban would false-positive on unrelated
   * version fields these same fixture files legitimately contain, e.g.
   * eval-contract.test.ts's `packageVersion: '1.2.3'` for the
   * @fro.bot/systematic package (a different versioning domain entirely).
   */
  const OPENCODE_VERSION_CONTEXT_PATTERN =
    /(?:\bpin\s*:\s*|\bopencodeVersion\s*:\s*|\bsdk\s*:\s*|\bplugin\s*:\s*|'@opencode-ai\/(?:sdk|plugin)'\s*:\s*|opencode-ai@|\bSENTINEL_(?:PIN|MISMATCH_PIN)\s*=\s*)['"]?\^?(\d+\.\d+\.\d+)/g

  test('every OpenCode-shaped version literal in the allowlisted fixture files uses the 9999.x sentinel range', () => {
    const offenders: string[] = []

    for (const relativePath of ALLOWLISTED_FIXTURE_FILES) {
      const filePath = path.join(REPO_ROOT, relativePath)
      const content = fs.readFileSync(filePath, 'utf8')
      const pattern = new RegExp(OPENCODE_VERSION_CONTEXT_PATTERN.source, 'g')
      let match: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
      while ((match = pattern.exec(content)) !== null) {
        const version = match[1]
        if (version === undefined || version.startsWith(SENTINEL_PREFIX)) {
          continue
        }
        const line = content.slice(0, match.index).split('\n').length
        offenders.push(`${relativePath}:${line} ("${version}")`)
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'Found a realistic-looking OpenCode version literal outside the ' +
          `${SENTINEL_PREFIX}x sentinel range in: ${offenders.join(', ')}. ` +
          'These fixture files never validate against the real OpenCode pin, ' +
          `so use an unpinnable sentinel version (e.g. "${SENTINEL_PREFIX}0.0") ` +
          'instead of a realistic-looking version literal.',
      )
    }

    expect(offenders).toEqual([])
  })
})
