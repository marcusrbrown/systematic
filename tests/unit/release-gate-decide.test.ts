import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHANGELOG_HEADER,
  CHANGELOG_SENTINEL,
} from '../../scripts/release/changelog.ts'
import { decideGate } from '../../scripts/release/gate.ts'
import {
  gatherGateFacts,
  parseArgs,
  runGateDecide,
} from '../../scripts/release/gate-decide.ts'
import type { Api } from '../../scripts/release/gather-publish-facts.ts'

const REPO = 'marcusrbrown/systematic'
const APP = 'systematic-release[bot]'
const MAIN = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const PR_NUMBER = 42
const CHECKS = ['Test', 'Lint']

const LIST_PATH = `repos/${REPO}/pulls?state=open&head=marcusrbrown:release/pending&per_page=100`
const CHECK_RUNS_PATH = `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`

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
  const raw = Buffer.from(text, 'utf8').toString('base64')
  return { content: raw.replace(/(.{60})/g, '$1\n'), encoding: 'base64' }
}

function run(
  name: string,
  conclusion: string | null,
  startedAt: string,
  status = 'completed',
) {
  return { name, status, conclusion, started_at: startedAt }
}

function apiCommit(
  author: string | null,
  committer: string | null,
  verified?: unknown,
) {
  return {
    author: author === null ? null : { login: author },
    committer: committer === null ? null : { login: committer },
    commit: { verification: verified === undefined ? {} : { verified } },
  }
}

interface FakeOptions {
  list?: unknown[]
  deletedFork?: boolean
  commits?: unknown[]
  checkRuns?: unknown[]
  author?: string
}

function fake(options: FakeOptions = {}) {
  const calls: string[] = []
  const responses = new Map<string, unknown>()
  const set = (path: string, value: unknown) => responses.set(path, value)

  set(LIST_PATH, options.list ?? [{ number: PR_NUMBER }])
  set(`repos/${REPO}/pulls/${PR_NUMBER}`, {
    head: {
      ref: 'release/pending',
      sha: HEAD,
      repo: options.deletedFork ? null : { full_name: REPO },
    },
    base: { repo: { full_name: REPO } },
    user: { login: options.author ?? APP },
    state: 'open',
    draft: false,
  })
  set(`repos/${REPO}/commits/${HEAD}`, { parents: [{ sha: MAIN }] })
  set(`repos/${REPO}/git/ref/heads/main`, { object: { sha: MAIN } })
  set(`repos/${REPO}/compare/${MAIN}...${HEAD}`, {
    files: [{ filename: 'CHANGELOG.md' }],
  })
  set(
    `repos/${REPO}/contents/CHANGELOG.md?ref=${MAIN}`,
    b64(changelog('3.21.8')),
  )
  set(
    `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`,
    b64(changelog('3.22.0', '3.21.8')),
  )
  set(
    `repos/${REPO}/pulls/${PR_NUMBER}/commits?per_page=100`,
    options.commits ?? [apiCommit(APP, APP)],
  )
  set(CHECK_RUNS_PATH, {
    check_runs: options.checkRuns ?? [
      run('Test', 'success', '2026-10-12T10:00:00Z'),
      run('Lint', 'success', '2026-10-12T10:00:01Z'),
    ],
  })
  set(`repos/${REPO}/git/matching-refs/tags/v`, [
    { ref: 'refs/tags/v3.21.8' },
    { ref: 'refs/tags/v3.21.7' },
  ])

  const api: Api = async (path) => {
    calls.push(path)
    if (!responses.has(path)) throw notFound(path)
    return responses.get(path)
  }
  return { api, calls, set }
}

function baseOptions(api: Api, requiredChecks: string[] = CHECKS) {
  return {
    api,
    repo: REPO,
    hold: false,
    releaseAppLogin: APP,
    requiredChecks,
  }
}

