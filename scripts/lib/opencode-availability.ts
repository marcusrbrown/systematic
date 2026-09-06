/**
 * Shared OpenCode host-availability probe, fail-closed gate, and Bun install
 * cache directory resolver used by every OpenCode-spawning code path:
 * `tests/integration/fixtures/receipt-workflow-host.ts`,
 * `scripts/eval-cases/opencode.ts`, and `scripts/run-evals.ts`.
 *
 * Every OpenCode host is launched through `bunx opencode-ai@<pin>` (see
 * `scripts/lib/opencode-pin.ts` for the pin itself). This module answers one
 * question — "is that launcher available at the pinned version, in this
 * child environment?" — without building the environment itself and without
 * memoizing: callers that want a computed-once gate (the fixture module, an
 * integration test module) memoize the result of {@link probeOpencodeAvailability}
 * themselves.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Classification returned by {@link probeOpencodeAvailability}. */
export type OpencodeAvailabilityStatus =
  | 'available'
  | 'mismatch'
  | 'unavailable'

export interface OpencodeAvailabilityClassification {
  status: OpencodeAvailabilityStatus
  /** The pin the probe was run against. */
  expectedVersion: string
  /** The version the launcher reported, when it reported one. */
  reportedVersion?: string
  /** Human-readable reason, safe to surface in a skip message or a thrown error. */
  reason: string
}

function truncateStderr(stderr: string): string {
  return stderr.slice(0, 300).replaceAll(/\s+/g, ' ').trim()
}

export interface ProbeOpencodeAvailabilityOptions {
  /** The exact pinned OpenCode version (from `readOpencodeSdkPin()`). */
  pin: string
  /** The full child environment to run the probe under; built by the caller. */
  env: Readonly<Record<string, string>>
  cwd?: string
  /** Bounded timeout, generous enough for a cold `bunx` download on CI. */
  timeoutMs?: number
  /**
   * Test-only hook: overrides the launcher binary. Defaults to `bunx`.
   * Production callers must not set this.
   */
  command?: string
  /**
   * Test-only hook: overrides the launcher arguments. Defaults to
   * `[opencode-ai@<pin>, --version]`. Production callers must not set this.
   */
  args?: readonly string[]
}

const DEFAULT_PROBE_TIMEOUT_MS = 300_000

function extractReportedVersion(output: string): string | undefined {
  const matches = output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/g)
  return matches?.at(-1)
}

/**
 * Runs `bunx opencode-ai@<pin> --version` (or the test-only override) under
 * the given environment and classifies the outcome. Never throws; never
 * memoizes. `available` requires exit 0 and stdout equal to the pin exactly;
 * `mismatch` is exit 0 with a different reported version; anything else,
 * including a timeout, is `unavailable`.
 */
export function probeOpencodeAvailability(
  options: ProbeOpencodeAvailabilityOptions,
): OpencodeAvailabilityClassification {
  const command = options.command ?? 'bunx'
  const args = options.args ?? [`opencode-ai@${options.pin}`, '--version']

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  })

  if (result.error || result.status !== 0) {
    const stderrExcerpt = truncateStderr(result.stderr ?? '')
    return {
      status: 'unavailable',
      expectedVersion: options.pin,
      reason:
        `bunx opencode-ai@${options.pin} --version failed: ` +
        `status=${result.status ?? 'null'} signal=${result.signal ?? 'null'} ` +
        `error=${result.error?.message ?? 'none'} stderr=${stderrExcerpt}`,
    }
  }

  const reportedVersion = extractReportedVersion(result.stdout ?? '')
  if (!reportedVersion) {
    const stderrExcerpt = truncateStderr(result.stderr ?? '')
    return {
      status: 'unavailable',
      expectedVersion: options.pin,
      reason:
        `bunx opencode-ai@${options.pin} --version produced no parseable version: ` +
        `stdout=${(result.stdout ?? '').slice(0, 200)} stderr=${stderrExcerpt}`,
    }
  }

  if (reportedVersion === options.pin) {
    return {
      status: 'available',
      expectedVersion: options.pin,
      reportedVersion,
      reason: `opencode-ai@${options.pin} is available`,
    }
  }

  return {
    status: 'mismatch',
    expectedVersion: options.pin,
    reportedVersion,
    reason: `expected opencode-ai@${options.pin} but bunx resolved opencode-ai@${reportedVersion}`,
  }
}

/**
 * Throws `classification.reason` when `process.env.SYSTEMATIC_REQUIRE_OPENCODE
 * === '1'` and the classification is not `available`. Only test modules call
 * this — never the fixture module itself and never the eval runner's
 * per-case probe path — so a green CI run under the flag can never be a run
 * of zero tests, while a local run without the flag stays a named skip.
 */
export function requireOpencodeAvailable(
  classification: OpencodeAvailabilityClassification,
): void {
  if (
    process.env.SYSTEMATIC_REQUIRE_OPENCODE === '1' &&
    classification.status !== 'available'
  ) {
    throw new Error(classification.reason)
  }
}

export interface ResolveBunInstallCacheDirOptions {
  /** The exact pinned OpenCode version; participates in the directory name. */
  pin: string
  /**
   * Test-only hook: overrides the OS temp root the directory is resolved
   * under. Defaults to `os.tmpdir()`.
   */
  tmpRoot?: string
}

/**
 * Resolves (and, on first use, creates) a stable directory under the OS temp
 * root for `BUN_INSTALL_CACHE_DIR`, shared by every child that installs
 * `opencode-ai` through `bunx`. Never memoizes — every call re-verifies the
 * directory's security properties, since cache hits are never re-verified
 * against the package registry and a directory another user could pre-
 * populate or redirect must never be trusted.
 *
 * The directory name carries the current uid and the pin, mirroring the rule
 * `bunx` applies to its own cache directory. `mkdir` runs first,
 * unconditionally, recursive, mode `0700` — it succeeds silently whether the
 * directory is fresh or already exists. The path is then always checked with
 * `lstat` (never `stat`, which would follow a planted symlink to a directory
 * the current user happens to own): a symlink, a non-directory, or a
 * directory not owned by the current uid is refused with a clear error. A
 * directory that is owned but wider than `0700` is tightened with `chmod`
 * before use.
 */
export function resolveBunInstallCacheDir(
  options: ResolveBunInstallCacheDirOptions,
): string {
  if (typeof process.getuid !== 'function') {
    throw new Error(
      'resolveBunInstallCacheDir requires a POSIX platform with process.getuid()',
    )
  }
  const uid = process.getuid()
  const tmpRoot = options.tmpRoot ?? os.tmpdir()
  const dirPath = path.join(
    tmpRoot,
    `systematic-bun-install-cache-${uid}-${options.pin}`,
  )

  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })

  const stats = fs.lstatSync(dirPath)

  if (stats.isSymbolicLink()) {
    throw new Error(
      `refusing to use ${dirPath} as the Bun install cache directory: it is a symlink`,
    )
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `refusing to use ${dirPath} as the Bun install cache directory: it is not a directory`,
    )
  }
  if (stats.uid !== uid) {
    throw new Error(
      `refusing to use ${dirPath} as the Bun install cache directory: it is owned by uid ${stats.uid}, not the current uid ${uid}`,
    )
  }

  const mode = stats.mode & 0o777
  if (mode !== 0o700) {
    fs.chmodSync(dirPath, 0o700)
  }

  return dirPath
}
