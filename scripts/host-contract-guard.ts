/**
 * Guards the `host-contract` CI job's skip/pass floor.
 *
 * The module-scope throw (`SYSTEMATIC_REQUIRE_OPENCODE=1`) already covers a
 * missing or mismatched host. This guard covers what it cannot: a per-test
 * gate such as `test.skipIf(!DIST_LOCAL_AVAILABLE)` skipping for an
 * unexpected reason while the job stays green, or a whole-file collapse (a
 * crash or an early exit) that still leaves the console summary and pass
 * floor looking plausible. The exempt set, the expected-file list, and the
 * floor all live here, next to the guard, so widening any of them is a
 * reviewed change.
 *
 * Structured as pure functions (parse JUnit XML string, parse the log's pass
 * count, evaluate the parsed shape into violations) plus a thin CLI wrapper
 * that performs the file I/O and exits non-zero on any violation. Splitting
 * it this way is what makes `evaluate()` unit-testable against synthetic
 * fixtures without touching the filesystem.
 */
import { readFileSync } from 'node:fs'

/**
 * The only test allowed to skip today: the mixed-version test stays opt-in
 * because enabling it would put a fetch of a published `@fro.bot/systematic`
 * release on the path that gates publishing the next one.
 *
 * This set is bidirectional: {@link evaluate} fails both when an
 * unlisted test skips (`unexpectedSkips`) and when a listed entry is
 * *absent* from the run (`missingExemptSkips`). A rename of the exempt
 * test's `classname`/`name` therefore fails loudly here (the old key stops
 * matching and shows up as missing) rather than silently accepting a
 * differently-named skip as a match.
 */
export const EXEMPT_SKIPS: readonly {
  readonly classname: string
  readonly name: string
}[] = [
  {
    classname: 'opencode mixed-version integration',
    name: 'pinned package plus local source keep systematic_skill deterministic and converge bootstrap',
  },
]

/**
 * Every test file under `tests/integration/`, enumerated by hand and
 * verified against `ls tests/integration/*.test.ts`. A file producing zero
 * JUnit `<testsuite>` entries means `bun test` never actually ran it — the
 * exact failure mode a mass-skip or an early crash would produce while the
 * console summary and pass floor alone could still look plausible.
 */
export const EXPECTED_SUITE_FILES: readonly string[] = [
  'tests/integration/ce-review-return-validation.test.ts',
  'tests/integration/claude-code.test.ts',
  'tests/integration/eval-artifact.test.ts',
  'tests/integration/eval-fixture.test.ts',
  'tests/integration/eval-runner.test.ts',
  'tests/integration/opencode.test.ts',
  'tests/integration/pi.test.ts',
  'tests/integration/question-attestation-opencode.test.ts',
  'tests/integration/receipt-workflow-dogfood.test.ts',
  'tests/integration/receipt-workflow-guard-real-host.test.ts',
  'tests/integration/receipt-workflow-recovery.test.ts',
  'tests/integration/release-notes-ci.test.ts',
]

/**
 * Measured: 139 test()/it() call sites exist across the twelve integration
 * files as of this writing. The prior floor of 50 exactly equalled the
 * host-free test count (claude-code 18 + eval-artifact 7 + eval-fixture 5 +
 * release-notes-ci 20 = 50), so a total collapse of every host-touching
 * file could still clear it silently. Raise this floor as the suite grows;
 * do not lower it without a documented reason.
 */
export const PASS_FLOOR = 120

export interface SkippedTestCase {
  readonly classname: string
  readonly name: string
}

export interface ParsedJUnit {
  readonly producedFiles: ReadonlySet<string>
  readonly skipped: readonly SkippedTestCase[]
}

/**
 * Decodes the five XML predefined entities plus numeric character
 * references. Bun's JUnit reporter XML-escapes attribute values, so a test
 * name containing `<`, `&`, etc. (this repo has one: the "payload &lt;=
 * 10000 chars" test in claude-code.test.ts, confirmed by generating a real
 * JUnit report) round-trips through `&lt;` in the report. Decoding here
 * keeps comparisons against literal `EXEMPT_SKIPS` strings correct and
 * keeps violation messages readable instead of printing raw entities.
 */
