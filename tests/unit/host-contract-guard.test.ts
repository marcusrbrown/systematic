import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EXEMPT_SKIPS,
  EXPECTED_SUITE_FILES,
  evaluate,
  type GuardViolation,
  HOST_CONTRACT_PROFILES,
  type HostContractProfile,
  mergeEvidence,
  PROFILE_EXEMPT_SKIPS,
  PROFILE_PASS_FLOORS,
  PROFILE_SUITE_FILES,
  parseCommandLine,
  parseJUnitXml,
  parseLogPassCount,
  readArtifact,
} from '../../scripts/host-contract-guard.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts/host-contract-guard.ts')

/** The profile most of this file judges: it has the exempt skip and the most files. */
const PROFILE: HostContractProfile = 'v1-current'
const PASS_FLOOR = PROFILE_PASS_FLOORS[PROFILE]
const PROFILE_FILES = PROFILE_SUITE_FILES[PROFILE]

/** `evaluate` for the default profile unless another is named. */
function judge(
  input: Parameters<typeof evaluate>[0],
  profile: HostContractProfile = PROFILE,
): GuardViolation[] {
  return evaluate(input, profile)
}

function runGuard(...paths: string[]): {
  exitCode: number
  stdout: string
  stderr: string
} {
  return runGuardArgs('--profile', PROFILE, ...paths)
}

