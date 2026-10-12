import { describe, expect, test } from 'bun:test'
import {
  CHANGELOG_HEADER,
  CHANGELOG_SENTINEL,
} from '../../scripts/release/changelog.ts'
import { decidePublish } from '../../scripts/release/decide-publish.ts'
import {
  type Api,
  gatherPublishFacts,
  githubApi,
} from '../../scripts/release/gather-publish-facts.ts'

const REPO = 'marcusrbrown/systematic'
const X = 'c'.repeat(40)
const PARENT = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const HEAD_PARENT = PARENT
const PR_NUMBER = 42

function notFound(path: string): Error {
  return Object.assign(new Error(`GET ${path} failed: 404`), { status: 404 })
}

function entry(version: string): string {
  return `## [${version}](https://example.com/compare/v0...v${version}) (2026-10-12)\n\n### Features\n\n- ship ${version}`
}

function changelog(...versions: string[]): string {
  return `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${versions.map(entry).join('\n\n')}\n`
}

function b64(text: string): { content: string; encoding: 'base64' } {
  // GitHub wraps base64 content at 60 columns with newlines.
  const raw = Buffer.from(text, 'utf8').toString('base64')
  return { content: raw.replace(/(.{60})/g, '$1\n'), encoding: 'base64' }
}

/** Pages of 100, ending with a short (possibly empty) page. */
function reviewPages(reviews: unknown[]): unknown[][] {
  const pages: unknown[][] = []
  for (let i = 0; i < reviews.length; i += 100) {
    pages.push(reviews.slice(i, i + 100))
  }
  if (reviews.length % 100 === 0) pages.push([])
  return pages
}

interface FakeOptions {
  prList?: unknown[]
  parentChangelog?: string | null
  headChangelog?: string
  reviews?: unknown[]
  tags?: string[]
  files?: string[]
  release?: boolean
  reviewPages?: unknown[][]
  headRef?: string
  headRepo?: string
}

function fake(options: FakeOptions = {}) {
  const calls: string[] = []
  const responses = new Map<string, unknown>()
  const set = (path: string, value: unknown) => responses.set(path, value)

  set(`repos/${REPO}/commits/${X}`, { parents: [{ sha: PARENT }] })
  set(`repos/${REPO}/git/ref/heads/main`, { object: { sha: X } })
  set(
    `repos/${REPO}/commits/${X}/pulls`,
    options.prList ?? [
      {
        number: PR_NUMBER,
        merged_at: '2026-10-12T11:00:00Z',
        merge_commit_sha: X,
      },
    ],
  )
  set(`repos/${REPO}/pulls/${PR_NUMBER}`, {
    head: {
      ref: options.headRef ?? 'release/pending',
      sha: HEAD,
      repo: { full_name: options.headRepo ?? REPO },
    },
    base: { repo: { full_name: REPO } },
    user: { login: 'systematic-release[bot]' },
    merged_at: '2026-10-12T11:00:00Z',
    merge_commit_sha: X,
  })
  set(`repos/${REPO}/commits/${HEAD}`, { parents: [{ sha: HEAD_PARENT }] })
  set(`repos/${REPO}/compare/${HEAD_PARENT}...${HEAD}`, {
    files: (options.files ?? ['CHANGELOG.md']).map((filename) => ({
      filename,
    })),
  })
  const parentChangelog =
    options.parentChangelog === undefined
      ? changelog('3.21.8')
      : options.parentChangelog
  if (parentChangelog !== null) {
    set(
      `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD_PARENT}`,
      b64(parentChangelog),
    )
  }
  set(
    `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`,
    b64(options.headChangelog ?? changelog('3.22.0', '3.21.8')),
  )
  const defaultReviews = [
    {
      id: 1,
      user: { login: 'marcusrbrown' },
      state: 'APPROVED',
      commit_id: HEAD,
      submitted_at: '2026-10-12T10:00:00Z',
    },
  ]
  const pages =
    options.reviewPages ?? reviewPages(options.reviews ?? defaultReviews)
  pages.forEach((page, index) => {
    set(
      `repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100&page=${index + 1}`,
      page,
    )
  })
  set(
    `repos/${REPO}/git/matching-refs/tags/v`,
    (options.tags ?? ['v3.21.8', 'v3.21.7']).map((name) => ({
      ref: `refs/tags/${name}`,
    })),
  )

  if (options.release === true) {
    set(`repos/${REPO}/releases/tags/v3.22.0`, { tag_name: 'v3.22.0' })
  }

  const api: Api = async (path) => {
    calls.push(path)
    if (!responses.has(path)) throw notFound(path)
    return responses.get(path)
  }
  return { api, calls, set }
}

