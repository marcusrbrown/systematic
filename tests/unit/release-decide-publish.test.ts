import { describe, expect, test } from 'bun:test'
import {
  decidePublish,
  type MergedReleasePr,
  type PublishFacts,
  type Review,
} from '../../scripts/release/decide-publish.ts'

const X = 'c'.repeat(40)
const PARENT = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const REPO = 'marcusrbrown/systematic'

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 1,
    user: 'marcusrbrown',
    state: 'APPROVED',
    commitId: HEAD,
    submittedAt: '2026-10-12T10:00:00Z',
    ...overrides,
  }
}

function basePr(overrides: Partial<MergedReleasePr> = {}): MergedReleasePr {
  return {
    number: 42,
    headRef: 'release/pending',
    headRepo: REPO,
    baseRepo: REPO,
    author: 'systematic-release[bot]',
    headSha: HEAD,
    headParentSha: PARENT,
    mergedAt: '2026-10-12T11:00:00Z',
    mergeCommitSha: X,
    changedFiles: ['CHANGELOG.md'],
    removedEntryVersions: [],
    addedEntryVersion: '3.22.0',
    ...overrides,
  }
}

function baseFacts(overrides: Partial<PublishFacts> = {}): PublishFacts {
  return {
    pushedSha: X,
    mainTipSha: X,
    pushedParentSha: PARENT,
    pr: basePr(),
    reviews: [review()],
    existingTags: new Set(['v3.21.8', 'v3.21.7']),
    hold: false,
    repo: REPO,
    maintainerLogin: 'marcusrbrown',
    gateLogin: 'fro-bot',
    releaseAppLogin: 'systematic-release[bot]',
    gateAttestedReviewIds: new Set<number>(),
    releasePublished: false,
    ...overrides,
  }
}

function withPr(overrides: Partial<MergedReleasePr>): PublishFacts {
  return baseFacts({ pr: basePr(overrides) })
}

