export interface GateFacts {
  hold: boolean
  pr: null | {
    number: number
    headRef: string
    headRepo: string
    baseRepo: string
    author: string
    state: 'open' | 'closed'
    draft: boolean
    headSha: string
    headParentSha: string
    mainTipSha: string
    changedFiles: readonly string[]
    addedEntryVersion: string | null
    removedEntryVersions: readonly string[]
    /** Logins of every commit author/committer in the PR (base..head). */
    headCommitAuthors: readonly string[]
  }
  /** Required checks on the head sha. */
  requiredChecks: ReadonlyArray<{
    name: string
    conclusion: string | null
    status: string
  }>
  /** Existing tags, e.g. `v3.21.8`. */
  existingTags: ReadonlySet<string>
  repo: string
  releaseAppLogin: string
}

export type GateDecision =
  | { kind: 'approve'; pr: number; headSha: string; version: string }
  | { kind: 'skip'; reason: string }

const RELEASE_BRANCH = 'release/pending'
const CHANGELOG_PATH = 'CHANGELOG.md'
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'skipped',
  'neutral',
])

type GatePr = NonNullable<GateFacts['pr']>

const skip = (reason: string): GateDecision => ({ kind: 'skip', reason })

/** Rules 2-4: an open release PR from the release app, in this repo. */
function prIdentityProblem(facts: GateFacts, pr: GatePr): string | null {
  if (pr.state !== 'open') return 'The release PR is not open.'
  if (pr.headRef !== RELEASE_BRANCH) {
    return `The release PR head is ${pr.headRef}, not ${RELEASE_BRANCH}.`
  }
  if (pr.headRepo !== facts.repo || pr.baseRepo !== facts.repo) {
    return `Release PR identity check failed: not from ${facts.repo}.`
  }
  if (pr.author !== facts.releaseAppLogin) {
    return `Release PR identity check failed: author ${pr.author} is not ${facts.releaseAppLogin}.`
  }
  if (pr.draft) return 'Release PR identity check failed: it is a draft.'
  if (
    pr.headCommitAuthors.length === 0 ||
    pr.headCommitAuthors.some((login) => login !== facts.releaseAppLogin)
  ) {
    return `Release PR commit authors must all be ${facts.releaseAppLogin}, found: ${pr.headCommitAuthors.join(', ') || 'none'}.`
  }
  return null
}

/** Rules 5-6: one commit on current main that only prepends a fresh entry. */
function prShapeProblem(facts: GateFacts, pr: GatePr): string | null {
  if (pr.headParentSha !== pr.mainTipSha) {
    return `Release PR is not one commit on current main (parent ${pr.headParentSha}, main ${pr.mainTipSha}).`
  }
  if (pr.changedFiles.length !== 1 || pr.changedFiles[0] !== CHANGELOG_PATH) {
    return `Release PR must change only ${CHANGELOG_PATH}, but changed: ${pr.changedFiles.join(', ') || 'nothing'}.`
  }
  if (pr.addedEntryVersion === null) {
    return 'Release PR did not add a CHANGELOG entry.'
  }
  if (facts.existingTags.has(`v${pr.addedEntryVersion}`)) {
    return `Version v${pr.addedEntryVersion} is already tagged.`
  }
  const removedTagged = pr.removedEntryVersions.filter((version) =>
    facts.existingTags.has(`v${version}`),
  )
  if (removedTagged.length > 0) {
    return `Release PR removed entries for tagged versions: ${removedTagged.join(', ')}.`
  }
  return null
}

/** Rule 7: every required check finished and passed. */
function checksProblem(facts: GateFacts): string | null {
  if (facts.requiredChecks.length === 0) {
    return 'No required checks were reported for the release PR head.'
  }
  const unfinished = facts.requiredChecks.filter(
    (check) => check.status !== 'completed',
  )
  if (unfinished.length > 0) {
    return `Required checks not completed: ${unfinished.map((check) => check.name).join(', ')}.`
  }
  const failing = facts.requiredChecks.filter(
    (check) =>
      check.conclusion === null || !PASSING_CONCLUSIONS.has(check.conclusion),
  )
  if (failing.length > 0) {
    return `Required checks did not pass: ${failing.map((check) => check.name).join(', ')}.`
  }
  return null
}

/** Decide whether the gate may approve the pending release PR. */
export function decideGate(facts: GateFacts): GateDecision {
  // Rule 1: hold.
  if (facts.hold) return skip('Release hold is set.')

  // Rule 2: an open release PR must exist.
  const { pr } = facts
  if (pr === null) return skip('No open release PR exists.')

  const problem =
    prIdentityProblem(facts, pr) ??
    prShapeProblem(facts, pr) ??
    checksProblem(facts)
  if (problem !== null) return skip(problem)

  // Rule 8: approve. Shape checks guarantee the version is set.
  return pr.addedEntryVersion === null
    ? skip('Release PR did not add a CHANGELOG entry.')
    : {
        kind: 'approve',
        pr: pr.number,
        headSha: pr.headSha,
        version: pr.addedEntryVersion,
      }
}
