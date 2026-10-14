import { describe, expect, test } from 'bun:test'
import { decideGate, type GateFacts } from '../../scripts/release/gate.ts'

type GatePr = NonNullable<GateFacts['pr']>

const MAIN = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const REPO = 'marcusrbrown/systematic'
const APP = 'systematic-release[bot]'

type GateCommit = GatePr['headCommits'][number]

function commit(overrides: Partial<GateCommit> = {}): GateCommit {
  return { author: APP, committer: APP, verified: false, ...overrides }
}

function basePr(overrides: Partial<GatePr> = {}): GatePr {
  return {
    number: 42,
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
    headCommits: [commit()],
    ...overrides,
  }
}

function baseFacts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    hold: false,
    pr: basePr(),
    requiredChecks: [
      { name: 'lint', conclusion: 'success', status: 'completed' },
      { name: 'test', conclusion: 'success', status: 'completed' },
    ],
    existingTags: new Set(['v3.21.8', 'v3.21.7']),
    repo: REPO,
    releaseAppLogin: APP,
    ...overrides,
  }
}

function withPr(overrides: Partial<GatePr>): GateFacts {
  return baseFacts({ pr: basePr(overrides) })
}

describe('decideGate', () => {
  test('an API-created release commit (App author, verified web-flow committer) approves', () => {
    expect(
      decideGate(
        withPr({
          headCommits: [commit({ committer: 'web-flow', verified: true })],
        }),
      ),
    ).toEqual({
      kind: 'approve',
      pr: 42,
      headSha: HEAD,
      version: '3.22.0',
    })
  })

  test('base facts approve', () => {
    expect(decideGate(baseFacts())).toEqual({
      kind: 'approve',
      pr: 42,
      headSha: HEAD,
      version: '3.22.0',
    })
  })

  test.each([
    // Rule 1: hold
    ['hold is set', baseFacts({ hold: true }), 'hold'],
    // Rule 2: no open release PR
    ['no pull request', baseFacts({ pr: null }), 'release PR'],
    ['PR is closed', withPr({ state: 'closed' }), 'release PR'],
    ['PR is from another branch', withPr({ headRef: 'feat/x' }), 'release PR'],
    // Rule 3: identity
    [
      'head repo is a fork',
      withPr({ headRepo: 'evil/systematic' }),
      'identity',
    ],
    ['base repo differs', withPr({ baseRepo: 'evil/systematic' }), 'identity'],
    ['author is someone else', withPr({ author: 'mallory' }), 'identity'],
    ['PR is a draft', withPr({ draft: true }), 'identity'],
    // Rule 4: commit authors and committers
    [
      'an extra commit author',
      withPr({ headCommits: [commit(), commit({ author: 'fro-bot' })] }),
      'commit author',
    ],
    [
      'only a foreign author',
      withPr({ headCommits: [commit({ author: 'mallory' })] }),
      'commit author',
    ],
    [
      'a human author via the web UI (verified web-flow committer)',
      withPr({
        headCommits: [
          commit({
            author: 'marcusrbrown',
            committer: 'web-flow',
            verified: true,
          }),
        ],
      }),
      'found: marcusrbrown',
    ],
    [
      'a missing author',
      withPr({ headCommits: [commit({ author: '' })] }),
      'commit author',
    ],
    [
      'an unverified web-flow committer',
      withPr({
        headCommits: [commit({ committer: 'web-flow', verified: false })],
      }),
      'found: unverified web-flow',
    ],
    [
      'a foreign committer',
      withPr({
        headCommits: [commit({ committer: 'mallory', verified: true })],
      }),
      'found: mallory',
    ],
    [
      'a missing committer',
      withPr({ headCommits: [commit({ committer: '', verified: true })] }),
      'commit committer',
    ],
    ['no commits', withPr({ headCommits: [] }), 'commit author'],
    // Rule 5: currency
    [
      'head parent is not the main tip',
      withPr({ headParentSha: 'd'.repeat(40) }),
      'main',
    ],
    // Rule 6: shape
    [
      'extra changed files',
      withPr({ changedFiles: ['CHANGELOG.md', 'src/x.ts'] }),
      'CHANGELOG.md',
    ],
    ['no changed files', withPr({ changedFiles: [] }), 'CHANGELOG.md'],
    [
      'a different single file',
      withPr({ changedFiles: ['package.json'] }),
      'CHANGELOG.md',
    ],
    ['no added entry', withPr({ addedEntryVersion: null }), 'entry'],
    [
      'added version already tagged',
      baseFacts({ existingTags: new Set(['v3.22.0']) }),
      'tagged',
    ],
    [
      'removed entry is tagged',
      withPr({ removedEntryVersions: ['3.21.8'] }),
      'tagged',
    ],
    // Rule 7: checks
    ['no required checks', baseFacts({ requiredChecks: [] }), 'check'],
    [
      'a check is pending',
      baseFacts({
        requiredChecks: [
          { name: 'lint', conclusion: null, status: 'in_progress' },
        ],
      }),
      'check',
    ],
    [
      'a check is queued with a stale conclusion',
      baseFacts({
        requiredChecks: [
          { name: 'lint', conclusion: 'success', status: 'queued' },
        ],
      }),
      'check',
    ],
    [
      'a check failed',
      baseFacts({
        requiredChecks: [
          { name: 'lint', conclusion: 'success', status: 'completed' },
          { name: 'test', conclusion: 'failure', status: 'completed' },
        ],
      }),
      'check',
    ],
    [
      'a check was cancelled',
      baseFacts({
        requiredChecks: [
          { name: 'lint', conclusion: 'cancelled', status: 'completed' },
        ],
      }),
      'check',
    ],
    [
      'a completed check has no conclusion',
      baseFacts({
        requiredChecks: [
          { name: 'lint', conclusion: null, status: 'completed' },
        ],
      }),
      'check',
    ],
  ])('skips when %s', (_name, facts, keyword) => {
    const decision = decideGate(facts)
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.reason.length).toBeGreaterThan(0)
      expect(decision.reason.toLowerCase()).toContain(keyword.toLowerCase())
    }
  })

  test.each(['skipped', 'neutral'])(
    'a %s check conclusion is allowed',
    (conclusion) => {
      const decision = decideGate(
        baseFacts({
          requiredChecks: [
            { name: 'lint', conclusion: 'success', status: 'completed' },
            { name: 'optional', conclusion, status: 'completed' },
          ],
        }),
      )
      expect(decision.kind).toBe('approve')
    },
  )

  test('removing an untagged phantom entry still approves', () => {
    expect(decideGate(withPr({ removedEntryVersions: ['3.21.9'] })).kind).toBe(
      'approve',
    )
  })

  test('rules apply in order: hold wins over a missing PR', () => {
    const decision = decideGate(baseFacts({ hold: true, pr: null }))
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.reason.toLowerCase()).toContain('hold')
    }
  })
})
