import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EXEMPT_SKIPS,
  EXPECTED_SUITE_FILES,
  evaluate,
  type GuardViolation,
  PASS_FLOOR,
  parseJUnitXml,
  parseLogPassCount,
  readArtifact,
} from '../../scripts/host-contract-guard.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts/host-contract-guard.ts')

function runGuard(
  junitPath: string,
  logPath: string,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', GUARD_SCRIPT, junitPath, logPath], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'host-contract-guard-'))
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** The exempt skip's key fields, reused so fixtures stay in sync with the
 * real exempt set instead of hardcoding a copy that could drift. */
const EXEMPT = EXEMPT_SKIPS[0]
if (EXEMPT === undefined) throw new Error('EXEMPT_SKIPS must be non-empty')

function testcase(
  classname: string,
  name: string,
  opts: { skipped?: boolean } = {},
): string {
  if (opts.skipped) {
    return `<testcase classname="${classname}" name="${name}" time="0.01"><skipped/></testcase>`
  }
  return `<testcase classname="${classname}" name="${name}" time="0.01"/>`
}

function testsuite(file: string, cases: string): string {
  return `<testsuite name="${file}" file="${file}" tests="1" failures="0" skipped="0">${cases}</testsuite>`
}

/** Builds a complete JUnit XML document with one <testsuite> per expected
 * file, each containing a single non-skipped passing testcase, plus the
 * exempt skip in its own suite. This is the "everything present and
 * healthy" baseline every mutated fixture starts from. */
function buildHealthyJUnit(): string {
  const suites = EXPECTED_SUITE_FILES.map((file) =>
    testsuite(file, testcase(`${file} suite`, 'passes')),
  )
  suites.push(
    testsuite(
      'tests/integration/opencode.test.ts',
      testcase(EXEMPT.classname, EXEMPT.name, { skipped: true }),
    ),
  )
  return `<?xml version="1.0"?><testsuites>${suites.join('')}</testsuites>`
}

function buildLog(passCount: number): string {
  return ['bun test v1.2.3', '', `${passCount} pass`, '0 fail', ''].join('\n')
}

// ---------------------------------------------------------------------------
// parseJUnitXml
// ---------------------------------------------------------------------------

describe('parseJUnitXml', () => {
  test('collects unique produced files across nested describe testsuites', () => {
    const xml =
      '<testsuites>' +
      '<testsuite name="outer" file="tests/integration/opencode.test.ts">' +
      '<testsuite name="inner describe" file="tests/integration/opencode.test.ts">' +
      testcase('c', 'n') +
      '</testsuite>' +
      '</testsuite>' +
      '</testsuites>'
    const parsed = parseJUnitXml(xml)
    expect([...parsed.producedFiles]).toEqual([
      'tests/integration/opencode.test.ts',
    ])
  })

  test('does not match the closing </testsuite> tag or the plural <testsuites>', () => {
    const xml = buildHealthyJUnit()
    const parsed = parseJUnitXml(xml)
    expect(parsed.producedFiles.size).toBe(EXPECTED_SUITE_FILES.length)
  })

  test('collects skipped testcases with classname and name', () => {
    const xml = buildHealthyJUnit()
    const parsed = parseJUnitXml(xml)
    expect(parsed.skipped).toEqual([
      { classname: EXEMPT.classname, name: EXEMPT.name },
    ])
  })

  test('ignores non-skipped testcases', () => {
    const xml = testsuite('f', testcase('c', 'n'))
    const parsed = parseJUnitXml(xml)
    expect(parsed.skipped).toEqual([])
  })

  test('malformed input: empty XML produces no suites and no skips', () => {
    const parsed = parseJUnitXml('')
    expect(parsed.producedFiles.size).toBe(0)
    expect(parsed.skipped).toEqual([])
  })

  test('malformed input: XML with no testsuite elements produces no suites', () => {
    const parsed = parseJUnitXml('<testsuites></testsuites>')
    expect(parsed.producedFiles.size).toBe(0)
    expect(parsed.skipped).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseLogPassCount
// ---------------------------------------------------------------------------

describe('parseLogPassCount', () => {
  test('parses a single pass summary line', () => {
    expect(parseLogPassCount(buildLog(138))).toBe(138)
  })

  test('takes the last of multiple pass summary lines', () => {
    const log = `${buildLog(50)}\n${buildLog(138)}`
    expect(parseLogPassCount(log)).toBe(138)
  })

  test('malformed input: empty log returns undefined', () => {
    expect(parseLogPassCount('')).toBeUndefined()
  })

  test('malformed input: truncated log with no pass line returns undefined', () => {
    expect(
      parseLogPassCount('bun test v1.2.3\n\nrunning tests...'),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// evaluate — the five failure conditions, each proven bidirectionally
// ---------------------------------------------------------------------------

describe('evaluate', () => {
  test('healthy fixture at the pass floor produces no violations', () => {
    const parsed = parseJUnitXml(buildHealthyJUnit())
    const violations = evaluate({ parsed, passCount: PASS_FLOOR })
    expect(violations).toEqual([])
  })

  test('healthy fixture above the pass floor produces no violations', () => {
    const parsed = parseJUnitXml(buildHealthyJUnit())
    const violations = evaluate({ parsed, passCount: PASS_FLOOR + 18 })
    expect(violations).toEqual([])
  })

  describe('condition 1: missingFiles', () => {
    test('trips when an expected suite file produced no testsuite entry', () => {
      const firstFile = EXPECTED_SUITE_FILES[0]
      if (firstFile === undefined) throw new Error('expected at least one file')
      const remaining = EXPECTED_SUITE_FILES.filter((f) => f !== firstFile)
      const suites = remaining.map((file) =>
        testsuite(file, testcase(`${file} suite`, 'passes')),
      )
      suites.push(
        testsuite(
          'tests/integration/opencode.test.ts',
          testcase(EXEMPT.classname, EXEMPT.name, { skipped: true }),
        ),
      )
      const xml = `<testsuites>${suites.join('')}</testsuites>`
      const parsed = parseJUnitXml(xml)
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      const missing = violations.find((v) => v.kind === 'missing-files')
      expect(missing).toBeDefined()
      expect(missing?.details).toEqual([firstFile])
    })

    test('near-miss: all expected files present does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'missing-files')).toBe(false)
    })
  })

  describe('condition 2: unexpected skips', () => {
    test('trips when a skip is not in the exempt set', () => {
      const xml = buildHealthyJUnit().replace(
        '</testsuites>',
        `${testsuite('tests/integration/pi.test.ts', testcase('pi suite', 'some other test', { skipped: true }))}</testsuites>`,
      )
      const parsed = parseJUnitXml(xml)
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      const unexpected = violations.find((v) => v.kind === 'unexpected-skips')
      expect(unexpected).toBeDefined()
      expect(unexpected?.details).toEqual(['pi suite::some other test'])
    })

    test('near-miss: only the exempt skip present does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'unexpected-skips')).toBe(false)
    })
  })

  describe('condition 3: missing exempt skips (bidirectional)', () => {
    test('trips when the known-exempt skip is absent from this run', () => {
      const suites = EXPECTED_SUITE_FILES.map((file) =>
        testsuite(file, testcase(`${file} suite`, 'passes')),
      )
      const xml = `<testsuites>${suites.join('')}</testsuites>`
      const parsed = parseJUnitXml(xml)
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      const missingExempt = violations.find(
        (v) => v.kind === 'missing-exempt-skips',
      )
      expect(missingExempt).toBeDefined()
      expect(missingExempt?.details).toEqual([
        `${EXEMPT.classname}::${EXEMPT.name}`,
      ])
    })

    test('near-miss: a differently-named skip does not satisfy the exempt entry (rename fails loudly)', () => {
      const suites = EXPECTED_SUITE_FILES.map((file) =>
        testsuite(file, testcase(`${file} suite`, 'passes')),
      )
      suites.push(
        testsuite(
          'tests/integration/opencode.test.ts',
          testcase(EXEMPT.classname, 'a renamed version of the exempt test', {
            skipped: true,
          }),
        ),
      )
      const xml = `<testsuites>${suites.join('')}</testsuites>`
      const parsed = parseJUnitXml(xml)
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      // The rename shows up as BOTH an unexpected skip (the new key isn't
      // exempt) and a missing exempt skip (the old key never matched) --
      // proving the exempt set has no rename-tolerance gap, per issue item 4.
      expect(violations.some((v) => v.kind === 'unexpected-skips')).toBe(true)
      expect(violations.some((v) => v.kind === 'missing-exempt-skips')).toBe(
        true,
      )
    })

    test('near-miss: exempt skip present does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'missing-exempt-skips')).toBe(
        false,
      )
    })
  })

  describe('condition 4: no pass line parseable', () => {
    test('trips when passCount is undefined', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: undefined })
      expect(violations.some((v) => v.kind === 'no-pass-line')).toBe(true)
    })

    test('near-miss: a parseable pass count at the floor does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'no-pass-line')).toBe(false)
    })
  })

  describe('condition 5: below pass floor', () => {
    test('trips when passCount is below PASS_FLOOR', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR - 1 })
      const belowFloor = violations.find((v) => v.kind === 'below-pass-floor')
      expect(belowFloor).toBeDefined()
      expect(belowFloor?.message).toContain(String(PASS_FLOOR - 1))
    })

    test('near-miss: exactly at the floor does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = evaluate({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'below-pass-floor')).toBe(false)
    })
  })

  test('multiple simultaneous violations are all reported', () => {
    const parsed = parseJUnitXml('<testsuites></testsuites>')
    const violations = evaluate({ parsed, passCount: 1 })
    const kinds = violations.map((v) => v.kind).sort()
    const expectedKinds: GuardViolation['kind'][] = [
      'missing-files',
      'missing-exempt-skips',
      'below-pass-floor',
    ]
    expect(kinds).toEqual(expectedKinds.sort())
  })
})

