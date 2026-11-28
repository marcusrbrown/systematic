/**
 * Pure-function tests for `readParityFailures` in the reviewer tools proof
 * helper. No host runs here: each case builds the two `ReviewerOfferRun`
 * records by hand. A read counts only when the planted marker came back or the
 * outcome is a recognized permission outcome, so two runs that return the same
 * unrelated error do not agree on anything.
 */
import { describe, expect, test } from 'bun:test'
import {
  ENV_FILE_MARKER,
  EXTERNAL_NOTE_MARKER,
  type ReviewerOfferRun,
  readParityFailures,
} from '../helpers/reviewer-tools-proof.js'

const AUTO_REJECT_LINE =
  'permission requested: external_directory (/tmp/notes/*); auto-rejecting'

function run(overrides: Partial<ReviewerOfferRun>): ReviewerOfferRun {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    requestCount: 4,
    parentOffered: ['read', 'subagent'],
    childOffered: ['read'],
    childRequestCount: 1,
    childIsAgent: true,
    childCallResult: undefined,
    ...overrides,
  }
}

const returned = (marker: string) =>
  run({ childCallResult: `1: ${marker}\n2: more` })
const autoRejected = () => run({ stderr: AUTO_REJECT_LINE })
const permissionDenied = () =>
  run({ childCallResult: 'Permission denied: external_directory' })
const unrelatedError = () =>
  run({ childCallResult: 'Invalid arguments: filePath must be a string' })

describe('readParityFailures', () => {
  test('both runs returned the marker: no failure', () => {
    expect(
      readParityFailures(
        returned(EXTERNAL_NOTE_MARKER),
        returned(EXTERNAL_NOTE_MARKER),
        EXTERNAL_NOTE_MARKER,
      ),
    ).toEqual([])
    expect(
      readParityFailures(
        returned(ENV_FILE_MARKER),
        returned(ENV_FILE_MARKER),
        ENV_FILE_MARKER,
      ),
    ).toEqual([])
  })

  test('both runs hit the host auto-reject: no failure', () => {
    expect(
      readParityFailures(autoRejected(), autoRejected(), EXTERNAL_NOTE_MARKER),
    ).toEqual([])
  })

  test('both runs got the permission-denied error: no failure', () => {
    expect(
      readParityFailures(
        permissionDenied(),
        permissionDenied(),
        EXTERNAL_NOTE_MARKER,
      ),
    ).toEqual([])
  })

  test('one run returned the marker and the other was rejected: a failure naming both', () => {
    const failures = readParityFailures(
      returned(EXTERNAL_NOTE_MARKER),
      permissionDenied(),
      EXTERNAL_NOTE_MARKER,
    )

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('reviewer')
    expect(failures[0]).toContain('control')
  })

  test('two identical non-permission errors: a failure naming each run and its outcome', () => {
    const failures = readParityFailures(
      unrelatedError(),
      unrelatedError(),
      EXTERNAL_NOTE_MARKER,
    )

    expect(failures.length).toBeGreaterThan(0)
    expect(failures.join('\n')).toContain('reviewer')
    expect(failures.join('\n')).toContain('control')
    expect(failures.join('\n')).toContain('Invalid arguments')
  })

  test('a reviewer with an unrelated error beside a control that returned the marker: a failure', () => {
    const failures = readParityFailures(
      unrelatedError(),
      returned(EXTERNAL_NOTE_MARKER),
      EXTERNAL_NOTE_MARKER,
    )

    expect(failures.length).toBeGreaterThan(0)
  })

  test('a control that shows nothing at all: a failure', () => {
    const failures = readParityFailures(
      returned(EXTERNAL_NOTE_MARKER),
      run({}),
      EXTERNAL_NOTE_MARKER,
    )

    expect(failures.length).toBeGreaterThan(0)
  })

  test('a run that is not a dispatched agent: the run failure comes back unchanged', () => {
    const failures = readParityFailures(
      run({ childIsAgent: false }),
      returned(EXTERNAL_NOTE_MARKER),
      EXTERNAL_NOTE_MARKER,
    )

    expect(failures).toEqual([
      'a child request did not carry the dispatched agent marker',
    ])
  })
})
