/**
 * Single source of truth for the pinned OpenCode host version: the
 * `@opencode-ai/sdk` devDependency in this repository's `package.json`.
 *
 * `@opencode-ai/plugin` also has a devDependency entry (the exact pin used
 * for the equality backstop below) and a separate `peerDependencies` range
 * entry (a consumer-facing compatibility range, not a pin). Only the
 * devDependency entries participate in the pin.
 *
 * Renovate's `OpenCode` group bumps both `@opencode-ai/sdk` and
 * `@opencode-ai/plugin` devDependencies together, so callers that need the
 * exact pinned version should read it from here rather than hardcoding a
 * literal, which would silently drift from `package.json` on the next bump.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json',
)

interface PackageJsonShape {
  devDependencies?: Record<string, unknown>
}

function readPackageJson(packageJsonPath: string): PackageJsonShape {
  let raw: string
  try {
    raw = fs.readFileSync(packageJsonPath, 'utf8')
  } catch (err) {
    throw new Error(
      `Failed to read ${packageJsonPath}: ${(err as Error).message}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Failed to parse ${packageJsonPath} as JSON: ${(err as Error).message}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${packageJsonPath} does not contain a JSON object.`)
  }

  return parsed as PackageJsonShape
}

/** Matches an exact semver version with no range specifier. */
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/

function readExactDevDependency(
  fieldName: string,
  packageJsonPath: string,
): string {
  const pkg = readPackageJson(packageJsonPath)
  const devDeps = pkg.devDependencies
  if (
    typeof devDeps !== 'object' ||
    devDeps === null ||
    Array.isArray(devDeps)
  ) {
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

/**
 * Returns the exact `@opencode-ai/sdk` devDependency version from
 * `package.json`. Throws a clear error naming the field if it is missing or
 * not an exact version.
 *
 * @param packageJsonPath - Optional override, primarily for tests that point
 *   at a temporary copy of `package.json`. Defaults to the repository's own
 *   `package.json`, resolved relative to this module rather than `cwd`.
 */
export function readOpencodeSdkPin(packageJsonPath?: string): string {
  return readExactDevDependency(
    '@opencode-ai/sdk',
    packageJsonPath ?? DEFAULT_PACKAGE_JSON_PATH,
  )
}

/**
 * Returns both the `@opencode-ai/sdk` and `@opencode-ai/plugin` devDependency
 * versions from `package.json`, for the equality backstop that guards against
 * the two drifting apart on a manual edit (Renovate's `OpenCode` group bumps
 * both together in one PR).
 *
 * @param packageJsonPath - Optional override, primarily for tests that point
 *   at a temporary copy of `package.json`.
 */
export function readOpencodeDevDependencyPins(packageJsonPath?: string): {
  sdk: string
  plugin: string
} {
  const resolvedPath = packageJsonPath ?? DEFAULT_PACKAGE_JSON_PATH
  return {
    sdk: readExactDevDependency('@opencode-ai/sdk', resolvedPath),
    plugin: readExactDevDependency('@opencode-ai/plugin', resolvedPath),
  }
}
