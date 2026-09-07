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

/**
 * The unpinnable sentinel range: no real `opencode-ai` release will ever
 * reach a major version this high, so a literal in this range can never
 * collide with the real pin the way a realistic-looking literal can.
 */
const SENTINEL_PREFIX = '9999.'

/**
 * Files whose OpenCode-shaped version literals are, by design, always
 * arbitrary fixture values -- never a value that is compared against the
 * real pin. probeOpencodeAvailability, resolveBunInstallCacheDir, and
 * readOpencodeSdkPin/readOpencodeDevDependencyPins all take the version as a
 * parameter or read it from a temp package.json, so nothing in these files
 * needs the real pin. This is deliberately an explicit allowlist rather than
 * every file R1 scans: most files under scripts/ and tests/ never mention an
 * OpenCode version at all, and some legitimately need the real one (e.g.
 * tests/integration/eval-runner.test.ts reads it via
 * `EXPECTED_OPENCODE_VERSION`) or a real historical reference in a comment.
 */
const ALLOWLISTED_FIXTURE_FILES = [
  'tests/unit/opencode-availability.test.ts',
  'tests/unit/eval-contract.test.ts',
  'tests/unit/eval-redaction.test.ts',
  'tests/unit/opencode-pin.test.ts',
]

interface FixtureVersionLiteralViolation {
  file: string
  line: number
  literal: string
}

interface FixtureFileContent {
  file: string
  content: string
}

interface VersionExemption {
  file: string
  literal: string
  /**
   * A substring that must appear on the offending line for this exemption to
   * apply, so it cannot silently cover a *different* occurrence of the same
   * literal in a different context in that file.
   */
  contextSubstring: string
  reason: string
}

// Built from parts rather than as a single quoted literal, so this exemption
// entry's own value doesn't itself read as a version literal to R2's scan of
// this file (this file is on R2's own allowlist below).
const EVAL_CONTRACT_PACKAGE_VERSION = ['1', '2', '3'].join('.')

/**
 * Version-shaped literals in the allowlisted files that are a real version,
 * just never an OpenCode one -- a different versioning domain entirely.
 * Every entry needs its own reason; an unexplained exemption is how this
 * guard rots.
 */
const VERSION_EXEMPTIONS: VersionExemption[] = [
  {
    file: 'tests/unit/eval-contract.test.ts',
    literal: EVAL_CONTRACT_PACKAGE_VERSION,
    contextSubstring: 'packageVersion:',
    reason:
      'the installed-provenance fixture for the @fro.bot/systematic package version, unrelated to opencode-ai',
  },
]

/**
 * Blanks out every `//` line comment and `/* *\/` block comment, replacing
 * their characters with spaces (never removing a newline), so line numbers
 * and column positions in the result line up exactly with the original
 * source. Doc comments in these files use markdown code spans that can
 * themselves contain a quoted, version-shaped string purely as prose (this
 * function's own doc comment is an example) -- scanning comment text with
 * the same string/regex tokenizer used for real code would misread that
 * prose as a fixture literal, so comments are removed before tokenizing.
 */
function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  )
  return withoutBlockComments.replace(/\/\/[^\n]*/g, (m) =>
    ' '.repeat(m.length),
  )
}

// Matches a quoted string or template literal in full.
const STRING_TOKEN_PATTERN =
  /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

