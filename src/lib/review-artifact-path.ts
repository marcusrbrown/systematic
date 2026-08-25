import fs from 'node:fs'
import path from 'node:path'

export type ArtifactPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string }

export function hasParentDirectoryTraversal(input: string): boolean {
  return input.split(/[\\/]+/).some((segment) => segment === '..')
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

export function resolveReviewArtifactPath(
  input: string,
  cwd: string,
): ArtifactPathResult {
  if (hasParentDirectoryTraversal(input)) {
    return {
      message:
        'Review artifact path must not contain parent-directory traversal',
      ok: false,
    }
  }

  const artifactRoot = path.resolve(cwd, '.context', 'systematic', 'ce-review')
  let canonicalRoot: string
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

  const candidate = path.resolve(cwd, input)
  if (pathContainsSymlink(candidate)) {
    return {
      message: 'Review artifact path must not contain symlinks',
      ok: false,
    }
  }

  let canonicalTarget: string
  try {
    canonicalTarget = fs.realpathSync(candidate)
  } catch {
    return { message: 'Review artifact file was not found', ok: false }
  }

  if (!isWithinDirectory(canonicalTarget, canonicalRoot)) {
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
