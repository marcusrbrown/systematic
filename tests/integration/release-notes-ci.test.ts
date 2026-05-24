/**
 * Smoke tests for the successCmd bash logic in scripts/dispatch-release-notes.sh.
 *
 * Strategy: copy scripts/dispatch-release-notes.sh to a temp dir and invoke it
 * with a mock `gh` binary on PATH. The mock binary's behavior is controlled
 * per-scenario via environment variables.
 *
 * All 19 scenarios are covered:
 *  1.  Validation — invalid RELEASE_VERSION
 *  2.  Validation — valid pre-release (v2.23.0-rc.1)
 *  3.  Happy path — success conclusion + valid body length
 *  4.  Happy path — neutral conclusion (idempotent short-circuit)
 *  5.  Edge case — timeout (WATCH_EXIT=124)
 *  5b. Edge case — unexpected non-zero WATCH_EXIT (e.g., 137)
 *  6.  Edge case — dispatch not registered within 90s (empty run list)
 *  7.  Edge case — no run created after dispatch epoch (all runs pre-date cutoff)
 *  8.  Edge case — selects newest workflow_dispatch run created after dispatch epoch
 *  9.  Error — HTTP 401 auth denial
 * 10.  Error — HTTP 403 + permission denied
 * 11.  Error — "Resource not accessible" auth keyword
 * 12.  Error — off-target tag edit (ANSI-stripped)
 * 13.  Error — success conclusion but body too short
 * 14.  Error — action_required conclusion
 * 15.  Error — skipped conclusion (policy block)
 * 16.  Edge case — cancelled conclusion
 * 17.  Edge case — generic narrative failure
 * 18.  Edge case — unknown future conclusion
 * 19.  Integration — prompt construction includes correlation token, target tag, repo name
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/dispatch-release-notes.sh')
const MOCK_GH_PATH = path.join(REPO_ROOT, 'tests/fixtures/mock-gh.sh')

// Timeout per scenario — the successCmd has a 90s polling loop; we cap it
// tightly in tests by making the mock return immediately.
const SCENARIO_TIMEOUT_MS = 30_000

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
 * Builds a run-list JSON array where each entry has a databaseId and a
 * createdAt timestamp. The script identifies the dispatched run by selecting
 * the newest workflow_dispatch run whose createdAt is strictly after the
 * DISPATCH_EPOCH captured immediately before `gh workflow run`.
 *
 * Using a far-future fixed timestamp ensures the run is always selected
 * regardless of when the test executes.
 */
function makeRunListJson(
  entries: Array<{ databaseId: number; createdAt?: string }>,
): string {
  return JSON.stringify(
    entries.map((e) => ({
      databaseId: e.databaseId,
      createdAt: e.createdAt ?? '2099-01-01T00:00:00Z',
    })),
  )
}

