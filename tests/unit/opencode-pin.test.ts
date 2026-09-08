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

type CodeSpanKind = 'string' | 'regex'

interface CodeSpan {
  kind: CodeSpanKind
  start: number
  text: string
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
      i = blockCommentEnd
      continue
    }

    const lineCommentEnd = tryConsumeLineComment(source, i)
    if (lineCommentEnd !== null) {
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
  span: CodeSpan,
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
}

const INJECTION_SHAPES: readonly InjectionShape[] = [
  {
    name: 'plain assignment (expectedVersion-style, no marker keyword)',
    injectLine: injectPlainAssignment,
  },
  {
    name: 'object field (opencodeVersion:, a marker-recognised shape)',
    injectLine: injectObjectField,
  },
  {
    name: 'launcher template string (opencode-ai@<version>)',
    injectLine: injectLauncherTemplate,
  },
  {
    name: 'bare regex assertion (.toThrow(/.../ ), drives the regex-span path)',
    injectLine: injectRegexAssertion,
  },
]

/**
 * Byte ranges of every `/* ... *\/` block comment in `source`, found with
 * the same left-to-right walk `tokenizeCodeSpans` uses -- reusing its
 * `tryConsume*` primitives rather than re-deriving the tokenizing rules --
 * so a `/*` inside a real string or regex is never mistaken for a comment
 * start. Used only to classify probe positions below; not part of R2
 * itself.
 */
function findBlockCommentByteRanges(
  source: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const n = source.length
  let i = 0

  while (i < n) {
    const blockCommentEnd = tryConsumeBlockComment(source, i)
    if (blockCommentEnd !== null) {
      ranges.push({ start: i, end: blockCommentEnd })
      i = blockCommentEnd
      continue
    }

    const lineCommentEnd = tryConsumeLineComment(source, i)
    if (lineCommentEnd !== null) {
      i = lineCommentEnd
      continue
    }

    const stringEnd = tryConsumeStringLiteral(source, i)
    if (stringEnd !== null) {
      i = stringEnd
      continue
    }

    const regexEnd = tryConsumeRegexLiteral(source, i)
    if (regexEnd !== null) {
      i = regexEnd
      continue
    }

    i++
  }

  return ranges
}

function isWithinAnyRange(
  offset: number,
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some((range) => offset > range.start && offset < range.end)
}

interface BlindSpotSummary {
  file: string
  totalPositions: number
  detected: number
  legitimateNonDetections: number
  misses: Array<{ position: number; line: number }>
}

/**
 * For one file's content, inserts `literal` (via `injectLine`) as a new
 * standalone line at every line boundary -- before the first line, between
 * every pair of lines, and after the last line -- and asks `scan` whether it
 * reports a violation at that line. A boundary whose insertion point falls
 * inside an already-open block comment in the *original* content is
 * classified as a legitimate non-detection rather than a miss: the scanner
 * is supposed to ignore comment text, so not reporting a violation there is
 * correct behaviour, not a blind spot.
 *
 * Generic over `scan`, the file contents, and the injection shape (rather
 * than closing over R2's `findFixtureVersionLiteralViolations` and
 * `ALLOWLISTED_FIXTURE_FILES` directly, or a single hardcoded shape), so a
 * second scanner-backed guard (e.g.
 * tests/unit/spawn-and-signal-conventions.test.ts) can reuse this probe
 * later without a rewrite.
 *
 * What this proves and what it does not: a clean sweep re-proves that, for
 * every shape in `INJECTION_SHAPES` and every line position in *today's*
 * allowlisted files, the scanner detects a planted violation. It does not
 * prove there is no injection shape outside that list the scanner would
 * miss, and it cannot expose a hazard that depends on a trigger no current
 * file contains (see the newline-bound regression tests below, and the
 * bidirectional-proof note in this file's history: reverting
 * `tryConsumeStringLiteral`'s newline bound does not fail this sweep,
 * because none of the four allowlisted files currently contain the
 * apostrophe-in-unrecognised-regex-position trigger that bound guards
 * against -- only the synthetic regression tests below do).
 */
function probeScannerBlindSpots(
  scan: (files: FixtureFileContent[]) => FixtureVersionLiteralViolation[],
  file: string,
  content: string,
  literal: string,
  injectLine: (literal: string) => string,
): BlindSpotSummary {
  const lines = content.split('\n')
  const commentRanges = findBlockCommentByteRanges(content)
  const misses: Array<{ position: number; line: number }> = []
  let detected = 0
  let legitimateNonDetections = 0

  for (let position = 0; position <= lines.length; position++) {
    const boundaryOffset = lines
      .slice(0, position)
      .reduce((offset, line) => offset + line.length + 1, 0)
    const insideComment = isWithinAnyRange(boundaryOffset, commentRanges)

    const mutatedLines = [
      ...lines.slice(0, position),
      injectLine(literal),
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
    } else if (insideComment) {
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

  test('every allowlisted file reports a violation at every planted position, in every shape, except inside comments', () => {
    const start = performance.now()
    const perShapeSummaries: Array<{
      shape: string
      summaries: BlindSpotSummary[]
    }> = []

    for (const shape of INJECTION_SHAPES) {
      const summaries: BlindSpotSummary[] = []
      for (const relativePath of ALLOWLISTED_FIXTURE_FILES) {
        const content = fs.readFileSync(
          path.join(REPO_ROOT, relativePath),
          'utf8',
        )
        summaries.push(
          probeScannerBlindSpots(
            findFixtureVersionLiteralViolations,
            relativePath,
            content,
            PROBE_LITERAL,
            shape.injectLine,
          ),
        )
      }
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

    console.log(
      `[blind-spot probe] ${totalPositions} positions across ${INJECTION_SHAPES.length} shapes x ${ALLOWLISTED_FIXTURE_FILES.length} files in ${elapsedMs.toFixed(1)}ms (full sweep, no sampling):`,
    )
    for (const { shape, summaries } of perShapeSummaries) {
      console.log(
        `  [${shape}] ` +
          summaries
            .map(
              (s) =>
                `${s.file}: ${s.detected} detected, ${s.legitimateNonDetections} legitimately not detected (inside a comment), ${s.misses.length} missed`,
            )
            .join('; '),
      )
    }

    if (totalMisses > 0) {
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
        `R2 failed to detect a planted "${PROBE_LITERAL}" literal at ${totalMisses} position(s) it should have caught: ${missReport}`,
      )
    }

    expect(totalMisses).toBe(0)
  })
})
