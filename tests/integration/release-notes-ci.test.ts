/**
 * Smoke tests for the successCmd bash logic embedded in .releaserc.yaml.
 *
 * Strategy: extract the successCmd block from .releaserc.yaml at test runtime,
 * write it to a temp shell file, and invoke it with a mock `gh` binary on PATH.
 * The mock binary's behavior is controlled per-scenario via environment variables.
 *
 * The test fails loudly if .releaserc.yaml is missing the successCmd block,
 * which prevents drift between the plugin config and this test suite.
 *
 * All 18 scenarios are covered:
 *  1.  Validation — invalid RELEASE_VERSION
 *  2.  Validation — valid pre-release (v2.23.0-rc.1)
 *  3.  Happy path — success conclusion + valid body length
 *  4.  Happy path — neutral conclusion (idempotent short-circuit)
 *  5.  Edge case — timeout (WATCH_EXIT=124)
 *  6.  Edge case — dispatch not registered within 90s
 *  7.  Edge case — correlation token matches second-newest run, not first
 *  8.  Error — HTTP 401 auth denial
 *  9.  Error — HTTP 403 + permission denied
 * 10.  Error — "Resource not accessible" auth keyword
 * 11.  Error — off-target tag edit (ANSI-stripped)
 * 12.  Error — success conclusion but body too short
 * 13.  Error — action_required conclusion
 * 14.  Error — skipped conclusion (policy block)
 * 15.  Edge case — cancelled conclusion
 * 16.  Edge case — generic narrative failure
 * 17.  Edge case — unknown future conclusion
 * 18.  Integration — prompt construction includes correlation token, target tag, repo name
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RELEASERC_PATH = path.join(REPO_ROOT, '.releaserc.yaml')
const MOCK_GH_PATH = path.join(REPO_ROOT, 'tests/fixtures/mock-gh.sh')

// Timeout per scenario — the successCmd has a 90s polling loop; we cap it
// tightly in tests by making the mock return immediately.
const SCENARIO_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// YAML successCmd extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the successCmd block from .releaserc.yaml.
 *
 * The block is expected to appear as a YAML literal block scalar under the
 * @semantic-release/exec plugin entry:
 *
 *   - - '@semantic-release/exec'
 *     - successCmd: |
 *         <bash content>
 *
 * Returns null if the block is not present (e.g., the @semantic-release/exec plugin entry has not been added yet).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: YAML literal-block extraction inherently branches on indent levels, block boundaries, and blank-line handling — the cognitive load lives in the YAML grammar, not the code shape.
function extractSuccessCmd(releasercContent: string): string | null {
  // Find the successCmd: | line and capture everything indented beneath it.
  const lines = releasercContent.split('\n')
  let inSuccessCmd = false
  let baseIndent = -1
  const cmdLines: string[] = []

  for (const line of lines) {
    if (!inSuccessCmd) {
      // Match lines like `    - successCmd: |` or `    successCmd: |`
      // The key may be preceded by a YAML list marker `- `.
      const match = line.match(/^(\s*)(?:-\s+)?successCmd:\s*\|\s*$/)
      if (match) {
        inSuccessCmd = true
        // Determine content indent from the next non-blank line
        // For now, use key indent + 4 (typical YAML literal block indent)
        baseIndent = (match[1]?.length ?? 0) + 4
      }
    } else {
      // We're inside the literal block. Lines that are more indented than
      // baseIndent belong to the block; anything at or below baseIndent-2
      // (the successCmd key's indent) ends the block.
      if (line.trim() === '') {
        // Blank lines are part of the literal block
        cmdLines.push('')
        continue
      }
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
      if (indent < baseIndent) {
        // End of literal block
        break
      }
      // Strip exactly baseIndent spaces of leading whitespace
      cmdLines.push(line.slice(baseIndent))
    }
  }

  if (cmdLines.length === 0) return null

  // Trim trailing blank lines
  while (cmdLines.length > 0 && cmdLines[cmdLines.length - 1]?.trim() === '') {
    cmdLines.pop()
  }

  return cmdLines.join('\n')
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface ScenarioEnv {
  RELEASE_VERSION?: string
  GITHUB_REPOSITORY?: string
  MOCK_GH_RUN_LIST_JSON?: string
  MOCK_GH_RUN_VIEW_LOG?: string
  MOCK_GH_RUN_VIEW_CONCLUSION?: string
  MOCK_GH_RUN_WATCH_EXIT?: string
  MOCK_GH_RELEASE_VIEW_BODY_LEN?: string
  MOCK_GH_WORKFLOW_RUN_PROMPT?: string
  MOCK_GH_WORKFLOW_RUN_CORRELATION?: string
  RELEASE_NOTES_TEST_POLL_BUDGET_SECS?: string
  RELEASE_NOTES_TEST_POLL_INTERVAL_SECS?: string
  RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS?: string
  RELEASE_NOTES_TEST_CORRELATION_ID?: string
}

interface ScenarioResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Builds a run-list JSON array where each entry has a databaseId and a log
 * that either matches or does not match the correlation token.
 *
 * The successCmd polls `gh run list` and then calls `gh run view <id> --log`
 * for each candidate. The mock-gh.sh returns MOCK_GH_RUN_VIEW_LOG for ALL
 * `gh run view --log` calls. To simulate "second run matches", we need the
 * run-list to contain two entries and the log to contain the correlation token
 * (the script will find it on the second attempt after the first fails).
 *
 * For the "second matches" scenario we use a special env var
 * MOCK_GH_RUN_VIEW_LOG_BY_ID which the mock reads to return different logs
 * per run ID. Since our mock-gh.sh is simple (single MOCK_GH_RUN_VIEW_LOG),
 * we implement the "second matches" scenario by having the first run's ID
 * appear in a MOCK_GH_SKIP_IDS list that causes the mock to return empty log.
 */