// Matches a `/regex/` literal, but only where it appears in a position a
// regex literal actually can -- immediately (allowing a little whitespace)
// after `(`, `,`, `=`, or `[` -- so this does not also match a stray
// division operator.
const REGEX_TOKEN_PATTERN = /(?<=[(,=[]\s{0,20})\/(?:[^/\\\n]|\\.)+\//g

// Inside an ordinary string/template literal, a version looks like a plain
// dotted-digit run. Inside a regex literal it is usually written with
// escaped dots (each dot preceded by a backslash, since a dot is a regex
// metacharacter), so this tolerates an optional backslash before each dot.
const VERSION_IN_STRING_PATTERN = /\d+\.\d+\.\d+/g
const VERSION_IN_REGEX_PATTERN = /\d+\\?\.\d+\\?\.\d+/g

function isExempt(file: string, literal: string, line: string): boolean {
  return VERSION_EXEMPTIONS.some(
    (exemption) =>
      exemption.file === file &&
      exemption.literal === literal &&
      line.includes(exemption.contextSubstring),
  )
}

function scanSpanForVersions(
  file: string,
  content: string,
  spanStart: number,
  spanText: string,
  versionPattern: RegExp,
  violations: FixtureVersionLiteralViolation[],
): void {
  for (const versionMatch of spanText.matchAll(versionPattern)) {
    const literal = versionMatch[0].replaceAll('\\', '')
    if (literal.startsWith(SENTINEL_PREFIX)) continue

    const absoluteIndex = spanStart + (versionMatch.index ?? 0)
    const lineNumber = content.slice(0, absoluteIndex).split('\n').length
    const lineText = content.split('\n')[lineNumber - 1] ?? ''
    if (isExempt(file, literal, lineText)) continue

    violations.push({ file, line: lineNumber, literal })
  }
}

/**
 * Pure scanner: given file contents, returns every OpenCode-shaped version
 * literal that falls outside the unpinnable sentinel range and is not
 * explicitly exempted. Takes `{ file, content }` pairs (not paths) so it is
 * directly testable against synthetic content, independent of the real
 * repository tree -- see the negative-path test below.
 *
 * Scans every quoted string, template literal, and regex literal in each
 * file for a version-shaped run of digits, rather than only literals that
 * follow a recognised marker like `pin:` or `opencodeVersion:`. A
 * marker-anchored scan misses exactly the shapes this suite used before its
 * fixtures were sentinel-ised: a version assigned straight to a
 * classification field with no `pin`/`opencodeVersion` keyword in sight, a
 * version embedded partway through a launcher script string, and a version
 * embedded inside a `.toThrow(/.../ )` regex literal (where it's typically
 * written with escaped dots) -- none of which sit next to one of those
 * markers. Deliberately not spelling out a realistic-looking example version
 * here, for the same reason the rest of this file avoids one: it would
 * itself become a hardcoded-pin false positive the moment a Renovate bump
 * reached it.
 */
function findFixtureVersionLiteralViolations(
  files: readonly FixtureFileContent[],
): FixtureVersionLiteralViolation[] {
  const violations: FixtureVersionLiteralViolation[] = []

  for (const { file, content } of files) {
    // Same length and line/column layout as `content`, with comment text
    // blanked out, so positions found here are also valid offsets into the
    // original `content` (used below for line-number and exemption lookups).
    const codeOnly = stripComments(content)

    for (const stringMatch of codeOnly.matchAll(STRING_TOKEN_PATTERN)) {
      scanSpanForVersions(
        file,
        content,
        stringMatch.index ?? 0,
        stringMatch[0],
        VERSION_IN_STRING_PATTERN,
        violations,
      )
    }
    for (const regexMatch of codeOnly.matchAll(REGEX_TOKEN_PATTERN)) {
      scanSpanForVersions(
        file,
        content,
        regexMatch.index ?? 0,
        regexMatch[0],
        VERSION_IN_REGEX_PATTERN,
        violations,
      )
    }
  }

  return violations
}

describe('R2: fixture version literals stay in the unpinnable sentinel range', () => {
  test('every OpenCode-shaped version literal in the allowlisted fixture files uses the 9999.x sentinel range', () => {
    const files: FixtureFileContent[] = ALLOWLISTED_FIXTURE_FILES.map(
      (relativePath) => ({
        file: relativePath,
        content: fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
      }),
    )
    const violations = findFixtureVersionLiteralViolations(files)

    if (violations.length > 0) {
      const offenderList = violations
        .map((v) => `${v.file}:${v.line} ("${v.literal}")`)
        .join(', ')
      throw new Error(
        'Found a realistic-looking OpenCode version literal outside the ' +
          `${SENTINEL_PREFIX}x sentinel range in: ${offenderList}. ` +
          'These fixture files never validate against the real OpenCode pin, ' +
          `so use an unpinnable sentinel version (e.g. "${SENTINEL_PREFIX}0.0") ` +
          'instead of a realistic-looking version literal.',
      )
    }

    expect(violations).toEqual([])
  })

  // Built from parts rather than as a single quoted literal, so this
  // synthetic "realistic-looking version" used to exercise the scanner below
  // doesn't itself read as a version literal to R2's own scan of this file.
  const SYNTHETIC_REALISTIC_VERSION = ['1', '18', '28'].join('.')
  // Deliberately equal to the real VERSION_EXEMPTIONS entry's literal, so
  // the second test below exercises that exact exemption.
  const SYNTHETIC_EXEMPT_VERSION = ['1', '2', '3'].join('.')

  test('the scanner flags a realistic literal with no recognised pin/version keyword nearby', () => {
    const violations = findFixtureVersionLiteralViolations([
      {
        file: 'synthetic.test.ts',
        content: `const expectedVersion = '${SYNTHETIC_REALISTIC_VERSION}'\n`,
      },
    ])

    expect(violations).toEqual([
      {
        file: 'synthetic.test.ts',
        line: 1,
        literal: SYNTHETIC_REALISTIC_VERSION,
      },
    ])
  })

  test('the scanner respects an exact (file, literal, context) exemption but not the same literal in a different context', () => {
    const violations = findFixtureVersionLiteralViolations([
      {
        file: 'tests/unit/eval-contract.test.ts',
        content: `    packageVersion: '${SYNTHETIC_EXEMPT_VERSION}',\n    pin: '${SYNTHETIC_EXEMPT_VERSION}',\n`,
      },
    ])

    expect(violations).toEqual([
      {
        file: 'tests/unit/eval-contract.test.ts',
        line: 2,
        literal: SYNTHETIC_EXEMPT_VERSION,
      },
    ])
  })
})