describe('decidePublish', () => {
  test('base facts publish', () => {
    expect(decidePublish(baseFacts())).toEqual({
      kind: 'publish',
      version: '3.22.0',
      reviewId: 1,
    })
  })

  describe('review semantics match GitHub review decisions', () => {
    test('a later COMMENTED review does not void an approval', () => {
      const reviews = [
        review(),
        review({
          id: 2,
          state: 'COMMENTED',
          submittedAt: '2026-10-12T10:30:00Z',
        }),
      ]
      expect(decidePublish(baseFacts({ reviews })).kind).toBe('publish')
    })

    test('a change request after the merge does not void the approval that governed it', () => {
      const reviews = [
        review(),
        review({
          id: 2,
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-10-12T12:00:00Z',
        }),
      ]
      expect(decidePublish(baseFacts({ reviews })).kind).toBe('publish')
    })

    test('a change request before the merge voids an earlier approval', () => {
      const reviews = [
        review(),
        review({
          id: 2,
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-10-12T10:30:00Z',
        }),
      ]
      expect(decidePublish(baseFacts({ reviews })).kind).toBe('refused')
    })
  })

  describe('rule 1: skip', () => {
    test('no merged PR skips', () => {
      expect(decidePublish(baseFacts({ pr: null })).kind).toBe('skip')
    })

    test('a PR from another branch skips', () => {
      expect(decidePublish(withPr({ headRef: 'feat/something' })).kind).toBe(
        'skip',
      )
    })
  })

  describe('rule 2: identity', () => {
    test.each([
      ['head repo is a fork', { headRepo: 'evil/systematic' }],
      ['base repo differs', { baseRepo: 'evil/systematic' }],
      ['author is not the release app', { author: 'someone-else' }],
      [
        'merge commit is not the pushed sha',
        { mergeCommitSha: 'd'.repeat(40) },
      ],
    ] as const)('%s refuses', (_name, overrides) => {
      const decision = decidePublish(withPr(overrides))
      expect(decision.kind).toBe('refused')
    })
  })

  describe('rules 3-4: shape', () => {
    test('head parent mismatch refuses', () => {
      const decision = decidePublish(withPr({ headParentSha: 'e'.repeat(40) }))
      expect(decision.kind).toBe('refused')
    })

    test('extra changed files refuse', () => {
      const decision = decidePublish(
        withPr({ changedFiles: ['CHANGELOG.md', 'src/x.ts'] }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('no changed files refuses', () => {
      expect(decidePublish(withPr({ changedFiles: [] })).kind).toBe('refused')
    })

    test('a different single file refuses', () => {
      expect(
        decidePublish(withPr({ changedFiles: ['package.json'] })).kind,
      ).toBe('refused')
    })
  })

  describe('rules 5-6: versions', () => {
    test('a null added version refuses', () => {
      expect(decidePublish(withPr({ addedEntryVersion: null })).kind).toBe(
        'refused',
      )
    })

    test('a tagged added version without a release is a partial publish and refuses', () => {
      const decision = decidePublish(
        baseFacts({
          existingTags: new Set(['v3.22.0', 'v3.21.8']),
          releasePublished: false,
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('a tagged added version with a published release skips (already published)', () => {
      const decision = decidePublish(
        baseFacts({
          existingTags: new Set(['v3.22.0', 'v3.21.8']),
          releasePublished: true,
        }),
      )
      expect(decision).toEqual({
        kind: 'skip',
        reason: 'v3.22.0 is already published.',
      })
    })

    test('a published release does not rescue an untagged version', () => {
      const decision = decidePublish(baseFacts({ releasePublished: true }))
      expect(decision.kind).toBe('publish')
    })

    test('removing an entry whose version is tagged refuses', () => {
      const decision = decidePublish(
        withPr({ removedEntryVersions: ['3.21.8'] }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('removing an untagged phantom entry publishes', () => {
      const decision = decidePublish(
        withPr({ removedEntryVersions: ['3.21.9'] }),
      )
      expect(decision.kind).toBe('publish')
    })
  })

  describe('rule 7: approval timing', () => {
    test('no reviews refuses', () => {
      const decision = decidePublish(baseFacts({ reviews: [] }))
      expect(decision.kind).toBe('refused')
    })

    test('an approval on an earlier head refuses', () => {
      const decision = decidePublish(
        baseFacts({ reviews: [review({ commitId: 'f'.repeat(40) })] }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('an approval submitted after the merge refuses', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [review({ submittedAt: '2026-10-12T11:00:01Z' })],
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('an approval submitted exactly at merge time counts', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [review({ submittedAt: '2026-10-12T11:00:00Z' })],
        }),
      )
      expect(decision.kind).toBe('publish')
    })

    test('an approval that was later dismissed refuses', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [
            review({ id: 1 }),
            review({
              id: 2,
              state: 'DISMISSED',
              submittedAt: '2026-10-12T10:30:00Z',
            }),
          ],
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('a later changes-requested review voids an earlier approval', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [
            review({ id: 1 }),
            review({
              id: 2,
              state: 'CHANGES_REQUESTED',
              submittedAt: '2026-10-12T10:30:00Z',
            }),
          ],
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('compares timestamps as dates, not strings', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [review({ submittedAt: '2026-10-12T12:00:00+02:00' })],
        }),
      )
      expect(decision.kind).toBe('publish')
    })
  })

  describe('rule 7: approver identity', () => {
    const gateReview = (overrides: Partial<Review> = {}) =>
      review({ id: 7, user: 'fro-bot', ...overrides })

    test('a gate approval without an attestation refuses', () => {
      const decision = decidePublish(baseFacts({ reviews: [gateReview()] }))
      expect(decision.kind).toBe('refused')
    })

    test('a gate approval with an attestation publishes', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [gateReview()],
          gateAttestedReviewIds: new Set([7]),
        }),
      )
      expect(decision).toEqual({
        kind: 'publish',
        version: '3.22.0',
        reviewId: 7,
      })
    })

    test('an attested gate approval while hold is true refuses', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [gateReview()],
          gateAttestedReviewIds: new Set([7]),
          hold: true,
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('a maintainer approval while hold is true publishes', () => {
      const decision = decidePublish(baseFacts({ hold: true }))
      expect(decision.kind).toBe('publish')
    })

    test('an approval from a random user refuses', () => {
      const decision = decidePublish(
        baseFacts({ reviews: [review({ user: 'random-user' })] }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('attestation of a different review id does not help', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [gateReview()],
          gateAttestedReviewIds: new Set([99]),
        }),
      )
      expect(decision.kind).toBe('refused')
    })

    test('prefers the maintainer approval when both are present', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [
            gateReview({ id: 7, submittedAt: '2026-10-12T09:00:00Z' }),
            review({ id: 3, submittedAt: '2026-10-12T10:00:00Z' }),
          ],
          gateAttestedReviewIds: new Set([7]),
        }),
      )
      expect(decision).toEqual({
        kind: 'publish',
        version: '3.22.0',
        reviewId: 3,
      })
    })

    test('a valid gate approval is used when the maintainer approval is voided', () => {
      const decision = decidePublish(
        baseFacts({
          reviews: [
            review({ id: 1, submittedAt: '2026-10-12T09:00:00Z' }),
            review({
              id: 2,
              state: 'DISMISSED',
              submittedAt: '2026-10-12T09:30:00Z',
            }),
            gateReview({ id: 7, submittedAt: '2026-10-12T10:00:00Z' }),
          ],
          gateAttestedReviewIds: new Set([7]),
        }),
      )
      expect(decision).toEqual({
        kind: 'publish',
        version: '3.22.0',
        reviewId: 7,
      })
    })
  })

  describe('rule 8: superseded', () => {
    test('main moved past a valid merge is superseded', () => {
      const decision = decidePublish(baseFacts({ mainTipSha: 'd'.repeat(40) }))
      expect(decision.kind).toBe('superseded')
    })

    test('main moved with an invalid merge is refused, not superseded', () => {
      const decision = decidePublish(
        baseFacts({ mainTipSha: 'd'.repeat(40), reviews: [] }),
      )
      expect(decision.kind).toBe('refused')
    })
  })

  test('every non-publish decision carries a non-empty reason', () => {
    const cases: PublishFacts[] = [
      baseFacts({ pr: null }),
      withPr({ headRepo: 'evil/x' }),
      withPr({ headParentSha: 'e'.repeat(40) }),
      withPr({ changedFiles: ['a'] }),
      withPr({ addedEntryVersion: null }),
      withPr({ removedEntryVersions: ['3.21.8'] }),
      baseFacts({ reviews: [] }),
      baseFacts({ mainTipSha: 'd'.repeat(40) }),
    ]
    for (const facts of cases) {
      const decision = decidePublish(facts)
      expect(decision.kind).not.toBe('publish')
      if (decision.kind !== 'publish') {
        expect(decision.reason.length).toBeGreaterThan(0)
      }
    }
  })
})
