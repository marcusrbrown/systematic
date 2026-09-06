import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
  formatReviewArtifactSuccessMessage,
  parseValidateReviewArtifactArguments,
  resolveReviewArtifactPath,
} from '../../src/lib/review-artifact-path.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CONFORMING_FIXTURE = path.join(
  ROOT_DIR,
  'tests/fixtures/review-artifacts/conforming-review-summary.json',
)

function makeDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('parseValidateReviewArtifactArguments', () => {
  it('accepts the flag before the path (the advertised ordering)', () => {
    const result = parseValidateReviewArtifactArguments([
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
      '/path/to/artifact.json',
    ])

    expect(result).toEqual({
      allowOutsideArtifactRoot: true,
      path: '/path/to/artifact.json',
    })
  })

  it('accepts the flag after the path', () => {
    const result = parseValidateReviewArtifactArguments([
      '/path/to/artifact.json',
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
    ])

    expect(result).toEqual({
      allowOutsideArtifactRoot: true,
      path: '/path/to/artifact.json',
    })
  })

  it('accepts the flag repeated more than once (idempotent)', () => {
    const result = parseValidateReviewArtifactArguments([
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
      '/path/to/artifact.json',
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
    ])

    expect(result).toEqual({
      allowOutsideArtifactRoot: true,
      path: '/path/to/artifact.json',
    })
  })

  it('parses a bare path with no flag', () => {
    const result = parseValidateReviewArtifactArguments([
      '/path/to/artifact.json',
    ])

    expect(result).toEqual({
      allowOutsideArtifactRoot: false,
      path: '/path/to/artifact.json',
    })
  })

  it('rejects an unknown flag alongside the recognized flag', () => {
    const result = parseValidateReviewArtifactArguments([
      '/path/to/artifact.json',
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
      '--unknown-flag',
    ])

    expect(result).toBeUndefined()
  })

  it('rejects an unknown flag with no recognized flag present', () => {
    const result = parseValidateReviewArtifactArguments([
      '/path/to/artifact.json',
      '--unknown-flag',
    ])

    expect(result).toBeUndefined()
  })

  it('rejects zero positional arguments', () => {
    expect(
      parseValidateReviewArtifactArguments([ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG]),
    ).toBeUndefined()
    expect(parseValidateReviewArtifactArguments([])).toBeUndefined()
  })

  it('rejects more than one positional argument', () => {
    const result = parseValidateReviewArtifactArguments([
      '/path/one.json',
      '/path/two.json',
      ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
    ])

    expect(result).toBeUndefined()
  })
})

describe('formatReviewArtifactSuccessMessage', () => {
  it('returns the plain success message when the flag is not set', () => {
    expect(formatReviewArtifactSuccessMessage(false)).toBe(
      'Review artifact is valid',
    )
  })

  it('marks the success message as external-mode when the flag is set', () => {
    const message = formatReviewArtifactSuccessMessage(true)
    expect(message).toContain('Review artifact is valid')
    expect(message).toContain('outside the run directory')
  })
})

describe('resolveReviewArtifactPath invariants shared by both entries', () => {
  it('still rejects symlinks with a resolved-path hint when the flag is set', () => {
    const cwd = makeDir('review-artifact-path-symlink-')
    const outsideDir = makeDir('review-artifact-path-outside-')
    try {
      const real = path.join(outsideDir, 'real.json')
      fs.copyFileSync(CONFORMING_FIXTURE, real)
      const link = path.join(outsideDir, 'link.json')
      fs.symlinkSync(real, link)

      const result = resolveReviewArtifactPath(link, cwd, {
        allowOutsideArtifactRoot: true,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toBe(
          'Review artifact path must not contain symlinks; pass a fully resolved path',
        )
        expect(result.message).not.toContain(link)
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still rejects lexical parent-directory traversal when the flag is set', () => {
    const cwd = makeDir('review-artifact-path-traversal-')
    try {
      const result = resolveReviewArtifactPath('../outside.json', cwd, {
        allowOutsideArtifactRoot: true,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain('parent-directory traversal')
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not echo the path for a missing target with the flag set', () => {
    const cwd = makeDir('review-artifact-path-missing-')
    const missing = path.join(cwd, 'does-not-exist.json')
    try {
      const result = resolveReviewArtifactPath(missing, cwd, {
        allowOutsideArtifactRoot: true,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toBe('Review artifact file was not found')
        expect(result.message).not.toContain(missing)
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a non-regular-file target with the flag set', () => {
    const cwd = makeDir('review-artifact-path-nonfile-')
    const directory = path.join(cwd, 'a-directory')
    try {
      fs.mkdirSync(directory)

      const result = resolveReviewArtifactPath(directory, cwd, {
        allowOutsideArtifactRoot: true,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toBe(
          'Review artifact target is not a regular file',
        )
        expect(result.message).not.toContain(directory)
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts a conforming artifact outside the root even when the root does not exist', () => {
    const cwd = makeDir('review-artifact-path-no-root-')
    const outsideDir = makeDir('review-artifact-path-outside-')
    try {
      const target = path.join(outsideDir, 'external.json')
      fs.copyFileSync(CONFORMING_FIXTURE, target)

      const result = resolveReviewArtifactPath(target, cwd, {
        allowOutsideArtifactRoot: true,
      })

      expect(result.ok).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
