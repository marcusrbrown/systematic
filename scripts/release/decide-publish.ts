export interface Review {
  id: number
  user: string
  state:
    | 'APPROVED'
    | 'CHANGES_REQUESTED'
    | 'COMMENTED'
    | 'DISMISSED'
    | 'PENDING'
  commitId: string
  /** ISO 8601 timestamp. */
  submittedAt: string
}

export interface MergedReleasePr {
  number: number
  headRef: string
  headRepo: string
  baseRepo: string
  author: string
  headSha: string
  headParentSha: string
  mergedAt: string
  mergeCommitSha: string
  /** Files in the PR head's diff against its parent. */
  changedFiles: readonly string[]
  /** CHANGELOG versions the head removed. */
  removedEntryVersions: readonly string[]
  /** CHANGELOG version the head prepended. */
  addedEntryVersion: string | null
}

export interface PublishFacts {
  /** X: the commit this run is for. */
  pushedSha: string
  mainTipSha: string
  /** Parent of X. */
  pushedParentSha: string
  /** Merged PR whose merge_commit_sha is X, or null. */
  pr: MergedReleasePr | null
  reviews: readonly Review[]
  /** Existing tags, e.g. `v3.21.8`. */
  existingTags: ReadonlySet<string>
  hold: boolean
  repo: string
  maintainerLogin: string
  gateLogin: string
  releaseAppLogin: string
  /** Gate-login review ids that carry a verified gate attestation. */
  gateAttestedReviewIds: ReadonlySet<number>
  /** A GitHub release exists for the PR's added version (false without one). */
  releasePublished: boolean
}

export type PublishDecision =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'publish'
      version: string
      reviewId: number
      /** Which approval qualified; the publish job re-checks the live hold against it. */
      approver: 'maintainer' | 'gate'
    }
  | { kind: 'superseded'; reason: string }
  | { kind: 'refused'; reason: string }

const RELEASE_BRANCH = 'release/pending'
const CHANGELOG_PATH = 'CHANGELOG.md'

const refused = (reason: string): PublishDecision => ({
  kind: 'refused',
  reason,
})

/** Unparseable timestamps sort as latest so they can only ever void an approval. */
function timeOf(iso: string): number {
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

function isLater(a: Review, b: Review): boolean {
  const diff = timeOf(a.submittedAt) - timeOf(b.submittedAt)
  // Equal (or both unparseable) timestamps: the higher review id is newer.
  return Number.isNaN(diff) || diff === 0 ? a.id > b.id : diff > 0
}

/**
 * Latest state-changing review per user as of the merge, matching GitHub's own
 * review-decision rules: COMMENTED and PENDING reviews never change approval
 * state, and reviews submitted after the merge did not govern it.
 */
function latestReviewPerUser(
  reviews: readonly Review[],
  mergedAt: number,
): Review[] {
  const latest = new Map<string, Review>()
  for (const review of reviews) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue
    const time = timeOf(review.submittedAt)
    if (Number.isFinite(time) && time > mergedAt) continue
    const current = latest.get(review.user)
    if (current === undefined || isLater(review, current)) {
      latest.set(review.user, review)
    }
  }
  return [...latest.values()]
}

function findApproval(
  facts: PublishFacts,
  pr: MergedReleasePr,
): { reviewId: number; approver: 'maintainer' | 'gate' } | { missing: string } {
  const mergedAt = new Date(pr.mergedAt).getTime()
  const candidates = latestReviewPerUser(facts.reviews, mergedAt).filter(
    (review) =>
      review.state === 'APPROVED' &&
      review.commitId === pr.headSha &&
      timeOf(review.submittedAt) <= mergedAt,
  )

  const maintainer = candidates.find((r) => r.user === facts.maintainerLogin)
  if (maintainer !== undefined) {
    return { reviewId: maintainer.id, approver: 'maintainer' }
  }

  const gate = candidates.find((r) => r.user === facts.gateLogin)
  if (gate !== undefined) {
    if (facts.hold) {
      return {
        missing: `only a ${facts.gateLogin} approval exists and the release hold is set`,
      }
    }
    if (!facts.gateAttestedReviewIds.has(gate.id)) {
      return {
        missing: `the ${facts.gateLogin} approval has no verified gate attestation`,
      }
    }
    return { reviewId: gate.id, approver: 'gate' }
  }

  return {
    missing: `no current approval of head ${pr.headSha} from ${facts.maintainerLogin} or ${facts.gateLogin} submitted before the merge`,
  }
}