function runGuardArgs(...args: string[]): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = Bun.spawnSync(['bun', GUARD_SCRIPT, ...args], {
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

const INTEGRATION_DIR = path.join(REPO_ROOT, 'tests/integration')

/**
 * Every `*.test.ts` file directly under `tests/integration/`. Deliberately
 * non-recursive: `tests/integration/` is flat (verified -- its only
 * subdirectory is `fixtures/`, which holds shared test scaffolding, not
 * suite files, and a non-recursive `.test.ts` filter already excludes it
 * since `fixtures` itself doesn't end in `.test.ts`).
 */
function listIntegrationSuiteFiles(): string[] {
  return fs
    .readdirSync(INTEGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/integration/${entry.name}`)
    .sort()
}

// ---------------------------------------------------------------------------
// EXPECTED_SUITE_FILES drift against the real directory
// ---------------------------------------------------------------------------

describe('EXPECTED_SUITE_FILES', () => {
  test('matches the real contents of tests/integration/ (a new or removed suite file must update this list)', () => {
    // EXPECTED_SUITE_FILES is deliberately hardcoded (see the module-level
    // doc comment on it) rather than derived at guard runtime, so this
    // test is what keeps it honest: without it, a newly added integration
    // test file would silently escape condition 1 ("an expected suite file
    // produced no JUnit entry") -- the guard would stay green while no
    // longer requiring that file to have run at all, which is exactly the
    // class of drift the guard exists to catch.
    const actual = listIntegrationSuiteFiles()
    expect([...EXPECTED_SUITE_FILES].sort()).toEqual(actual)
  })
})

describe('PROFILE_SUITE_FILES', () => {
  test('every integration test file appears in at least one profile list, so a new file cannot silently go unrun', () => {
    const listed = new Set(Object.values(PROFILE_SUITE_FILES).flat())
    const unlisted = listIntegrationSuiteFiles().filter(
      (file) => !listed.has(file),
    )

    expect(unlisted).toEqual([])
  })

  test('every listed file exists, and no profile lists a file twice', () => {
    for (const profile of HOST_CONTRACT_PROFILES) {
      const files = PROFILE_SUITE_FILES[profile]
      expect(new Set(files).size).toBe(files.length)
      for (const file of files) {
        expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true)
      }
    }
  })

  test('host-neutral files run in the v2 profile only', () => {
    const neutral = [
      'tests/integration/claude-code.test.ts',
      'tests/integration/pi.test.ts',
      'tests/integration/release-notes-ci.test.ts',
      'tests/integration/validate-release-target.test.ts',
      'tests/integration/eval-artifact.test.ts',
      'tests/integration/eval-fixture.test.ts',
    ]
    for (const file of neutral) {
      expect(PROFILE_SUITE_FILES.v2).toContain(file)
      expect(PROFILE_SUITE_FILES['v1-floor']).not.toContain(file)
      expect(PROFILE_SUITE_FILES['v1-current']).not.toContain(file)
    }
  })

  test('v1-only behavior stays out of the v2 profile', () => {
    expect(PROFILE_SUITE_FILES.v2).not.toContain(
      'tests/integration/skill-command-probe.test.ts',
    )
    expect(PROFILE_SUITE_FILES.v2).not.toContain(
      'tests/integration/eval-runner.test.ts',
    )
    expect(PROFILE_SUITE_FILES['v1-floor']).not.toContain(
      'tests/integration/eval-runner.test.ts',
    )
  })

  test('each profile lists the files that carry its host contract', () => {
    const anchors: Record<HostContractProfile, readonly string[]> = {
      v2: [
        'tests/integration/opencode-v2.test.ts',
        'tests/integration/opencode.test.ts',
      ],
      'v1-floor': [
        'tests/integration/ce-review-return-validation.test.ts',
        'tests/integration/opencode-v1.test.ts',
        'tests/integration/opencode.test.ts',
        'tests/integration/skill-command-probe.test.ts',
        'tests/integration/skill-delivery.test.ts',
      ],
      'v1-current': [
        'tests/integration/ce-review-return-validation.test.ts',
        'tests/integration/opencode-v1.test.ts',
        'tests/integration/opencode.test.ts',
        'tests/integration/skill-command-probe.test.ts',
        'tests/integration/skill-delivery.test.ts',
      ],
    }
    for (const profile of HOST_CONTRACT_PROFILES) {
      for (const file of anchors[profile]) {
        expect(PROFILE_SUITE_FILES[profile], `${profile}: ${file}`).toContain(
          file,
        )
      }
    }
    expect(PROFILE_SUITE_FILES.v2).not.toContain(
      'tests/integration/opencode-v1.test.ts',
    )
  })

  test('the two v1 profiles run the same smoke set, and the current pin adds only the eval runner', () => {
    const floor = PROFILE_SUITE_FILES['v1-floor']
    const current = PROFILE_SUITE_FILES['v1-current']

    expect(current.filter((file) => !floor.includes(file))).toEqual([
      'tests/integration/eval-runner.test.ts',
    ])
    expect(floor.every((file) => current.includes(file))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** The exempt skip's key fields, reused so fixtures stay in sync with the
 * real exempt set instead of hardcoding a copy that could drift. This is a
 * function (not a bare index access) so the non-optional return type holds
 * across the hoisted function declarations below that reference `EXEMPT`. */
function requireFirstExemptSkip(): (typeof EXEMPT_SKIPS)[number] {
  const exempt = EXEMPT_SKIPS[0]
  if (exempt === undefined) throw new Error('EXEMPT_SKIPS must be non-empty')
  return exempt
}
const EXEMPT = requireFirstExemptSkip()

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
  const suites = PROFILE_FILES.map((file) =>
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
    expect(parsed.producedFiles.size).toBe(PROFILE_FILES.length)
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
    const violations = judge({ parsed, passCount: PASS_FLOOR })
    expect(violations).toEqual([])
  })

  test('healthy fixture above the pass floor produces no violations', () => {
    const parsed = parseJUnitXml(buildHealthyJUnit())
    const violations = judge({ parsed, passCount: PASS_FLOOR + 18 })
    expect(violations).toEqual([])
  })

  describe('condition 1: missingFiles', () => {
    test('trips when an expected suite file produced no testsuite entry', () => {
      const firstFile = PROFILE_FILES[0]
      if (firstFile === undefined) throw new Error('expected at least one file')
      const remaining = PROFILE_FILES.filter((f) => f !== firstFile)
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
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      const missing = violations.find((v) => v.kind === 'missing-files')
      expect(missing).toBeDefined()
      expect(missing?.details).toEqual([firstFile])
    })

    test('near-miss: all expected files present does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: PASS_FLOOR })
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
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      const unexpected = violations.find((v) => v.kind === 'unexpected-skips')
      expect(unexpected).toBeDefined()
      expect(unexpected?.details).toEqual(['pi suite::some other test'])
    })

    test('near-miss: only the exempt skip present does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'unexpected-skips')).toBe(false)
    })
  })

  describe('condition 3: missing exempt skips (bidirectional)', () => {
    test('trips when the known-exempt skip is absent from this run', () => {
      const suites = PROFILE_FILES.map((file) =>
        testsuite(file, testcase(`${file} suite`, 'passes')),
      )
      const xml = `<testsuites>${suites.join('')}</testsuites>`
      const parsed = parseJUnitXml(xml)
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      const missingExempt = violations.find(
        (v) => v.kind === 'missing-exempt-skips',
      )
      expect(missingExempt).toBeDefined()
      expect(missingExempt?.details).toEqual([
        `${EXEMPT.classname}::${EXEMPT.name}`,
      ])
    })

    test('near-miss: a differently-named skip does not satisfy the exempt entry (rename fails loudly)', () => {
      const suites = PROFILE_FILES.map((file) =>
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
      const violations = judge({ parsed, passCount: PASS_FLOOR })
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
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'missing-exempt-skips')).toBe(
        false,
      )
    })
  })

  describe('condition 4: no pass line parseable', () => {
    test('trips when passCount is undefined', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: undefined })
      expect(violations.some((v) => v.kind === 'no-pass-line')).toBe(true)
    })

    test('near-miss: a parseable pass count at the floor does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'no-pass-line')).toBe(false)
    })
  })

  describe('condition 5: below pass floor', () => {
    test('trips when passCount is below PASS_FLOOR', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: PASS_FLOOR - 1 })
      const belowFloor = violations.find((v) => v.kind === 'below-pass-floor')
      expect(belowFloor).toBeDefined()
      expect(belowFloor?.message).toContain(String(PASS_FLOOR - 1))
    })

    test('near-miss: exactly at the floor does not trip', () => {
      const parsed = parseJUnitXml(buildHealthyJUnit())
      const violations = judge({ parsed, passCount: PASS_FLOOR })
      expect(violations.some((v) => v.kind === 'below-pass-floor')).toBe(false)
    })
  })

  test('multiple simultaneous violations are all reported', () => {
    const parsed = parseJUnitXml('<testsuites></testsuites>')
    const violations = judge({ parsed, passCount: 1 })
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
    const violations = judge({ parsed, passCount: PASS_FLOOR })
    expect(violations.some((v) => v.kind === 'unexpected-skips')).toBe(true)
    expect(violations.some((v) => v.kind === 'missing-exempt-skips')).toBe(true)
  })

  describe('out-of-range numeric character references (must not crash the guard)', () => {
    // `String.fromCodePoint` throws a RangeError above 0x10FFFF (the
    // highest valid Unicode code point) rather than returning a sentinel.
    // These go through the real exported `parseJUnitXml` entry point, not
    // a copy of the private `decodeXmlEntities`, so a regression that
    // reintroduces the crash is caught exactly where a real JUnit report
    // would trigger it.
    test('an out-of-range hex reference (&#x110000;) is left as literal text, not thrown', () => {
      const xml = testsuite(
        'f',
        testcase('c', 'broken &#x110000; reference', { skipped: true }),
      )
      expect(() => parseJUnitXml(xml)).not.toThrow()
      const parsed = parseJUnitXml(xml)
      expect(parsed.skipped).toEqual([
        { classname: 'c', name: 'broken &#x110000; reference' },
      ])
    })

    test('an out-of-range decimal reference (&#9999999999;) is left as literal text, not thrown', () => {
      const xml = testsuite(
        'f',
        testcase('c', 'broken &#9999999999; reference', { skipped: true }),
      )
      expect(() => parseJUnitXml(xml)).not.toThrow()
      const parsed = parseJUnitXml(xml)
      expect(parsed.skipped).toEqual([
        { classname: 'c', name: 'broken &#9999999999; reference' },
      ])
    })

    test('a non-numeric, non-predefined reference is left as literal text, not thrown', () => {
      // &nbsp; is a valid HTML entity but not one of the five XML
      // predefined entities and not numeric, so the regex in
      // decodeXmlEntities never matches it at all -- included as a
      // baseline "not decoded, definitely not thrown" case alongside the
      // numeric out-of-range cases above.
      const xml = testsuite(
        'f',
        testcase('c', 'broken &nbsp; reference', { skipped: true }),
      )
      expect(() => parseJUnitXml(xml)).not.toThrow()
      const parsed = parseJUnitXml(xml)
      expect(parsed.skipped).toEqual([
        { classname: 'c', name: 'broken &nbsp; reference' },
      ])
    })

    test('valid references still decode correctly alongside the range check', () => {
      const xml = testsuite(
        'f',
        testcase('c', 'valid &lt; and &#60; and &#x3C; all decode', {
          skipped: true,
        }),
      )
      const parsed = parseJUnitXml(xml)
      expect(parsed.skipped).toEqual([
        { classname: 'c', name: 'valid < and < and < all decode' },
      ])
    })
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
      expect(result.stdout).toContain(
        `Observed ${PROFILE} pass count: ${PASS_FLOOR}`,
      )
      expect(result.stdout).toContain(
        `host-contract skip/pass guard passed for ${PROFILE}.`,
      )
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
      'Usage: bun scripts/host-contract-guard.ts --profile <profile> <junit-path> <log-path>',
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
        `Pass count ${PASS_FLOOR - 1} is below the ${PROFILE} floor`,
      )
      expect(result.stderr).not.toContain('Could not read')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Several shards: the guard reads one junit/log pair per shard and judges the
// union. Files, skips and pass counts are merged before the same checks run.
// ---------------------------------------------------------------------------

const SHARD_COUNT = 4

/** Splits the expected suite files round-robin into `SHARD_COUNT` groups. */
function partitionFiles(): string[][] {
  const groups: string[][] = Array.from({ length: SHARD_COUNT }, () => [])
  for (const [index, file] of PROFILE_FILES.entries()) {
    groups[index % SHARD_COUNT]?.push(file)
  }
  return groups
}

/** A healthy shard report: its files, plus the exempt skip when it owns opencode.test.ts. */
function buildShardJUnit(files: readonly string[]): string {
  const suites = files.map((file) =>
    testsuite(file, testcase(`${file} suite`, 'passes')),
  )
  if (files.includes('tests/integration/opencode.test.ts')) {
    suites.push(
      testsuite(
        'tests/integration/opencode.test.ts',
        testcase(EXEMPT.classname, EXEMPT.name, { skipped: true }),
      ),
    )
  }
  return `<?xml version="1.0"?><testsuites>${suites.join('')}</testsuites>`
}

/** A pass count per shard that sums to exactly the floor. */
function shardPassCounts(): number[] {
  const base = Math.floor(PASS_FLOOR / SHARD_COUNT)
  const counts = Array.from({ length: SHARD_COUNT }, () => base)
  counts[0] = (counts[0] ?? 0) + (PASS_FLOOR - base * SHARD_COUNT)
  return counts
}

function evidenceOf(
  junit: string,
  passCount: number | undefined,
): { parsed: ReturnType<typeof parseJUnitXml>; passCount: number | undefined } {
  return { parsed: parseJUnitXml(junit), passCount }
}

function healthyShardEvidence() {
  const counts = shardPassCounts()
  return partitionFiles().map((files, index) =>
    evidenceOf(buildShardJUnit(files), counts[index]),
  )
}

describe('mergeEvidence', () => {
  test('a file produced by only one shard still counts for the union', () => {
    const merged = mergeEvidence(healthyShardEvidence())

    expect([...merged.parsed.producedFiles].sort()).toEqual(
      [...PROFILE_FILES].sort(),
    )
    expect(judge(merged)).toEqual([])
  })

  test('judged alone, a single shard misses the files the others ran', () => {
    const [first] = healthyShardEvidence()
    if (!first) throw new Error('no shard evidence')

    const kinds = judge(first).map((violation) => violation.kind)

    expect(kinds).toContain('missing-files')
  })

  test('an expected file produced by no shard is reported missing', () => {
    const dropped = 'tests/integration/skill-delivery.test.ts'
    const counts = shardPassCounts()
    const shards = partitionFiles().map((files, index) =>
      evidenceOf(
        buildShardJUnit(files.filter((file) => file !== dropped)),
        counts[index],
      ),
    )

    const violations = judge(mergeEvidence(shards))

    const missing = violations.find((v) => v.kind === 'missing-files')
    expect(missing?.details).toEqual([dropped])
  })

  test('pass counts sum across shards', () => {
    const merged = mergeEvidence(healthyShardEvidence())

    expect(merged.passCount).toBe(PASS_FLOOR)
  })

  test('shards that each clear a quarter of the floor but sum below it fail the floor', () => {
    const shards = partitionFiles().map((files) =>
      evidenceOf(
        buildShardJUnit(files),
        Math.floor(PASS_FLOOR / SHARD_COUNT) - 1,
      ),
    )

    const violations = judge(mergeEvidence(shards))

    expect(violations.map((v) => v.kind)).toEqual(['below-pass-floor'])
  })

  test('a shard whose log has no pass line leaves the sum unknown and fails', () => {
    const shards = healthyShardEvidence()
    shards[2] = evidenceOf(
      buildShardJUnit(partitionFiles()[2] ?? []),
      undefined,
    )

    const merged = mergeEvidence(shards)

    expect(merged.passCount).toBeUndefined()
    expect(judge(merged).map((v) => v.kind)).toContain('no-pass-line')
  })

  test('the exempt skip may sit in any one shard', () => {
    const merged = mergeEvidence(healthyShardEvidence())

    expect(merged.parsed.skipped).toHaveLength(1)
    expect(judge(merged)).toEqual([])
  })

  test('an unexpected skip in any shard fails the union', () => {
    const counts = shardPassCounts()
    const shards = partitionFiles().map((files, index) => {
      const extra =
        index === 3
          ? testsuite(
              files[0] ?? 'tests/integration/x.test.ts',
              testcase('other', 'skips', { skipped: true }),
            )
          : ''
      return evidenceOf(
        buildShardJUnit(files).replace(
          '</testsuites>',
          `${extra}</testsuites>`,
        ),
        counts[index],
      )
    })

    const kinds = judge(mergeEvidence(shards)).map((v) => v.kind)

    expect(kinds).toEqual(['unexpected-skips'])
  })

  test('merging nothing yields an empty union that fails every check', () => {
    const kinds = judge(mergeEvidence([])).map((v) => v.kind)

    expect(kinds).toContain('missing-files')
    expect(kinds).toContain('no-pass-line')
  })
})

describe('CLI wrapper with several shards', () => {
  function writeShardPairs(
    dir: string,
    { skipJunit }: { skipJunit?: number } = {},
  ): string[] {
    const counts = shardPassCounts()
    return partitionFiles().flatMap((files, index) => {
      const junitPath = path.join(dir, `junit-${index + 1}.xml`)
      const logPath = path.join(dir, `log-${index + 1}.txt`)
      if (skipJunit !== index) {
        fs.writeFileSync(junitPath, buildShardJUnit(files), 'utf8')
      }
      fs.writeFileSync(logPath, buildLog(counts[index] ?? 0), 'utf8')
      return [junitPath, logPath]
    })
  }

  test('four healthy pairs pass and report the summed pass count', () => {
    const dir = makeTempDir()
    try {
      const result = runGuard(...writeShardPairs(dir))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        `Observed ${PROFILE} pass count: ${PASS_FLOOR}`,
      )
      expect(result.stdout).toContain(
        `host-contract skip/pass guard passed for ${PROFILE}.`,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing artifact for one pair is a violation, named by path', () => {
    const dir = makeTempDir()
    try {
      const result = runGuard(...writeShardPairs(dir, { skipJunit: 2 }))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        `Could not read ${path.join(dir, 'junit-3.xml')}`,
      )
      expect(result.stderr).toContain(
        'Expected integration test file(s) produced no JUnit suite',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a shard missing from the arguments leaves its files unproduced and fails', () => {
    const dir = makeTempDir()
    try {
      const result = runGuard(...writeShardPairs(dir).slice(0, 6))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        'Expected integration test file(s) produced no JUnit suite',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    { label: 'no arguments', count: 0 },
    { label: 'one path', count: 1 },
    { label: 'three paths', count: 3 },
    { label: 'seven paths', count: 7 },
  ])('$label is a usage error', ({ count }) => {
    const dir = makeTempDir()
    try {
      const paths = Array.from({ length: count }, (_, i) =>
        path.join(dir, `arg-${i}`),
      )

      const result = runGuard(...paths)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        'Usage: bun scripts/host-contract-guard.ts --profile <profile> <junit-path> <log-path>',
      )
      expect(result.stderr).toContain('[<junit-path> <log-path> ...]')
      expect(result.stderr).not.toContain('Could not read')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Profiles: each host job is judged against its own files, floor and skips.
// ---------------------------------------------------------------------------

function exemptSkipSuite(
  profile: HostContractProfile,
  { omit }: { omit?: string } = {},
): string[] {
  const [exempt] = PROFILE_EXEMPT_SKIPS[profile]
  if (exempt === undefined) return []
  if (omit === 'tests/integration/opencode-v1.test.ts') return []
  return [
    testsuite(
      'tests/integration/opencode-v1.test.ts',
      testcase(exempt.classname, exempt.name, { skipped: true }),
    ),
  ]
}

/** A complete, healthy report for one profile: its files, plus its exempt skip if it has one. */
function healthyReport(
  profile: HostContractProfile,
  { without }: { without?: string } = {},
): string {
  const suites = PROFILE_SUITE_FILES[profile]
    .filter((file) => file !== without)
    .map((file) => testsuite(file, testcase(`${file} suite`, 'passes')))
  return `<?xml version="1.0"?><testsuites>${[...suites, ...exemptSkipSuite(profile, { omit: without })].join('')}</testsuites>`
}

function judgeReport(
  report: string,
  profile: HostContractProfile,
  passCount = PROFILE_PASS_FLOORS[profile],
): GuardViolation[] {
  return evaluate({ parsed: parseJUnitXml(report), passCount }, profile)
}

describe('profile configuration', () => {
  test.each([...HOST_CONTRACT_PROFILES])(
    '%s has a positive whole-number pass floor',
    (profile) => {
      const floor = PROFILE_PASS_FLOORS[profile]
      expect(Number.isInteger(floor)).toBe(true)
      expect(floor).toBeGreaterThan(0)
    },
  )

  test('the v2 profile exempts no skip, and both v1 profiles exempt the mixed-version test', () => {
    expect(PROFILE_EXEMPT_SKIPS.v2).toEqual([])
    expect(PROFILE_EXEMPT_SKIPS['v1-floor']).toEqual(EXEMPT_SKIPS)
    expect(PROFILE_EXEMPT_SKIPS['v1-current']).toEqual(EXEMPT_SKIPS)
  })

  test('the exempt test lives in a file both v1 profiles run and the v2 profile does not', () => {
    const exemptFile = 'tests/integration/opencode-v1.test.ts'
    const source = fs.readFileSync(path.join(REPO_ROOT, exemptFile), 'utf8')

    for (const exempt of EXEMPT_SKIPS) {
      expect(source).toContain(exempt.classname)
    }
    expect(PROFILE_SUITE_FILES['v1-floor']).toContain(exemptFile)
    expect(PROFILE_SUITE_FILES['v1-current']).toContain(exemptFile)
    expect(PROFILE_SUITE_FILES.v2).not.toContain(exemptFile)
  })
})

describe('evaluate per profile', () => {
  test.each([...HOST_CONTRACT_PROFILES])(
    'a complete report set at the %s floor passes',
    (profile) => {
      expect(judgeReport(healthyReport(profile), profile)).toEqual([])
    },
  )

  test('a file missing from the v2 report fails the v2 profile only', () => {
    const file = 'tests/integration/opencode-v2.test.ts'
    const violations = (profile: HostContractProfile) =>
      judgeReport(healthyReport(profile, { without: file }), profile)

    const missing = violations('v2').find((v) => v.kind === 'missing-files')
    expect(missing?.details).toEqual([file])
    expect(violations('v1-floor')).toEqual([])
    expect(violations('v1-current')).toEqual([])
  })

  test('a file missing from a v1 report fails the v1 profiles and names it', () => {
    const file = 'tests/integration/opencode-v1.test.ts'
    for (const profile of ['v1-floor', 'v1-current'] as const) {
      const missing = judgeReport(
        healthyReport(profile, { without: file }),
        profile,
      ).find((v) => v.kind === 'missing-files')
      expect(missing?.details).toEqual([file])
    }
    expect(judgeReport(healthyReport('v2'), 'v2')).toEqual([])
  })

  test('a report that has every file of another profile but not its own fails', () => {
    const v1Report = healthyReport('v1-current')
    const kinds = judgeReport(v1Report, 'v2').map((v) => v.kind)

    expect(kinds).toContain('missing-files')
  })

  test.each<HostContractProfile>(['v1-floor', 'v1-current'])(
    'an unexpected skip in %s fails',
    (profile) => {
      const extra = testsuite(
        'tests/integration/opencode.test.ts',
        testcase('some suite', 'some test', { skipped: true }),
      )
      const report = healthyReport(profile).replace(
        '</testsuites>',
        `${extra}</testsuites>`,
      )

      const unexpected = judgeReport(report, profile).find(
        (v) => v.kind === 'unexpected-skips',
      )

      expect(unexpected?.details).toEqual(['some suite::some test'])
    },
  )

  test('the mixed-version skip passes on the v1 profiles and fails on v2', () => {
    for (const profile of ['v1-floor', 'v1-current'] as const) {
      expect(judgeReport(healthyReport(profile), profile)).toEqual([])
    }

    const v2WithSkip = healthyReport('v2').replace(
      '</testsuites>',
      `${exemptSkipSuite('v1-current').join('')}</testsuites>`,
    )
    const kinds = judgeReport(v2WithSkip, 'v2').map((v) => v.kind)

    expect(kinds).toEqual(['unexpected-skips'])
  })

  test('a v1 report without the mixed-version skip reports a stale exempt set', () => {
    const suites = PROFILE_SUITE_FILES['v1-floor'].map((file) =>
      testsuite(file, testcase(`${file} suite`, 'passes')),
    )
    const report = `<testsuites>${suites.join('')}</testsuites>`

    const kinds = judgeReport(report, 'v1-floor').map((v) => v.kind)

    expect(kinds).toEqual(['missing-exempt-skips'])
  })

  test.each([...HOST_CONTRACT_PROFILES])(
    'a pass count one under the %s floor fails, naming the profile',
    (profile) => {
      const floor = PROFILE_PASS_FLOORS[profile]

      const violations = judgeReport(healthyReport(profile), profile, floor - 1)

      expect(violations.map((v) => v.kind)).toEqual(['below-pass-floor'])
      expect(violations[0]?.message).toContain(profile)
      expect(violations[0]?.message).toContain(String(floor))
    },
  )

  test('a count that clears the smaller floor can still fail the larger one', () => {
    const [low, high] = [...HOST_CONTRACT_PROFILES].sort(
      (a, b) => PROFILE_PASS_FLOORS[a] - PROFILE_PASS_FLOORS[b],
    )
    if (low === undefined || high === undefined) throw new Error('no profiles')
    if (PROFILE_PASS_FLOORS[low] === PROFILE_PASS_FLOORS[high]) return
    const count = PROFILE_PASS_FLOORS[low]

    expect(judgeReport(healthyReport(low), low, count)).toEqual([])
    expect(
      judgeReport(healthyReport(high), high, count).map((v) => v.kind),
    ).toEqual(['below-pass-floor'])
  })

  test('four v2 shards that together hold every v2 file, with no skips, pass', () => {
    const files = PROFILE_SUITE_FILES.v2
    const shards = Array.from({ length: SHARD_COUNT }, (_, shard) => {
      const own = files.filter((_file, index) => index % SHARD_COUNT === shard)
      const suites = own.map((file) =>
        testsuite(file, testcase(`${file} suite`, 'passes')),
      )
      return {
        parsed: parseJUnitXml(`<testsuites>${suites.join('')}</testsuites>`),
        passCount: Math.ceil(PROFILE_PASS_FLOORS.v2 / SHARD_COUNT),
      }
    })

    expect(evaluate(mergeEvidence(shards), 'v2')).toEqual([])
  })
})

describe('parseCommandLine', () => {
  test('reads the profile flag in front of or behind the paths', () => {
    expect(parseCommandLine(['--profile', 'v2', 'a.xml', 'b.txt'])).toEqual({
      command: 'check',
      profile: 'v2',
      rest: ['a.xml', 'b.txt'],
    })
    expect(
      parseCommandLine(['a.xml', 'b.txt', '--profile', 'v1-floor']),
    ).toEqual({
      command: 'check',
      profile: 'v1-floor',
      rest: ['a.xml', 'b.txt'],
    })
  })

  test('reads the files command with its profile', () => {
    expect(parseCommandLine(['files', '--profile', 'v1-current'])).toEqual({
      command: 'files',
      profile: 'v1-current',
      rest: [],
    })
  })

  test.each([
    { label: 'no profile', args: ['a.xml', 'b.txt'] },
    { label: 'an unknown profile', args: ['--profile', 'v3', 'a', 'b'] },
    { label: 'a flag with no value', args: ['a', 'b', '--profile'] },
    {
      label: 'a repeated flag',
      args: ['--profile', 'v2', '--profile', 'v2', 'a', 'b'],
    },
    { label: 'files with no profile', args: ['files'] },
  ])('rejects $label', ({ args }) => {
    expect(parseCommandLine(args)).toBeUndefined()
  })
})

describe('CLI profiles', () => {
  test.each([...HOST_CONTRACT_PROFILES])(
    "files --profile %s prints exactly that profile's expected files",
    (profile) => {
      const result = runGuardArgs('files', '--profile', profile)

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual([
        ...PROFILE_SUITE_FILES[profile],
      ])
    },
  )

  test('the files output names real test files, one per line, with nothing else', () => {
    for (const profile of HOST_CONTRACT_PROFILES) {
      const lines = runGuardArgs('files', '--profile', profile)
        .stdout.trim()
        .split('\n')
      for (const line of lines) {
        expect(line).toMatch(/^tests\/integration\/[\w-]+\.test\.ts$/)
        expect(fs.existsSync(path.join(REPO_ROOT, line))).toBe(true)
      }
    }
  })

  test.each([
    { label: 'no arguments', args: [] },
    { label: 'files with no profile', args: ['files'] },
    { label: 'an unknown profile', args: ['files', '--profile', 'v3'] },
    {
      label: 'files with extra arguments',
      args: ['files', '--profile', 'v2', 'x'],
    },
    { label: 'a check with no profile', args: ['junit.xml', 'log.txt'] },
  ])('$label is a usage error', ({ args }) => {
    const result = runGuardArgs(...args)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Usage: bun scripts/host-contract-guard.ts')
    expect(result.stderr).toContain('files --profile <profile>')
  })

  test.each([...HOST_CONTRACT_PROFILES])(
    'a healthy %s report pair passes under its own profile',
    (profile) => {
      const dir = makeTempDir()
      const junitPath = path.join(dir, 'junit.xml')
      const logPath = path.join(dir, 'log.txt')
      fs.writeFileSync(junitPath, healthyReport(profile), 'utf8')
      fs.writeFileSync(logPath, buildLog(PROFILE_PASS_FLOORS[profile]), 'utf8')
      try {
        const result = runGuardArgs('--profile', profile, junitPath, logPath)

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain(
          `host-contract skip/pass guard passed for ${profile}.`,
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('a v1 report pair judged as the v2 profile fails with the v2 files named', () => {
    const dir = makeTempDir()
    const junitPath = path.join(dir, 'junit.xml')
    const logPath = path.join(dir, 'log.txt')
    fs.writeFileSync(junitPath, healthyReport('v1-current'), 'utf8')
    fs.writeFileSync(logPath, buildLog(PROFILE_PASS_FLOORS.v2), 'utf8')
    try {
      const result = runGuardArgs('--profile', 'v2', junitPath, logPath)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('tests/integration/opencode-v2.test.ts')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