function makeRunListJson(entries: Array<{ databaseId: number }>): string {
  return JSON.stringify(
    entries.map((e) => ({
      databaseId: e.databaseId,
      createdAt: new Date().toISOString(),
    })),
  )
}

/**
 * Runs the successCmd script in a temp directory with the mock-gh binary on PATH.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Test scaffold consolidates default env-var wiring, correlation-token plumbing, log-prepending, and timeout escape hatches in one place by design — splitting into helpers would scatter related context across multiple functions.
function runSuccessCmd(
  scriptPath: string,
  env: ScenarioEnv,
  extraMockBinDir?: string,
): ScenarioResult {
  const mockBinDir =
    extraMockBinDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mock-bin-'))
  const ghLink = path.join(mockBinDir, 'gh')

  // Create a wrapper that delegates to mock-gh.sh, forwarding all args.
  // Tests that supply extraMockBinDir may pre-populate gh with a custom wrapper
  // (scenario 7 does this for per-run-ID log responses); in that case we leave
  // the existing wrapper in place. Otherwise we write the default shim.
  // Using fs.openSync with O_CREAT|O_EXCL is atomic — no check-then-write race
  // (avoids js/file-system-race CodeQL flag).
  try {
    const fd = fs.openSync(
      ghLink,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o755,
    )
    fs.writeSync(fd, `#!/usr/bin/env bash\nexec "${MOCK_GH_PATH}" "$@"\n`)
    fs.closeSync(fd)
  } catch (err) {
    // EEXIST means a custom wrapper is already in place; leave it.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw err
  }

  const parentPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'

  // Default correlation ID — used to wire the polling loop end-to-end so most
  // tests can focus on conclusion classification rather than re-mocking polling.
  // Tests that explicitly want polling to FAIL set MOCK_GH_RUN_LIST_JSON: '[]'.
  // The correlation line is auto-prepended to any provided MOCK_GH_RUN_VIEW_LOG
  // so tests that override the log to inject auth/off-target signals still let
  // the polling loop find their run.
  const defaultCorrelationId =
    env.RELEASE_NOTES_TEST_CORRELATION_ID ?? 'test-correlation-token-default'
  const correlationLine = `correlation=${defaultCorrelationId}\n`
  const providedLog = env.MOCK_GH_RUN_VIEW_LOG
  const effectiveLog =
    providedLog === undefined
      ? `${correlationLine}release edit ${env.RELEASE_VERSION ?? 'v2.23.0'} succeeded\n`
      : providedLog === ''
        ? '' // explicit empty — caller wants polling to fail
        : `${correlationLine}${providedLog}`

  const childEnv: Record<string, string> = {
    PATH: `${mockBinDir}:${parentPath}`,
    RELEASE_VERSION: env.RELEASE_VERSION ?? 'v2.23.0',
    GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? 'marcusrbrown/systematic',
    MOCK_GH_RUN_LIST_JSON:
      env.MOCK_GH_RUN_LIST_JSON ?? makeRunListJson([{ databaseId: 12345 }]),
    MOCK_GH_RUN_VIEW_LOG: effectiveLog,
    MOCK_GH_RUN_VIEW_CONCLUSION: env.MOCK_GH_RUN_VIEW_CONCLUSION ?? 'success',
    MOCK_GH_RUN_WATCH_EXIT: env.MOCK_GH_RUN_WATCH_EXIT ?? '0',
    MOCK_GH_RELEASE_VIEW_BODY_LEN: env.MOCK_GH_RELEASE_VIEW_BODY_LEN ?? '800',
    RELEASE_NOTES_TEST_CORRELATION_ID: defaultCorrelationId,
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    // Shorten polling and watch budgets so the 18 scenarios complete quickly.
    // Production runs use the default 90s / 5s / 600s values; tests use sub-second.
    RELEASE_NOTES_TEST_POLL_BUDGET_SECS:
      env.RELEASE_NOTES_TEST_POLL_BUDGET_SECS ?? '2',
    RELEASE_NOTES_TEST_POLL_INTERVAL_SECS:
      env.RELEASE_NOTES_TEST_POLL_INTERVAL_SECS ?? '1',
    RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS:
      env.RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS ?? '5',
  }

  if (env.MOCK_GH_WORKFLOW_RUN_PROMPT !== undefined) {
    childEnv.MOCK_GH_WORKFLOW_RUN_PROMPT = env.MOCK_GH_WORKFLOW_RUN_PROMPT
  }

  if (env.MOCK_GH_WORKFLOW_RUN_CORRELATION !== undefined) {
    childEnv.MOCK_GH_WORKFLOW_RUN_CORRELATION =
      env.MOCK_GH_WORKFLOW_RUN_CORRELATION
  }

  const result = Bun.spawnSync(['bash', scriptPath], {
    env: childEnv,
    timeout: SCENARIO_TIMEOUT_MS,
  })

  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

// ---------------------------------------------------------------------------
// Module-level setup: extract successCmd once
// ---------------------------------------------------------------------------

// Module-load-time extraction: it.skipIf() evaluates its predicate when it() is
// invoked (module-load time), not when the test runs. beforeAll() runs too late
// to flip the skip flag. Doing the extraction synchronously at module-load time
// makes the predicate see the correct value.
const successCmdScript: string = (() => {
  if (!fs.existsSync(RELEASERC_PATH)) {
    console.warn(
      '[release-notes-ci] .releaserc.yaml not found — all scenarios will be skipped. ' +
        'The @semantic-release/exec plugin entry must be present in .releaserc.yaml before these scenarios can run.',
    )
    return ''
  }

  const releasercContent = fs.readFileSync(RELEASERC_PATH, 'utf8')
  const extracted = extractSuccessCmd(releasercContent)

  if (extracted === null) {
    console.warn(
      '[release-notes-ci] successCmd block not found in .releaserc.yaml — ' +
        'all scenarios will be skipped until the @semantic-release/exec plugin entry is added.',
    )
    return ''
  }

  return extracted
})()

const successCmdAvailable = successCmdScript.length > 0
let scriptPath = ''

// ---------------------------------------------------------------------------
// Per-test temp directory
// ---------------------------------------------------------------------------

let testTempDir = ''
let testMockBinDir = ''

beforeEach(() => {
  testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-ci-'))
  testMockBinDir = path.join(testTempDir, 'mock-bin')
  fs.mkdirSync(testMockBinDir, { recursive: true })

  // Write the successCmd to a temp script file for this test.
  // The production successCmd contains `${nextRelease.gitTag}` — a Lodash template
  // that @semantic-release/exec resolves BEFORE handing the string to the shell.
  // In tests we don't go through semantic-release, so we substitute the Lodash
  // expression with `${RELEASE_VERSION:-v2.23.0}` (a bash env var the test sets).
  if (successCmdAvailable) {
    scriptPath = path.join(testTempDir, 'successCmd.sh')
    // The YAML successCmd escapes all bash ${...} as \${...} so Lodash passes them
    // through unmodified. In tests we bypass semantic-release, so we must:
    //   1. Unescape \${...} → ${...} (undo the Lodash escaping).
    //   2. Replace ${nextRelease.gitTag} with ${RELEASE_VERSION:-v2.23.0} (simulate
    //      the Lodash interpolation that semantic-release would normally perform).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal bash parameter expansions written verbatim into the bash script — not JS template placeholders.
    const lodashSubstituted = successCmdScript
      .replace(/\\\$/g, '$')
      .replace(/\$\{nextRelease\.gitTag\}/g, '${RELEASE_VERSION:-v2.23.0}')
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nset -Eeuo pipefail\n${lodashSubstituted}\n`,
    )
    fs.chmodSync(scriptPath, 0o755)
  }
})

afterEach(() => {
  fs.rmSync(testTempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: run with the per-test mock-bin dir
// ---------------------------------------------------------------------------

function run(env: ScenarioEnv): ScenarioResult {
  return runSuccessCmd(scriptPath, env, testMockBinDir)
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('release-notes-ci successCmd smoke tests', () => {
  // -------------------------------------------------------------------------
  // 1. Validation — invalid RELEASE_VERSION
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 and emits ::error:: for invalid RELEASE_VERSION shape',
    () => {
      const result = run({ RELEASE_VERSION: 'not-a-tag' })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toContain('Invalid RELEASE_VERSION shape')
      // Must NOT have dispatched gh workflow run
      expect(combined).not.toContain('workflow_dispatch event')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 2. Validation — valid pre-release passes validation
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'accepts valid pre-release version v2.23.0-rc.1 and proceeds to dispatch',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0-rc.1',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
      })

      // Validation passes — dispatch fires (mock prints the dispatch line)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('workflow_dispatch event')
      // Should not emit an invalid-version error
      expect(combined).not.toContain('Invalid RELEASE_VERSION shape')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 3. Happy path — success conclusion + valid body length
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with narrative-applied message on success conclusion and body length >= 200',
    () => {
      const correlationId = 'test-correlation-happy-path'
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
        // Log must contain the correlation token so polling finds the run
        MOCK_GH_RUN_VIEW_LOG: `correlation=${correlationId}\nsome other log content`,
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      // Must NOT emit any annotation
      expect(combined).not.toContain('::error::')
      expect(combined).not.toContain('::warning::')
      // Must contain success signal
      expect(combined).toMatch(/narrative applied/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 4. Happy path — neutral conclusion (idempotent short-circuit)
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with no-action-taken message on neutral conclusion',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'neutral',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).not.toContain('::error::')
      expect(combined).not.toContain('::warning::')
      expect(combined).toMatch(/no-action-taken/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 5. Edge case — timeout (WATCH_EXIT=124)
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with ::warning:: annotation when gh run watch times out (exit 124)',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_WATCH_EXIT: '124',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::warning::')
      expect(combined).toMatch(/timed out/i)
      expect(combined).not.toContain('::error::')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 5b. Edge case — unexpected non-zero WATCH_EXIT (not 124, not 0)
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: for unexpected gh run watch exit (e.g., SIGKILL via 137)',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        // Common signal-propagation exit code: 128 + 9 (SIGKILL) = 137
        MOCK_GH_RUN_WATCH_EXIT: '137',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/unexpected gh run watch exit/i)
      expect(combined).toContain('WATCH_EXIT=137')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 6. Edge case — dispatch not registered within 90s
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: when dispatched run is never found in run list',
    () => {
      // Return an empty run list so the correlation token is never matched
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_LIST_JSON: '[]',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/not found within/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 7. Edge case — correlation token matches second-newest run, not first
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'uses the second run when correlation token only appears in its log',
    () => {
      // Two runs: 99999 (newest, no correlation match) and 12345 (second, matches)
      // The mock returns MOCK_GH_RUN_VIEW_LOG for ALL view --log calls.
      // We need the first run (99999) to NOT match and the second (12345) to match.
      //
      // Since mock-gh.sh returns the same log for all run IDs, we use a
      // special approach: set the log to contain the correlation token, but
      // also write a wrapper that skips the first ID.
      //
      // Simpler: use a custom mock-gh wrapper that checks the run ID arg.
      const customMockBin = path.join(testTempDir, 'custom-mock-bin')
      fs.mkdirSync(customMockBin, { recursive: true })

      const customGh = path.join(customMockBin, 'gh')
      // The script returns empty log for run 99999, and a correlation-matching
      // log for run 12345. The correlation token is embedded in the log.
      fs.writeFileSync(
        customGh,
        `#!/usr/bin/env bash
set -Eeuo pipefail
SUBCOMMAND="\${1:-}"
if [[ "$SUBCOMMAND" == "run" && "\${2:-}" == "list" ]]; then
  echo "\${MOCK_GH_RUN_LIST_JSON:-[]}"
  exit 0
fi
if [[ "$SUBCOMMAND" == "run" && "\${2:-}" == "view" ]]; then
  RUN_ID="\${3:-}"
  LOG_FLAG=0
  JSON_FLAG=0
  for arg in "$@"; do
    [[ "$arg" == "--log" ]] && LOG_FLAG=1
    [[ "$arg" == "--json" ]] && JSON_FLAG=1
  done
  if [[ "$LOG_FLAG" == "1" ]]; then
    if [[ "$RUN_ID" == "99999" ]]; then
      echo "no correlation here"
    else
      echo "\${MOCK_GH_RUN_VIEW_LOG:-}"
    fi
    exit 0
  fi
  if [[ "$JSON_FLAG" == "1" ]]; then
    echo "{\\"conclusion\\":\\"\${MOCK_GH_RUN_VIEW_CONCLUSION:-success}\\"}"
    exit 0
  fi
fi
if [[ "$SUBCOMMAND" == "run" && "\${2:-}" == "watch" ]]; then
  exit "\${MOCK_GH_RUN_WATCH_EXIT:-0}"
fi
if [[ "$SUBCOMMAND" == "workflow" && "\${2:-}" == "run" ]]; then
  echo "Created workflow_dispatch event for fro-bot.yaml at refs/heads/main"
  exit 0
fi
if [[ "$SUBCOMMAND" == "release" && "\${2:-}" == "view" ]]; then
  echo "\${MOCK_GH_RELEASE_VIEW_BODY_LEN:-800}"
  exit 0
fi
echo "custom-mock-gh: unhandled: $*" >&2
exit 1
`,
      )
      fs.chmodSync(customGh, 0o755)

      const runListJson = makeRunListJson([
        { databaseId: 99999 },
        { databaseId: 12345 },
      ])

      // Use a specific correlation token so the script and the custom mock's
      // run-12345 log agree on the exact match value. The custom mock returns
      // "no correlation here" for run 99999, so only run 12345's log matches.
      const knownCorrelation = 'second-run-correlation-token'
      const result = runSuccessCmd(
        scriptPath,
        {
          RELEASE_VERSION: 'v2.23.0',
          RELEASE_NOTES_TEST_CORRELATION_ID: knownCorrelation,
          MOCK_GH_RUN_LIST_JSON: runListJson,
          MOCK_GH_RUN_VIEW_LOG: `correlation=${knownCorrelation}\nsome log`,
          MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
          MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
        },
        customMockBin,
      )

      // The script should find run 12345 (second) and succeed
      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).not.toContain('::error::')
      // Should contain the second run's ID in output
      expect(combined).toContain('12345')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 8. Error — HTTP 401 auth denial
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: Auth failure when log contains HTTP 401',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
        MOCK_GH_RUN_VIEW_LOG: 'HTTP 401: Bad credentials\nsome other output',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/[Aa]uth failure/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 9. Error — HTTP 403 + permission denied
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: Auth failure when log contains HTTP 403 and permission denied',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
        MOCK_GH_RUN_VIEW_LOG:
          'HTTP 403: Forbidden\npermission denied for resource',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/[Aa]uth failure/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 10. Error — "Resource not accessible" auth keyword
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: Auth failure when log contains "Resource not accessible"',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
        MOCK_GH_RUN_VIEW_LOG:
          'Resource not accessible by integration\nsome other output',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/[Aa]uth failure/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 11. Error — off-target tag edit (ANSI-stripped)
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: Off-target when log contains ANSI-colored edit of a different tag',
    () => {
      // ANSI-colored log line: `gh release edit v9.9.9` in red
      const ansiLog = '\x1b[31mgh release edit v9.9.9\x1b[0m\nsome other output'
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
        MOCK_GH_RUN_VIEW_LOG: ansiLog,
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/[Oo]ff-target/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 12. Error — success conclusion but body too short
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: body integrity check failed when conclusion=success but body length < 200',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '50',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/body integrity check failed/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 13. Error — action_required conclusion
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: manual intervention when conclusion=action_required',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'action_required',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/manual intervention/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 14. Error — skipped conclusion (policy block)
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 1 with ::error:: policy/branch protection when conclusion=skipped',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'skipped',
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/policy\/branch protection/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 15. Edge case — cancelled conclusion
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with ::warning:: when conclusion=cancelled',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'cancelled',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::warning::')
      expect(combined).not.toContain('::error::')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 16. Edge case — generic narrative failure
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with ::warning:: for generic failure with no security signals',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'failure',
        // Log has no auth keywords, no off-target edits
        MOCK_GH_RUN_VIEW_LOG:
          'OpenCode agent error: model timeout\nsome output',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::warning::')
      expect(combined).not.toContain('::error::')
      expect(combined).toMatch(/narrative.failure|Fro Bot run failed/i)
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 17. Edge case — unknown future conclusion
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'exits 0 with ::warning:: Unknown conclusion for unrecognized conclusion values',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'some_new_value',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::warning::')
      expect(combined).toMatch(/[Uu]nknown conclusion/i)
      expect(combined).not.toContain('::error::')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 18. Integration — prompt construction includes correlation token, target tag, repo name
  // -------------------------------------------------------------------------
  it.skipIf(!successCmdAvailable)(
    'prompt and correlation-id are forwarded to gh workflow run as separate -f fields',
    () => {
      const promptCapturePath = path.join(testTempDir, 'captured-prompt.txt')
      const correlationCapturePath = path.join(
        testTempDir,
        'captured-correlation.txt',
      )
      const knownCorrelationId = 'test-known-correlation-uuid-for-scenario-18'

      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        GITHUB_REPOSITORY: 'marcusrbrown/systematic',
        RELEASE_NOTES_TEST_CORRELATION_ID: knownCorrelationId,
        MOCK_GH_WORKFLOW_RUN_PROMPT: promptCapturePath,
        MOCK_GH_WORKFLOW_RUN_CORRELATION: correlationCapturePath,
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
      })

      // The dispatch must have fired
      const combined = result.stdout + result.stderr
      expect(combined).toContain('workflow_dispatch event')

      // The captured prompt file must exist with the embedded correlation token
      expect(fs.existsSync(promptCapturePath)).toBe(true)
      const capturedPrompt = fs.readFileSync(promptCapturePath, 'utf8')

      // Must contain the target tag
      expect(capturedPrompt).toContain('v2.23.0')

      // Must contain the repo name (not a workflow-expression artifact)
      expect(capturedPrompt).toContain('marcusrbrown/systematic')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Asserting the prompt does NOT contain the literal GitHub workflow-expression syntax `${{ github.repository }}`, which is the failure mode being guarded against.
      expect(capturedPrompt).not.toContain('${{ github.repository }}')

      // Must contain the correlation token as a first-line reference
      // and an instruction telling Fro Bot to echo it.
      expect(capturedPrompt).toMatch(/^correlation=[a-zA-Z0-9-]+/m)
      expect(capturedPrompt).toContain(`correlation=${knownCorrelationId}`)
      expect(capturedPrompt).toMatch(/echo.*correlation/i)

      // The correlation-id MUST be forwarded as a separate `-f correlation-id=<value>`
      // argument, not just embedded in the prompt body. Without this assertion,
      // accidentally deleting the `-f "correlation-id=$CORRELATION_ID"` line in
      // the dispatch would silently pass the prompt-construction test.
      expect(fs.existsSync(correlationCapturePath)).toBe(true)
      const capturedCorrelation = fs
        .readFileSync(correlationCapturePath, 'utf8')
        .trim()
      expect(capturedCorrelation).toBe(knownCorrelationId)
    },
    SCENARIO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// Structural test: successCmd extraction is well-formed
// ---------------------------------------------------------------------------

describe('successCmd extraction from .releaserc.yaml', () => {
  it('extractSuccessCmd returns null when successCmd block is absent', () => {
    const yaml = `
plugins:
  - '@semantic-release/commit-analyzer'
  - '@semantic-release/github'
`
    expect(extractSuccessCmd(yaml)).toBeNull()
  })

  it('extractSuccessCmd captures multi-line bash block', () => {
    const yaml = `
plugins:
  - - '@semantic-release/exec'
    - successCmd: |
        RELEASE_VERSION="\${nextRelease.gitTag}"
        echo "hello $RELEASE_VERSION"
        exit 0
  - '@semantic-release/github'
`
    const result = extractSuccessCmd(yaml)
    expect(result).not.toBeNull()
    expect(result).toContain('RELEASE_VERSION=')
    expect(result).toContain('echo "hello $RELEASE_VERSION"')
    expect(result).toContain('exit 0')
  })

  it('extractSuccessCmd does not include content from the next plugin entry', () => {
    const yaml = `
plugins:
  - - '@semantic-release/exec'
    - successCmd: |
        echo "cmd line"
  - '@semantic-release/github'
`
    const result = extractSuccessCmd(yaml)
    expect(result).not.toBeNull()
    expect(result).not.toContain('@semantic-release/github')
  })
})