const noAttestation = async () => false

function baseOptions(api: Api) {
  return {
    api,
    repo: REPO,
    sha: X,
    maintainerLogin: 'marcusrbrown',
    gateLogin: 'fro-bot',
    releaseAppLogin: 'systematic-release[bot]',
    hold: false,
    verifyGateAttestation: noAttestation,
  }
}

describe('gatherPublishFacts', () => {
  test('happy path produces facts that publish', async () => {
    const { api } = fake()
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pushedSha).toBe(X)
    expect(facts.mainTipSha).toBe(X)
    expect(facts.pushedParentSha).toBe(PARENT)
    expect(facts.pr).toEqual({
      number: PR_NUMBER,
      headRef: 'release/pending',
      headRepo: REPO,
      baseRepo: REPO,
      author: 'systematic-release[bot]',
      headSha: HEAD,
      headParentSha: HEAD_PARENT,
      mergedAt: '2026-10-12T11:00:00Z',
      mergeCommitSha: X,
      changedFiles: ['CHANGELOG.md'],
      removedEntryVersions: [],
      addedEntryVersion: '3.22.0',
    })
    expect(facts.reviews).toEqual([
      {
        id: 1,
        user: 'marcusrbrown',
        state: 'APPROVED',
        commitId: HEAD,
        submittedAt: '2026-10-12T10:00:00Z',
      },
    ])
    expect(facts.existingTags).toEqual(new Set(['v3.21.8', 'v3.21.7']))
    expect(decidePublish(facts)).toEqual({
      kind: 'publish',
      version: '3.22.0',
      reviewId: 1,
      approver: 'maintainer',
    })
  })

  describe('regenerated entries (superseded same-version replacement)', () => {
    const original = changelog('3.22.0', '3.21.8')
    const regenerated = original.replace(
      'ship 3.22.0',
      'ship 3.22.0, regenerated',
    )

    test('an untagged entry with new text replaces the old one and publishes', async () => {
      const { api } = fake({
        parentChangelog: original,
        headChangelog: regenerated,
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
      expect(facts.pr?.removedEntryVersions).toEqual([])
      expect(decidePublish(facts)).toMatchObject({
        kind: 'publish',
        version: '3.22.0',
      })
    })

    test('an identical top entry adds nothing', async () => {
      const { api } = fake({
        parentChangelog: original,
        headChangelog: original,
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBeNull()
      expect(decidePublish(facts).kind).toBe('refused')
    })

    test("a tagged rewrite is still a candidate; eligibility is the decision's job", async () => {
      const { api } = fake({
        tags: ['v3.22.0', 'v3.21.8'],
        parentChangelog: original,
        headChangelog: regenerated,
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
    })

    test('replacement, then tag and release exist: reconcile on the same merge skips', async () => {
      const { api } = fake({
        tags: ['v3.22.0', 'v3.21.8'],
        release: true,
        parentChangelog: original,
        headChangelog: regenerated,
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.releasePublished).toBe(true)
      expect(decidePublish(facts)).toEqual({
        kind: 'skip',
        reason: 'v3.22.0 is already published.',
      })
    })

    test('replacement, then tag without a release: partial publish is refused', async () => {
      const { api } = fake({
        tags: ['v3.22.0', 'v3.21.8'],
        parentChangelog: original,
        headChangelog: regenerated,
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.releasePublished).toBe(false)
      expect(decidePublish(facts).kind).toBe('refused')
    })

    test('a tagged rewrite with no release never publishes', async () => {
      for (const release of [true, false]) {
        const { api } = fake({
          tags: ['v3.22.0', 'v3.21.8'],
          release,
          parentChangelog: original,
          headChangelog: regenerated,
        })
        const facts = await gatherPublishFacts(baseOptions(api))
        expect(decidePublish(facts).kind).not.toBe('publish')
      }
    })

    test('a tagged entry still counts as removed when the head drops it', async () => {
      const { api } = fake({
        tags: ['v3.21.8'],
        parentChangelog: changelog('3.21.8'),
        headChangelog: changelog('3.22.0'),
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.pr?.removedEntryVersions).toEqual(['3.21.8'])
      expect(decidePublish(facts).kind).toBe('refused')
    })
  })

  describe('review pagination', () => {
    const filler = (count: number, firstId: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: firstId + i,
        user: { login: 'bystander' },
        state: 'COMMENTED',
        commit_id: HEAD,
        submitted_at: '2026-10-12T09:00:00Z',
      }))
    const approval = {
      id: 5000,
      user: { login: 'marcusrbrown' },
      state: 'APPROVED',
      commit_id: HEAD,
      submitted_at: '2026-10-12T10:00:00Z',
    }

    test('an approval on page 2 counts', async () => {
      const { api, calls } = fake({ reviews: [...filler(100, 1), approval] })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(facts.reviews).toHaveLength(101)
      expect(decidePublish(facts)).toMatchObject({
        kind: 'publish',
        reviewId: 5000,
      })
      expect(calls.filter((c) => c.includes('/reviews?'))).toEqual([
        `repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100&page=1`,
        `repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100&page=2`,
      ])
    })

    test('a changes-requested review on page 2 voids an earlier approval', async () => {
      const voiding = {
        id: 5001,
        user: { login: 'marcusrbrown' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        submitted_at: '2026-10-12T10:30:00Z',
      }
      const { api } = fake({
        reviews: [approval, ...filler(99, 1), voiding],
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(decidePublish(facts).kind).toBe('refused')
    })

    test('a dismissal on page 2 voids an earlier approval', async () => {
      const dismissal = {
        id: 5001,
        user: { login: 'marcusrbrown' },
        state: 'DISMISSED',
        commit_id: HEAD,
        submitted_at: '2026-10-12T10:30:00Z',
      }
      const { api } = fake({
        reviews: [approval, ...filler(99, 1), dismissal],
      })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(decidePublish(facts).kind).toBe('refused')
    })

    test('a page-two API failure after a page-one approval rejects, not a partial list', async () => {
      const { api } = fake({ reviews: [approval, ...filler(100, 1)] })
      const failing: Api = async (path) => {
        if (path.endsWith('reviews?per_page=100&page=2')) {
          throw Object.assign(new Error('boom'), { status: 500 })
        }
        return api(path)
      }
      await expect(gatherPublishFacts(baseOptions(failing))).rejects.toThrow(
        'boom',
      )
    })

    test('stops after a short page without requesting more', async () => {
      const { api, calls } = fake({ reviews: [approval] })
      await gatherPublishFacts(baseOptions(api))
      expect(calls.filter((c) => c.includes('/reviews?'))).toHaveLength(1)
    })

    test('past the 20 page cap it throws instead of deciding on partial history', async () => {
      const fullPages = Array.from({ length: 21 }, (_, page) =>
        filler(100, page * 100 + 1),
      )
      const { api } = fake({ reviewPages: fullPages })
      await expect(gatherPublishFacts(baseOptions(api))).rejects.toThrow(
        /reviews/,
      )
    })
  })

  describe('non-release merges', () => {
    const changelogCalls = (calls: string[]) =>
      calls.filter((c) => c.includes('CHANGELOG.md') || c.includes('/compare/'))

    test('an ordinary merged PR skips without any changelog endpoint, even with no CHANGELOG.md', async () => {
      const { api, calls } = fake({ headRef: 'feat/ordinary' })
      const noChangelog: Api = async (path) => {
        if (path.includes('CHANGELOG.md')) throw notFound(path)
        return api(path)
      }
      const facts = await gatherPublishFacts(baseOptions(noChangelog))
      expect(decidePublish(facts).kind).toBe('skip')
      expect(changelogCalls(calls)).toEqual([])
      expect(calls.some((c) => c.includes('/reviews?'))).toBe(false)
    })

    test('a release/pending PR from another repo is refused without changelog fetches', async () => {
      const { api, calls } = fake({ headRepo: 'mallory/systematic' })
      const facts = await gatherPublishFacts(baseOptions(api))
      expect(decidePublish(facts).kind).toBe('refused')
      expect(changelogCalls(calls)).toEqual([])
    })
  })

  test('releasePublished is true when the release for the added version exists', async () => {
    const { api } = fake({ release: true })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.releasePublished).toBe(true)
  })

  test('releasePublished is false when the release lookup returns 404', async () => {
    const { api, calls } = fake()
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.releasePublished).toBe(false)
    expect(calls).toContain(`repos/${REPO}/releases/tags/v3.22.0`)
  })

  test('releasePublished is false, with no lookup, when no version was added', async () => {
    const { api, calls } = fake({ headChangelog: changelog('3.21.8') })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.addedEntryVersion).toBeNull()
    expect(facts.releasePublished).toBe(false)
    expect(calls.some((c) => c.includes('/releases/'))).toBe(false)
  })

  test('a 500 from the release lookup propagates', async () => {
    const { api } = fake({ release: true })
    const failingApi: Api = async (path) => {
      if (path === `repos/${REPO}/releases/tags/v3.22.0`) {
        throw Object.assign(new Error('boom'), { status: 500 })
      }
      return api(path)
    }
    await expect(gatherPublishFacts(baseOptions(failingApi))).rejects.toThrow(
      'boom',
    )
  })

  test('no merged PR yields pr: null and never calls PR endpoints', async () => {
    const { api, calls } = fake({ prList: [] })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr).toBeNull()
    expect(facts.reviews).toEqual([])
    expect(facts.gateAttestedReviewIds.size).toBe(0)
    expect(calls.some((c) => c.includes('/pulls/'))).toBe(false)
    expect(calls.some((c) => c.includes('/compare/'))).toBe(false)
    expect(calls.some((c) => c.includes('/contents/'))).toBe(false)
    expect(decidePublish(facts).kind).toBe('skip')
  })

  test('unmerged PRs and PRs with another merge commit are ignored', async () => {
    const { api, calls } = fake({
      prList: [
        { number: 7, merged_at: null, merge_commit_sha: X },
        {
          number: 8,
          merged_at: '2026-10-12T11:00:00Z',
          merge_commit_sha: 'd'.repeat(40),
        },
      ],
    })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr).toBeNull()
    expect(calls.some((c) => c.includes('/pulls/'))).toBe(false)
  })

  test('picks the matching PR out of several', async () => {
    const { api } = fake({
      prList: [
        { number: 7, merged_at: null, merge_commit_sha: X },
        {
          number: PR_NUMBER,
          merged_at: '2026-10-12T11:00:00Z',
          merge_commit_sha: X,
        },
      ],
    })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.number).toBe(PR_NUMBER)
  })

  test('a CHANGELOG 404 at the parent means the file is new', async () => {
    const { api } = fake({
      parentChangelog: null,
      headChangelog: changelog('3.22.0'),
    })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
    expect(facts.pr?.removedEntryVersions).toEqual([])
  })

  test('a head that removes a phantom entry lists it as removed', async () => {
    const { api } = fake({
      parentChangelog: changelog('3.21.9', '3.21.8'),
      headChangelog: changelog('3.22.0', '3.21.8'),
    })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
    expect(facts.pr?.removedEntryVersions).toEqual(['3.21.9'])
  })

  test('addedEntryVersion is null when the head adds nothing', async () => {
    const { api } = fake({
      parentChangelog: changelog('3.21.8'),
      headChangelog: changelog('3.21.8'),
    })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.addedEntryVersion).toBeNull()
  })

  test('reports every changed file from the compare', async () => {
    const { api } = fake({ files: ['CHANGELOG.md', 'src/x.ts'] })
    const facts = await gatherPublishFacts(baseOptions(api))
    expect(facts.pr?.changedFiles).toEqual(['CHANGELOG.md', 'src/x.ts'])
  })

  test('only APPROVED gate reviews on the head go to attestation', async () => {
    const review = (
      id: number,
      user: string,
      state: string,
      commit: string,
    ) => ({
      id,
      user: { login: user },
      state,
      commit_id: commit,
      submitted_at: '2026-10-12T10:00:00Z',
    })
    const { api } = fake({
      reviews: [
        review(10, 'fro-bot', 'APPROVED', HEAD),
        review(11, 'fro-bot', 'APPROVED', HEAD),
        review(12, 'fro-bot', 'APPROVED', 'f'.repeat(40)),
        review(13, 'fro-bot', 'COMMENTED', HEAD),
        review(14, 'marcusrbrown', 'APPROVED', HEAD),
        review(15, 'random', 'APPROVED', HEAD),
      ],
    })
    const seen: Array<{ pr: number; headSha: string; reviewId: number }> = []
    const facts = await gatherPublishFacts({
      ...baseOptions(api),
      verifyGateAttestation: async (input) => {
        seen.push(input)
        return input.reviewId === 11
      },
    })
    expect(seen).toEqual([
      { pr: PR_NUMBER, headSha: HEAD, reviewId: 10 },
      { pr: PR_NUMBER, headSha: HEAD, reviewId: 11 },
    ])
    expect(facts.gateAttestedReviewIds).toEqual(new Set([11]))
  })

  test.each([
    ['commit lookup', `repos/${REPO}/commits/${X}`],
    ['main ref', `repos/${REPO}/git/ref/heads/main`],
    ['PR list', `repos/${REPO}/commits/${X}/pulls`],
    ['PR fields', `repos/${REPO}/pulls/${PR_NUMBER}`],
    ['head commit', `repos/${REPO}/commits/${HEAD}`],
    ['compare', `repos/${REPO}/compare/${HEAD_PARENT}...${HEAD}`],
    ['head changelog', `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`],
    [
      'parent changelog (non-404)',
      `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD_PARENT}`,
    ],
    ['reviews', `repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100&page=1`],
    ['tags', `repos/${REPO}/git/matching-refs/tags/v`],
  ])('a 500 from %s propagates', async (_name, failing) => {
    const { api } = fake()
    const failingApi: Api = async (path) => {
      if (path === failing) {
        throw Object.assign(new Error('boom'), { status: 500 })
      }
      return api(path)
    }
    await expect(gatherPublishFacts(baseOptions(failingApi))).rejects.toThrow(
      'boom',
    )
  })

  test('a 404 outside the parent CHANGELOG propagates', async () => {
    const { api } = fake()
    const failingApi: Api = async (path) => {
      if (path === `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`) {
        throw notFound(path)
      }
      return api(path)
    }
    await expect(
      gatherPublishFacts(baseOptions(failingApi)),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('githubApi', () => {
  function stubFetch(response: Response) {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return response
    }) as unknown as typeof fetch
    return { impl, seen }
  }

  test('sends auth + accept headers and a timeout signal, returns parsed JSON', async () => {
    const { impl, seen } = stubFetch(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const result = await githubApi('tok', impl)(`repos/${REPO}/commits/${X}`)
    expect(result).toEqual({ ok: true })
    expect(seen[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/commits/${X}`,
    )
    const headers = new Headers(seen[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer tok')
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('throws an error carrying status on a 404', async () => {
    const { impl } = stubFetch(new Response('nope', { status: 404 }))
    const rejection = expect(githubApi('tok', impl)('repos/x/y')).rejects
    await rejection.toBeInstanceOf(Error)
    await rejection.toMatchObject({ status: 404 })
  })

  test('throws an error carrying status on a 500', async () => {
    const { impl } = stubFetch(new Response('bad', { status: 500 }))
    await expect(githubApi('tok', impl)('repos/x/y')).rejects.toMatchObject({
      status: 500,
    })
  })
})
