import { describe, expect, it } from 'bun:test'
import { verifyProvenance } from '../../src/lib/connect-provenance.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
const CONNECT = 'marcusrbrown/systematic/.github/workflows/connect.yaml'

/** One `referenced_workflows` entry, as `gh api` prints it. */
function entry(
  workflowPath: string,
  sha: unknown = SHA,
  ref = 'refs/heads/main',
): Record<string, unknown> {
  return { path: `${workflowPath}@${ref}`, sha, ref }
}

const text = (value: unknown): string => JSON.stringify(value)

const UNPROVABLE = {
  status: 'refused',
  reason: 'provenance-unprovable',
} as const
const NOT_CONNECT = { status: 'refused', reason: 'not-a-connect-run' } as const

describe('verifyProvenance: the list', () => {
  it('selects the sha of the one Systematic connect.yaml entry', () => {
    expect(
      verifyProvenance({ referencedWorkflows: text([entry(CONNECT)]) }),
    ).toEqual({
      status: 'selected',
      sha: SHA,
    })
  })

  it.each([
    ['an empty string', ''],
    ['whitespace', '  \n'],
    ['text that is not JSON', 'not json'],
    ['a gh error line', 'gh: Not Found (HTTP 404)'],
    ['truncated JSON', '[{"path": "marcusrbrown/systematic'],
    ['null', 'null'],
    ['an empty list', '[]'],
    ['an object', '{"path": "x"}'],
    ['a string', '"marcusrbrown/systematic"'],
    ['a number', '7'],
    ['a boolean', 'true'],
  ])('is unprovable for %s', (_label, input) => {
    expect(verifyProvenance({ referencedWorkflows: input })).toEqual(UNPROVABLE)
  })

  it('is unprovable when the input is not text at all', () => {
    for (const value of [undefined, null, 7, [entry(CONNECT)], {}]) {
      expect(verifyProvenance({ referencedWorkflows: value })).toEqual(
        UNPROVABLE,
      )
    }
  })

  it.each([
    ['no path', { sha: SHA }],
    ['a numeric path', { path: 7, sha: SHA }],
    ['a null path', { path: null, sha: SHA }],
    ['a list as the path', { path: [CONNECT], sha: SHA }],
    ['null', null],
    ['a string', CONNECT],
  ])(
    'is unprovable when an entry is %s, even beside a valid one',
    (_l, bad) => {
      expect(
        verifyProvenance({ referencedWorkflows: text([entry(CONNECT), bad]) }),
      ).toEqual(UNPROVABLE)
      expect(
        verifyProvenance({ referencedWorkflows: text([bad, entry(CONNECT)]) }),
      ).toEqual(UNPROVABLE)
    },
  )
})

describe('verifyProvenance: which entry matches', () => {
  it('matches the owner and repository without regard to case', () => {
    for (const name of [
      'MarcusRBrown/Systematic',
      'MARCUSRBROWN/SYSTEMATIC',
      'marcusrbrown/Systematic',
    ]) {
      expect(
        verifyProvenance({
          referencedWorkflows: text([
            entry(`${name}/.github/workflows/connect.yaml`),
          ]),
        }),
        name,
      ).toEqual({ status: 'selected', sha: SHA })
    }
  })

  it('matches by path and never by position', () => {
    const others = [
      entry('acme/other/.github/workflows/lint.yaml', OTHER_SHA),
      entry('marcusrbrown/systematic/.github/workflows/other.yaml', OTHER_SHA),
    ]
    for (const list of [
      [entry(CONNECT), ...others],
      [...others, entry(CONNECT)],
      [others[0], entry(CONNECT), others[1]],
    ]) {
      expect(verifyProvenance({ referencedWorkflows: text(list) })).toEqual({
        status: 'selected',
        sha: SHA,
      })
    }
  })

  it('matches a path with no @ suffix and ignores whatever the suffix says', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([{ path: CONNECT, sha: SHA }]),
      }),
    ).toEqual({ status: 'selected', sha: SHA })
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          { path: `${CONNECT}@refs/heads/${OTHER_SHA}`, sha: SHA },
        ]),
      }),
    ).toEqual({ status: 'selected', sha: SHA })
  })

  it('is not-a-connect-run for a fork owner', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          entry('someone-else/systematic/.github/workflows/connect.yaml'),
        ]),
      }),
    ).toEqual(NOT_CONNECT)
  })

  it('is not-a-connect-run for a different repository, a prefix of the name or a suffix of it', () => {
    for (const name of [
      'marcusrbrown/systematic-fork',
      'marcusrbrown/systematic2',
      'xmarcusrbrown/systematic',
      'acme/marcusrbrown/systematic',
    ]) {
      expect(
        verifyProvenance({
          referencedWorkflows: text([
            entry(`${name}/.github/workflows/connect.yaml`),
          ]),
        }),
        name,
      ).toEqual(NOT_CONNECT)
    }
  })

  it('is not-a-connect-run for a different workflow file', () => {
    for (const file of [
      '.github/workflows/connect-scheduled.yaml',
      '.github/workflows/connect.yml',
      '.github/workflows/fro-bot.yaml',
      '.github/workflows/sub/connect.yaml',
      '.github/connect.yaml',
    ]) {
      expect(
        verifyProvenance({
          referencedWorkflows: text([entry(`marcusrbrown/systematic/${file}`)]),
        }),
        file,
      ).toEqual(NOT_CONNECT)
    }
  })

  it('compares the file path exactly: a mixed-case Workflows is another file', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          entry('marcusrbrown/systematic/.github/Workflows/connect.yaml'),
        ]),
      }),
    ).toEqual(NOT_CONNECT)
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          entry('marcusrbrown/systematic/.github/workflows/Connect.yaml'),
        ]),
      }),
    ).toEqual(NOT_CONNECT)
  })

  it('lets an entry that differs only in case of the file path stand beside a real match', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          entry(
            'marcusrbrown/systematic/.github/Workflows/connect.yaml',
            OTHER_SHA,
          ),
          entry(CONNECT),
        ]),
      }),
    ).toEqual({ status: 'selected', sha: SHA })
  })

  it('is unprovable when two entries match, even with the same sha', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([entry(CONNECT), entry(CONNECT, OTHER_SHA)]),
      }),
    ).toEqual(UNPROVABLE)
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          entry(CONNECT),
          entry(`MarcusRBrown/Systematic/.github/workflows/connect.yaml`),
        ]),
      }),
    ).toEqual(UNPROVABLE)
  })
})