/**
 * Rule 5. Returns the fresh, untagged version that was added, or the decision
 * that ends the run. A tag with a release is a finished publish (the hourly
 * reconcile lands here while main's tip is still the release merge); a tag
 * alone is a partial publish.
 */
function checkAddedVersion(
  facts: PublishFacts,
  pr: MergedReleasePr,
): PublishDecision | string {
  const version = pr.addedEntryVersion
  if (version === null) {
    return refused('Release PR did not add a CHANGELOG entry.')
  }
  if (!facts.existingTags.has(`v${version}`)) return version
  if (facts.releasePublished) {
    return { kind: 'skip', reason: `v${version} is already published.` }
  }
  return refused(`Version v${version} is already tagged.`)
}

export function decidePublish(facts: PublishFacts): PublishDecision {
  const { pr } = facts

  // Rule 1: not a release merge.
  if (pr === null) {
    return {
      kind: 'skip',
      reason: 'No merged pull request matches this commit.',
    }
  }
  if (pr.headRef !== RELEASE_BRANCH) {
    return {
      kind: 'skip',
      reason: `Merged PR head is ${pr.headRef}, not ${RELEASE_BRANCH}.`,
    }
  }

  // Rule 2: identity.
  if (pr.headRepo !== facts.repo) {
    return refused(`Release PR head repo ${pr.headRepo} is not ${facts.repo}.`)
  }
  if (pr.baseRepo !== facts.repo) {
    return refused(`Release PR base repo ${pr.baseRepo} is not ${facts.repo}.`)
  }
  if (pr.author !== facts.releaseAppLogin) {
    return refused(
      `Release PR author ${pr.author} is not ${facts.releaseAppLogin}.`,
    )
  }
  if (pr.mergeCommitSha !== facts.pushedSha) {
    return refused(
      `Release PR merge commit ${pr.mergeCommitSha} is not the pushed commit ${facts.pushedSha}.`,
    )
  }

  // Rule 3: head sits one commit on top of X's parent.
  if (pr.headParentSha !== facts.pushedParentSha) {
    return refused(
      `Release PR head parent ${pr.headParentSha} does not match the pushed commit's parent ${facts.pushedParentSha}.`,
    )
  }

  // Rule 4: the head touches only the changelog.
  if (pr.changedFiles.length !== 1 || pr.changedFiles[0] !== CHANGELOG_PATH) {
    return refused(
      `Release PR must change only ${CHANGELOG_PATH}, but changed: ${pr.changedFiles.join(', ') || 'nothing'}.`,
    )
  }

  // Rule 5: a fresh, untagged version was added.
  const addedVersion = checkAddedVersion(facts, pr)
  if (typeof addedVersion !== 'string') return addedVersion

  // Rule 6: only never-tagged entries may be removed.
  const removedTagged = pr.removedEntryVersions.filter((version) =>
    facts.existingTags.has(`v${version}`),
  )
  if (removedTagged.length > 0) {
    return refused(
      `Release PR removed CHANGELOG entries for tagged versions: ${removedTagged.join(', ')}.`,
    )
  }

  // Rule 7: a valid approval of the merged head.
  const approval = findApproval(facts, pr)
  if ('missing' in approval) {
    return refused(`No valid release approval: ${approval.missing}.`)
  }

  // Rule 8: checked last so staleness never hides a bad merge.
  if (facts.mainTipSha !== facts.pushedSha) {
    return {
      kind: 'superseded',
      reason: `Main tip ${facts.mainTipSha} moved past the release commit ${facts.pushedSha}.`,
    }
  }

  return {
    kind: 'publish',
    version: addedVersion,
    reviewId: approval.reviewId,
    approver: approval.approver,
  }
}
