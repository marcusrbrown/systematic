import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findOpencodePinMismatches,
  parseOpencodeHost,
  readOpencodeDevDependencyPins,
  readOpencodeHostPin,
  readOpencodeHostPins,
  readOpencodeSdkPin,
  readOpencodeV2DevDependencyPins,
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
function writePinFile(dir: string, contents: unknown): string {
  const full = path.join(dir, 'opencode-host-pins.json')
  fs.writeFileSync(full, JSON.stringify(contents), 'utf-8')
  return full
}

/** A pin file made only of sentinel versions, with room to override one field. */
function sentinelPins(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { v2: '9999.2.0', v1: '9999.1.1', v1Floor: '9999.1.0', ...overrides }
}

describe('readOpencodeHostPins', () => {
  test('returns the three exact versions from the real pin file', () => {
    const pins = readOpencodeHostPins()
    const exact = /^\d+\.\d+\.\d+$/
    expect(pins.v2).toMatch(exact)
    expect(pins.v1).toMatch(exact)
    expect(pins.v1Floor).toMatch(exact)
  })

  test('reads each field from a temp pin file', () => {
    const pinFile = writePinFile(makeTempDir(), sentinelPins())

    expect(readOpencodeHostPins(pinFile)).toEqual({
      v2: '9999.2.0',
      v1: '9999.1.1',
      v1Floor: '9999.1.0',
    })
  })

  test('readOpencodeHostPin returns the current pin for each host line, never the floor', () => {
    const pinFile = writePinFile(makeTempDir(), sentinelPins())

    expect(readOpencodeHostPin('v2', pinFile)).toBe('9999.2.0')
    expect(readOpencodeHostPin('v1', pinFile)).toBe('9999.1.1')
    expect(readOpencodeSdkPin(pinFile)).toBe('9999.1.1')
  })

  test('throws naming the field when one is missing', () => {
    const { v1Floor: _omitted, ...withoutFloor } = sentinelPins()
    const pinFile = writePinFile(makeTempDir(), withoutFloor)

    expect(() => readOpencodeHostPins(pinFile)).toThrow(
      /"v1Floor" is missing from/,
    )
  })

  test('throws "must be an exact version" when a field is a range', () => {
    const pinFile = writePinFile(
      makeTempDir(),
      sentinelPins({ v2: '^9999.2.0' }),
    )

    expect(() => readOpencodeHostPins(pinFile)).toThrow(
      /"v2".*must be an exact version/,
    )
  })

  test('throws when the floor is newer than the current v1 pin', () => {
    const pinFile = writePinFile(
      makeTempDir(),
      sentinelPins({ v1Floor: '9999.1.2' }),
    )

    expect(() => readOpencodeHostPins(pinFile)).toThrow(
      /"v1Floor".*newer than "v1"/,
    )
  })

  test('parseOpencodeHost accepts the two host lines and rejects anything else', () => {
    expect(parseOpencodeHost('v1')).toBe('v1')
    expect(parseOpencodeHost('v2')).toBe('v2')
    expect(() => parseOpencodeHost('v3')).toThrow(/Unknown OpenCode host "v3"/)
  })
})

describe('readOpencodeDevDependencyPins', () => {
  test('throws when devDependencies is missing entirely', () => {
    const dir = makeTempDir()
    const pkgPath = writePackageJson(dir, {})

    expect(() => readOpencodeDevDependencyPins(pkgPath)).toThrow(
      /is missing a devDependencies object/,
    )
  })

  test('throws when devDependencies is not an object', () => {
    const dir = makeTempDir()
    const pkgPath = writePackageJson(dir, { devDependencies: [] })

    expect(() => readOpencodeDevDependencyPins(pkgPath)).toThrow(
      /is missing a devDependencies object/,
    )
  })

  test('throws "not listed in" when the sdk entry is missing', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/plugin': '9999.0.0',
    })

    expect(() => readOpencodeDevDependencyPins(pkgPath)).toThrow(
      /not listed in/,
    )
  })

  test('throws "must be an exact version" when the sdk entry is a range', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode-ai/sdk': '^9999.0.0',
      '@opencode-ai/plugin': '9999.0.0',
    })

    expect(() => readOpencodeDevDependencyPins(pkgPath)).toThrow(
      /must be an exact version/,
    )
  })

  test('returns the sdk and plugin devDependency versions', () => {
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
})

describe('readOpencodeV2DevDependencyPins', () => {
  test('returns the sdk, plugin and client devDependency versions', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode/sdk': '9999.2.0',
      '@opencode/plugin': '9999.2.0',
      '@opencode/client': '9999.2.0',
    })

    expect(readOpencodeV2DevDependencyPins(pkgPath)).toEqual({
      sdk: '9999.2.0',
      plugin: '9999.2.0',
      client: '9999.2.0',
    })
  })

  test('throws "not listed in" when the client entry is missing', () => {
    const dir = makeTempDir()
    const pkgPath = writeDevDependencies(dir, {
      '@opencode/sdk': '9999.2.0',
      '@opencode/plugin': '9999.2.0',
    })

    expect(() => readOpencodeV2DevDependencyPins(pkgPath)).toThrow(
      /@opencode\/client is not listed in/,
    )
  })
})