describe('gatherGateFacts', () => {
  test('happy path produces facts that approve', async () => {
    const { api } = fake()
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr).toEqual({
      number: PR_NUMBER,
      headRef: 'release/pending',
      headRepo: REPO,
      baseRepo: REPO,
      author: APP,
      state: 'open',
      draft: false,
      headSha: HEAD,
      headParentSha: MAIN,
      mainTipSha: MAIN,
      changedFiles: ['CHANGELOG.md'],
      addedEntryVersion: '3.22.0',
      removedEntryVersions: [],
      headCommits: [{ author: APP, committer: APP, verified: false }],
    })
    expect(facts.requiredChecks).toEqual([
      { name: 'Test', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'completed', conclusion: 'success' },
    ])
    expect(facts.existingTags).toEqual(new Set(['v3.21.8', 'v3.21.7']))
    expect(facts.hold).toBe(false)
    expect(facts.repo).toBe(REPO)
    expect(facts.releaseAppLogin).toBe(APP)
    expect(decideGate(facts)).toEqual({
      kind: 'approve',
      pr: PR_NUMBER,
      headSha: HEAD,
      version: '3.22.0',
    })
  })

  test('no open PR yields pr: null and skips without PR endpoint calls', async () => {
    const { api, calls } = fake({ list: [] })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr).toBeNull()
    expect(facts.requiredChecks).toEqual([])
    expect(calls.some((c) => c.includes('/compare/'))).toBe(false)
    expect(calls.some((c) => c.includes('/contents/'))).toBe(false)
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('two open PRs on release/pending throw', async () => {
    const { api } = fake({ list: [{ number: 42 }, { number: 43 }] })
    await expect(gatherGateFacts(baseOptions(api))).rejects.toThrow(
      /more than one/i,
    )
  })

  test('a required check with no run is reported missing and skips', async () => {
    const { api } = fake({
      checkRuns: [run('Test', 'success', '2026-10-12T10:00:00Z')],
    })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.requiredChecks).toContainEqual({
      name: 'Lint',
      status: 'missing',
      conclusion: null,
    })
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('the newest run of a check wins: old failure then new success approves', async () => {
    const { api } = fake({
      checkRuns: [
        run('Test', 'failure', '2026-10-12T09:00:00Z'),
        run('Test', 'success', '2026-10-12T10:00:00Z'),
        run('Lint', 'success', '2026-10-12T10:00:01Z'),
      ],
    })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.requiredChecks[0]).toEqual({
      name: 'Test',
      status: 'completed',
      conclusion: 'success',
    })
    expect(decideGate(facts).kind).toBe('approve')
  })

  test('the newest run wins regardless of API ordering: new failure after old success skips', async () => {
    const { api } = fake({
      checkRuns: [
        run('Test', 'failure', '2026-10-12T10:00:00Z'),
        run('Test', 'success', '2026-10-12T09:00:00Z'),
        run('Lint', 'success', '2026-10-12T10:00:01Z'),
      ],
    })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.requiredChecks[0]?.conclusion).toBe('failure')
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('an API-created release commit (App author, verified web-flow committer) is approved', async () => {
    const { api } = fake({ commits: [apiCommit(APP, 'web-flow', true)] })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr?.headCommits).toEqual([
      { author: APP, committer: 'web-flow', verified: true },
    ])
    expect(decideGate(facts).kind).toBe('approve')
  })

  test('a human-authored web-UI commit (verified web-flow committer) skips naming the author', async () => {
    const { api } = fake({
      commits: [apiCommit('marcusrbrown', 'web-flow', true)],
    })
    const decision = decideGate(await gatherGateFacts(baseOptions(api)))
    expect(decision.kind).toBe('skip')
    expect(decision.kind === 'skip' && decision.reason).toContain(
      'marcusrbrown',
    )
  })

  test('an unverified web-flow committer skips', async () => {
    const { api } = fake({ commits: [apiCommit(APP, 'web-flow', false)] })
    const decision = decideGate(await gatherGateFacts(baseOptions(api)))
    expect(decision.kind).toBe('skip')
    expect(decision.kind === 'skip' && decision.reason).toContain('web-flow')
  })

  test.each([
    ['missing', undefined],
    ['a string', 'true'],
    ['null', null],
  ])(
    'a web-flow commit whose verification.verified is %s counts as unverified and skips',
    async (_label, verified) => {
      const { api } = fake({ commits: [apiCommit(APP, 'web-flow', verified)] })
      const facts = await gatherGateFacts(baseOptions(api))
      expect(facts.pr?.headCommits[0]?.verified).toBe(false)
      expect(decideGate(facts).kind).toBe('skip')
    },
  )

  test('a commit with no verification object at all counts as unverified', async () => {
    const { api } = fake({
      commits: [
        {
          author: { login: APP },
          committer: { login: 'web-flow' },
          commit: {},
        },
      ],
    })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr?.headCommits[0]?.verified).toBe(false)
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('a fro-bot committer skips even when verified', async () => {
    const { api } = fake({
      commits: [apiCommit(APP, APP), apiCommit(APP, 'fro-bot', true)],
    })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('a commit with a null author or committer yields an empty login and skips', async () => {
    const { api } = fake({ commits: [apiCommit(null, APP)] })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr?.headCommits).toEqual([
      { author: '', committer: APP, verified: false },
    ])
    expect(decideGate(facts).kind).toBe('skip')

    const missingCommitter = fake({ commits: [apiCommit(APP, null, true)] })
    const facts2 = await gatherGateFacts(baseOptions(missingCommitter.api))
    expect(facts2.pr?.headCommits[0]?.committer).toBe('')
    expect(decideGate(facts2).kind).toBe('skip')
  })

  test('a null head.repo (deleted fork) becomes an empty string and skips', async () => {
    const { api } = fake({ deletedFork: true })
    const facts = await gatherGateFacts(baseOptions(api))
    expect(facts.pr?.headRepo).toBe('')
    expect(decideGate(facts).kind).toBe('skip')
  })

  test('hold is passed through and skips', async () => {
    const { api } = fake()
    const facts = await gatherGateFacts({ ...baseOptions(api), hold: true })
    expect(facts.hold).toBe(true)
    expect(decideGate(facts)).toEqual({
      kind: 'skip',
      reason: 'Release hold is set.',
    })
  })

  test('a CHANGELOG 404 at the parent means the file is new', async () => {
    const { api, set } = fake()
    const failing: Api = async (p) => {
      if (p === `repos/${REPO}/contents/CHANGELOG.md?ref=${MAIN}`) {
        throw notFound(p)
      }
      return api(p)
    }
    set(
      `repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`,
      b64(changelog('3.22.0')),
    )
    const facts = await gatherGateFacts(baseOptions(failing))
    expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
    expect(facts.pr?.removedEntryVersions).toEqual([])
  })

  describe('regenerated entries (superseded same-version replacement)', () => {
    const original = changelog('3.22.0', '3.21.8')
    const regenerated = original.replace(
      'ship 3.22.0',
      'ship 3.22.0, regenerated',
    )

    test('an untagged same-version entry with new text is approved', async () => {
      const { api, set } = fake()
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${MAIN}`, b64(original))
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`, b64(regenerated))
      const facts = await gatherGateFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
      expect(decideGate(facts)).toEqual({
        kind: 'approve',
        pr: PR_NUMBER,
        headSha: HEAD,
        version: '3.22.0',
      })
    })

    test('an identical top entry adds nothing and skips', async () => {
      const { api, set } = fake()
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${MAIN}`, b64(original))
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`, b64(original))
      const facts = await gatherGateFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBeNull()
      expect(decideGate(facts).kind).toBe('skip')
    })

    test('a PR rewriting an already-tagged entry is a candidate but never approved', async () => {
      const { api, set } = fake()
      set(`repos/${REPO}/git/matching-refs/tags/v`, [
        { ref: 'refs/tags/v3.22.0' },
        { ref: 'refs/tags/v3.21.8' },
      ])
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${MAIN}`, b64(original))
      set(`repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`, b64(regenerated))
      const facts = await gatherGateFacts(baseOptions(api))
      expect(facts.pr?.addedEntryVersion).toBe('3.22.0')
      expect(decideGate(facts).kind).toBe('skip')
    })
  })

  test('a PR that is not from the release app skips without any changelog fetch', async () => {
    const { api, calls } = fake({ author: 'mallory' })
    const noChangelog: Api = async (p) => {
      if (p.includes('CHANGELOG.md')) throw notFound(p)
      return api(p)
    }
    const facts = await gatherGateFacts(baseOptions(noChangelog))
    expect(decideGate(facts).kind).toBe('skip')
    expect(
      calls.filter(
        (c) => c.includes('CHANGELOG.md') || c.includes('/compare/'),
      ),
    ).toEqual([])
  })

  test('a 500 from the check-runs endpoint propagates', async () => {
    const { api } = fake()
    const failing: Api = async (p) => {
      if (p === CHECK_RUNS_PATH) {
        throw Object.assign(new Error('boom'), { status: 500 })
      }
      return api(p)
    }
    await expect(gatherGateFacts(baseOptions(failing))).rejects.toThrow('boom')
  })
})

describe('parseArgs', () => {
  test('collects --out and repeated --required-check flags', () => {
    expect(
      parseArgs([
        '--out',
        'dir',
        '--required-check',
        'Test',
        '--required-check',
        'Lint',
      ]),
    ).toEqual({ out: 'dir', requiredChecks: ['Test', 'Lint'] })
  })

  test('throws without --out', () => {
    expect(() => parseArgs(['--required-check', 'Test'])).toThrow(/--out/)
  })

  test('throws on an unknown flag', () => {
    expect(() => parseArgs(['--out', 'd', '--nope', 'x'])).toThrow(/--nope/)
  })
})

describe('runGateDecide', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-decide-'))
    dirs.push(dir)
    return dir
  }

  test('writes gate.json for an approve decision', async () => {
    const { api } = fake()
    const out = tmp()
    const decision = await runGateDecide({ ...baseOptions(api), out })
    const written = JSON.parse(
      fs.readFileSync(path.join(out, 'gate.json'), 'utf8'),
    )
    expect(written).toEqual({
      kind: 'approve',
      pr: PR_NUMBER,
      headSha: HEAD,
      version: '3.22.0',
    })
    expect(decision).toEqual(written)
  })

  test('writes gate.json for a skip decision, creating the out dir', async () => {
    const { api } = fake({ list: [] })
    const out = path.join(tmp(), 'nested')
    await runGateDecide({ ...baseOptions(api), out })
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')),
    ).toEqual({ kind: 'skip', reason: 'No open release PR exists.' })
  })

  test('only the requested checks are consulted', async () => {
    const { api } = fake({
      checkRuns: [
        run('Test', 'success', '2026-10-12T10:00:00Z'),
        run('Lint', 'failure', '2026-10-12T10:00:00Z'),
      ],
    })
    const out = tmp()
    // Lint fails but is not requested: only Test matters.
    const decision = await runGateDecide({
      ...baseOptions(api, ['Test']),
      out,
    })
    expect(decision.kind).toBe('approve')
    // Requesting an unknown check skips with it reported as not completed.
    const skipped = await runGateDecide({
      ...baseOptions(api, ['Test', 'Nope']),
      out,
    })
    expect(skipped.kind).toBe('skip')
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')),
    ).toMatchObject({ kind: 'skip' })
  })
})

describe('gate-decide CLI', () => {
  test('exits 1 with an ::error:: line when GH_TOKEN is missing', () => {
    const result = Bun.spawnSync(
      ['bun', 'scripts/release/gate-decide.ts', '--out', os.tmpdir()],
      {
        env: {
          ...process.env,
          GH_TOKEN: '',
          GITHUB_REPOSITORY: REPO,
        },
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain('::error::gate-decide failed:')
    expect(result.stdout.toString()).toContain('GH_TOKEN')
  })
})
