import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG,
  formatProjectedIssueLines,
  formatReviewArtifactSuccessMessage,
  formatReviewArtifactValidationFailure,
  MAX_PROJECTED_ISSUE_LINES,
  parseValidateReviewArtifactArguments,
  projectZodIssues,
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

describe('projectZodIssues', () => {
  const issueAt = (index: number) => ({
    path: ['items', index, 'name'] as PropertyKey[],
    code: 'too_big',
  })

  it('bounds the projection at the default and reports the full total', () => {
    const issues = Array.from({ length: 20 }, (_, index) => issueAt(index))

    const projected = projectZodIssues(issues)

    expect(MAX_PROJECTED_ISSUE_LINES).toBe(8)
    expect(projected.issues).toHaveLength(MAX_PROJECTED_ISSUE_LINES)
    expect(projected.total).toBe(20)
    expect(projected.issues[0]).toEqual({
      path: 'items.0.name',
      code: 'too_big',
    })
  })

  it('honors an explicit bound', () => {
    const issues = Array.from({ length: 5 }, (_, index) => issueAt(index))

    const projected = projectZodIssues(issues, 2)

    expect(projected.issues).toHaveLength(2)
    expect(projected.total).toBe(5)
  })

  it('keeps every issue when there are fewer than the bound', () => {
    const projected = projectZodIssues([issueAt(0), issueAt(1)])

    expect(projected.issues).toHaveLength(2)
    expect(projected.total).toBe(2)
  })

  it('projects an empty list as an empty list with a zero total', () => {
    expect(projectZodIssues([])).toEqual({ issues: [], total: 0 })
  })

  it('formats a root path as $', () => {
    expect(
      projectZodIssues([{ path: [], code: 'invalid_type' }]).issues,
    ).toEqual([{ path: '$', code: 'invalid_type' }])
  })

  it('projects only the path and the code of a real Zod issue', () => {
    const schema = z
      .object({
        name: z.string().max(4),
        tags: z.array(z.string()).max(1),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.name === 'abc') {
          ctx.addIssue({
            code: 'custom',
            path: ['name'],
            message: 'MESSAGE_CANARY authored text',
          })
        }
      })
    const result = schema.safeParse({
      name: 'VALUE_CANARY_too_long',
      tags: ['a', 'b'],
      KEY_CANARY: 'x',
    })
    expect(result.success).toBe(false)
    if (result.success) return

    const projected = projectZodIssues(result.error.issues)
    const serialized = JSON.stringify(projected)

    expect(projected.total).toBe(result.error.issues.length)
    for (const issue of projected.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path'])
    }
    expect(serialized).not.toContain('VALUE_CANARY')
    expect(serialized).not.toContain('KEY_CANARY')
  })

  it('never copies an issue message into the projection', () => {
    const projected = projectZodIssues([
      { path: ['name'], code: 'custom', message: 'MESSAGE_CANARY' } as {
        path: PropertyKey[]
        code: string
      },
    ])

    expect(JSON.stringify(projected)).not.toContain('MESSAGE_CANARY')
  })
})

describe('formatProjectedIssueLines', () => {
  it('prints one path-and-code line per issue and no overflow line when all fit', () => {
    expect(
      formatProjectedIssueLines({
        issues: [
          { path: 'a', code: 'too_big' },
          { path: 'b.0', code: 'invalid_type' },
        ],
        total: 2,
      }),
    ).toEqual(['a too_big', 'b.0 invalid_type'])
  })

  it('adds an overflow line counting the issues that were not printed', () => {
    const issues = Array.from({ length: 8 }, (_, index) => ({
      path: `f${index}`,
      code: 'too_big',
    }))

    const lines = formatProjectedIssueLines({ issues, total: 11 })

    expect(lines).toHaveLength(9)
    expect(lines[8]).toBe('… and 3 more')
  })
})

describe('formatReviewArtifactValidationFailure', () => {
  const SCHEMA = 'skills/ce-review/references/review-summary-schema.json'
  const issue = (index: number) => ({
    path: ['items', index] as PropertyKey[],
    code: 'too_big',
    message: 'MESSAGE_CANARY',
  })

  it('prints the context line, the schema line, then the issue lines', () => {
    expect(formatReviewArtifactValidationFailure([issue(0)], SCHEMA)).toEqual([
      'Review artifact failed schema validation',
      `Schema: ${SCHEMA}`,
      'items.0 too_big',
    ])
  })

  it('prints at most eight issues and counts the rest', () => {
    const issues = Array.from({ length: 12 }, (_, index) => issue(index))

    const lines = formatReviewArtifactValidationFailure(issues, SCHEMA)

    expect(lines).toHaveLength(2 + MAX_PROJECTED_ISSUE_LINES + 1)
    expect(lines.at(-1)).toBe('… and 4 more')
  })

  it('keeps an authored message only for a custom issue, and never prints another issue message', () => {
    const lines = formatReviewArtifactValidationFailure(
      [
        { path: ['a'], code: 'custom', message: 'severity count must match' },
        { path: ['b'], code: 'too_big', message: 'MESSAGE_CANARY' },
      ],
      SCHEMA,
    )

    expect(lines).toContain('a custom: severity count must match')
    expect(lines).toContain('b too_big')
    expect(lines.join('\n')).not.toContain('MESSAGE_CANARY')
  })
})
