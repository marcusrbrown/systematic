/**
 * Shared OpenCode host-availability probe, fail-closed gate, and Bun install
 * cache directory resolver used by every OpenCode-spawning code path:
 * `tests/integration/fixtures/opencode-host.ts`,
 * `scripts/eval-cases/opencode.ts`, and `scripts/run-evals.ts`.
 *
 * Two host lines are probed. A v1 host is launched through
 * `bunx opencode-ai@<pin>` unless an explicit binary is configured. A v2 host
 * is launched only through an explicit binary, because its CLI needs install
 * scripts that `bunx` does not run. The pins come from
 * `scripts/lib/opencode-pin.ts`. This module answers one question — "is that
 * launcher available at the pinned version, in this child environment?" —
 * without building the environment itself and without memoizing: callers that
 * want a computed-once gate (the fixture module, an integration test module)
 * memoize the result of {@link probeOpencodeAvailability} themselves.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  OPENCODE_CLI_PACKAGES,
  type OpencodeHost,
  parseOpencodeHost,
  readOpencodeHostPins,
} from './opencode-pin.js'

/** Classification returned by {@link probeOpencodeAvailability}. */
export type OpencodeAvailabilityStatus =
  | 'available'
  | 'mismatch'
  | 'unavailable'

export interface OpencodeAvailabilityClassification {
  status: OpencodeAvailabilityStatus
  /** The host line the probe was run against. */
  host: OpencodeHost
  /** The pin the probe was run against. */
  expectedVersion: string
  /** The version the launcher reported, when it reported one. */
  reportedVersion?: string
  /** Human-readable reason, safe to surface in a skip message or a thrown error. */
  reason: string
}

/** Env var that selects the host line the integration harness targets. */
export const OPENCODE_HOST_ENV = 'SYSTEMATIC_OPENCODE_HOST'

/** The host line used when {@link OPENCODE_HOST_ENV} is unset. */
export const DEFAULT_OPENCODE_HOST: OpencodeHost = 'v1'

/**
 * Reads the selected host line from the environment. An unset or empty value
 * selects {@link DEFAULT_OPENCODE_HOST}; any other value must name a host line.
 */
export function resolveOpencodeHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpencodeHost {
  const value = env[OPENCODE_HOST_ENV]
  if (value === undefined || value === '') return DEFAULT_OPENCODE_HOST
  return parseOpencodeHost(value)
}

/** Env var that picks which v1 pin a v1 run targets: `floor` or `current`. */
export const OPENCODE_V1_LINE_ENV = 'SYSTEMATIC_OPENCODE_V1_LINE'

/**
 * The exact CLI version a run targets for `host`. A v2 run targets the v2 pin.
 * A v1 run targets the current v1 pin, or the v1 floor when
 * {@link OPENCODE_V1_LINE_ENV} is `floor`. The variable only chooses between
 * the two committed pins; it never carries a version of its own.
 */
export function resolveTargetOpencodePin(
  host: OpencodeHost,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pinFilePath?: string,
): string {
  const pins = readOpencodeHostPins(pinFilePath)
  if (host === 'v2') return pins.v2
  const line = env[OPENCODE_V1_LINE_ENV]
  if (line === undefined || line === '' || line === 'current') return pins.v1
  if (line === 'floor') return pins.v1Floor
  throw new Error(
    `Unknown v1 line "${line}" in ${OPENCODE_V1_LINE_ENV}. Expected "floor" or "current".`,
  )
}

/** Env var that points at an installed CLI binary for one host line. */
export function opencodeBinaryEnvName(host: OpencodeHost): string {
  return `SYSTEMATIC_OPENCODE_${host.toUpperCase()}_BIN`
}

/**
 * Returns the configured binary path for a host line, or `undefined` when the
 * env var is unset or empty. A configured path is used as given; whether it is
 * executable is decided by actually running it.
 */
