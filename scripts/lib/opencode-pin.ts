/**
 * Single source of truth for the pinned OpenCode host versions: the committed
 * pin file `scripts/opencode-host-pins.json`.
 *
 * The pin file holds three exact CLI versions: the v2 CLI (`@opencode/cli`),
 * the current v1 CLI (`opencode-ai`) and the v1 floor, the oldest v1 release
 * the package still supports. It lives under `scripts/` because Renovate
 * ignores `tests/**`. A Renovate regex manager bumps the two moving pins (v2
 * and v1 current) and never the floor.
 *
 * Each CLI pin is tied to the dev dependencies that must move with it:
 * `@opencode-ai/sdk` and `@opencode-ai/plugin` for v1, and `@opencode/sdk`,
 * `@opencode/plugin` and `@opencode/client` for v2. The equality tests in
 * `tests/unit/opencode-pin.test.ts` read both sides, so a manual edit of one
 * side fails loudly. `peerDependencies` entries are consumer-facing ranges,
 * not pins, and take no part in the equality.
 *
 * Callers that need an exact host version read it from here rather than
 * hardcoding a literal, which would silently drift from the pin file on the
 * next bump.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const DEFAULT_PIN_FILE_PATH = path.join(SCRIPTS_DIR, 'opencode-host-pins.json')

const DEFAULT_PACKAGE_JSON_PATH = path.resolve(
  SCRIPTS_DIR,
  '..',
  'package.json',
)

export const OPENCODE_HOSTS = ['v1', 'v2'] as const

/** The two OpenCode host lines the package supports. */
export type OpencodeHost = (typeof OPENCODE_HOSTS)[number]

/** The npm package that ships each host line's CLI. */
export const OPENCODE_CLI_PACKAGES = {
  v1: 'opencode-ai',
  v2: '@opencode/cli',
} as const satisfies Record<OpencodeHost, string>

/** Narrows an arbitrary string (such as an env var value) to a host line. */
export function parseOpencodeHost(value: string): OpencodeHost {
  const host = OPENCODE_HOSTS.find((candidate) => candidate === value)
  if (host === undefined) {
    throw new Error(
      `Unknown OpenCode host "${value}". Expected one of: ${OPENCODE_HOSTS.join(', ')}.`,
    )
  }
  return host
}

