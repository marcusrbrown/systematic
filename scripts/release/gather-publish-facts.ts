import { parseEntries } from './changelog.js'
import type { MergedReleasePr, PublishFacts, Review } from './decide-publish.js'

/** GET `https://api.github.com/<path>` as parsed JSON; throws on non-2xx. */
export type Api = (path: string) => Promise<unknown>

export interface GatherPublishFactsOptions {
  api: Api
  repo: string
  sha: string
  maintainerLogin: string
  gateLogin: string
  releaseAppLogin: string
  hold: boolean
  verifyGateAttestation: (input: {
    pr: number
    headSha: string
    reviewId: number
  }) => Promise<boolean>
}

const API_ORIGIN = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000
const REVIEW_STATES = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
] as const satisfies readonly Review['state'][]

function isReviewState(value: string): value is Review['state'] {
  return REVIEW_STATES.some((state) => state === value)
}

export function githubApi(token: string, fetchImpl: typeof fetch = fetch): Api {
  return async (path) => {
    const response = await fetchImpl(`${API_ORIGIN}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `GET ${path} failed: ${response.status} ${response.statusText}`,
        ),
        { status: response.status },
      )
    }
    return response.json()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Walk `keys` through nested records; undefined when any step is missing or null. */
export function dig(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Unexpected GitHub API response: missing ${what}`)
  }
  return value
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Unexpected GitHub API response: missing ${what}`)
  }
  return value
}

export function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected GitHub API response: ${what} is not a list`)
  }
  return value
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.status === 404
}

export async function parentShaOf(
  api: Api,
  repo: string,
  sha: string,
): Promise<string> {
  const commit = await api(`repos/${repo}/commits/${sha}`)
  const parents = requireArray(dig(commit, 'parents'), `parents of ${sha}`)
  return requireString(dig(parents[0], 'sha'), `first parent of ${sha}`)
}

/**
 * Read CHANGELOG.md at `ref` through the contents API. With `missingIsEmpty`,
 * a 404 yields an empty string (a file that does not exist yet); otherwise a
 * missing file throws.
 */
export async function readChangelog(
  api: Api,
  repo: string,
  ref: string,
  options: { missingIsEmpty: boolean },
): Promise<string> {
  let file: unknown
  try {
    file = await api(`repos/${repo}/contents/CHANGELOG.md?ref=${ref}`)
  } catch (error) {
    if (options.missingIsEmpty && isNotFound(error)) return ''
    throw error
  }
  const content = requireString(
    dig(file, 'content'),
    `CHANGELOG.md content at ${ref}`,
  )
  return Buffer.from(content.replaceAll('\n', ''), 'base64').toString('utf8')
}

/**
 * Compare CHANGELOG.md entry versions between a commit and its parent.
 * A 404 at the parent means the file is new (empty changelog).
 */
export async function changelogVersionDelta(
  api: Api,
  repo: string,
  parentSha: string,
  headSha: string,
): Promise<{
  addedEntryVersion: string | null
  removedEntryVersions: string[]
}> {
  const [parentChangelog, headChangelog] = await Promise.all([
    readChangelog(api, repo, parentSha, { missingIsEmpty: true }),
    readChangelog(api, repo, headSha, { missingIsEmpty: false }),
  ])
  const parentVersions = parseEntries(parentChangelog).map(
    (entry) => entry.version,
  )
  const headVersions = parseEntries(headChangelog).map((entry) => entry.version)
  const parentSet = new Set(parentVersions)
  const headSet = new Set(headVersions)
  return {
    removedEntryVersions: parentVersions.filter(
      (version) => !headSet.has(version),
    ),
    addedEntryVersion:
      headVersions.find((version) => !parentSet.has(version)) ?? null,
  }
}

function toReview(raw: unknown): Review {
  const state = dig(raw, 'state')
  if (typeof state !== 'string' || !isReviewState(state)) {
    throw new Error(
      `Unexpected GitHub API response: unknown review state ${String(state)}`,
    )
  }
  const user = dig(raw, 'user', 'login')
  const submittedAt = dig(raw, 'submitted_at')
  return {
    id: requireNumber(dig(raw, 'id'), 'review id'),
    // Deleted accounts and pending reviews can lack these; empty never matches a login.
    user: typeof user === 'string' ? user : '',
    state,
    commitId:
      typeof dig(raw, 'commit_id') === 'string'
        ? (dig(raw, 'commit_id') as string)
        : '',
    submittedAt: typeof submittedAt === 'string' ? submittedAt : '',
  }
}