export function resolveOpencodeBinary(
  host: OpencodeHost,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env[opencodeBinaryEnvName(host)]
  return value === undefined || value === '' ? undefined : value
}

function truncateStderr(stderr: string): string {
  return stderr.slice(0, 300).replaceAll(/\s+/g, ' ').trim()
}

export interface ProbeOpencodeAvailabilityOptions {
  /** The exact pinned OpenCode version for the host line (from `opencode-pin.ts`). */
  pin: string
  /** The host line to probe. Defaults to `v1`. */
  host?: OpencodeHost
  /**
   * Absolute path of an installed CLI binary. When set, the probe runs
   * `<binary> --version` instead of the default launcher. A v2 host has no
   * default launcher, so it is unavailable without one.
   */
  binary?: string
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

/** What a v2 CLI prints for `--version`, for example `opencode v<semver>`. */
const V2_VERSION_LINE_PATTERN = /^opencode v(\d+\.\d+\.\d+(?:[-+].+)?)$/

/**
 * Extracts the reported version per the documented contract: the last
 * non-empty trimmed line of stdout must itself be a version line — not any
 * substring anywhere in the buffer. A v1 line is a bare exact semver; a v2
 * line is `opencode v<semver>`. A first-run autoupdate banner or a trailing
 * "update available" notice on its own line is therefore never mistaken for
 * the reported version; it simply fails to parse (the caller's
 * `OPENCODE_DISABLE_*` env flags are what actually prevent that banner from
 * appearing at all).
 */
function extractReportedVersion(
  output: string,
  host: OpencodeHost,
): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  const lastNonEmpty = [...lines].reverse().find((line) => line.length > 0)
  if (lastNonEmpty === undefined) return undefined
  if (host === 'v2') return V2_VERSION_LINE_PATTERN.exec(lastNonEmpty)?.[1]
  return EXACT_SEMVER_LINE_PATTERN.test(lastNonEmpty) ? lastNonEmpty : undefined
}

interface ProbeLauncher {
  command: string
  args: readonly string[]
  /** The command line as shown in diagnostics and failure reasons. */
  label: string
  /** What the launcher is called in a mismatch reason: `bunx` or the binary path. */
  resolver: string
}

/** The launcher for a host, or `undefined` when none can be built (v2 without a binary). */
function buildLauncher(
  options: ProbeOpencodeAvailabilityOptions,
  host: OpencodeHost,
): ProbeLauncher | undefined {
  const spec = `${OPENCODE_CLI_PACKAGES[host]}@${options.pin}`
  if (options.binary !== undefined) {
    return {
      command: options.command ?? options.binary,
      args: options.args ?? ['--version'],
      label: `${options.binary} --version`,
      resolver: options.binary,
    }
  }
  if (host === 'v2') return undefined
  return {
    command: options.command ?? 'bunx',
    args: options.args ?? [spec, '--version'],
    label: `bunx ${spec} --version`,
    resolver: 'bunx',
  }
}

/**
 * True only on the real launcher path: every unit test override supplies its
 * own `command`, and logging would otherwise fire once per fake-launcher
 * case. Callers whose own output must stay clean (the eval runner CLI
 * child) pass `quiet: true` to suppress it. Split out from
 * {@link probeOpencodeAvailability} to keep that function's cognitive
 * complexity under the project's lint ceiling.
 */
function shouldLogProbeDiagnostic(
  options: ProbeOpencodeAvailabilityOptions,
): boolean {
  return options.command === undefined && !options.quiet
}

function unavailable(
  host: OpencodeHost,
  pin: string,
  reason: string,
): OpencodeAvailabilityClassification {
  return { status: 'unavailable', host, expectedVersion: pin, reason }
}