describe('verifyProvenance: the sha', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 7],
    ['empty', ''],
    ['short', SHA.slice(0, 39)],
    ['an abbreviated 7 characters', SHA.slice(0, 7)],
    ['long', `${SHA}0`],
    ['a 64-character hash', `${SHA}${SHA.slice(0, 24)}`],
    ['uppercase', SHA.toUpperCase()],
    ['mixed case', `A${SHA.slice(1)}`],
    ['not hex', `${SHA.slice(0, 39)}g`],
    ['padded', ` ${SHA}`],
    ['ending in a newline', `${SHA}\n`],
    ['a ref name', 'main'],
  ])('is unprovable when the matching entry sha is %s', (_label, sha) => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          { path: `${CONNECT}@refs/heads/main`, sha },
        ]),
      }),
    ).toEqual(UNPROVABLE)
  })

  it('never reads the ref or the text after the @ in place of the sha', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([{ path: `${CONNECT}@${SHA}`, ref: SHA }]),
      }),
    ).toEqual(UNPROVABLE)
  })

  it('does not check the sha of an entry that does not match', () => {
    expect(
      verifyProvenance({
        referencedWorkflows: text([
          { path: 'acme/other/.github/workflows/x.yaml@main', sha: 'bad' },
          entry(CONNECT),
        ]),
      }),
    ).toEqual({ status: 'selected', sha: SHA })
  })
})

describe('verifyProvenance: the compare status', () => {
  const list = text([entry(CONNECT)])

  it.each(['behind', 'identical'])('accepts %s', (status) => {
    expect(verifyProvenance({ referencedWorkflows: list, status })).toEqual({
      status: 'accepted',
      sha: SHA,
    })
  })

  it.each([
    ['ahead', 'ahead'],
    ['diverged', 'diverged'],
    ['empty', ''],
    ['whitespace', ' '],
    ['uppercase', 'BEHIND'],
    ['padded', ' behind'],
    ['a trailing newline', 'behind\n'],
    ['a made-up word', 'merged'],
    ['an error text', 'gh: Not Found (HTTP 404)'],
    ['null', null],
    ['a number', 0],
    ['a list', ['behind']],
  ])('is unprovable for status %s', (_label, status) => {
    expect(verifyProvenance({ referencedWorkflows: list, status })).toEqual(
      UNPROVABLE,
    )
  })

  it('judges the list before the status', () => {
    const other = text([
      entry('someone-else/systematic/.github/workflows/connect.yaml'),
    ])
    expect(
      verifyProvenance({ referencedWorkflows: other, status: 'behind' }),
    ).toEqual(NOT_CONNECT)
    expect(
      verifyProvenance({ referencedWorkflows: '[]', status: 'behind' }),
    ).toEqual(UNPROVABLE)
    expect(
      verifyProvenance({
        referencedWorkflows: text([entry(CONNECT, 'short')]),
        status: 'behind',
      }),
    ).toEqual(UNPROVABLE)
    expect(
      verifyProvenance({
        referencedWorkflows: text([entry(CONNECT), entry(CONNECT)]),
        status: 'behind',
      }),
    ).toEqual(UNPROVABLE)
  })

  it('accepts without a status only as a selection, never as an accepted commit', () => {
    expect(verifyProvenance({ referencedWorkflows: list })).toEqual({
      status: 'selected',
      sha: SHA,
    })
  })
})

describe('verifyProvenance: the verdict carries no input', () => {
  it('names a reason or a sha and nothing else', () => {
    const verdict = verifyProvenance({
      referencedWorkflows: text([
        {
          path: `${CONNECT}@refs/heads/secret-branch`,
          sha: SHA,
          extra: '/home/me',
        },
      ]),
      status: 'behind',
    })
    expect(Object.keys(verdict).sort()).toEqual(['sha', 'status'])
    expect(
      JSON.stringify(verifyProvenance({ referencedWorkflows: 'x /home/me' })),
    ).not.toContain('/home/me')
  })
})
