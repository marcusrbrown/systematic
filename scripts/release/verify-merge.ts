import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEntries } from './changelog.ts'
import { decidePublish, type PublishDecision } from './decide-publish.ts'
import { buildGatedReleaseConfig } from './gated-config.ts'
import {
  type Api,
  gatherPublishFacts,
  githubApi,
} from './gather-publish-facts.ts'

export const PREDICATE_TYPE =
  'https://github.com/marcusrbrown/systematic/attestations/release-gate-approval/v1'

const MAINTAINER_LOGIN = 'marcusrbrown'
const GATE_LOGIN = 'fro-bot'
const DEFAULT_RELEASE_APP_LOGIN = 'systematic-release[bot]'
const NOTES_PATH = '.release/notes.md'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

export interface VerifyMergeOptions {
  sha: string
  outDir: string
  repo: string
  hold: boolean
  cwd: string
  api: Api
  exec: Exec
  /** Defaults to `$RELEASE_APP_LOGIN`, then `systematic-release[bot]`. */
  releaseAppLogin?: string
}

export interface ApprovalSubjectInput {
  repo: string
  pr: number
  headSha: string
  reviewId: number
}

/**
 * Byte-identical to `jq -cjS '{headSha, pr, repo, reviewId}'`: compact, keys
 * sorted, no trailing newline. Built by hand so key order cannot drift.
 */
export function approvalSubject({
  repo,
  pr,
  headSha,
  reviewId,
}: ApprovalSubjectInput): string {
  return `{"headSha":${JSON.stringify(headSha)},"pr":${JSON.stringify(pr)},"repo":${JSON.stringify(repo)},"reviewId":${JSON.stringify(reviewId)}}`
}

async function fetchChangelog(
  api: Api,
  repo: string,
  sha: string,
): Promise<string> {
  const file = await api(`repos/${repo}/contents/CHANGELOG.md?ref=${sha}`)
  const content =
    typeof file === 'object' && file !== null
      ? (file as Record<string, unknown>).content
      : undefined
  if (typeof content !== 'string' || content === '') {
    throw new Error(`Unexpected GitHub API response: no CHANGELOG.md at ${sha}`)
  }
  return Buffer.from(content.replaceAll('\n', ''), 'base64').toString('utf8')
}

export async function runVerifyMerge(
  opts: VerifyMergeOptions,
): Promise<PublishDecision> {
  const { sha, outDir, repo, hold, cwd, api, exec } = opts
  const releaseAppLogin =
    opts.releaseAppLogin ||
    process.env.RELEASE_APP_LOGIN ||
    DEFAULT_RELEASE_APP_LOGIN

  const verifyGateAttestation = async (input: {
    pr: number
    headSha: string
    reviewId: number
  }): Promise<boolean> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-subject-'))
    const file = path.join(dir, 'subject.json')
    try {
      fs.writeFileSync(file, approvalSubject({ repo, ...input }))
      const result = await exec('gh', [
        'attestation',
        'verify',
        file,
        '--repo',
        repo,
        '--signer-workflow',
        `${repo}/.github/workflows/release-gate.yaml`,
        '--source-ref',
        'refs/heads/main',
        '--predicate-type',
        PREDICATE_TYPE,
        '--format',
        'json',
      ])
      return result.code === 0
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const facts = await gatherPublishFacts({
    api,
    repo,
    sha,
    maintainerLogin: MAINTAINER_LOGIN,
    gateLogin: GATE_LOGIN,
    releaseAppLogin,
    hold,
    verifyGateAttestation,
  })
  const decision = decidePublish(facts)

  fs.mkdirSync(outDir, { recursive: true })
  if (decision.kind === 'publish') {
    const entries = parseEntries(await fetchChangelog(api, repo, sha))
    const approved = entries.find((e) => e.version === decision.version)
    if (approved === undefined) {
      throw new Error(
        `CHANGELOG.md at ${sha} has no entry for version ${decision.version}`,
      )
    }
    const config = buildGatedReleaseConfig({
      releasercYaml: fs.readFileSync(path.join(cwd, '.releaserc.yaml'), 'utf8'),
      notesPath: NOTES_PATH,
      version: decision.version,
    })
    fs.writeFileSync(path.join(outDir, 'notes.md'), approved.text)
    fs.writeFileSync(
      path.join(outDir, 'releaserc.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    )
  }

  // Written last so a failed publish step never leaves a "publish" decision behind.
  fs.writeFileSync(
    path.join(outDir, 'decision.json'),
    `${JSON.stringify(decision, null, 2)}\n`,
  )

  return decision
}

const spawnExec: Exec = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function parseArgs(argv: string[]): { sha: string; out: string } {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === undefined || !['--sha', '--out'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`)
    }
    if (value === undefined) throw new Error(`${flag} requires a value`)
    values.set(flag, value)
  }
  const sha = values.get('--sha')
  const out = values.get('--out')
  if (sha === undefined) throw new Error('Missing required --sha')
  if (out === undefined) throw new Error('Missing required --out')
  return { sha, out }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

if (import.meta.main) {
  try {
    const { sha, out } = parseArgs(process.argv.slice(2))
    const decision = await runVerifyMerge({
      sha,
      outDir: out,
      repo: requireEnv('GITHUB_REPOSITORY'),
      hold: process.env.RELEASE_HOLD === 'true',
      cwd: process.cwd(),
      api: githubApi(requireEnv('GH_TOKEN')),
      exec: spawnExec,
    })
    if (decision.kind === 'refused' || decision.kind === 'superseded') {
      console.log(`::error::${decision.reason}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`::error::verify-merge failed: ${message}`)
    process.exit(1)
  }
}