function decodeXmlEntities(str: string): string {
  return str.replaceAll(
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g,
    (match, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default: {
          const codePoint = entity.startsWith('#x')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10)
          // `String.fromCodePoint` throws a RangeError above 0x10FFFF (the
          // highest valid Unicode code point) instead of returning a
          // sentinel, so an out-of-range numeric reference -- malformed
          // input, not something Bun's own reporter would ever emit -- is
          // left as the literal source text rather than crashing this
          // guard. Surrogate-range code points (0xD800-0xDFFF) are
          // deliberately NOT excluded: `String.fromCodePoint` accepts them
          // without throwing (producing a lone surrogate in the string,
          // unlike the stricter validation some Unicode-aware APIs apply),
          // so there is no crash to prevent, and no test name a real `bun
          // test` JUnit run could plausibly produce would contain one.
          return Number.isNaN(codePoint) || codePoint > 0x10ffff
            ? match
            : String.fromCodePoint(codePoint)
        }
      }
    },
  )
}

function parseAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe = /(\w+)="([^"]*)"/g
  for (const m of str.matchAll(attrRe)) {
    const [, key, value] = m
    if (key !== undefined && value !== undefined) {
      attrs[key] = decodeXmlEntities(value)
    }
  }
  return attrs
}

/**
 * Parses a Bun JUnit XML report into the produced testsuite `file=`
 * attributes and the skipped testcases.
 *
 * Bun emits one outer `<testsuite>` per test file, plus one nested
 * `<testsuite>` per describe block, all sharing that file's `file=`
 * attribute — so collecting every testsuite's file attribute and taking the
 * unique set recovers exactly the set of files bun actually loaded and ran,
 * regardless of describe nesting. The `<testsuite\b` pattern never matches
 * the closing `</testsuite>` tag (a `/` immediately follows `<`, not `t`),
 * and never matches the plural `<testsuites` container (no word boundary
 * between `testsuite` and the trailing `s`).
 */
export function parseJUnitXml(xml: string): ParsedJUnit {
  const testsuiteRe = /<testsuite\b([^>]*)>/g
  const producedFiles = new Set<string>()
  for (const suiteMatch of xml.matchAll(testsuiteRe)) {
    const attrsStr = suiteMatch[1]
    if (attrsStr === undefined) continue
    const attrs = parseAttrs(attrsStr)
    if (attrs.file !== undefined) producedFiles.add(attrs.file)
  }

  const testcaseRe = /<testcase\b([^>]*?)(\/>|>[\s\S]*?<\/testcase>)/g
  const skipped: SkippedTestCase[] = []
  for (const caseMatch of xml.matchAll(testcaseRe)) {
    const [, attrStr, rest] = caseMatch
    if (attrStr === undefined || rest === undefined) continue
    const attrs = parseAttrs(attrStr)
    if (rest.includes('<skipped')) {
      skipped.push({ classname: attrs.classname ?? '', name: attrs.name ?? '' })
    }
  }

  return { producedFiles, skipped }
}

/**
 * Extracts the pass count from a captured `bun test` log.
 *
 * Bun's default reporter prints one "<N> pass" summary line per run; take
 * the last match rather than the first so a captured log containing more
 * than one summary is scored on the final, authoritative count. Returns
 * `undefined` when no such line is found (a malformed or truncated log).
 */
export function parseLogPassCount(log: string): number | undefined {
  const passMatches = [...log.matchAll(/^\s*(\d+)\s+pass\s*$/gm)]
  const lastPassMatch = passMatches.at(-1)
  const rawCount = lastPassMatch?.[1]
  if (rawCount === undefined) return undefined
  return Number(rawCount)
}

export interface GuardViolation {
  readonly kind:
    | 'missing-files'
    | 'unexpected-skips'
    | 'missing-exempt-skips'
    | 'no-pass-line'
    | 'below-pass-floor'
  readonly message: string
  readonly details: readonly string[]
}

export interface EvaluateInput {
  readonly parsed: ParsedJUnit
  readonly passCount: number | undefined
}

function skipKey(s: SkippedTestCase): string {
  return `${s.classname}::${s.name}`
}

/**
 * Evaluates a parsed JUnit report plus a parsed pass count against the
 * five failure conditions the guard enforces. Pure: takes already-parsed
 * data in, returns violations out, performs no I/O.
 */
