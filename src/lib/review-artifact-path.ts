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

/** Maximum number of projected issues emitted before the total. */
export const MAX_PROJECTED_ISSUE_LINES = 8

/** One bounded, payload-safe projected validation issue: a safe path and an
 * issue code, never a message, a value, or an unrecognized key name. */
export interface ProjectedIssue {
  readonly path: string
  readonly code: string
}

/** The structural shape of a validation issue the projector reads. A Zod
 * issue satisfies it; this module does not import Zod, so the input is typed
 * by the two fields that are projected. */
export interface ProjectableIssue {
  readonly path: readonly PropertyKey[]
  readonly code: string
}

export interface ProjectedIssues {
  readonly issues: readonly ProjectedIssue[]
  /** The full issue count, even when {@link ProjectedIssues.issues} is capped. */
  readonly total: number
}

/**
 * Projects at most `max` issues to `{path, code}` pairs plus the full count.
 * Only the path and the code are read, so no issue message, payload value or
 * unrecognized key name can reach the projection.
 */
export function projectZodIssues(
  issues: readonly ProjectableIssue[],
  max: number = MAX_PROJECTED_ISSUE_LINES,
): ProjectedIssues {
  return {
    issues: issues.slice(0, max).map((issue) => ({
      path: formatReviewArtifactIssuePath(issue.path),
      code: issue.code,
    })),
    total: issues.length,
  }
}

/** A payload-safe schema rejection: a fixed reason code, the first issue's
 * safe path, up to {@link MAX_PROJECTED_ISSUE_LINES} projected `{path, code}`
 * issues and the full issue count. Never a message, a value or an
 * unrecognized key name. */
export interface SchemaRejection<Reason extends string> {
  readonly path: string
  readonly reason: Reason
  readonly issues: readonly ProjectedIssue[]
  readonly total: number
}

/**
 * Builds a schema rejection from a failed parse's issues. The path is the
 * first issue's path, or the root `$` when there is none. Every surface that
 * reports a schema failure builds it here, so that rule has one owner.
 */
export function schemaRejection<Reason extends string>(
  reason: Reason,
  zodIssues: readonly ProjectableIssue[],
): SchemaRejection<Reason> {
  const { issues, total } = projectZodIssues(zodIssues)
  return {
    path: issues[0]?.path ?? '$',
    reason,
    issues,
    total,
  }
}

/** The repository-relative path of the published review-summary schema,
 * named in every artifact validation failure. */
export const REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH =
  'skills/ce-review/references/review-summary-schema.json'

/** The `path code` lines of a projection, then `… and N more` when the
 * projection was capped. Pure formatting: nothing but the two projected
 * fields reaches a line. */
export function formatProjectedIssueLines(
  projected: ProjectedIssues,
): string[] {
  const lines = projected.issues.map((issue) => `${issue.path} ${issue.code}`)
  const omitted = projected.total - projected.issues.length
  if (omitted > 0) lines.push(`… and ${omitted} more`)
  return lines
}

/** A validation issue as the artifact validators format it: the projected
 * path and code, plus the message, which is read only for a `custom` code. */
export interface ArtifactValidationIssue extends ProjectableIssue {
  readonly message?: string
}

/**
 * The lines both artifact validators print for a schema failure: a fixed
 * context line, the published schema's path, up to {@link MAX_PROJECTED_ISSUE_LINES}
 * `path code` lines, then `… and N more`.
 *
 * A `custom` issue keeps its message. Those messages are the closed,
 * author-written set in `REVIEW_ARTIFACT_CUSTOM_MESSAGES`
 * (`tests/unit/review-artifact-schema.test.ts` enforces it), never text
 * derived from the payload. Every other issue's message is dropped.
 */
export function formatReviewArtifactValidationFailure(
  issues: readonly ArtifactValidationIssue[],
): string[] {
  const projected = projectZodIssues(issues)
  const issueLines = formatProjectedIssueLines(projected)
  const shown = projected.issues.length
  for (const [index, issue] of issues.slice(0, shown).entries()) {
    if (issue.code === 'custom' && issue.message !== undefined) {
      issueLines[index] = `${issueLines[index]}: ${issue.message}`
    }
  }
  return [
    'Review artifact failed schema validation',
    `Schema: ${REVIEW_ARTIFACT_SCHEMA_RELATIVE_PATH}`,
    ...issueLines,
  ]
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