function missingBinaryReason(host: OpencodeHost, pin: string): string {
  return (
    `no ${host} binary configured: set ${opencodeBinaryEnvName(host)} to the absolute path of an installed ` +
    `${OPENCODE_CLI_PACKAGES[host]}@${pin} (for v2: npm install --prefix <dir> ${OPENCODE_CLI_PACKAGES[host]}@${pin} --dangerously-allow-all-scripts, ` +
    'then use <dir>/node_modules/.bin/opencode)'
  )
}

/**
 * Runs the host's `--version` launcher (or the test-only override) under the
 * given environment and classifies the outcome. Never throws; never
 * memoizes. `available` requires exit 0 and the last stdout line to report
 * the pin exactly; `mismatch` is exit 0 with a different exact version;
 * anything else, including a timeout or an unparseable last line, is
 * `unavailable`.
 */
export function probeOpencodeAvailability(
  options: ProbeOpencodeAvailabilityOptions,
): OpencodeAvailabilityClassification {
  const host = options.host ?? 'v1'
  const launcher = buildLauncher(options, host)
  if (launcher === undefined) {
    return unavailable(
      host,
      options.pin,
      missingBinaryReason(host, options.pin),
    )
  }
  const packageSpec = `${OPENCODE_CLI_PACKAGES[host]}@${options.pin}`

  // A wedged package registry blocks synchronously for the full timeout
  // with no other output, so this line is what makes that stall
  // attributable in CI logs rather than a silent multi-minute pause.
  if (shouldLogProbeDiagnostic(options)) {
    console.warn(`[opencode-availability] probing ${launcher.label}`)
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
  const result = spawnSync(launcher.command, [...launcher.args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  })

  if (result.error || result.status !== 0) {
    const stderrExcerpt = truncateStderr(result.stderr ?? '')
    return unavailable(
      host,
      options.pin,
      `${launcher.label} failed: ` +
        `status=${result.status ?? 'null'} signal=${result.signal ?? 'null'} ` +
        `error=${result.error?.message ?? 'none'} stderr=${stderrExcerpt}`,
    )
  }

  const reportedVersion = extractReportedVersion(result.stdout ?? '', host)
  if (!reportedVersion) {
    const stderrExcerpt = truncateStderr(result.stderr ?? '')
    return unavailable(
      host,
      options.pin,
      `${launcher.label} produced no parseable version: ` +
        `stdout=${(result.stdout ?? '').slice(0, 200)} stderr=${stderrExcerpt}`,
    )
  }

  if (reportedVersion === options.pin) {
    return {
      status: 'available',
      host,
      expectedVersion: options.pin,
      reportedVersion,
      reason: `${packageSpec} is available`,
    }
  }

  return {
    status: 'mismatch',
    host,
    expectedVersion: options.pin,
    reportedVersion,
    reason: `expected ${packageSpec} but ${launcher.resolver} resolved ${OPENCODE_CLI_PACKAGES[host]}@${reportedVersion}`,
  }
}

/**
 * True when the host is required: `SYSTEMATIC_REQUIRE_OPENCODE=1` requires
 * whichever host the job targets, and `SYSTEMATIC_REQUIRE_OPENCODE_V1=1` or
 * `SYSTEMATIC_REQUIRE_OPENCODE_V2=1` requires that one host line only.
 */
function isOpencodeRequired(host: OpencodeHost): boolean {
  return (
    process.env.SYSTEMATIC_REQUIRE_OPENCODE === '1' ||
    process.env[`SYSTEMATIC_REQUIRE_OPENCODE_${host.toUpperCase()}`] === '1'
  )
}

/**
 * Throws `classification.reason` when the host is required (see
 * {@link isOpencodeRequired}) and the classification is not `available`. Only
 * test modules call this — never the fixture module itself and never the eval
 * runner's per-case probe path — so a green CI run under the flag can never be
 * a run of zero tests, while a local run without the flag stays a named skip.
 */
export function requireOpencodeAvailable(
  classification: OpencodeAvailabilityClassification,
): void {
  if (
    isOpencodeRequired(classification.host) &&
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
