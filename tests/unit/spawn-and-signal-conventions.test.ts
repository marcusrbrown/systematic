import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkDir } from '../../src/lib/walk-dir.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Pure source-scan helpers
//
// Both the real-tree tests and the fixture-based bidirectional proof tests
// below call these same functions: dir list in, violations out. Neither
// scanner spawns a process or touches a host -- they only read files already
// on disk.
// ---------------------------------------------------------------------------

interface SourceViolation {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Replaces comments with whitespace (preserving newlines and therefore line
 * numbers) while leaving string/template literal contents untouched, so a
 * scan for a literal like `'opencode'` inside a call expression does not
 * false-positive on the same text appearing inside a `//` or `/* *\/`
 * comment.
 */
function consumeLineComment(
  source: string,
  start: number,
): { next: number; text: string } {
  let i = start
  let text = ''
  while (i < source.length && source[i] !== '\n') {
    text += ' '
    i++
  }
  return { next: i, text }
}

function consumeBlockComment(
  source: string,
  start: number,
): { next: number; text: string } {
  let i = start + 2
  let text = '  '
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
    text += source[i] === '\n' ? '\n' : ' '
    i++
  }
  if (i < source.length) {
    text += '  '
    i += 2
  }
  return { next: i, text }
}

function consumeStringLiteral(
  source: string,
  start: number,
): { next: number; text: string } {
  const quote = source[start]
  let i = start + 1
  let text = quote ?? ''
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\' && i + 1 < source.length) {
      text += source[i] + source[i + 1]
      i += 2
      continue
    }
    text += source[i]
    i++
  }
  if (i < source.length) {
    text += source[i]
    i++
  }
  return { next: i, text }
}

function stripComments(source: string): string {
  let result = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const r = consumeLineComment(source, i)
      result += r.text
      i = r.next
      continue
    }
    if (ch === '/' && next === '*') {
      const r = consumeBlockComment(source, i)
      result += r.text
      i = r.next
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const r = consumeStringLiteral(source, i)
      result += r.text
      i = r.next
      continue
    }
    result += ch
    i++
  }
  return result
}

function lineNumberAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

function collectTsFiles(roots: readonly string[]): string[] {
  const files: string[] = []
  for (const root of roots) {
    files.push(
      ...walkDir(root, {
        maxDepth: 20,
        filter: (entry) =>
          !entry.isDirectory &&
          entry.path.endsWith('.ts') &&
          !entry.path.split(path.sep).includes('node_modules'),
      }).map((entry) => entry.path),
    )
  }
  return files
}

function scanFilesForPatterns(
  roots: readonly string[],
  patterns: readonly RegExp[],
): SourceViolation[] {
  const violations: SourceViolation[] = []
  for (const file of collectTsFiles(roots)) {
    const source = fs.readFileSync(file, 'utf8')
    const stripped = stripComments(source)
    const sourceLines = source.split('\n')
    const seenLines = new Set<number>()
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags)
      let match: RegExpExecArray | null = re.exec(stripped)
      while (match !== null) {
        const line = lineNumberAt(stripped, match.index)
        if (!seenLines.has(line)) {
          seenLines.add(line)
          violations.push({
            file,
            line,
            text: sourceLines[line - 1]?.trim() ?? '',
          })
        }
        match = re.exec(stripped)
      }
    }
  }
  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  )
}