describe('lockstep: each CLI pin equals the dev dependencies that move with it', () => {
  const LOCKSTEP_PACKAGES = {
    '@opencode-ai/sdk': '9999.1.1',
    '@opencode-ai/plugin': '9999.1.1',
    '@opencode/sdk': '9999.2.0',
    '@opencode/plugin': '9999.2.0',
    '@opencode/client': '9999.2.0',
  }

  function lockstepFixture(devDependencies: Record<string, unknown>): {
    pinFilePath: string
    packageJsonPath: string
  } {
    const dir = makeTempDir()
    return {
      pinFilePath: writePinFile(dir, sentinelPins()),
      packageJsonPath: writeDevDependencies(dir, devDependencies),
    }
  }

  test('the real package.json and the real pin file agree', () => {
    expect(findOpencodePinMismatches()).toEqual([])
  })

  test('a temp copy in lockstep reports no mismatch', () => {
    expect(
      findOpencodePinMismatches(lockstepFixture(LOCKSTEP_PACKAGES)),
    ).toEqual([])
  })

  test.each(Object.keys(LOCKSTEP_PACKAGES))(
    'bumping only %s in a temp copy of package.json fails the equality',
    (name) => {
      const options = lockstepFixture({
        ...LOCKSTEP_PACKAGES,
        [name]: '9999.9.9',
      })

      const mismatches = findOpencodePinMismatches(options)

      expect(mismatches).toHaveLength(1)
      expect(mismatches[0]).toContain(name)
    },
  )

  test('bumping a pin in the pin file without the dev dependencies fails the equality', () => {
    const dir = makeTempDir()
    const options = {
      pinFilePath: writePinFile(dir, sentinelPins({ v2: '9999.3.0' })),
      packageJsonPath: writeDevDependencies(dir, LOCKSTEP_PACKAGES),
    }

    const mismatches = findOpencodePinMismatches(options)

    expect(mismatches).toHaveLength(3)
    expect(mismatches.every((message) => message.includes('v2 CLI pin'))).toBe(
      true,
    )
  })
})

