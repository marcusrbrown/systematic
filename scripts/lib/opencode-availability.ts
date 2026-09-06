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
  /**
   * Suppresses the pre-probe diagnostic (see below). Set by callers whose
   * output is itself asserted to be clean, such as `verifyExactOpencodeRuntime`'s
   * per-case probe inside the eval runner CLI child — its stderr is asserted
   * empty by `eval-runner.test.ts`'s direct-CLI tests. Defaults to `false`.
   */
  quiet?: boolean
}

const DEFAULT_PROBE_TIMEOUT_MS = 300_000

const EXACT_SEMVER_LINE_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * Extracts the reported version per the documented contract: the last
 * non-empty trimmed line of stdout must itself be an exact semver — not any
 * substring anywhere in the buffer. A first-run autoupdate banner or a
 * trailing "update available" notice on its own line is therefore never
 * mistaken for the reported version; it simply fails to parse (the caller's
 * `OPENCODE_DISABLE_*` env flags are what actually prevent that banner from
 * appearing at all).
 */
function extractReportedVersion(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  const lastNonEmpty = [...lines].reverse().find((line) => line.length > 0)
  if (lastNonEmpty === undefined) return undefined
  return EXACT_SEMVER_LINE_PATTERN.test(lastNonEmpty) ? lastNonEmpty : undefined
}

/**
 * Runs `bunx opencode-ai@<pin> --version` (or the test-only override) under
 * the given environment and classifies the outcome. Never throws; never
 * memoizes. `available` requires exit 0 and the last stdout line to equal
 * the pin exactly; `mismatch` is exit 0 with a different exact-semver last
 * line; anything else, including a timeout or an unparseable last line, is
 * `unavailable`.
 */
export function probeOpencodeAvailability(
  options: ProbeOpencodeAvailabilityOptions,
): OpencodeAvailabilityClassification {
  const command = options.command ?? 'bunx'
  const args = options.args ?? [`opencode-ai@${options.pin}`, '--version']

  // Only the real launcher path logs: every unit test override supplies its
  // own `command`, and this line would otherwise fire once per fake-launcher
  // case. A wedged package registry blocks synchronously for the full
  // timeout with no other output, so this line is what makes that stall
  // attributable in CI logs rather than a silent multi-minute pause. Callers
  // whose own output must stay clean (the eval runner CLI child) pass
  // `quiet: true` to suppress it.
  if (options.command === undefined && !options.quiet) {
    console.warn(
      `[opencode-availability] probing bunx opencode-ai@${options.pin} --version`,
    )
  }

  // spawnSync's own timeout sends SIGTERM (then SIGKILL) to the direct child
  // only, not its process group; this function is deliberately synchronous
  // (every caller computes availability once, inline, before deciding
  // whether to proceed), and `stopProcessGroup` from process-group.js needs
  // an async ChildProcess to await the exit event on, which spawnSync does
  // not produce. A timed-out `bunx` cold-install could therefore in
  // principle leave a grandchild `bun install` writing into the shared
  // BUN_INSTALL_CACHE_DIR after this function returns `unavailable`, risking
  // a partially-populated shared cache for the next caller. Mitigating that
  // fully would mean switching this probe to async spawn + group reaping
  // everywhere it's called (the fixture, eval-runner.test.ts, and
  // verifyExactOpencodeRuntime's per-case path); left as a documented risk
  // rather than expanding this change's surface.
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
  // process.getuid is POSIX-only (undefined on Windows). Where it's missing,
  // the directory name falls back to the OS username as its discriminator,
  // and the ownership assertion below (which needs a uid to compare against)
  // is skipped rather than thrown — this function must never throw at module
  // load on a getuid-less platform, since it runs from every fixture-consuming
  // suite's module scope ahead of that suite's own `process.platform` skip
  // guards. The symlink/non-directory refusal and the 0700 mkdir/chmod still
  // apply on every platform.
  const uid = process.getuid?.()
  const discriminator = uid ?? os.userInfo().username
  const tmpRoot = options.tmpRoot ?? os.tmpdir()
  const dirPath = path.join(
    tmpRoot,
    `systematic-bun-install-cache-${discriminator}-${options.pin}`,
  )

  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  } catch (err) {
    throw new Error(
      `failed to create ${dirPath} as the Bun install cache directory: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

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
  if (uid !== undefined && stats.uid !== uid) {
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
