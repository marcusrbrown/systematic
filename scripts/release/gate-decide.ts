import fs from 'node:fs'
import path from 'node:path'
import { decideGate, type GateDecision, type GateFacts } from './gate.js'
import {
  type Api,
  changelogVersionDelta,
  dig,
  githubApi,
  parentShaOf,
  requireArray,
  requireString,
} from './gather-publish-facts.js'

const RELEASE_BRANCH = 'release/pending'
const DEFAULT_RELEASE_APP_LOGIN = 'systematic-release[bot]'

type GatePr = NonNullable<GateFacts['pr']>
type RequiredCheck = GateFacts['requiredChecks'][number]

export interface GatherGateFactsOptions {
  api: Api
  repo: string
  hold: boolean
  releaseAppLogin: string
  requiredChecks: string[]
}

/** Empty string never matches a login or repo, so a null field fails the gate closed. */
function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function findOpenPrNumber(
  api: Api,
  repo: string,
): Promise<number | null> {
  const owner = repo.split('/')[0] ?? ''
  const open = requireArray(
    await api(
      `repos/${repo}/pulls?state=open&head=${owner}:${RELEASE_BRANCH}&per_page=100`,
    ),
    'open pull requests',
  )
  if (open.length === 0) return null
  if (open.length > 1) {
    throw new Error(
      `Found more than one open pull request on ${RELEASE_BRANCH}: ${open.map((pr) => String(dig(pr, 'number'))).join(', ')}`,
    )
  }
  const number = dig(open[0], 'number')
  if (typeof number !== 'number') {
    throw new Error('Unexpected GitHub API response: missing PR number')
  }
  return number
}

async function gatherPr(
  options: GatherGateFactsOptions,
  number: number,
): Promise<GatePr> {
  const { api, repo } = options
  const raw = await api(`repos/${repo}/pulls/${number}`)
  const headSha = requireString(
    dig(raw, 'head', 'sha'),
    `head sha of PR ${number}`,
  )
  const common = {
    number,
    headRef: requireString(dig(raw, 'head', 'ref'), `head ref of PR ${number}`),
    // A deleted fork has no head repo; empty never equals the repo, so it skips.
    headRepo: stringOrEmpty(dig(raw, 'head', 'repo', 'full_name')),
    baseRepo: stringOrEmpty(dig(raw, 'base', 'repo', 'full_name')),
    author: stringOrEmpty(dig(raw, 'user', 'login')),
    state:
      dig(raw, 'state') === 'open' ? ('open' as const) : ('closed' as const),
    draft: dig(raw, 'draft') === true,
    headSha,
  }

  // Classify before requesting release-only facts: a PR that fails the
  // identity checks skips on identity alone, so a missing CHANGELOG.md on it
  // can never fail fact collection.
  const isReleasePr =
    common.headRef === RELEASE_BRANCH &&
    common.headRepo === repo &&
    common.baseRepo === repo &&
    common.author === options.releaseAppLogin
  if (!isReleasePr) {
    return {
      ...common,
      headParentSha: '',
      mainTipSha: '',
      changedFiles: [],
      addedEntryVersion: null,
      removedEntryVersions: [],
      headCommits: [],
    }
  }

  const headParentSha = await parentShaOf(api, repo, headSha)
  const [mainRef, compare, delta, commits] = await Promise.all([
    api(`repos/${repo}/git/ref/heads/main`),
    api(`repos/${repo}/compare/${headParentSha}...${headSha}`),
    changelogVersionDelta(api, repo, headParentSha, headSha),
    api(`repos/${repo}/pulls/${number}/commits?per_page=100`),
  ])

  return {
    ...common,
    headParentSha,
    mainTipSha: requireString(dig(mainRef, 'object', 'sha'), 'main tip sha'),
    changedFiles: requireArray(dig(compare, 'files'), 'compare files').map(
      (file) => requireString(dig(file, 'filename'), 'compare filename'),
    ),
    addedEntryVersion: delta.addedEntryVersion,
    removedEntryVersions: delta.removedEntryVersions,
    headCommits: requireArray(commits, 'PR commits').map((commit) => ({
      author: stringOrEmpty(dig(commit, 'author', 'login')),
      committer: stringOrEmpty(dig(commit, 'committer', 'login')),
      // Fail closed: anything but a literal boolean true is unverified.
      verified: dig(commit, 'commit', 'verification', 'verified') === true,
    })),
  }
}