describe('re-exports stay in sync with the helper', () => {
  test('scripts/run-evals.ts EXPECTED_OPENCODE_VERSION equals the v1 pin', async () => {
    const { EXPECTED_OPENCODE_VERSION } = await import(
      '../../scripts/run-evals.ts'
    )
    expect(EXPECTED_OPENCODE_VERSION).toBe(readOpencodeSdkPin())
  })

  test('tests/integration/fixtures/opencode-host.ts EXACT_OPENCODE_VERSION equals the targeted host pin', async () => {
    const { EXACT_OPENCODE_VERSION, TARGET_OPENCODE_HOST } = await import(
      '../integration/fixtures/opencode-host.ts'
    )
    expect(EXACT_OPENCODE_VERSION).toBe(
      readOpencodeHostPin(TARGET_OPENCODE_HOST),
    )
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

  /**
   * The files in `files` that contain any of `pins` as a whole version
   * (not inside a longer dotted number). The pin file is JSON, so it is the
   * only place all three versions may live.
   */
  function findPinLiteralOffenders(
    files: readonly FixtureFileContent[],
    pins: Readonly<Record<string, string>>,
  ): { file: string; pin: string; name: string }[] {
    return Object.entries(pins).flatMap(([name, pin]) => {
      const pinPattern = new RegExp(`(?<![\\d.])${escapeRegExp(pin)}(?![\\d.])`)
      return files
        .filter(({ content }) => pinPattern.test(content))
        .map(({ file }) => ({ file, pin, name }))
    })
  }

  test('no pinned version (v2, v1 current, or the v1 floor) appears under scripts/ or tests/', () => {
    const pins = readOpencodeHostPins()
    const files = [
      ...collectTsFiles(path.join(REPO_ROOT, 'scripts')),
      ...collectTsFiles(path.join(REPO_ROOT, 'tests')),
    ].map((file) => ({
      file: path.relative(REPO_ROOT, file),
      content: fs.readFileSync(file, 'utf8'),
    }))

    expect(files.length).toBeGreaterThan(0)

    const offenders = findPinLiteralOffenders(files, { ...pins })

    if (offenders.length > 0) {
      const offenderList = offenders
        .map(({ file, name, pin }) => `${file} (${name} "${pin}")`)
        .join(', ')
      throw new Error(
        `Found a hardcoded OpenCode pin in: ${offenderList}. ` +
          'The pin file scripts/opencode-host-pins.json is the only allowed ' +
          'home for all three. If this code genuinely needs a real pin, read ' +
          'it via readOpencodeHostPins() / readOpencodeSdkPin() from ' +
          'scripts/lib/opencode-pin.ts instead of hardcoding it. If this is ' +
          'an arbitrary fixture value that never needed to be the real pin (e.g. ' +
          "a parameterised test helper's `pin` argument), use an unpinnable " +
          'sentinel version such as 9999.0.0 instead of a realistic-looking ' +
          'version literal.',
      )
    }

    expect(offenders).toEqual([])
  })

  test('the pin file is the one place all three versions are written', () => {
    const pins = readOpencodeHostPins()
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/opencode-host-pins.json'),
      'utf8',
    )

    const homes = findPinLiteralOffenders(
      [{ file: 'scripts/opencode-host-pins.json', content: raw }],
      { ...pins },
    )

    expect(homes.map(({ name }) => name).sort()).toEqual(
      ['v1', 'v1Floor', 'v2'].sort(),
    )
  })

  test.each([
    ['v2', '9999.2.0'],
    ['v1', '9999.1.1'],
    ['v1Floor', '9999.1.0'],
  ])('a planted %s literal in a script or a test is reported', (name, pin) => {
    const pins = readOpencodeHostPins(
      writePinFile(makeTempDir(), sentinelPins()),
    )
    const offenders = findPinLiteralOffenders(
      [
        { file: 'scripts/planted.ts', content: `const host = '${pin}'\n` },
        {
          file: 'tests/planted.test.ts',
          content: `expect(v).toBe('>=${pin}')\n`,
        },
        { file: 'scripts/clean.ts', content: "const host = '9999.0.0'\n" },
      ],
      { ...pins },
    )

    expect(offenders.filter((offender) => offender.name === name)).toEqual([
      { file: 'scripts/planted.ts', pin, name },
      { file: 'tests/planted.test.ts', pin, name },
    ])
  })

  test('a pin inside a longer dotted number is not a literal hit', () => {
    const offenders = findPinLiteralOffenders(
      [{ file: 'scripts/longer.ts', content: "const v = '9999.2.0.1'\n" }],
      { v2: '9999.2.0' },
    )

    expect(offenders).toEqual([])
  })
})

/**
 * The unpinnable sentinel range: no real `opencode-ai` release will ever
 * reach a major version this high, so a literal in this range can never
 * collide with the real pin the way a realistic-looking literal can.
 */
const SENTINEL_PREFIX = '9999.'
/** Anchored so a version merely *containing* "9999." isn't mistaken for one that starts with it. */
const SENTINEL_PATTERN = /^9999\./

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

type CodeSpanKind = 'string' | 'regex' | 'comment'

interface CodeSpan {
  kind: CodeSpanKind
  start: number
  text: string
}

/**
 * The subset of `CodeSpan` that `scanSpanForVersions` is allowed to scan.
 * Comment spans exist (`tokenizeCodeSpans` emits them so a classifier can
 * find them; see the blind-spot probe below) but were never meant to be
 * scanned for version literals -- comment text is exactly where false
 * version literals live. Narrowing the parameter to this type turns
 * passing a comment span into a compile error instead of a silent
 * mis-scan: the call site's `if (span.kind === 'comment') continue` is
 * what narrows `CodeSpan` down to this type, so the runtime check and the
 * type boundary enforce the same exclusion in two different ways.
 */
type ScannableCodeSpan = CodeSpan & { kind: 'string' | 'regex' }

/**
 * Type guard, not a bare `span.kind !== 'comment'` check: a plain literal
 * comparison narrows `span.kind` at the point it's read, but does not
 * narrow the *type of `span` itself* to `ScannableCodeSpan` for a
 * subsequent call -- `CodeSpan` is one interface with a union-typed field,
 * not a discriminated union of variant interfaces, so TS has nothing to
 * narrow `span`'s own type against. A named predicate does.
 */
function isScannableCodeSpan(span: CodeSpan): span is ScannableCodeSpan {
  return span.kind !== 'comment'
}

const WHITESPACE_PATTERN = /\s/
const REGEX_LITERAL_PRECEDING_CHARS = new Set(['(', ',', '=', '['])

/**
 * Single left-to-right pass over `source` that yields every quoted
 * string/template literal and every `/regex/` literal, skipping `//` and
 * `/* *\/` comments entirely -- never by blanking or regexing comment text
 * out first, but by tracking which of those five states (line comment,
 * block comment, string, regex, plain code) the cursor is in as it walks
 * the source once, character by character.
 *
 * This file has had two narrower designs, both broken by a real hazard in
 * this repository's own fixture files:
 *
 * 1. A separate `stripComments` pass that blanked `//`-to-end-of-line on
 *    raw source *before* tokenizing strings. That misreads a `//` that
 *    occurs inside a real string (e.g. a `'//host/share/path'` fixture
 *    value in tests/unit/eval-redaction.test.ts) as a comment start,
 *    eating that string's closing quote and desynchronizing quote parity
 *    for the rest of the file -- silently blinding the scanner to
 *    everything after it.
 * 2. No comment awareness at all, tokenizing strings directly against raw
 *    source. That misreads a contraction apostrophe in comment prose
 *    ("suite's", "doesn't", "it's" -- all present in these files' own
 *    comments) as a string's opening quote, which then greedily consumes
 *    forward to the *next* quote it finds -- typically the opening quote
 *    of the next real fixture string -- corrupting parity the same way.
 *
 * Tracking state explicitly avoids both: a comment's content, including
 * any `/`, `'`, or `"` it contains, is never inspected as anything but
 * comment content, and a string's content is never inspected as anything
 * but string content. Each `tryConsume*` helper below either returns the
 * index just past its construct or `null` if `source[i]` doesn't start
 * that construct, so the main loop is a flat try-each-kind-in-turn walk
 * with no nested branching of its own.
 */
function tryConsumeBlockComment(source: string, i: number): number | null {
  if (source[i] !== '/' || source[i + 1] !== '*') return null
  const end = source.indexOf('*/', i + 2)
  return end === -1 ? source.length : end + 2
}

function tryConsumeLineComment(source: string, i: number): number | null {
  if (source[i] !== '/' || source[i + 1] !== '/') return null
  const end = source.indexOf('\n', i)
  return end === -1 ? source.length : end
}

/**
 * A `'` or `"` string literal cannot span a real newline in JS/TS (an
 * unescaped line break inside one is a syntax error); a backtick template
 * literal can. This asymmetry is what bounds the blast radius of a
 * mis-detected `'`/`"` open quote -- whatever caused the tokenizer to think
 * a quote opened a string here (a `//` inside an unrelated string, an
 * apostrophe in a comment, an unrecognised regex position, or a cause not
 * yet found), the resulting phantom span can never extend past the end of
 * the current line, so at most one line's real content is ever lost.
 */
function tryConsumeStringLiteral(source: string, i: number): number | null {
  const quote = source[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  const spansNewlines = quote === '`'
  const n = source.length
  let j = i + 1
  while (j < n && source[j] !== quote) {
    if (!spansNewlines && source[j] === '\n') return null
    j += source[j] === '\\' ? 2 : 1
  }
  return Math.min(j + 1, n) // consume the closing quote, if the string is well-formed
}

function precedesRegexLiteral(source: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && WHITESPACE_PATTERN.test(source[j] ?? '')) j--
  const precedingChar = j >= 0 ? source[j] : undefined
  return (
    precedingChar !== undefined &&
    REGEX_LITERAL_PRECEDING_CHARS.has(precedingChar)
  )
}

function tryConsumeRegexLiteral(source: string, i: number): number | null {
  if (source[i] !== '/' || !precedesRegexLiteral(source, i)) return null
  const n = source.length
  let k = i + 1
  while (k < n && source[k] !== '\n') {
    if (source[k] === '\\') {
      k += 2
      continue
    }
    if (source[k] === '/') return k + 1
    k++
  }
  return null // unterminated on this line: not a regex literal
}

function tokenizeCodeSpans(source: string): CodeSpan[] {
  const spans: CodeSpan[] = []
  const n = source.length
  let i = 0

  while (i < n) {
    const blockCommentEnd = tryConsumeBlockComment(source, i)
    if (blockCommentEnd !== null) {
      spans.push({
        kind: 'comment',
        start: i,
        text: source.slice(i, blockCommentEnd),
      })
      i = blockCommentEnd
      continue
    }

    const lineCommentEnd = tryConsumeLineComment(source, i)
    if (lineCommentEnd !== null) {
      spans.push({
        kind: 'comment',
        start: i,
        text: source.slice(i, lineCommentEnd),
      })
      i = lineCommentEnd
      continue
    }

    const stringEnd = tryConsumeStringLiteral(source, i)
    if (stringEnd !== null) {
      spans.push({ kind: 'string', start: i, text: source.slice(i, stringEnd) })
      i = stringEnd
      continue
    }

    const regexEnd = tryConsumeRegexLiteral(source, i)
    if (regexEnd !== null) {
      spans.push({ kind: 'regex', start: i, text: source.slice(i, regexEnd) })
      i = regexEnd
      continue
    }

    i++
  }

  return spans
}

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
  span: ScannableCodeSpan,
  violations: FixtureVersionLiteralViolation[],
): void {
  const versionPattern =
    span.kind === 'regex' ? VERSION_IN_REGEX_PATTERN : VERSION_IN_STRING_PATTERN

  for (const versionMatch of span.text.matchAll(versionPattern)) {
    const literal = versionMatch[0].replaceAll('\\', '')
    if (SENTINEL_PATTERN.test(literal)) continue

    const absoluteIndex = span.start + (versionMatch.index ?? 0)
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
    for (const span of tokenizeCodeSpans(content)) {
      if (!isScannableCodeSpan(span)) continue
      scanSpanForVersions(file, content, span, violations)
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

  // These three tests pin the exact hazards that broke this scanner's first
  // two designs (see tokenizeCodeSpans's doc comment), plus the newline
  // bound added to contain any hazard neither of us has found yet. They are
  // the durable regression record: if any of these three starts failing, a
  // future edit has reopened a real blindness, not a cosmetic change.

  test('a // inside an earlier string does not blind the scanner to a version on a later line', () => {
    const violations = findFixtureVersionLiteralViolations([
      {
        file: 'synthetic.test.ts',
        content:
          "const hazard = '//host/share/path'\n" +
          `const expectedVersion = '${SYNTHETIC_REALISTIC_VERSION}'\n`,
      },
    ])

    expect(violations).toEqual([
      {
        file: 'synthetic.test.ts',
        line: 2,
        literal: SYNTHETIC_REALISTIC_VERSION,
      },
    ])
  })

  test('a contraction apostrophe in comment prose does not open a phantom string that blinds a later version', () => {
    const violations = findFixtureVersionLiteralViolations([
      {
        file: 'synthetic.test.ts',
        content:
          "// This suite's helper doesn't spawn a real process.\n" +
          `const expectedVersion = '${SYNTHETIC_REALISTIC_VERSION}'\n`,
      },
    ])

    expect(violations).toEqual([
      {
        file: 'synthetic.test.ts',
        line: 2,
        literal: SYNTHETIC_REALISTIC_VERSION,
      },
    ])
  })

  test('an apostrophe inside a regex literal in an unrecognised position cannot blind past the current line', () => {
    // /don't/ here sits after `&&`, not after one of
    // REGEX_LITERAL_PRECEDING_CHARS, so it is not recognised as a regex
    // literal -- the apostrophe inside it is exactly the kind of
    // mis-detected quote the newline bound on tryConsumeStringLiteral
    // exists to contain. Without that bound, the phantom string it opens
    // would search past the end of this line for a closing quote and could
    // swallow the real version literal below.
    const violations = findFixtureVersionLiteralViolations([
      {
        file: 'synthetic.test.ts',
        content:
          "if (a && /don't/.test(b)) {}\n" +
          `const expectedVersion = '${SYNTHETIC_REALISTIC_VERSION}'\n`,
      },
    ])

    expect(violations).toEqual([
      {
        file: 'synthetic.test.ts',
        line: 2,
        literal: SYNTHETIC_REALISTIC_VERSION,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Blind-spot probe: measure R2's coverage on every run instead of asserting
// it from a hand-run snapshot. See
// docs/solutions/best-practices/measure-a-source-scanner-blind-spots-2026-09-07.md
// (Guidance 1) for why a scanner's blind spots need measuring, not reviewing.
// ---------------------------------------------------------------------------

/**
 * Injection shapes for the probe below, one function per historical shape
 * the guard must detect. Guidance Example 1 in
 * docs/solutions/best-practices/measure-a-source-scanner-blind-spots-2026-09-07.md
 * names the four shapes a context-anchored (marker-recognising) design
 * missed: `expectedVersion:`/`reportedVersion:`-style fields with no
 * recognised keyword, a version inside a launcher template string, and a
 * bare `.toThrow(/.../ )` regex assertion -- plus the `opencodeVersion:`/
 * `pin:` shape that same design *did* recognise. Sweeping all four (not
 * just the one recognised shape) is what makes the probe able to fail
 * against that design; sweeping only `opencodeVersion:` cannot, since a
 * context-anchored scanner would still catch it.
 *
 * Each shape is a single self-contained literal whose tokenization never
 * depends on neighbouring lines, so every planted position behaves the
 * same way regardless of where it lands.
 */
function injectPlainAssignment(literal: string): string {
  // Unrecognised by any marker-anchored design: no `pin`/`opencodeVersion`
  // keyword nearby, the exact shape a context-anchored scanner missed.
  return `  const expectedVersion = '${literal}'`
}

function injectObjectField(literal: string): string {
  // The one shape a context-anchored design *did* recognise -- included so
  // the sweep still measures this shape's own coverage, not just the gaps.
  return `  opencodeVersion: '${literal}',`
}

function injectLauncherTemplate(literal: string): string {
  // A version embedded partway through a launcher script string, in the
  // `opencode-ai@<version>` form -- no marker keyword precedes the version
  // itself, only free text inside a template literal.
  return `  const launcherCmd = \`bunx opencode-ai@${literal} start\``
}

function injectRegexAssertion(literal: string): string {
  // A version inside a `.toThrow(/.../ )` regex literal, escaped-dot form,
  // matching VERSION_IN_REGEX_PATTERN -- the only shape that drives
  // scanSpanForVersions's `span.kind === 'regex'` branch rather than its
  // string-span branch. Preceded by `(`, one of REGEX_LITERAL_PRECEDING_CHARS,
  // so precedesRegexLiteral recognises it.
  return `  expect(() => run()).toThrow(/${literal.replaceAll('.', '\\.')}/)`
}

interface InjectionShape {
  name: string
  injectLine: (literal: string) => string
  /**
   * Whether this shape is still expected to be detected when planted at a
   * boundary that falls *inside* an already-open multi-line template
   * literal. A boundary there is string content, not a code-injection
   * point: the planted text becomes part of the enclosing template rather
   * than new top-level code, so shapes that only work as top-level code
   * cannot be expected to survive it.
   *
   * `injectPlainAssignment` and `injectObjectField` plant no backtick, so
   * their text just becomes more of the enclosing template's content --
   * and the enclosing template's *own* span still gets scanned for version
   * digits normally (see `scanSpanForVersions`), so the literal is still
   * detected. `injectLauncherTemplate` plants its own pair of backticks,
   * which closes the enclosing template early and reopens a new one,
   * stranding the version in a plain-code gap outside every span.
   * `injectRegexAssertion` plants no backtick either, so its text also
   * becomes template content -- but its escaped-dot literal only matches
   * `VERSION_IN_REGEX_PATTERN`, and a boundary inside a template is always
   * scanned as `kind: 'string'` (`VERSION_IN_STRING_PATTERN`), which never
   * matches an escaped dot. Both failures are real, structural
   * consequences of the shape, not scanner defects -- see
   * `findNonPlantableRanges` below for where this is enforced.
   */
  plantableInsideMultilineTemplate: boolean
}

const INJECTION_SHAPES: readonly InjectionShape[] = [
  {
    name: 'plain assignment (expectedVersion-style, no marker keyword)',
    injectLine: injectPlainAssignment,
    plantableInsideMultilineTemplate: true,
  },
  {
    name: 'object field (opencodeVersion:, a marker-recognised shape)',
    injectLine: injectObjectField,
    plantableInsideMultilineTemplate: true,
  },
  {
    name: 'launcher template string (opencode-ai@<version>)',
    injectLine: injectLauncherTemplate,
    plantableInsideMultilineTemplate: false,
  },
  {
    name: 'bare regex assertion (.toThrow(/.../ ), drives the regex-span path)',
    injectLine: injectRegexAssertion,
    plantableInsideMultilineTemplate: false,
  },
]

type NonPlantableReason = 'comment' | 'multiline-template'

interface NonPlantableRange {
  start: number
  end: number
  reason: NonPlantableReason
}

/**
 * Byte ranges of the probe below where an inserted line is not scanned as
 * new top-level code: every comment span, and every multi-line template
 * literal span (a backtick string whose text contains a newline). Derived
 * directly from `tokenizeCodeSpans`'s own output -- the same function R2
 * itself scans with -- rather than an independent walk, so a construct
 * added to that tokenizer can never silently diverge from what this
 * classifier knows about.
 *
 * Both reasons matter, and differently:
 *
 * - Inside a `'comment'` span, no shape is ever detected: comment text is
 *   filtered out before `scanSpanForVersions` ever sees it (see
 *   `findFixtureVersionLiteralViolations`), so nothing planted there can
 *   be detected by any shape, and none should be.
 * - Inside a `'multiline-template'` span, whether a shape is detected
 *   depends on the shape itself -- see each `InjectionShape`'s
 *   `plantableInsideMultilineTemplate` doc comment above for why. This is
 *   why the reason is threaded through instead of collapsed into one
 *   boolean: the caller decides per shape, not per range.
 */
function findNonPlantableRanges(source: string): NonPlantableRange[] {
  const ranges: NonPlantableRange[] = []

  for (const span of tokenizeCodeSpans(source)) {
    const end = span.start + span.text.length
    if (span.kind === 'comment') {
      ranges.push({ start: span.start, end, reason: 'comment' })
    } else if (span.kind === 'string' && span.text.includes('\n')) {
      ranges.push({ start: span.start, end, reason: 'multiline-template' })
    }
  }

  return ranges
}

function isLegitimateNonDetection(
  offset: number,
  ranges: readonly NonPlantableRange[],
  shape: InjectionShape,
): boolean {
  return ranges.some((range) => {
    if (offset <= range.start || offset >= range.end) return false
    if (range.reason === 'comment') return true
    return !shape.plantableInsideMultilineTemplate
  })
}

interface BlindSpotSummary {
  file: string
  totalPositions: number
  detected: number
  legitimateNonDetections: number
  misses: Array<{ position: number; line: number }>
}

/**
 * For one file's content, inserts `literal` (via `shape.injectLine`) as a
 * new standalone line at every line boundary -- before the first line,
 * between every pair of lines, and after the last line -- and asks `scan`
 * whether it reports a violation at that line. A boundary whose insertion
 * point falls inside a comment, or inside a multi-line template literal in
 * a way `shape` cannot survive, is classified as a legitimate
 * non-detection rather than a miss -- see `findNonPlantableRanges` and
 * `isLegitimateNonDetection` above for exactly which boundaries and shapes
 * that covers, and why.
 *
 * Generic over `scan`, the file contents, and the injection shape (rather
 * than closing over R2's `findFixtureVersionLiteralViolations` and
 * `ALLOWLISTED_FIXTURE_FILES` directly, or a single hardcoded shape), so a
 * second scanner-backed guard (e.g.
 * tests/unit/spawn-and-signal-conventions.test.ts) can reuse this probe
 * later without a rewrite.
 *
 * What this proves, what it does not, and what it can wrongly flag:
 *
 * - A clean sweep re-proves that, for every shape in `INJECTION_SHAPES` and
 *   every line position in *today's* allowlisted files, the scanner
 *   detects a planted violation.
 * - It does not prove there is no injection shape outside that list the
 *   scanner would miss, and it cannot expose a hazard that depends on a
 *   trigger no current file contains (see the newline-bound regression
 *   tests below, and the bidirectional-proof note in this file's history:
 *   reverting `tryConsumeStringLiteral`'s newline bound does not fail this
 *   sweep, because none of the four allowlisted files currently contain
 *   the apostrophe-in-unrecognised-regex-position trigger that bound
 *   guards against -- only the synthetic regression tests below do).
 * - It can also report a *false* miss if a boundary is not a genuine
 *   code-injection point for a given shape and that is not accounted for
 *   in the classifier -- e.g. a boundary inside a multi-line template
 *   literal is string content, not top-level code, so a shape whose own
 *   syntax cannot survive landing there (see each shape's
 *   `plantableInsideMultilineTemplate` doc comment) will legitimately go
 *   undetected there. Before `findNonPlantableRanges` accounted for this,
 *   the sweep reported real-looking misses for exactly this reason,
 *   pointing at a scanner defect that did not exist. Any future injection
 *   shape or scanned file construct needs the same question asked of it:
 *   does landing this text at this boundary still test what the shape
 *   claims to test, or does it just test the probe's own insertion
 *   mechanics?
 */
/**
 * The byte offset of every line boundary in `lines` -- before the first
 * line, between every pair of lines, and after the last -- as one array of
 * `lines.length + 1` offsets, computed with a single running sum rather
 * than a per-position `lines.slice(0, position).reduce(...)` (which would
 * be O(n^2) in allocations across the sweep below). `boundaryOffsets[p]`
 * is the offset for probe position `p`, for every `p` in
 * `0..lines.length` inclusive -- a legitimately in-range index for every
 * position the sweep visits, so the sweep never has to read `lines[p]`
 * itself (which, at `p === lines.length`, is one past the last line and
 * always `undefined`) just to decide whether to advance the running sum.
 */
function computeBoundaryOffsets(lines: readonly string[]): number[] {
  const offsets = [0]
  let running = 0

  for (const line of lines) {
    running += line.length + 1
    offsets.push(running)
  }

  return offsets
}

function probeScannerBlindSpots(
  scan: (
    files: readonly FixtureFileContent[],
  ) => FixtureVersionLiteralViolation[],
  file: string,
  content: string,
  literal: string,
  shape: InjectionShape,
): BlindSpotSummary {
  const lines = content.split('\n')
  const nonPlantableRanges = findNonPlantableRanges(content)
  const boundaryOffsets = computeBoundaryOffsets(lines)
  const misses: Array<{ position: number; line: number }> = []
  let detected = 0
  let legitimateNonDetections = 0

  for (let position = 0; position <= lines.length; position++) {
    const offset = boundaryOffsets[position]
    if (offset === undefined) {
      throw new Error(
        `boundaryOffsets is documented to have lines.length + 1 entries; missing offset at position ${position}`,
      )
    }
    const legitimateHere = isLegitimateNonDetection(
      offset,
      nonPlantableRanges,
      shape,
    )

    const mutatedLines = [
      ...lines.slice(0, position),
      shape.injectLine(literal),
      ...lines.slice(position),
    ]
    const mutatedContent = mutatedLines.join('\n')
    const injectedLine = position + 1

    const wasDetected = scan([{ file, content: mutatedContent }]).some(
      (violation) =>
        violation.line === injectedLine && violation.literal === literal,
    )

    if (wasDetected) {
      detected++
    } else if (legitimateHere) {
      legitimateNonDetections++
    } else {
      misses.push({ position, line: injectedLine })
    }
  }

  return {
    file,
    totalPositions: lines.length + 1,
    detected,
    legitimateNonDetections,
    misses,
  }
}

describe('probe: R2 catches a planted violation, in every historical shape, at every line position', () => {
  // Built from parts, like SYNTHETIC_REALISTIC_VERSION above, so this
  // literal never appears as a quoted string in this file's own source --
  // this file is itself on ALLOWLISTED_FIXTURE_FILES, so a literal written
  // directly here would trip R2's real scan of this file.
  const PROBE_LITERAL = ['2', '4', '17'].join('.')

  test('every allowlisted file reports a violation at every planted position, in every shape, except where the shape cannot survive the boundary', () => {
    const start = performance.now()

    // Each file is read once, not once per shape: every shape sweeps the
    // same on-disk content, so re-reading per shape only adds a way for a
    // sweep to disagree with itself if the file changed mid-run.
    const fileContents = ALLOWLISTED_FIXTURE_FILES.map((relativePath) => ({
      relativePath,
      content: fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }))

    const perShapeSummaries: Array<{
      shape: string
      summaries: BlindSpotSummary[]
    }> = []

    for (const shape of INJECTION_SHAPES) {
      const summaries = fileContents.map(({ relativePath, content }) =>
        probeScannerBlindSpots(
          findFixtureVersionLiteralViolations,
          relativePath,
          content,
          PROBE_LITERAL,
          shape,
        ),
      )
      perShapeSummaries.push({ shape: shape.name, summaries })
    }

    const elapsedMs = performance.now() - start
    const totalPositions = perShapeSummaries.reduce(
      (sum, s) => sum + s.summaries.reduce((n, f) => n + f.totalPositions, 0),
      0,
    )
    const totalMisses = perShapeSummaries.reduce(
      (sum, s) => sum + s.summaries.reduce((n, f) => n + f.misses.length, 0),
      0,
    )

    if (totalMisses > 0) {
      // The per-shape breakdown is only diagnostic when something failed;
      // logging it unconditionally would add five wide lines to every
      // passing run, and this is the only console output under
      // tests/unit/.
      const breakdown = perShapeSummaries
        .map(
          ({ shape, summaries }) =>
            `  [${shape}] ` +
            summaries
              .map(
                (s) =>
                  `${s.file}: ${s.detected} detected, ${s.legitimateNonDetections} legitimately not detected, ${s.misses.length} missed`,
              )
              .join('; '),
        )
        .join('\n')
      const missReport = perShapeSummaries
        .flatMap(({ shape, summaries }) =>
          summaries
            .filter((s) => s.misses.length > 0)
            .map(
              (s) =>
                `[${shape}] ${s.file}: missed line(s) ${s.misses.map((m) => m.line).join(', ')}`,
            ),
        )
        .join('; ')

      throw new Error(
        `R2 failed to detect a planted "${PROBE_LITERAL}" literal at ${totalMisses} position(s) it should have caught (full sweep, no sampling, ${totalPositions} positions across ${INJECTION_SHAPES.length} shapes x ${ALLOWLISTED_FIXTURE_FILES.length} files in ${elapsedMs.toFixed(1)}ms):\n${breakdown}\nMisses: ${missReport}`,
      )
    }

    expect(totalMisses).toBe(0)
    // The full sweep takes 2-5 s on CI runners, too close to bun's 5 s default.
  }, 30_000)
})

describe('probe classifier: a multi-line template literal is not a code-injection point for every shape', () => {
  // A minimal reproduction of the failure mode this classifier exists to
  // prevent: a five-line host with one multi-line template. Before
  // `findNonPlantableRanges` accounted for multi-line templates, sweeping
  // this host with the launcher and regex shapes reported real-looking
  // misses at the lines inside the template -- not because the scanner has
  // a blind spot, but because those two shapes plant syntax that cannot
  // survive landing inside an already-open template literal (see each
  // shape's `plantableInsideMultilineTemplate` doc comment). The
  // plain-assignment and object-field shapes plant no backtick, so their
  // text just becomes more of the template's own content, which is still
  // scanned normally -- they are expected to keep being detected there.
  const MULTILINE_TEMPLATE_HOST =
    'const help = `\n' +
    'first line of help text\n' +
    'second line of help text\n' +
    '`\n' +
    'module.exports = help\n'

  // A separate case per shape, not one test looping over all four: the
  // whole point of this test is that the four shapes behave differently
  // inside a multi-line template, so a failure needs to name which shape
  // broke rather than report a single undifferentiated assertion.
  test.each(INJECTION_SHAPES.map((shape) => [shape.name, shape] as const))(
    'reports zero misses for the %s shape',
    (_name, shape) => {
      const literal = ['6', '11', '23'].join('.')

      const summary = probeScannerBlindSpots(
        findFixtureVersionLiteralViolations,
        'synthetic.test.ts',
        MULTILINE_TEMPLATE_HOST,
        literal,
        shape,
      )

      expect(summary.misses).toEqual([])
    },
  )
})

describe('probe sensitivity: probeScannerBlindSpots can report a real miss', () => {
  // Pins the probe's ability to FAIL without hand-reconstructing a
  // historical design again: a deliberately crippled stub scanner,
  // marker-anchored like the first historical design (Guidance Example 1
  // in the blind-spots doc), recognising a version only on a line
  // containing `opencodeVersion`. The plain-assignment shape plants no
  // such marker, so this stub must miss it -- if `probeScannerBlindSpots`'s
  // detection predicate ever broke such that `wasDetected` were always
  // true, this is the test that would catch it, not a hand-run sweep.
  function markerAnchoredStubScanner(
    files: readonly FixtureFileContent[],
  ): FixtureVersionLiteralViolation[] {
    const violations: FixtureVersionLiteralViolation[] = []
    for (const { file, content } of files) {
      content.split('\n').forEach((line, index) => {
        if (!line.includes('opencodeVersion')) return
        for (const match of line.matchAll(VERSION_IN_STRING_PATTERN)) {
          violations.push({ file, line: index + 1, literal: match[0] })
        }
      })
    }
    return violations
  }

  test('a marker-anchored stub scanner misses the plain-assignment shape', () => {
    const plainAssignmentShape = INJECTION_SHAPES.find(
      (shape) => shape.injectLine === injectPlainAssignment,
    )
    if (plainAssignmentShape === undefined) {
      throw new Error('expected the plain-assignment shape to be registered')
    }

    const summary = probeScannerBlindSpots(
      markerAnchoredStubScanner,
      'synthetic.test.ts',
      'const noop = true\n',
      ['3', '7', '11'].join('.'),
      plainAssignmentShape,
    )

    expect(summary.misses.length).toBeGreaterThan(0)
  })
})

describe('findNonPlantableRanges: comment detection does not misfire inside strings or regexes', () => {
  test('a /* inside a real string or a real regex is never mistaken for a block comment start', () => {
    const content =
      "const marker = '/* not a real comment */'\n" +
      'const pattern = /a\\/\\*b/\n'

    const commentRanges = findNonPlantableRanges(content).filter(
      (range) => range.reason === 'comment',
    )

    expect(commentRanges).toEqual([])
  })
})