// ---------------------------------------------------------------------------
// parseJUnitXml — XML entity decoding
// ---------------------------------------------------------------------------

describe('parseJUnitXml entity decoding', () => {
  test('decodes &lt; in a testcase name (the real "payload &lt;= 10000 chars" test in claude-code.test.ts produces exactly this)', () => {
    const xml = testsuite(
      'tests/integration/claude-code.test.ts',
      testcase('claude-code suite', 'payload &lt;= 10000 chars', {
        skipped: true,
      }),
    )
    const parsed = parseJUnitXml(xml)
    expect(parsed.skipped).toEqual([
      { classname: 'claude-code suite', name: 'payload <= 10000 chars' },
    ])
  })

  test('decodes &amp; &gt; &quot; &apos; and a numeric character reference', () => {
    const xml = testsuite(
      'f',
      testcase(
        'A &amp; B &gt; C &quot;quoted&quot; &apos;single&apos; &#65;',
        'n',
        { skipped: true },
      ),
    )
    const parsed = parseJUnitXml(xml)
    expect(parsed.skipped).toEqual([
      { classname: `A & B > C "quoted" 'single' A`, name: 'n' },
    ])
  })

  test('an entity-mismatched skip still trips both unexpected-skips and missing-exempt-skips (fails loudly, not silently)', () => {
    // If EXEMPT_SKIPS were compared against raw, un-decoded XML text, a
    // real skip whose name round-trips through entity-escaping would
    // silently fail to match a correctly-written literal exempt entry.
    // Decoding closes that gap; this proves the failure mode it prevents
    // still fails loudly rather than passing by accident.
    const xml = testsuite(
      'tests/integration/opencode.test.ts',
      testcase(EXEMPT.classname, `${EXEMPT.name} &amp; extra`, {
        skipped: true,
      }),
    )
    const parsed = parseJUnitXml(xml)
    const violations = evaluate({ parsed, passCount: PASS_FLOOR })
    expect(violations.some((v) => v.kind === 'unexpected-skips')).toBe(true)
    expect(violations.some((v) => v.kind === 'missing-exempt-skips')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readArtifact
// ---------------------------------------------------------------------------

describe('readArtifact', () => {
  test('returns content with no readError for an existing file', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'present.txt')
    fs.writeFileSync(file, 'hello', 'utf8')
    try {
      const result = readArtifact(file)
      expect(result.content).toBe('hello')
      expect(result.readError).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns empty content and a readError naming the path for a missing file', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'missing.txt')
    try {
      const result = readArtifact(file)
      expect(result.content).toBe('')
      expect(result.readError).toContain(file)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an existing but genuinely empty file has empty content and no readError', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'empty.txt')
    fs.writeFileSync(file, '', 'utf8')
    try {
      const result = readArtifact(file)
      expect(result.content).toBe('')
      expect(result.readError).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// CLI wrapper (subprocess) — argv arity, exit codes, and the missing-artifact
// path the "Guard skipped tests and pass floor" step now reaches whenever it
// runs against a suite step that failed before producing output.
// ---------------------------------------------------------------------------

describe('CLI wrapper', () => {
  test('exits 0 and prints the pass line for a healthy fixture pair', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'junit.xml')
    const logPath = path.join(dir, 'log.txt')
    fs.writeFileSync(junitPath, buildHealthyJUnit(), 'utf8')
    fs.writeFileSync(logPath, buildLog(PASS_FLOOR), 'utf8')
    try {
      const result = runGuard(junitPath, logPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`Observed pass count: ${PASS_FLOOR}`)
      expect(result.stdout).toContain('host-contract skip/pass guard passed.')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing JUnit path reports a contract failure, not a raw ENOENT crash, and exits 1', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'does-not-exist.xml')
    const logPath = path.join(dir, 'log.txt')
    fs.writeFileSync(logPath, buildLog(PASS_FLOOR), 'utf8')
    try {
      const result = runGuard(junitPath, logPath)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`Could not read ${junitPath}`)
      expect(result.stderr).toContain(
        'Treating this as the suite producing no test evidence, not as a guard pass.',
      )
      // The missing artifact still routes through the same evaluate() logic
      // as any other empty JUnit content, so the reader also sees which
      // specific expected files were never produced -- a diagnosis, not
      // just an I/O complaint.
      expect(result.stderr).toContain(
        'Expected integration test file(s) produced no JUnit suite',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing log path reports a contract failure and exits 1', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'junit.xml')
    const logPath = path.join(dir, 'does-not-exist.txt')
    fs.writeFileSync(junitPath, buildHealthyJUnit(), 'utf8')
    try {
      const result = runGuard(junitPath, logPath)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`Could not read ${logPath}`)
      expect(result.stderr).toContain(
        'Treating this as the suite producing no pass-count evidence, not as a guard pass.',
      )
      expect(result.stderr).toContain(
        'Could not find a "<N> pass" summary line',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('both artifacts missing reports both contract failures and exits 1', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'no-junit.xml')
    const logPath = path.join(dir, 'no-log.txt')
    const result = runGuard(junitPath, logPath)
    fs.rmSync(dir, { recursive: true, force: true })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Could not read ${junitPath}`)
    expect(result.stderr).toContain(`Could not read ${logPath}`)
  })

  test('missing CLI arguments print usage and exit 1', () => {
    const result = Bun.spawnSync(['bun', GUARD_SCRIPT], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      'Usage: bun scripts/host-contract-guard.ts <junit-path> <log-path>',
    )
  })

  test('a fixture pair that trips a normal violation (below floor) exits 1 without a readError message', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'junit.xml')
    const logPath = path.join(dir, 'log.txt')
    fs.writeFileSync(junitPath, buildHealthyJUnit(), 'utf8')
    fs.writeFileSync(logPath, buildLog(PASS_FLOOR - 1), 'utf8')
    try {
      const result = runGuard(junitPath, logPath)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        `Pass count ${PASS_FLOOR - 1} is below the floor`,
      )
      expect(result.stderr).not.toContain('Could not read')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