function startedAt(run: unknown): string {
  const value = dig(run, 'started_at')
  return typeof value === 'string' ? value : ''
}

async function gatherChecks(
  api: Api,
  repo: string,
  headSha: string,
  names: readonly string[],
): Promise<RequiredCheck[]> {
  const runs = requireArray(
    dig(
      await api(`repos/${repo}/commits/${headSha}/check-runs?per_page=100`),
      'check_runs',
    ),
    'check runs',
  )
  return names.map((name) => {
    const newest = runs
      .filter((run) => dig(run, 'name') === name)
      .reduce<unknown>(
        (best, run) =>
          best === undefined || startedAt(run) > startedAt(best) ? run : best,
        undefined,
      )
    if (newest === undefined) {
      return { name, status: 'missing', conclusion: null }
    }
    const conclusion = dig(newest, 'conclusion')
    return {
      name,
      status: stringOrEmpty(dig(newest, 'status')),
      conclusion: typeof conclusion === 'string' ? conclusion : null,
    }
  })
}

export async function gatherGateFacts(
  options: GatherGateFactsOptions,
): Promise<GateFacts> {
  const { api, repo } = options

  const [number, rawTags] = await Promise.all([
    findOpenPrNumber(api, repo),
    api(`repos/${repo}/git/matching-refs/tags/v`),
  ])
  const existingTags = new Set(
    requireArray(rawTags, 'tag refs').map((ref) =>
      requireString(dig(ref, 'ref'), 'tag ref').replace(/^refs\/tags\//, ''),
    ),
  )

  const pr = number === null ? null : await gatherPr(options, number)
  const requiredChecks =
    pr === null
      ? []
      : await gatherChecks(api, repo, pr.headSha, options.requiredChecks)

  return {
    hold: options.hold,
    pr,
    requiredChecks,
    existingTags,
    repo,
    releaseAppLogin: options.releaseAppLogin,
  }
}

export interface RunGateDecideOptions extends GatherGateFactsOptions {
  out: string
}

/** Gather facts, decide, and write `<out>/gate.json`. */
export async function runGateDecide(
  options: RunGateDecideOptions,
): Promise<GateDecision> {
  const decision = decideGate(await gatherGateFacts(options))
  fs.mkdirSync(options.out, { recursive: true })
  fs.writeFileSync(
    path.join(options.out, 'gate.json'),
    `${JSON.stringify(decision, null, 2)}\n`,
  )
  return decision
}

export function parseArgs(argv: string[]): {
  out: string
  requiredChecks: string[]
} {
  let out: string | undefined
  const requiredChecks: string[] = []
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag !== '--out' && flag !== '--required-check') {
      throw new Error(`Unknown argument: ${flag}`)
    }
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    if (flag === '--out') out = value
    else requiredChecks.push(value)
  }
  if (out === undefined) throw new Error('Missing required --out')
  return { out, requiredChecks }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

if (import.meta.main) {
  try {
    const { out, requiredChecks } = parseArgs(process.argv.slice(2))
    const decision = await runGateDecide({
      api: githubApi(requireEnv('GH_TOKEN')),
      repo: requireEnv('GITHUB_REPOSITORY'),
      hold: process.env.RELEASE_HOLD === 'true',
      releaseAppLogin:
        process.env.RELEASE_APP_LOGIN || DEFAULT_RELEASE_APP_LOGIN,
      requiredChecks,
      out,
    })
    process.stdout.write(
      decision.kind === 'approve'
        ? `Approve PR #${decision.pr} at ${decision.headSha} for v${decision.version}\n`
        : `Skip: ${decision.reason}\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`::error::gate-decide failed: ${message}\n`)
    process.exit(1)
  }
}