// Guard 1 -- no bare `opencode` launch. Every real launch site in this repo
// goes through `bunx opencode-ai@<pin>` (see
// docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md);
// a spawn/exec call whose first argv element is the literal string
// `'opencode'` (or `"opencode"`) is the exact bug #932 fixed. The trailing
// quote in each pattern means `opencode-ai@1.2.3` and `bunx` never match --
// only the bare, unqualified binary name does.
const BARE_OPENCODE_LAUNCH_PATTERNS: readonly RegExp[] = [
  /\bspawn\s*\(\s*['"]opencode['"]/g,
  /\bspawnSync\s*\(\s*['"]opencode['"]/g,
  /\bBun\.spawn\s*\(\s*\[\s*['"]opencode['"]/g,
  /\bBun\.spawnSync\s*\(\s*\[\s*['"]opencode['"]/g,
  /\bexecFile\s*\(\s*['"]opencode['"]/g,
  /\[\s*['"]opencode['"]\s*,/g,
]

function scanForBareOpencodeLaunches(
  roots: readonly string[],
): SourceViolation[] {
  return scanFilesForPatterns(roots, BARE_OPENCODE_LAUNCH_PATTERNS)
}

// Guard 2 -- no `process.emit` of a terminal signal in tests. `process` is
// one emitter per Bun worker, so an in-process emit reaches every listener
// installed by every test file loaded in the same worker, not just the
// listener under test -- the exact bug #933 fixed. `tests/manual/` is
// included here (unlike Guard 1) because there is no legitimate reason to
// broadcast a real signal in-process anywhere under `tests/`.
const TERMINAL_SIGNAL_EMIT_PATTERN =
  /\bprocess\.emit\s*\(\s*['"](?:SIGINT|SIGTERM|SIGHUP|SIGQUIT)['"]/g

function scanForProcessEmitSignals(
  roots: readonly string[],
): SourceViolation[] {
  return scanFilesForPatterns(roots, [TERMINAL_SIGNAL_EMIT_PATTERN])
}

function formatViolations(violations: readonly SourceViolation[]): string {
  return violations
    .map((v) => `${path.relative(REPO_ROOT, v.file)}:${v.line}: ${v.text}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Temp fixture helpers
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = []

function makeTempDir(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TEMP_ROOTS.push(tmp)
  return tmp
}

function writeFixtureFile(dir: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(dir, name), contents, 'utf8')
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Guard 1: no bare `opencode` launch
// ---------------------------------------------------------------------------

describe('guard: no bare opencode launch', () => {
  test('the real tree under tests/integration/ and scripts/ has no bare opencode spawn (tests/manual/ excluded)', () => {
    const violations = scanForBareOpencodeLaunches([
      path.join(REPO_ROOT, 'tests/integration'),
      path.join(REPO_ROOT, 'scripts'),
    ])

    if (violations.length > 0) {
      throw new Error(
        `Found a bare 'opencode' launch (bypasses the bunx opencode-ai@<pin> launcher, see docs/solutions/workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md):\n${formatViolations(
          violations,
        )}`,
      )
    }
    expect(violations).toEqual([])
  })

  test('tests/manual/ is intentionally excluded from the bare opencode launch guard', () => {
    // tests/manual/ hosts human-run probes that intentionally invoke the
    // developer's own opencode on PATH, not the pinned bunx launcher. This
    // is a deliberate exception, documented here and in the guard test
    // above so a future reader does not "fix" the exclusion away.
    const manualDir = path.join(REPO_ROOT, 'tests/manual')
    expect(fs.existsSync(manualDir)).toBe(true)

    const scopedRoots = [
      path.join(REPO_ROOT, 'tests/integration'),
      path.join(REPO_ROOT, 'scripts'),
    ]
    for (const root of scopedRoots) {
      expect(root.startsWith(manualDir)).toBe(false)
    }
  })

  test('bidirectional proof: flags a bare opencode spawn call, ignores a commented mention, bunx, and opencode-ai@ forms', () => {
    const dir = makeTempDir('bare-opencode-guard-')
    writeFixtureFile(
      dir,
      'violating.ts',
      [
        "import { spawn } from 'node:child_process'",
        '',
        "const child = spawn('opencode', ['run', 'hello'])",
        '',
      ].join('\n'),
    )
    writeFixtureFile(
      dir,
      'benign.ts',
      [
        "import { spawn } from 'node:child_process'",
        '',
        "// do not spawn('opencode', []) -- this is only a comment mention",
        "const child = spawn('bunx', ['opencode-ai@1.2.3', 'serve'])",
        "const other = spawn('opencode-ai@1.2.3', ['run'])",
        '',
      ].join('\n'),
    )

    const violations = scanForBareOpencodeLaunches([dir])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(path.join(dir, 'violating.ts'))
    expect(violations[0]?.line).toBe(3)
    expect(violations[0]?.text).toContain("spawn('opencode'")
  })

  test('bidirectional proof: flags the array-form first-element case', () => {
    const dir = makeTempDir('bare-opencode-array-guard-')
    writeFixtureFile(
      dir,
      'violating.ts',
      ["const child = Bun.spawn(['opencode', 'run'], { cwd })", ''].join('\n'),
    )

    const violations = scanForBareOpencodeLaunches([dir])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.line).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Guard 2: no process.emit of a terminal signal in tests
// ---------------------------------------------------------------------------

describe('guard: no process.emit of a terminal signal (SIGINT/SIGTERM/SIGHUP/SIGQUIT)', () => {
  test('the real tree under tests/ has no in-process terminal signal emit', () => {
    // This guard's own fixture tests below deliberately write the banned
    // pattern into temp files as literal test data (the bidirectional
    // proof requires a real violating string). The source-scan operates on
    // raw text, so this file's own fixture-string literals would otherwise
    // self-trip the real-tree assertion; excluding this file by path is the
    // guard's own documented exception, analogous to tests/manual/ for
    // Guard 1.
    const violations = scanForProcessEmitSignals([
      path.join(REPO_ROOT, 'tests'),
    ]).filter((v) => v.file !== __filename)

    if (violations.length > 0) {
      throw new Error(
        `Found process.emit(...) of a terminal signal (broadcasts to every listener in this Bun worker, see docs/solutions/workflow-issues/real-host-ci-catches-what-offline-gates-cannot-2026-09-06.md):\n${formatViolations(
          violations,
        )}`,
      )
    }
    expect(violations).toEqual([])
  })

  test('does not trip on the documented prose mention in tests/integration/eval-runner.test.ts', () => {
    const eventRunnerPath = path.join(
      REPO_ROOT,
      'tests/integration/eval-runner.test.ts',
    )
    const source = fs.readFileSync(eventRunnerPath, 'utf8')
    expect(source).toContain("process.emit('SIGINT')")

    const violations = scanForProcessEmitSignals([
      path.join(REPO_ROOT, 'tests/integration'),
    ])
    const eventRunnerViolations = violations.filter(
      (v) => v.file === eventRunnerPath,
    )
    expect(eventRunnerViolations).toEqual([])
  })

  test('bidirectional proof: flags process.emit of SIGINT/SIGTERM, ignores a commented mention', () => {
    const dir = makeTempDir('process-emit-guard-')
    writeFixtureFile(
      dir,
      'violating.test.ts',
      [
        "test('simulates an interrupt', () => {",
        "  process.emit('SIGINT')",
        '})',
        '',
      ].join('\n'),
    )
    writeFixtureFile(
      dir,
      'benign.test.ts',
      [
        "// A real `process.emit('SIGINT')` would reach every listener in",
        '// this worker, so this comment only describes the hazard.',
        "test('does not simulate an interrupt', () => {",
        '  expect(true).toBe(true)',
        '})',
        '',
      ].join('\n'),
    )

    const violations = scanForProcessEmitSignals([dir])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(path.join(dir, 'violating.test.ts'))
    expect(violations[0]?.line).toBe(2)
    expect(violations[0]?.text).toContain("process.emit('SIGINT')")
  })

  test('bidirectional proof: flags SIGTERM/SIGHUP/SIGQUIT and double-quoted forms too', () => {
    const dir = makeTempDir('process-emit-variants-guard-')
    writeFixtureFile(
      dir,
      'violating.test.ts',
      [
        'process.emit("SIGTERM")',
        "process.emit('SIGHUP')",
        'process.emit("SIGQUIT")',
        '',
      ].join('\n'),
    )

    const violations = scanForProcessEmitSignals([dir])

    expect(violations).toHaveLength(3)
    expect(violations.map((v) => v.line)).toEqual([1, 2, 3])
  })
})