export interface OpencodeHostPins {
  /** The v2 CLI (`@opencode/cli`) version. */
  v2: string
  /** The current v1 CLI (`opencode-ai`) version. */
  v1: string
  /** The oldest supported v1 CLI version. */
  v1Floor: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readJsonObject(filePath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${errorMessage(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${errorMessage(err)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON object.`)
  }

  return Object.fromEntries(Object.entries(parsed))
}

/** Matches an exact semver version with no range specifier. */
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return Object.fromEntries(Object.entries(value))
}

/**
 * Extracts and validates one exact-pinned devDependency field from an
 * already-parsed `package.json` object, so a caller that needs several fields
 * reads and parses the file once.
 */
function extractExactDevDependency(
  pkg: Record<string, unknown>,
  fieldName: string,
  packageJsonPath: string,
): string {
  const devDeps = asRecord(pkg.devDependencies)
  if (devDeps === undefined) {
    throw new Error(
      `${packageJsonPath} is missing a devDependencies object. Add "${fieldName}": "<exact version>" to devDependencies.`,
    )
  }

  const raw = devDeps[fieldName]
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `${fieldName} is not listed in ${packageJsonPath} devDependencies. Add it with an exact version pin (no ^ or ~).`,
    )
  }

  if (!EXACT_SEMVER_PATTERN.test(raw)) {
    throw new Error(
      `${fieldName} in ${packageJsonPath} devDependencies must be an exact version, but found "${raw}". Remove any range specifier (^, ~, *, etc.) so the OpenCode host pin stays exact.`,
    )
  }

  return raw
}

function extractExactPin(
  file: Record<string, unknown>,
  key: keyof OpencodeHostPins,
  pinFilePath: string,
): string {
  const raw = file[key]
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `"${key}" is missing from ${pinFilePath}. Add it with an exact version.`,
    )
  }
  if (!EXACT_SEMVER_PATTERN.test(raw)) {
    throw new Error(
      `"${key}" in ${pinFilePath} must be an exact version, but found "${raw}". Remove any range specifier (^, ~, *, etc.) so the OpenCode host pin stays exact.`,
    )
  }
  return raw
}

/**
 * Returns the three CLI pins from the pin file. Throws a clear error naming
 * the field when one is missing or not an exact version, and when the floor is
 * newer than the current v1 pin.
 *
 * @param pinFilePath - Optional override, primarily for tests that point at a
 *   temporary pin file. Defaults to `scripts/opencode-host-pins.json`,
 *   resolved relative to this module rather than `cwd`.
 */
export function readOpencodeHostPins(pinFilePath?: string): OpencodeHostPins {
  const resolvedPath = pinFilePath ?? DEFAULT_PIN_FILE_PATH
  const file = readJsonObject(resolvedPath)
  const pins: OpencodeHostPins = {
    v2: extractExactPin(file, 'v2', resolvedPath),
    v1: extractExactPin(file, 'v1', resolvedPath),
    v1Floor: extractExactPin(file, 'v1Floor', resolvedPath),
  }
  if (Bun.semver.order(pins.v1Floor, pins.v1) > 0) {
    throw new Error(
      `"v1Floor" (${pins.v1Floor}) in ${resolvedPath} is newer than "v1" (${pins.v1}). The floor is the oldest supported v1 release.`,
    )
  }
  return pins
}

/** Returns the current CLI pin for one host line (v1 current, or v2). */
export function readOpencodeHostPin(
  host: OpencodeHost,
  pinFilePath?: string,
): string {
  return readOpencodeHostPins(pinFilePath)[host]
}

/**
 * Returns the current v1 CLI pin, which the eval runner measures against.
 *
 * @param pinFilePath - Optional override for tests.
 */
export function readOpencodeSdkPin(pinFilePath?: string): string {
  return readOpencodeHostPin('v1', pinFilePath)
}

/**
 * Returns both the `@opencode-ai/sdk` and `@opencode-ai/plugin` devDependency
 * versions from `package.json`, for the equality check that guards against the
 * pair, or either of them and the v1 CLI pin, drifting apart on a manual edit.
 *
 * @param packageJsonPath - Optional override, primarily for tests that point
 *   at a temporary copy of `package.json`.
 */
export function readOpencodeDevDependencyPins(packageJsonPath?: string): {
  sdk: string
  plugin: string
} {
  const resolvedPath = packageJsonPath ?? DEFAULT_PACKAGE_JSON_PATH
  const pkg = readJsonObject(resolvedPath)
  return {
    sdk: extractExactDevDependency(pkg, '@opencode-ai/sdk', resolvedPath),
    plugin: extractExactDevDependency(pkg, '@opencode-ai/plugin', resolvedPath),
  }
}

/**
 * The v2 counterpart of {@link readOpencodeDevDependencyPins}: the
 * `@opencode/sdk`, `@opencode/plugin` and `@opencode/client` devDependency
 * versions, which move in lockstep with the v2 CLI pin.
 */
export function readOpencodeV2DevDependencyPins(packageJsonPath?: string): {
  sdk: string
  plugin: string
  client: string
} {
  const resolvedPath = packageJsonPath ?? DEFAULT_PACKAGE_JSON_PATH
  const pkg = readJsonObject(resolvedPath)
  return {
    sdk: extractExactDevDependency(pkg, '@opencode/sdk', resolvedPath),
    plugin: extractExactDevDependency(pkg, '@opencode/plugin', resolvedPath),
    client: extractExactDevDependency(pkg, '@opencode/client', resolvedPath),
  }
}

export interface FindOpencodePinMismatchesOptions {
  /** Override for tests. Defaults to `scripts/opencode-host-pins.json`. */
  pinFilePath?: string
  /** Override for tests. Defaults to the repository's `package.json`. */
  packageJsonPath?: string
}

/**
 * Compares each CLI pin with the dev dependencies that must equal it and
 * returns one message per disagreement; an empty list means the pins are in
 * lockstep. The v1 CLI pin must equal `@opencode-ai/sdk` and
 * `@opencode-ai/plugin`. The v2 CLI pin must equal `@opencode/sdk`,
 * `@opencode/plugin` and `@opencode/client`. The floor has no dev dependency.
 */
export function findOpencodePinMismatches(
  options: FindOpencodePinMismatchesOptions = {},
): string[] {
  const pins = readOpencodeHostPins(options.pinFilePath)
  const v1 = readOpencodeDevDependencyPins(options.packageJsonPath)
  const v2 = readOpencodeV2DevDependencyPins(options.packageJsonPath)
  const checks: readonly (readonly [string, string, string])[] = [
    ['@opencode-ai/sdk', v1.sdk, pins.v1],
    ['@opencode-ai/plugin', v1.plugin, pins.v1],
    ['@opencode/sdk', v2.sdk, pins.v2],
    ['@opencode/plugin', v2.plugin, pins.v2],
    ['@opencode/client', v2.client, pins.v2],
  ]
  return checks.flatMap(([name, actual, expected]) =>
    actual === expected
      ? []
      : [
          `${name} is ${actual} in devDependencies but the ${name.startsWith('@opencode-ai/') ? 'v1' : 'v2'} CLI pin is ${expected}. Bump them together.`,
        ],
  )
}