/** True when a GitHub release exists for `version`; only a 404 means false. */
async function releaseExists(
  api: Api,
  repo: string,
  version: string | null,
): Promise<boolean> {
  if (version === null) return false
  try {
    await api(`repos/${repo}/releases/tags/v${version}`)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function gatherPr(
  options: GatherPublishFactsOptions,
  number: number,
): Promise<{ pr: MergedReleasePr; reviews: Review[] }> {
  const { api, repo } = options
  const raw = await api(`repos/${repo}/pulls/${number}`)
  const headSha = requireString(
    dig(raw, 'head', 'sha'),
    `head sha of PR ${number}`,
  )
  const headParentSha = await parentShaOf(api, repo, headSha)

  const [compare, delta, rawReviews] = await Promise.all([
    api(`repos/${repo}/compare/${headParentSha}...${headSha}`),
    changelogVersionDelta(api, repo, headParentSha, headSha),
    api(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
  ])

  const changedFiles = requireArray(dig(compare, 'files'), 'compare files').map(
    (file) => requireString(dig(file, 'filename'), 'compare filename'),
  )

  const pr: MergedReleasePr = {
    number,
    headRef: requireString(dig(raw, 'head', 'ref'), `head ref of PR ${number}`),
    // A deleted fork has no head repo; empty never equals the repo, so it is refused.
    headRepo: String(dig(raw, 'head', 'repo', 'full_name') ?? ''),
    baseRepo: String(dig(raw, 'base', 'repo', 'full_name') ?? ''),
    author: String(dig(raw, 'user', 'login') ?? ''),
    headSha,
    headParentSha,
    mergedAt: requireString(dig(raw, 'merged_at'), `merged_at of PR ${number}`),
    mergeCommitSha: requireString(
      dig(raw, 'merge_commit_sha'),
      `merge commit of PR ${number}`,
    ),
    changedFiles,
    removedEntryVersions: delta.removedEntryVersions,
    addedEntryVersion: delta.addedEntryVersion,
  }
  return { pr, reviews: requireArray(rawReviews, 'reviews').map(toReview) }
}

export async function gatherPublishFacts(
  options: GatherPublishFactsOptions,
): Promise<PublishFacts> {
  const { api, repo, sha, gateLogin } = options

  const [pushedParentSha, mainRef, pulls, rawTags] = await Promise.all([
    parentShaOf(api, repo, sha),
    api(`repos/${repo}/git/ref/heads/main`),
    api(`repos/${repo}/commits/${sha}/pulls`),
    api(`repos/${repo}/git/matching-refs/tags/v`),
  ])

  const existingTags = new Set(
    requireArray(rawTags, 'tag refs').map((ref) =>
      requireString(dig(ref, 'ref'), 'tag ref').replace(/^refs\/tags\//, ''),
    ),
  )

  const merged = requireArray(pulls, 'pulls for commit').find(
    (candidate) =>
      Boolean(dig(candidate, 'merged_at')) &&
      dig(candidate, 'merge_commit_sha') === sha,
  )

  let pr: MergedReleasePr | null = null
  let reviews: Review[] = []
  let releasePublished = false
  const gateAttestedReviewIds = new Set<number>()

  if (merged !== undefined) {
    const gathered = await gatherPr(
      options,
      requireNumber(dig(merged, 'number'), 'PR number'),
    )
    pr = gathered.pr
    reviews = gathered.reviews
    releasePublished = await releaseExists(
      api,
      repo,
      gathered.pr.addedEntryVersion,
    )
    const gateApprovals = reviews.filter(
      (review) =>
        review.user === gateLogin &&
        review.state === 'APPROVED' &&
        review.commitId === gathered.pr.headSha,
    )
    const verdicts = await Promise.all(
      gateApprovals.map((review) =>
        options.verifyGateAttestation({
          pr: gathered.pr.number,
          headSha: gathered.pr.headSha,
          reviewId: review.id,
        }),
      ),
    )
    gateApprovals.forEach((review, index) => {
      if (verdicts[index]) gateAttestedReviewIds.add(review.id)
    })
  }

  return {
    pushedSha: sha,
    mainTipSha: requireString(dig(mainRef, 'object', 'sha'), 'main tip sha'),
    pushedParentSha,
    pr,
    reviews,
    existingTags,
    hold: options.hold,
    repo,
    maintainerLogin: options.maintainerLogin,
    gateLogin,
    releaseAppLogin: options.releaseAppLogin,
    gateAttestedReviewIds,
    releasePublished,
  }
}
