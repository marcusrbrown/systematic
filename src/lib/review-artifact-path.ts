import fs from 'node:fs'
import path from 'node:path'

export type ArtifactPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string }

export type ReadArtifactResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export function formatReviewArtifactIssuePath(
  issuePath: readonly PropertyKey[],
): string {
  if (issuePath.length === 0) return '$'
  return issuePath
    .map((segment) => (typeof segment === 'number' ? String(segment) : segment))
    .join('.')
}

export function readReviewArtifact(filePath: string): ReadArtifactResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { message: 'Review artifact file could not be read', ok: false }
  }

  try {
    return { ok: true, value: JSON.parse(content) as unknown }
  } catch (error) {
    return {
      message:
        error instanceof SyntaxError
          ? 'Review artifact contains malformed JSON'
          : 'Review artifact file could not be read',
      ok: false,
    }
  }
}

export function isLegacyReviewArtifact(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'schema_version')
  )
}

export function hasParentDirectoryTraversal(input: string): boolean {
  return input.split(/[\\/]+/).some((segment) => segment === '..')
}

// Shared CLI argument surface for both the standalone CLI and the bundled
// validator entry, so the two stay structurally identical rather than
// hand-maintained copies.
export const ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG = '--allow-outside-artifact-root'
export const VALIDATE_REVIEW_ARTIFACT_USAGE =
  'Usage: systematic validate-review-artifact <path> [--allow-outside-artifact-root]'

export interface ValidateReviewArtifactArguments {
  readonly path: string
  readonly allowOutsideArtifactRoot: boolean
}

// Filters every occurrence of the flag rather than removing only the first,
// so a repeated flag is accepted (idempotent) instead of being treated as an
// extra positional argument and rejected. Any other unrecognized token still
// fails the single-positional check below.
export function parseValidateReviewArtifactArguments(
  argv: readonly string[],
): ValidateReviewArtifactArguments | undefined {
  const allowOutsideArtifactRoot = argv.includes(
    ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
  )
  const positional = argv.filter(
    (arg) => arg !== ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
  )
  if (positional.length !== 1) return undefined
  const path = positional[0]
  if (path === undefined) return undefined
  return { allowOutsideArtifactRoot, path }
}

const REVIEW_ARTIFACT_VALID_MESSAGE = 'Review artifact is valid'
const REVIEW_ARTIFACT_VALID_EXTERNAL_MESSAGE =
  'Review artifact is valid (validated outside the run directory; not evidence for this run)'

// Keeps a transcript from mistaking an --allow-outside-artifact-root success
// for evidence about the current ce:review run.
export function formatReviewArtifactSuccessMessage(
  allowOutsideArtifactRoot: boolean,
): string {
  return allowOutsideArtifactRoot
    ? REVIEW_ARTIFACT_VALID_EXTERNAL_MESSAGE
    : REVIEW_ARTIFACT_VALID_MESSAGE
}

// Deliberately redundant with the realpath + containment check below. That pair
// rejects a symlink whose target escapes the artifact root; this rejects every
// symlink in the path outright, which also narrows the window between the
// containment check and the later read.
export function pathContainsSymlink(candidate: string): boolean {
  let current = path.parse(candidate).root
  const relative = path.relative(current, candidate)
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true
    } catch {
      // A missing path is handled by realpathSync below. Existing ancestors
      // have still been checked for symlinks before reaching the missing part.
      return false
    }
  }
  return false
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export interface ResolveReviewArtifactPathOptions {
  // When true, skip the containment check that requires the resolved path to
  // stay inside .context/systematic/ce-review, and do not require that
  // directory to exist. Lexical `..` rejection, symlink rejection, realpath
  // canonicalization, and the regular-file check still apply. Default false.
  readonly allowOutsideArtifactRoot?: boolean
}

export function resolveReviewArtifactPath(
  input: string,
  cwd: string,
  options: ResolveReviewArtifactPathOptions = {},
): ArtifactPathResult {
  const allowOutsideArtifactRoot = options.allowOutsideArtifactRoot ?? false

  if (hasParentDirectoryTraversal(input)) {
    return {
      message:
        'Review artifact path must not contain parent-directory traversal',
      ok: false,
    }
  }

  let canonicalRoot: string | undefined
  if (!allowOutsideArtifactRoot) {
    const artifactRoot = path.resolve(
      cwd,
      '.context',
      'systematic',
      'ce-review',
    )
    try {
      canonicalRoot = fs.realpathSync(artifactRoot)
      if (!fs.statSync(canonicalRoot).isDirectory()) {
        return {
          message: 'Review artifact directory is not a directory',
          ok: false,
        }
      }
    } catch {
      return { message: 'Review artifact directory is unavailable', ok: false }
    }
  }

  const candidate = path.resolve(cwd, input)
  if (pathContainsSymlink(candidate)) {
    return {
      message:
        'Review artifact path must not contain symlinks; pass a fully resolved path',
      ok: false,
    }
  }

  let canonicalTarget: string
  try {
    canonicalTarget = fs.realpathSync(candidate)
  } catch {
    return { message: 'Review artifact file was not found', ok: false }
  }

  if (
    canonicalRoot !== undefined &&
    !isWithinDirectory(canonicalTarget, canonicalRoot)
  ) {
    return {
      message:
        'Review artifact path must remain inside .context/systematic/ce-review',
      ok: false,
    }
  }

  try {
    if (!fs.lstatSync(canonicalTarget).isFile()) {
      return {
        message: 'Review artifact target is not a regular file',
        ok: false,
      }
    }
  } catch {
    return { message: 'Review artifact file was not found', ok: false }
  }

  return { ok: true, path: canonicalTarget }
}