export function evaluate(input: EvaluateInput): GuardViolation[] {
  const { parsed, passCount } = input
  const violations: GuardViolation[] = []

  const missingFiles = EXPECTED_SUITE_FILES.filter(
    (f) => !parsed.producedFiles.has(f),
  )
  if (missingFiles.length > 0) {
    violations.push({
      kind: 'missing-files',
      message:
        'Expected integration test file(s) produced no JUnit suite (bun test never ran them):',
      details: missingFiles,
    })
  }

  const exemptKeys = new Set(EXEMPT_SKIPS.map(skipKey))
  const actualKeys = parsed.skipped.map(skipKey)

  const unexpected = actualKeys.filter((k) => !exemptKeys.has(k))
  if (unexpected.length > 0) {
    violations.push({
      kind: 'unexpected-skips',
      message: 'Unexpected skipped test(s) (not in the known-exempt set):',
      details: unexpected,
    })
  }

  const missingExempt = [...exemptKeys].filter((k) => !actualKeys.includes(k))
  if (missingExempt.length > 0) {
    violations.push({
      kind: 'missing-exempt-skips',
      message:
        'Known-exempt skip(s) not found in this run (exempt set is stale):',
      details: missingExempt,
    })
  }

  if (passCount === undefined) {
    violations.push({
      kind: 'no-pass-line',
      message:
        'Could not find a "<N> pass" summary line in the captured test output.',
      details: [],
    })
  } else if (passCount < PASS_FLOOR) {
    violations.push({
      kind: 'below-pass-floor',
      message: `Pass count ${passCount} is below the floor of ${PASS_FLOOR}.`,
      details: [],
    })
  }

  return violations
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ArtifactRead {
  /** File content, or `''` when the file could not be read. */
  readonly content: string
  /**
   * Set when the file could not be read (missing, unreadable, etc). `''` is
   * a legitimate empty-file content on success, so a separate field (rather
   * than treating `''` as failure) is what makes an empty-but-present file
   * distinguishable from a missing one.
   */
  readonly readError?: string
}

/**
 * Reads an artifact file, converting any read failure into a `readError`
 * instead of throwing or exiting. This is what lets a missing artifact be
 * evaluated as the contract failure it is (via {@link evaluate}, which
 * already treats empty JUnit/log content as `missing-files` /
 * `missing-exempt-skips` / `no-pass-line`) rather than surfacing as an
 * unrelated filesystem error -- the exact path the guard step's `failure()`
 * gating newly reaches when the suite step dies before writing its output.
 */
export function readArtifact(path: string): ArtifactRead {
  try {
    return { content: readFileSync(path, 'utf8') }
  } catch (err) {
    return {
      content: '',
      readError: `Could not read ${path}: ${errorMessage(err)}`,
    }
  }
}

function main(): void {
  const [, , junitPath, logPath] = process.argv
  if (junitPath === undefined || logPath === undefined) {
    console.error(
      'Usage: bun scripts/host-contract-guard.ts <junit-path> <log-path>',
    )
    process.exit(1)
  }

  const junit = readArtifact(junitPath)
  const log = readArtifact(logPath)

  if (junit.readError !== undefined) {
    console.error(junit.readError)
    console.error(
      'Treating this as the suite producing no test evidence, not as a guard pass.',
    )
  }
  if (log.readError !== undefined) {
    console.error(log.readError)
    console.error(
      'Treating this as the suite producing no pass-count evidence, not as a guard pass.',
    )
  }

  const parsed = parseJUnitXml(junit.content)
  const passCount = parseLogPassCount(log.content)

  if (passCount !== undefined) {
    console.log(`Observed pass count: ${passCount} (floor: ${PASS_FLOOR})`)
  }

  const violations = evaluate({ parsed, passCount })

  for (const violation of violations) {
    console.error(violation.message)
    for (const detail of violation.details) console.error(`  - ${detail}`)
  }

  const hadReadError =
    junit.readError !== undefined || log.readError !== undefined
  if (hadReadError || violations.length > 0) process.exit(1)
  console.log('host-contract skip/pass guard passed.')
}

if (import.meta.main) {
  main()
}