/**
 * Runs the dispatch-release-notes.sh script in a temp directory with the mock-gh binary on PATH.
 * The script receives RELEASE_VERSION as its first positional argument.
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

  // Default correlation ID — forwarded as RELEASE_NOTES_TEST_CORRELATION_ID so
  // scenario 19 can assert the value is passed as a separate -f arg to gh workflow run.
  const defaultCorrelationId =
    env.RELEASE_NOTES_TEST_CORRELATION_ID ?? 'test-correlation-token-default'

  // Default log provides a realistic success-path output for off-target detection
  // and auth-failure scanning. Run identification is now timestamp-based, so the
  // log is NOT scanned for the correlation token during polling.
  const effectiveLog =
    env.MOCK_GH_RUN_VIEW_LOG ??
    `release edit ${env.RELEASE_VERSION ?? 'v2.23.0'} succeeded\n`

  const releaseVersion = env.RELEASE_VERSION ?? 'v2.23.0'

  const childEnv: Record<string, string> = {
    PATH: `${mockBinDir}:${parentPath}`,
    GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? 'marcusrbrown/systematic',
    MOCK_GH_RUN_LIST_JSON:
      env.MOCK_GH_RUN_LIST_JSON ??
      makeRunListJson([
        { databaseId: 12345, createdAt: '2099-01-01T00:00:00Z' },
      ]),
    MOCK_GH_RUN_VIEW_LOG: effectiveLog,
    MOCK_GH_RUN_VIEW_CONCLUSION: env.MOCK_GH_RUN_VIEW_CONCLUSION ?? 'success',
    MOCK_GH_RUN_WATCH_EXIT: env.MOCK_GH_RUN_WATCH_EXIT ?? '0',
    MOCK_GH_RELEASE_VIEW_BODY_LEN: env.MOCK_GH_RELEASE_VIEW_BODY_LEN ?? '800',
    RELEASE_NOTES_TEST_CORRELATION_ID: defaultCorrelationId,
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    // Shorten polling and watch budgets so the scenarios complete quickly.
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

  // The script receives RELEASE_VERSION as its first positional argument.
  const result = Bun.spawnSync(['bash', scriptPath, releaseVersion], {
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
// Per-test temp directory
// ---------------------------------------------------------------------------

let testTempDir = ''
let testMockBinDir = ''
let scriptPath = ''

beforeEach(() => {
  testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-ci-'))
  testMockBinDir = path.join(testTempDir, 'mock-bin')
  fs.mkdirSync(testMockBinDir, { recursive: true })

  // Copy the canonical script to the per-test temp dir.
  scriptPath = path.join(testTempDir, 'successCmd.sh')
  fs.copyFileSync(SCRIPT_PATH, scriptPath)
  fs.chmodSync(scriptPath, 0o755)
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
  it(
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
  it(
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
  it(
    'exits 0 with narrative-applied message on success conclusion and body length >= 200',
    () => {
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
        MOCK_GH_RUN_VIEW_LOG:
          'release edit v2.23.0 succeeded\nsome other log content',
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
  it(
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
  it(
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
  it(
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
  it(
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
  // 7. Edge case — no run created after dispatch epoch
  // -------------------------------------------------------------------------
  it(
    'exits 1 with ::error:: when all candidate runs pre-date the dispatch epoch',
    () => {
      // All runs have a createdAt in the past — before any real DISPATCH_EPOCH.
      // The script's jq filter selects runs with epoch > DISPATCH_EPOCH, so none
      // qualify and the polling loop times out.
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_LIST_JSON: makeRunListJson([
          { databaseId: 12345, createdAt: '1999-01-01T00:00:00Z' },
        ]),
      })

      expect(result.exitCode).toBe(1)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('::error::')
      expect(combined).toMatch(/not found within/i)
      expect(combined).toContain('dispatched_at_epoch=')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 8. Edge case — selects newest workflow_dispatch run created after dispatch epoch
  // -------------------------------------------------------------------------
  it(
    'selects newest workflow_dispatch run created after dispatch epoch when two candidates exist',
    () => {
      // Two runs both after the cutoff. Run 99999 has a later createdAt than 12345,
      // so the script should select 99999 (newest-after-cutoff wins).
      const result = run({
        RELEASE_VERSION: 'v2.23.0',
        MOCK_GH_RUN_LIST_JSON: JSON.stringify([
          { databaseId: 99999, createdAt: '2099-06-01T00:00:00Z' },
          { databaseId: 12345, createdAt: '2099-01-01T00:00:00Z' },
        ]),
        MOCK_GH_RUN_VIEW_CONCLUSION: 'success',
        MOCK_GH_RELEASE_VIEW_BODY_LEN: '800',
      })

      expect(result.exitCode).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).not.toContain('::error::')
      // The newer run (99999) should be selected and appear in the output
      expect(combined).toContain('99999')
    },
    SCENARIO_TIMEOUT_MS,
  )

  // -------------------------------------------------------------------------
  // 9. Error — HTTP 401 auth denial
  // -------------------------------------------------------------------------
  it(
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
  // 10. Error — HTTP 403 + permission denied
  // -------------------------------------------------------------------------
  it(
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
  // 11. Error — "Resource not accessible" auth keyword
  // -------------------------------------------------------------------------
  it(
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
  // 12. Error — off-target tag edit (ANSI-stripped)
  // -------------------------------------------------------------------------
  it(
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
  // 13. Error — success conclusion but body too short
  // -------------------------------------------------------------------------
  it(
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
  // 14. Error — action_required conclusion
  // -------------------------------------------------------------------------
  it(
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
  // 15. Error — skipped conclusion (policy block)
  // -------------------------------------------------------------------------
  it(
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
  // 16. Edge case — cancelled conclusion
  // -------------------------------------------------------------------------
  it(
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
  // 17. Edge case — generic narrative failure
  // -------------------------------------------------------------------------
  it(
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
  // 18. Edge case — unknown future conclusion
  // -------------------------------------------------------------------------
  it(
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
  // 19. Integration — prompt construction includes correlation token, target tag, repo name
  // -------------------------------------------------------------------------
  it(
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
