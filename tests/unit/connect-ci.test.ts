import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyTicks,
  assembleReport,
  DECISIONS_BEGIN,
  DECISIONS_END,
  decisionLine,
  fenceText,
  fitReport,
  MANIFEST_FILE,
  MANIFESTS_KEPT,
  MAX_UNVERIFIED_IDS,
  manifestMarker,
  neutraliseText,
  PAYLOAD_FILE,
  parseReportBody,
  REPORT_FILE,
  REPORT_MAX_CHARS,
  type RenderRequest,
  readReportBody,
  renderReport,
} from '../../src/lib/connect-ci.js'
import {
  acquireLock,
  decideLedgerEntry,
  INVOCATION_FILE,
  type LedgerEntry,
  pruneRuns,
  readLedger,
  releaseLock,
  revisionOf,
} from '../../src/lib/connect-state.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

// ── Fixtures ────────────────────────────────────────────────────────────────

const DAY_ONE = '2026-11-12'
const DAY_TWO = '2026-11-13'
const CONNECT_RUN = '20261112T010000Z-abcd1234'
const PROJECT_ROOT = '/runner/work/connect/checkouts/acme__target'
const PROJECT_KEY = '0123456789ab'

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The id of the nth fixture candidate. A real id is a sha256 as well. */
function idOf(index: number): string {
  return sha(`candidate-${index}`)
}

function makeRoot(): string {
  const root = path.join(makeDir('connect-ci-'), 'state')
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true })
  return root
}

function entryOf(index: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: idOf(index),
    kind: 'transferable-lesson',
    target: PROJECT_ROOT,
    ruleId: 'rule-0123456789abcdef',
    sources: [
      {
        role: 'source',
        path: `docs/solutions/lesson-${index}.md`,
        fingerprint: sha(`fingerprint-${index}`),
      },
    ],
    targetEvidence: [],
    status: 'candidate',
    history: [],
    // Candidate 1 is the oldest; the number is the minute of the record.
    recordedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    ...over,
  }
}

function writeLedger(root: string, entries: readonly LedgerEntry[]): void {
  fs.writeFileSync(
    path.join(root, 'ledger.json'),
    `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
  )
}

function settle(
  root: string,
  indexes: readonly number[],
  status: 'promoted' | 'rejected' = 'rejected',
): void {
  const read = readLedger(root)
  if (read.status !== 'ok') throw new Error('ledger unreadable in a test')
  writeLedger(
    root,
    read.ledger.entries.map((entry) =>
      indexes.some((index) => idOf(index) === entry.id)
        ? { ...entry, status, reason: 'settled by hand' }
        : entry,
    ),
  )
}

type Json = Record<string, unknown>

function blockCandidate(index: number, over: Json = {}): Json {
  return {
    id: idOf(index),
    // What the run's digest was written against: the entry's own revision.
    revision: revisionOf(entryOf(index)),
    status: 'candidate',
    standing: 'new',
    possibleMatches: [],
    kind: 'transferable-lesson',
    ruleId: 'rule-0123456789abcdef',
    target: PROJECT_ROOT,
    targetName: 'target',
    title: `Lesson ${index}`,
    summary: `Summary of lesson ${index}.`,
    nextStep: 'compound-learning',
    overlapCheck: { queries: ['q'], result: 'none-found' },
    sources: [
      {
        project: PROJECT_KEY,
        projectName: 'source',
        path: `docs/solutions/lesson-${index}.md`,
        fingerprint: sha(`fingerprint-${index}`),
        excerpt: `Excerpt of lesson ${index} from the source learning.`,
        cite: 'x',
      },
    ],
    targetEvidence: [],
    counterevidence: [],
    ...over,
  }
}

function writeRunRecord(
  root: string,
  candidates: readonly Json[],
  over: Json = {},
  runId: string = CONNECT_RUN,
): void {
  const dir = path.join(root, 'runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      createdAt: '2026-11-12T01:00:00.000Z',
      outcome: 'complete',
      degradeReasons: [],
      mode: 'headless',
      selection: { kind: 'all' },
      projects: [
        {
          name: 'target',
          root: PROJECT_ROOT,
          key: PROJECT_KEY,
          repo: 'acme/target',
          commit: 'a'.repeat(40),
        },
      ],
      sweep: { total: 40, covered: 12, coveredThisRun: 8, runsLeft: 4 },
      candidateBlock: { schemaVersion: 1, candidates },
      ...over,
    }),
  )
}

function writeInvocation(
  root: string,
  marker: string,
  over: Json = {},
  runId: string | null = CONNECT_RUN,
): void {
  fs.writeFileSync(
    path.join(root, INVOCATION_FILE),
    JSON.stringify({
      version: 1,
      marker,
      phase: 'terminal',
      outcome: 'complete',
      finalLine: 'Connect complete',
      ...(runId === null ? {} : { runId }),
      projects: [{ key: PROJECT_KEY, name: 'target', repo: 'acme/target' }],
      ...over,
    }),
  )
}

function request(over: Partial<RenderRequest> = {}): RenderRequest {
  return {
    date: DAY_ONE,
    runId: '900',
    attempt: '1',
    cacheRestored: true,
    ...over,
  }
}

/** A state root with `count` open candidates, all proposed by one run. */
function seeded(count: number, over: Json = {}): string {
  const root = makeRoot()
  const numbers = Array.from({ length: count }, (_, i) => i + 1)
  writeLedger(
    root,
    numbers.map((n) => entryOf(n)),
  )
  writeRunRecord(
    root,
    numbers.map((n) => blockCandidate(n)),
    over,
  )
  writeInvocation(root, '900-1')
  return root
}

function rendered(root: string, over: Partial<RenderRequest> = {}) {
  const result = renderReport(root, request(over))
  if (result.status !== 'rendered') {
    throw new Error(`expected a report: ${JSON.stringify(result)}`)
  }
  return result
}

function readJson(root: string, name: string): Json {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Json
}

function payloadsOf(root: string): Json[] {
  return readJson(root, PAYLOAD_FILE).payloads as Json[]
}

function manifestsOf(root: string): Array<{ hash: string; ids: string[] }> {
  return readJson(root, MANIFEST_FILE).manifests as Array<{
    hash: string
    ids: string[]
  }>
}

/** The generated line of candidate `index`, at its fixture entry's revision unless one is named. */
/** The workflow itself: its verifier's cap and the line its finalize step appends are read from it, not restated. */
const WORKFLOW_TEXT = fs.readFileSync(
  path.join(import.meta.dir, '../../.github/workflows/connect.yaml'),
  'utf8',
)

/** `REPORT_BODY_CAP` in the workflow: the size its verifier accepts, with the line below added. */
const WORKFLOW_BODY_CAP = Number(
  /REPORT_BODY_CAP: "(\d+)"/.exec(WORKFLOW_TEXT)?.[1],
)

/** The fixed line the workflow appends to the body when the ledger cache could not be saved. */
const CACHE_SAVE_LINE = String(
  /printf '(\\n\\n> The ledger cache[^']*)' >> "\$body"/.exec(
    WORKFLOW_TEXT,
  )?.[1],
).replaceAll('\\n', '\n')

/** The heading of the one section that collapses the rows with no bundle for their live revision. */
const NO_DETAILS = '## No verified details'

function boxLine(
  index: number,
  status: 'promoted' | 'rejected',
  isTicked: boolean,
  revision = revisionOf(entryOf(index)),
): string {
  return decisionLine(idOf(index), status, isTicked, revision)
}

function ticked(
  body: string,
  ticks: ReadonlyArray<readonly [number, 'promoted' | 'rejected']>,
): string {
  let out = body
  for (const [index, status] of ticks) {
    const open = boxLine(index, status, false)
    if (!out.includes(open)) throw new Error(`no box for ${index} ${status}`)
    out = out.replace(open, boxLine(index, status, true))
  }
  return out
}

/**
 * Split a body into the content of its code fences and the lines outside
 * them, the way Markdown does: a fence ends at a line of at least as many
 * backticks and nothing else. Throws when a fence never closes.
 */
function splitFences(body: string): { blocks: string[][]; outside: string[] } {
  const blocks: string[][] = []
  const outside: string[] = []
  let current: string[] | undefined
  let width = 0
  for (const line of body.split('\n')) {
    const run = /^(`{3,})(.*)$/.exec(line)
    if (current === undefined) {
      if (run === null) outside.push(line)
      else {
        current = []
        width = run[1]?.length ?? 0
      }
    } else if (
      run !== null &&
      (run[1]?.length ?? 0) >= width &&
      run[2] === ''
    ) {
      blocks.push(current)
      current = undefined
    } else {
      current.push(line)
    }
  }
  if (current !== undefined) throw new Error('a fence never closed')
  return { blocks, outside }
}

function ledgerBytes(root: string): string {
  return fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')
}

function statusOf(root: string, index: number): string | undefined {
  const read = readLedger(root)
  if (read.status !== 'ok') return undefined
  return read.ledger.entries.find((entry) => entry.id === idOf(index))?.status
}

// ── Neutralisation ──────────────────────────────────────────────────────────

describe('neutraliseText', () => {
  it('leaves ordinary text as it is', () => {
    const text = 'Verify the holder before reclaiming a lock (see section 2).'
    expect(neutraliseText(text)).toBe(text)
  })

  it('breaks a mention so it cannot notify anyone', () => {
    const out = neutraliseText('ping @octocat and @acme/security-team now')
    expect(out).not.toMatch(/@[A-Za-z0-9_]/)
  })

  it('breaks #n, GH-n and owner/repo#n references', () => {
    const out = neutraliseText(
      'see #12, gh-34, GH-56 and acme/target#78 for details',
    )
    expect(out).not.toMatch(/#\d/)
    expect(out).not.toMatch(/gh-\d/i)
  })

  it('breaks comment delimiters so a marker cannot be written', () => {
    const out = neutraliseText(
      `${DECISIONS_BEGIN}\n${manifestMarker('0123456789abcdef')}\n${decisionLine(idOf(1), 'promoted', true)}`,
    )
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('-->')
  })

  it('loses nothing but the break itself', () => {
    const text = 'a @b #1 GH-2 <!-- c --> d'
    expect(neutraliseText(text).replaceAll('\u200b', '')).toBe(text)
  })

  it('removes control and format characters but keeps line breaks', () => {
    const out = neutraliseText('a\u0000b\u202ec\r\nd\u200be\tf')
    expect(out).toBe('abc\nde f')
  })
})

describe('fenceText', () => {
  function fenceLines(fenced: string): string[] {
    return fenced.split('\n')
  }

  it('uses a fence longer than any backtick run inside the text', () => {
    const fenced = fenceText('before\n```\n- [x] Promoted\n````\nafter')
    const lines = fenceLines(fenced)
    const opening = lines[0] ?? ''
    expect(opening).toMatch(/^`{5,}/)
    const closing = lines.at(-1) ?? ''
    expect(closing).toMatch(/^`{5,}$/)
    for (const line of lines.slice(1, -1)) {
      expect(line.trim()).not.toBe('`'.repeat(opening.length))
    }
  })

  it('neutralises before it fences', () => {
    expect(fenceText('@octocat #12')).not.toMatch(/@[A-Za-z0-9_]|#\d/)
  })
})

// ── Parsing a body ──────────────────────────────────────────────────────────

describe('parseReportBody', () => {
  const MARKER = '0123456789abcdef'

  function body(inner: string, marker: string[] = [manifestMarker(MARKER)]) {
    return [...marker, 'text', DECISIONS_BEGIN, inner, DECISIONS_END, ''].join(
      '\n',
    )
  }

  it('pins the generated line format', () => {
    expect(decisionLine(idOf(1), 'promoted', false)).toBe(
      `- [ ] Promoted <!-- connect-decision:promoted:${idOf(1)} -->`,
    )
    expect(decisionLine(idOf(1), 'rejected', true)).toBe(
      `- [x] Rejected <!-- connect-decision:rejected:${idOf(1)} -->`,
    )
  })

  it('reads unticked and ticked boxes inside the section', () => {
    const parsed = parseReportBody(
      body(
        [
          decisionLine(idOf(1), 'promoted', true),
          decisionLine(idOf(1), 'rejected', false),
        ].join('\n'),
      ),
    )
    expect(parsed.section).toBe('ok')
    expect(parsed.manifest).toBe(MARKER)
    expect(parsed.boxes).toEqual([
      { id: idOf(1), status: 'promoted', ticked: true, revision: undefined },
      { id: idOf(1), status: 'rejected', ticked: false, revision: undefined },
    ])
  })

  it('accepts an upper-case X and carriage returns, as GitHub and a browser write them', () => {
    const text = body(decisionLine(idOf(1), 'rejected', true)).replace(
      '[x]',
      '[X]',
    )
    const parsed = parseReportBody(text.replaceAll('\n', '\r\n'))
    expect(parsed.boxes).toEqual([
      { id: idOf(1), status: 'rejected', ticked: true, revision: undefined },
    ])
  })

  it('ignores a box outside the section', () => {
    const text = `${decisionLine(idOf(1), 'rejected', true)}\n${body('')}\n${decisionLine(idOf(2), 'rejected', true)}`
    expect(parseReportBody(text).boxes).toEqual([])
  })

  it('ignores a box inside a code fence', () => {
    const inner = [
      '````text',
      decisionLine(idOf(1), 'rejected', true),
      '```',
      decisionLine(idOf(2), 'rejected', true),
      '````',
      decisionLine(idOf(3), 'rejected', true),
    ].join('\n')
    expect(parseReportBody(body(inner)).boxes.map((box) => box.id)).toEqual([
      idOf(3),
    ])
  })

  it('ignores a box inside a tilde fence', () => {
    const inner = [
      '~~~text',
      decisionLine(idOf(1), 'rejected', true),
      '~~~',
      decisionLine(idOf(2), 'rejected', true),
    ].join('\n')
    expect(parseReportBody(body(inner)).boxes.map((box) => box.id)).toEqual([
      idOf(2),
    ])
  })

  it('closes a fence only on its own character and at least its own length', () => {
    const inner = [
      '~~~~',
      '```',
      decisionLine(idOf(1), 'rejected', true),
      '~~~',
      decisionLine(idOf(2), 'rejected', true),
      '~~~~~',
      decisionLine(idOf(3), 'rejected', true),
      '````',
      '~~~~',
      decisionLine(idOf(4), 'rejected', true),
      '````',
      decisionLine(idOf(5), 'rejected', true),
    ].join('\n')
    expect(parseReportBody(body(inner)).boxes.map((box) => box.id)).toEqual([
      idOf(3),
      idOf(5),
    ])
  })

  it('opens a tilde fence whose info string holds a backtick', () => {
    const inner = [
      '~~~ a`b',
      decisionLine(idOf(1), 'rejected', true),
      '~~~',
      decisionLine(idOf(2), 'rejected', true),
    ].join('\n')
    expect(parseReportBody(body(inner)).boxes.map((box) => box.id)).toEqual([
      idOf(2),
    ])
  })

  it('ignores a manifest marker inside a tilde fence', () => {
    const text = body(decisionLine(idOf(1), 'rejected', true), [
      '~~~',
      manifestMarker('fedcba9876543210'),
      '~~~',
      manifestMarker(MARKER),
    ])
    expect(parseReportBody(text).manifest).toBe(MARKER)
  })

  it('ignores a line whose label disagrees with its marker, or whose id is not a candidate id', () => {
    const inner = [
      `- [x] Promoted <!-- connect-decision:rejected:${idOf(1)} -->`,
      '- [x] Promoted <!-- connect-decision:promoted:not-an-id -->',
      `- [x] Promoted <!-- connect-decision:promoted:${idOf(2)} --> trailing`,
      `  - [x] Rejected <!-- connect-decision:rejected:${idOf(3)} -->`,
    ].join('\n')
    expect(parseReportBody(body(inner)).boxes).toEqual([])
  })

  it('reads no section when there is none', () => {
    const parsed = parseReportBody(manifestMarker(MARKER))
    expect(parsed.section).toBe('missing')
    expect(parsed.boxes).toEqual([])
  })

  it('reads no section when a delimiter appears twice', () => {
    const text = `${DECISIONS_BEGIN}\n${decisionLine(idOf(1), 'rejected', true)}\n${DECISIONS_BEGIN}\n${DECISIONS_END}`
    const parsed = parseReportBody(text)
    expect(parsed.section).toBe('malformed')
    expect(parsed.boxes).toEqual([])
  })

  it('reads no section when the end comes before the begin', () => {
    const parsed = parseReportBody(`${DECISIONS_END}\n${DECISIONS_BEGIN}`)
    expect(parsed.section).toBe('malformed')
  })

  it('reads no manifest from a body with two markers, or none', () => {
    const inner = decisionLine(idOf(1), 'rejected', true)
    expect(
      parseReportBody(
        body(inner, [
          manifestMarker(MARKER),
          manifestMarker('fedcba9876543210'),
        ]),
      ).manifest,
    ).toBeUndefined()
    expect(parseReportBody(body(inner, [])).manifest).toBeUndefined()
  })

  it('ignores a manifest marker inside a code fence', () => {
    const text = body(decisionLine(idOf(1), 'rejected', true), [
      '````',
      manifestMarker('fedcba9876543210'),
      '````',
      manifestMarker(MARKER),
    ])
    expect(parseReportBody(text).manifest).toBe(MARKER)
  })
})

// ── Rendering ───────────────────────────────────────────────────────────────

describe('renderReport', () => {
  it('lists each open candidate with two unticked boxes bound to the manifest', () => {
    const root = seeded(3)
    const result = rendered(root)

    expect(result.shown).toBe(3)
    expect(result.hidden).toBe(0)
    expect(fs.readFileSync(path.join(root, REPORT_FILE), 'utf8')).toBe(
      result.body,
    )
    const parsed = parseReportBody(result.body)
    expect(parsed.section).toBe('ok')
    expect(parsed.manifest).toBe(result.manifest)
    expect(parsed.boxes).toHaveLength(6)
    expect(parsed.boxes.every((box) => !box.ticked)).toBe(true)
    expect(manifestsOf(root)).toEqual([
      {
        hash: result.manifest,
        ids: [idOf(1), idOf(2), idOf(3)],
      },
    ])
    expect(result.body).toContain('Lesson 1')
    expect(result.body).toContain('Excerpt of lesson 2')
  })

  it('lists the oldest candidate first, whatever order the ledger holds them in', () => {
    const root = seeded(3)
    writeLedger(root, [entryOf(3), entryOf(1), entryOf(2)])
    const { body } = rendered(root)
    const order = [
      ...body.matchAll(/connect-decision:promoted:([0-9a-f]{64})/g),
    ]
    expect(order.map((match) => match[1])).toEqual([idOf(1), idOf(2), idOf(3)])
  })

  it('stores a payload per open candidate with its originating run and attempt', () => {
    const root = seeded(3)
    rendered(root)
    const payloads = payloadsOf(root)
    expect(payloads.map((payload) => payload.id)).toEqual([
      idOf(1),
      idOf(2),
      idOf(3),
    ])
    for (const payload of payloads) {
      expect(payload.runId).toBe('900')
      expect(payload.attempt).toBe('1')
      expect(payload.firstShown).toBe(DAY_ONE)
      expect(payload.repo).toBe('acme/target')
    }
  })

  it('drops a settled candidate from the list and deletes its payload', () => {
    const root = seeded(3)
    rendered(root)
    settle(root, [2])
    writeInvocation(root, '901-1', {}, null)
    const second = rendered(root, { date: DAY_TWO, runId: '901' })
    expect(second.shown).toBe(2)
    expect(second.body).not.toContain(idOf(2))
    expect(payloadsOf(root).map((payload) => payload.id)).toEqual([
      idOf(1),
      idOf(3),
    ])
  })

  it('lists an unticked candidate again after another is settled', () => {
    const root = seeded(2)
    rendered(root)
    settle(root, [1])
    writeInvocation(root, '901-1', {}, null)
    const second = rendered(root, { date: DAY_TWO, runId: '901' })
    expect(second.body).toContain(boxLine(2, 'rejected', false))
    expect(second.body).not.toContain(idOf(1))
  })

  it('marks a candidate new on the date it is first shown, and not after', () => {
    const root = seeded(2)
    const first = rendered(root)
    expect(first.fresh).toBe(2)
    expect(first.body.match(/^### Candidate \d+ \(new\)$/gm)).toHaveLength(2)

    writeInvocation(root, '901-1', {}, null)
    const second = rendered(root, { date: DAY_TWO, runId: '901' })
    expect(second.fresh).toBe(0)
    expect(second.body.match(/^### Candidate \d+$/gm)).toHaveLength(2)
  })

  it('lists the same candidate with its details the next day after a cache round trip', () => {
    const root = seeded(2)
    rendered(root)
    const copy = path.join(makeDir('connect-ci-copy-'), 'state')
    fs.cpSync(root, copy, { recursive: true })
    fs.rmSync(path.join(copy, 'runs'), { recursive: true, force: true })
    fs.mkdirSync(path.join(copy, 'runs'))
    writeInvocation(copy, '901-1', {}, null)

    const next = rendered(copy, { date: DAY_TWO, runId: '901' })
    expect(next.shown).toBe(2)
    expect(next.body).toContain('Lesson 1')
    expect(next.body).not.toMatch(/\(new\)/)
    expect(next.body).toContain('fetch:900.1')
  })

  it('lists a candidate with no payload by id, with no verified details and no boxes', () => {
    const root = seeded(1)
    writeLedger(root, [entryOf(1), entryOf(2)])
    const { body, fetches } = rendered(root)
    expect(body).toContain(NO_DETAILS)
    expect(body).toContain(`\`${idOf(2)}\``)
    expect(body).not.toContain('### Candidate 2')
    expect(body).not.toContain(`connect-decision:promoted:${idOf(2)}`)
    expect(body).not.toContain(`connect-decision:rejected:${idOf(2)}`)
    expect(body).not.toContain('Details unavailable')
    // Candidate 1 has verified details; the other is in no Fetch line.
    expect(body).toContain(boxLine(1, 'rejected', false))
    expect(fetches).toEqual(['900.1'])
    expect(body).toContain('for candidates 1\n')
    expect(body).toContain('1 open, 1 listed')
  })

  it('notes a ledger that was not restored, with the sweep line and the fetch line', () => {
    const root = seeded(2)
    const reset = rendered(root, { cacheRestored: false }).body
    expect(reset).toMatch(/Ledger reset/)
    expect(reset).toContain('Sweep: covered 12 of 40 rules')
    expect(reset).toContain('/ce:connect fetch:900.1')

    const kept = rendered(seeded(2)).body
    expect(kept).not.toMatch(/Ledger reset/)
  })

  it('writes one fetch line per originating run and attempt, and one per candidate', () => {
    const root = seeded(2)
    rendered(root)
    // Two later runs each propose one more candidate.
    writeLedger(root, [entryOf(1), entryOf(2), entryOf(3), entryOf(4)])
    writeRunRecord(root, [blockCandidate(3)], {}, 'run-three')
    writeInvocation(root, '905-2', {}, 'run-three')
    rendered(root, { date: DAY_TWO, runId: '905', attempt: '2' })
    writeRunRecord(root, [blockCandidate(4)], {}, 'run-four')
    writeInvocation(root, '910-1', {}, 'run-four')
    const third = rendered(root, { date: '2026-11-14', runId: '910' })

    const header = [
      ...third.body.matchAll(/^- `\/ce:connect fetch:(\d+\.\d+)`/gm),
    ].map((match) => match[1])
    expect(header).toEqual(['900.1', '905.2', '910.1'])
    expect(third.fetches).toEqual(['900.1', '905.2', '910.1'])
    const perCandidate = [
      ...third.body.matchAll(/^- Fetch: `\/ce:connect fetch:(\d+\.\d+)`/gm),
    ].map((match) => match[1])
    expect(perCandidate).toEqual(['900.1', '900.1', '905.2', '910.1'])
    expect(third.body).toContain('(run 905, attempt 2)')
  })

  describe('a rerun of one run', () => {
    /** Attempt 1 of run 900 proposes candidate 1; attempt 2 of the same run proposes candidate 2. */
    function rerun(): ReturnType<typeof rendered> {
      const root = seeded(1)
      rendered(root)
      writeLedger(root, [entryOf(1), entryOf(2)])
      writeRunRecord(root, [blockCandidate(2)], {}, 'run-rerun')
      writeInvocation(root, '900-2', {}, 'run-rerun')
      return rendered(root, { date: DAY_TWO, runId: '900', attempt: '2' })
    }

    it('names the attempt a carried candidate came from, not the newest one', () => {
      const { body } = rerun()
      const blocks = body.split('### Candidate ').slice(1)
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toContain('- Fetch: `/ce:connect fetch:900.1`')
      expect(blocks[0]).not.toContain('fetch:900.2')
      expect(blocks[1]).toContain('- Fetch: `/ce:connect fetch:900.2`')
    })

    it('writes two separate fetch lines, one per attempt', () => {
      const { body, fetches } = rerun()
      const header = [
        ...body.matchAll(
          /^- `\/ce:connect fetch:(\d+\.\d+)` for candidates (.+)$/gm,
        ),
      ].map((match) => [match[1], match[2]])
      expect(header).toEqual([
        ['900.1', '1'],
        ['900.2', '2'],
      ])
      expect(fetches).toEqual(['900.1', '900.2'])
    })
  })

  it('keeps the first-shown date and the text when a later run proposes the candidate again', () => {
    const root = seeded(1)
    rendered(root)
    writeRunRecord(
      root,
      [blockCandidate(1, { title: 'Lesson 1, reopened' })],
      {},
      'run-two',
    )
    writeInvocation(root, '905-1', {}, 'run-two')
    rendered(root, { date: DAY_TWO, runId: '905' })
    const [payload] = payloadsOf(root)
    expect(payload?.firstShown).toBe(DAY_ONE)
    expect(payload?.runId).toBe('905')
    expect(payload?.title).toBe('Lesson 1, reopened')
  })

  describe('the payload store', () => {
    /** A run record lists at most 200 candidates, so 600 open ones take three runs. */
    function openAcrossRuns(total: number): string {
      const root = makeRoot()
      const all = Array.from({ length: total }, (_, i) => i + 1)
      writeLedger(
        root,
        all.map((n) => entryOf(n)),
      )
      for (let from = 0, run = 0; from < total; from += 200, run++) {
        const runName = `run-${run}`
        writeRunRecord(
          root,
          all.slice(from, from + 200).map((n) => blockCandidate(n)),
          {},
          runName,
        )
        writeInvocation(root, `${900 + run}-1`, {}, runName)
        rendered(root, { runId: String(900 + run) })
      }
      return root
    }

    it('keeps a payload for every open candidate past five hundred', () => {
      const root = openAcrossRuns(600)
      expect(payloadsOf(root)).toHaveLength(600)

      settle(
        root,
        Array.from({ length: 560 }, (_, i) => i + 1),
      )
      writeInvocation(root, '903-1', {}, null)
      const last = rendered(root, { date: DAY_TWO, runId: '903' })

      expect(last.shown).toBe(40)
      expect(last.body).not.toContain(NO_DETAILS)
      expect(last.body).toContain('Lesson 561')
      expect(last.body).toContain('Lesson 600')
      expect(last.fetches).toEqual(['902.1'])
      expect(last.body).toContain('/ce:connect fetch:902.1')
    })

    it('fails with a fixed reason, and writes nothing, when a payload would not fit the byte bound', () => {
      const fat = (n: number): Json => ({
        id: idOf(n),
        title: 't'.repeat(160),
        summary: 's'.repeat(800),
        kind: 'transferable-lesson',
        nextStep: 'compound-learning',
        targetName: 'target',
        repo: 'acme/target',
        sources: Array.from({ length: 8 }, (_, i) => ({
          projectName: 'p'.repeat(100),
          path: `${'d/'.repeat(100)}${i}.md`,
          excerpt: 'e'.repeat(240),
        })),
        firstShown: DAY_ONE,
        runId: '800',
        attempt: '1',
      })
      const text = (items: readonly Json[]): string =>
        `${JSON.stringify({ version: 1, payloads: items }, null, 2)}\n`
      const limit = 8 * 1024 * 1024
      const sizeOf = (count: number): number =>
        Buffer.byteLength(
          text(Array.from({ length: count }, (_, i) => fat(i + 1))),
        )
      const each = sizeOf(2) - sizeOf(1)
      // The most payloads that a store can hold under the bound.
      let stored = Math.floor(limit / each)
      while (sizeOf(stored) >= limit) stored--
      while (sizeOf(stored + 1) <= limit) stored++
      const items = Array.from({ length: stored }, (_, i) => fat(i + 1))
      expect(Buffer.byteLength(text(items))).toBeLessThan(limit)

      const root = makeRoot()
      const all = Array.from({ length: stored + 1 }, (_, i) => i + 1)
      writeLedger(
        root,
        all.map((n) => entryOf(n)),
      )
      writeRunRecord(root, [
        blockCandidate(stored + 1, {
          title: 't'.repeat(160),
          summary: 's'.repeat(800),
          sources: fat(1).sources,
        }),
      ])
      writeInvocation(root, '900-1')
      fs.writeFileSync(path.join(root, PAYLOAD_FILE), text(items))
      const before = fs.readFileSync(path.join(root, PAYLOAD_FILE))

      expect(renderReport(root, request())).toEqual({
        status: 'failed',
        reason: 'payload-store-too-large',
      })
      expect(
        fs.readFileSync(path.join(root, PAYLOAD_FILE)).equals(before),
      ).toBe(true)
      expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
      expect(fs.existsSync(path.join(root, MANIFEST_FILE))).toBe(false)
    })
  })

  it('ignores a candidate in the run record that the ledger does not show open', () => {
    const root = seeded(1)
    writeRunRecord(root, [blockCandidate(1), blockCandidate(7)])
    rendered(root)
    expect(payloadsOf(root).map((payload) => payload.id)).toEqual([idOf(1)])
  })

  it('gives the same body when the same date is rendered again', () => {
    const root = seeded(3)
    const first = rendered(root)
    const second = rendered(root)
    expect(second.body).toBe(first.body)
    expect(second.fresh).toBe(3)
  })

  it('keeps its stores and its report when the run directories are pruned', () => {
    const root = seeded(2)
    rendered(root)
    const held = acquireLock(root)
    if (held.status !== 'acquired') throw new Error('lock not taken')
    try {
      const pruned = pruneRuns(root, held.lock, {
        now: () => Date.now() + 365 * 24 * 60 * 60 * 1000,
      })
      expect(pruned).toMatchObject({ status: 'pruned' })
    } finally {
      releaseLock(held.lock)
    }
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual([])
    expect(payloadsOf(root)).toHaveLength(2)
    expect(manifestsOf(root)).toHaveLength(1)
    expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(true)
  })

  describe('a code-mismatch candidate', () => {
    const INFRA_ROOT = '/runner/work/connect/checkouts/acme__infra'
    const DEP_ROOT = '/runner/work/connect/checkouts/acme__dependency'
    const INFRA_COMMIT = 'b'.repeat(40)
    const EXCERPT_TEXT = 'handle /app/* { try_files {path} /index.html }'

    function evidenceItem(over: Json = {}): Json {
      return {
        project: INFRA_ROOT,
        projectName: 'infra',
        path: 'caddy/Caddyfile',
        start: 3,
        end: 9,
        fingerprint: sha('caddyfile'),
        excerpt: EXCERPT_TEXT,
        cite: 'x',
        ...over,
      }
    }

    function mismatch(over: Json = {}): Json {
      return blockCandidate(1, {
        kind: 'code-mismatch',
        nextStep: 'refresh-learning',
        reason: 'stale',
        counterevidence: [evidenceItem()],
        ...over,
      })
    }

    const PROJECTS = [
      {
        name: 'target',
        root: PROJECT_ROOT,
        key: PROJECT_KEY,
        repo: 'acme/target',
        commit: 'a'.repeat(40),
      },
      {
        name: 'infra',
        root: INFRA_ROOT,
        key: 'abcdefabcdef',
        repo: 'acme/infra',
        commit: INFRA_COMMIT,
      },
      {
        name: 'dependency',
        root: DEP_ROOT,
        key: 'fedcbafedcba',
        repo: 'acme/dependency',
      },
    ]

    function seededMismatch(candidate: Json = mismatch()): string {
      const root = makeRoot()
      writeLedger(root, [
        entryOf(1, { kind: 'code-mismatch', status: 'candidate' }),
      ])
      writeRunRecord(root, [candidate], { projects: PROJECTS })
      writeInvocation(root, '900-1')
      return root
    }

    it('shows the reason and each evidence as project:path:span:HEAD, and no excerpt', () => {
      const { body } = rendered(seededMismatch())
      expect(body).toContain('Kind: code-mismatch')
      expect(body).toContain('Reason: stale')
      expect(body).toContain(`- infra:caddy/Caddyfile:3-9:${INFRA_COMMIT}`)
      expect(body).not.toContain(EXCERPT_TEXT)
    })

    it('names a missing HEAD as unavailable rather than leaving it out', () => {
      const root = seededMismatch(
        mismatch({
          reason: 'unscoped',
          counterevidence: [
            evidenceItem({
              project: DEP_ROOT,
              projectName: 'dependency',
              path: 'src/loader.ts',
              start: 12,
              end: 14,
            }),
          ],
        }),
      )
      const { body } = rendered(root)
      expect(body).toContain('Reason: unscoped')
      expect(body).toContain('- dependency:src/loader.ts:12-14:unavailable')
    })

    it('lists every evidence in the order the candidate gave them', () => {
      const root = seededMismatch(
        mismatch({
          counterevidence: [
            evidenceItem(),
            evidenceItem({ path: 'caddy/other.conf', start: 1, end: 2 }),
          ],
        }),
      )
      const { body } = rendered(root)
      const first = body.indexOf('infra:caddy/Caddyfile:3-9')
      const second = body.indexOf('infra:caddy/other.conf:1-2')
      expect(first).toBeGreaterThan(-1)
      expect(second).toBeGreaterThan(first)
    })

    it('keeps the reason and the evidence, with their HEADs, after the run record is gone', () => {
      const root = seededMismatch()
      rendered(root)
      const [stored] = payloadsOf(root)
      expect(stored).toMatchObject({
        reason: 'stale',
        evidence: [
          {
            projectName: 'infra',
            repo: 'acme/infra',
            path: 'caddy/Caddyfile',
            start: 3,
            end: 9,
            head: INFRA_COMMIT,
          },
        ],
      })
      expect(JSON.stringify(stored)).not.toContain(EXCERPT_TEXT)

      writeInvocation(root, '901-1', {}, null)
      const { body } = rendered(root, { date: DAY_TWO, runId: '901' })
      expect(body).toContain('Reason: stale')
      expect(body).toContain(`- infra:caddy/Caddyfile:3-9:${INFRA_COMMIT}`)
    })

    it('stores no repository for evidence in a project the run record does not list, so the recheck fails closed on it', () => {
      const root = seededMismatch(
        mismatch({
          counterevidence: [
            evidenceItem({
              project: '/runner/work/connect/checkouts/unlisted',
            }),
          ],
        }),
      )
      rendered(root)
      const [stored] = payloadsOf(root)
      const evidence = (stored?.evidence ?? []) as Json[]
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).not.toHaveProperty('repo')
    })

    it('prints no reason or evidence for a kind that has none', () => {
      const { body } = rendered(seeded(1))
      expect(body).not.toContain('Reason:')
      expect(body).not.toContain('Evidence:')
    })

    it('still renders a stored payload written before these fields existed', () => {
      const root = makeRoot()
      writeLedger(root, [
        entryOf(1, { kind: 'code-mismatch', status: 'candidate' }),
      ])
      fs.writeFileSync(
        path.join(root, PAYLOAD_FILE),
        `${JSON.stringify({
          version: 1,
          payloads: [
            {
              id: idOf(1),
              revision: revisionOf(
                entryOf(1, { kind: 'code-mismatch', status: 'candidate' }),
              ),
              title: 'Old',
              summary: 'Written by an earlier helper.',
              kind: 'transferable-lesson',
              nextStep: 'compound-learning',
              targetName: 'target',
              sources: [],
              runId: '800',
              attempt: '1',
            },
          ],
        })}\n`,
      )
      writeInvocation(root, '900-1', {}, null)
      const { body } = rendered(root)
      expect(body).toContain('Title: Old')
      expect(body).not.toContain('Reason:')
    })

    it('drops a reason that is not one of the two, and evidence on a kind that cannot carry it', () => {
      const bogus = seededMismatch(mismatch({ reason: 'bogus' }))
      expect(rendered(bogus).body).not.toContain('Reason:')

      const other = seededMismatch(
        mismatch({ kind: 'contradiction', reason: undefined }),
      )
      const { body } = rendered(other)
      expect(body).not.toContain('Evidence:')
      expect(body).not.toContain('caddy/Caddyfile')
    })

    it('bounds the evidence list and makes its text inert', () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        evidenceItem({ path: `f${i}.conf`, start: 1, end: 2 }),
      )
      const root = seededMismatch(mismatch({ counterevidence: many }))
      const { body } = rendered(root)
      expect(body.match(/- infra:f\d+\.conf:1-2/g)).toHaveLength(8)

      const hostile = seededMismatch(
        mismatch({
          counterevidence: [
            evidenceItem({ projectName: 'infra @octocat', path: 'a#12.conf' }),
          ],
        }),
      )
      const hostileBody = rendered(hostile).body
      expect(hostileBody).not.toMatch(/@[A-Za-z0-9_]/)
      expect(hostileBody).not.toMatch(/#\d/)
    })

    it('names an unusable span with a question mark and skips an item with no path', () => {
      const root = seededMismatch(
        mismatch({
          counterevidence: [
            evidenceItem({ path: 'bad-span.conf', start: 'x' }),
            evidenceItem({ path: undefined }),
            evidenceItem({ path: 'ok.conf', start: 4, end: 6 }),
          ],
        }),
      )
      const { body } = rendered(root)
      expect(body).toContain('- infra:bad-span.conf:?:')
      expect(body).toContain('- infra:ok.conf:4-6:')
      expect(body.match(/^- infra:/gm)).toHaveLength(2)
    })
  })

  describe('the outcome', () => {
    it('says a complete run is complete and is not red', () => {
      const result = rendered(seeded(1))
      expect(result.outcome).toBe('complete')
      expect(result.red).toBe(false)
      expect(result.body).toContain('Connect complete')
    })

    it('puts the degrade reasons of a degraded run in a fence', () => {
      const root = seeded(1, { degradeReasons: ['ledger-write-failed'] })
      writeInvocation(root, '900-1', {
        outcome: 'degraded',
        finalLine: 'Connect degraded',
      })
      const result = rendered(root)
      expect(result.outcome).toBe('degraded')
      expect(result.red).toBe(false)
      expect(result.body).toMatch(/```[\s\S]*ledger-write-failed[\s\S]*```/)
    })

    it('posts a busy run as itself and is not red', () => {
      const root = seeded(0)
      writeInvocation(
        root,
        '900-1',
        { outcome: 'busy', finalLine: 'Connect busy', reason: 'lock-held' },
        null,
      )
      const result = rendered(root)
      expect(result.outcome).toBe('busy')
      expect(result.red).toBe(false)
      expect(result.body).toContain('Connect busy')
    })

    describe('a busy run while a live holder keeps the lock', () => {
      function busyRoot(): string {
        const root = seeded(2)
        writeInvocation(
          root,
          '900-1',
          { outcome: 'busy', finalLine: 'Connect busy', reason: 'lock-held' },
          null,
        )
        return root
      }

      it('renders the report read-only, says no state was recorded, and leaves the lock with its holder', () => {
        const root = busyRoot()
        const held = acquireLock(root)
        if (held.status !== 'acquired') throw new Error('lock not taken')
        try {
          const ledger = ledgerBytes(root)
          const result = renderReport(root, request())
          if (result.status !== 'rendered') {
            throw new Error(`expected a report: ${JSON.stringify(result)}`)
          }
          expect(result.outcome).toBe('busy')
          expect(result.red).toBe(false)
          expect(result.stateUpdated).toBe(false)
          // No payload store exists, so neither candidate has a bundle to list.
          expect(result).toMatchObject({ open: 2, shown: 0, unverified: 2 })
          expect(result.body).toContain('Connect busy')
          expect(result.body).toMatch(/State not updated/)
          // Nothing stored describes the two candidates, so neither has boxes.
          expect(result.body.split(NO_DETAILS)).toHaveLength(2)
          expect(result.body).toContain(`\`${idOf(1)}\`, \`${idOf(2)}\``)
          expect(parseReportBody(result.body).boxes).toHaveLength(0)
          expect(fs.readFileSync(path.join(root, REPORT_FILE), 'utf8')).toBe(
            result.body,
          )
          expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
          expect(fs.existsSync(path.join(root, MANIFEST_FILE))).toBe(false)
          expect(ledgerBytes(root)).toBe(ledger)
          expect(acquireLock(root).status).toBe('busy')
        } finally {
          releaseLock(held.lock)
        }
      })

      it('records state as usual once the lock is free', () => {
        const root = busyRoot()
        const result = rendered(root)
        expect(result.stateUpdated).toBe(true)
        expect(result.body).not.toMatch(/State not updated/)
        expect(payloadsOf(root)).toHaveLength(0)
        expect(manifestsOf(root)).toHaveLength(1)
      })

      it('still answers busy for a run that is not itself busy', () => {
        const root = seeded(2)
        const held = acquireLock(root)
        if (held.status !== 'acquired') throw new Error('lock not taken')
        try {
          expect(renderReport(root, request()).status).toBe('busy')
          expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
        } finally {
          releaseLock(held.lock)
        }
      })

      it('still refuses a busy answer that belongs to another workflow run', () => {
        const root = busyRoot()
        writeInvocation(
          root,
          '899-1',
          { outcome: 'busy', finalLine: 'Connect busy' },
          null,
        )
        const held = acquireLock(root)
        if (held.status !== 'acquired') throw new Error('lock not taken')
        try {
          expect(renderReport(root, request()).status).toBe('busy')
          expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
        } finally {
          releaseLock(held.lock)
        }
      })

      it('lists the candidates a payload store already holds when the lock is busy', () => {
        const root = seeded(2)
        rendered(root)
        writeInvocation(
          root,
          '901-1',
          { outcome: 'busy', finalLine: 'Connect busy' },
          null,
        )
        const store = fs.readFileSync(path.join(root, PAYLOAD_FILE))
        const held = acquireLock(root)
        if (held.status !== 'acquired') throw new Error('lock not taken')
        try {
          const result = renderReport(root, request({ runId: '901' }))
          if (result.status !== 'rendered') throw new Error('not rendered')
          expect(result.body).toContain('Lesson 1')
          expect(
            fs.readFileSync(path.join(root, PAYLOAD_FILE)).equals(store),
          ).toBe(true)
        } finally {
          releaseLock(held.lock)
        }
      })
    })

    it('posts a failed run as itself, with its reason, and is red', () => {
      const root = seeded(0)
      writeInvocation(
        root,
        '900-1',
        {
          outcome: 'failed',
          finalLine: 'Connect failed',
          reason: 'unsupported-host',
        },
        null,
      )
      const result = rendered(root)
      expect(result.outcome).toBe('failed')
      expect(result.red).toBe(true)
      expect(result.body).toContain('Connect failed')
      expect(result.body).toContain('unsupported-host')
    })

    it('says a run that began and never finished ended with no final line, and is red', () => {
      const root = seeded(0)
      fs.writeFileSync(
        path.join(root, INVOCATION_FILE),
        JSON.stringify({
          version: 1,
          marker: '900-1',
          phase: 'begun',
          runId: CONNECT_RUN,
          projects: [{ key: PROJECT_KEY, name: 'target' }],
        }),
      )
      const result = rendered(root)
      expect(result.outcome).toBe('no-final-line')
      expect(result.red).toBe(true)
      expect(result.body).toMatch(/ended with no final line/)
    })

    it('still reports open candidates when the run failed, by id, since the run left no details', () => {
      const root = seeded(2)
      writeInvocation(
        root,
        '900-1',
        { outcome: 'failed', finalLine: 'Connect failed', reason: 'aborted' },
        null,
      )
      const result = rendered(root)
      expect(result).toMatchObject({ open: 2, shown: 0, unverified: 2 })
      expect(result.body).toContain(`\`${idOf(1)}\`, \`${idOf(2)}\``)
    })

    it('writes nothing when no invocation record carries this run marker', () => {
      const root = seeded(2)
      writeInvocation(root, '899-1')
      const before = ledgerBytes(root)
      const result = renderReport(root, request())
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'no-invocation',
      })
      expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
      expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
      expect(fs.existsSync(path.join(root, MANIFEST_FILE))).toBe(false)
      expect(ledgerBytes(root)).toBe(before)
    })

    it('writes nothing when there is no invocation record', () => {
      const root = seeded(2)
      fs.rmSync(path.join(root, INVOCATION_FILE))
      expect(renderReport(root, request())).toMatchObject({
        status: 'failed',
        reason: 'no-invocation',
      })
    })
  })

  describe('the body cap', () => {
    function crowded(count: number): string {
      const root = makeRoot()
      const numbers = Array.from({ length: count }, (_, i) => i + 1)
      writeLedger(
        root,
        numbers.map((n) => entryOf(n)),
      )
      writeRunRecord(
        root,
        numbers.map((n) =>
          blockCandidate(n, {
            title: `Candidate title ${n} ${'t'.repeat(100)}`,
            summary: `Summary ${n} ${'s'.repeat(700)}`,
          }),
        ),
      )
      writeInvocation(root, '900-1')
      return root
    }

    it('shows the oldest candidates whole, states how many are hidden, and keeps them open', () => {
      const root = crowded(200)
      const result = rendered(root)

      expect(result.body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
      expect(result.shown).toBeGreaterThan(0)
      expect(result.shown).toBeLessThan(200)
      expect(result.hidden).toBe(200 - result.shown)
      expect(result.body).toMatch(
        new RegExp(
          `\\*\\*${result.hidden} open candidates are not shown\\.\\*\\*`,
        ),
      )
      const shownIds = [
        ...result.body.matchAll(/connect-decision:promoted:([0-9a-f]{64})/g),
      ].map((match) => match[1] ?? '')
      expect(shownIds).toEqual(
        Array.from({ length: result.shown }, (_, i) => idOf(i + 1)),
      )
      expect(manifestsOf(root).at(-1)?.ids).toEqual(shownIds)
      for (let n = 1; n <= 200; n++) expect(statusOf(root, n)).toBe('candidate')
    })

    it('never cuts a block: every shown candidate has both boxes and every fence closes', () => {
      const { body } = rendered(crowded(200))
      const blocks = body.split(/^### Candidate /m).slice(1)
      expect(blocks.length).toBeGreaterThan(1)
      for (const block of blocks) {
        expect(block).toMatch(
          /- \[ \] Promoted <!-- connect-decision:promoted:/,
        )
        expect(block).toMatch(
          /- \[ \] Rejected <!-- connect-decision:rejected:/,
        )
      }
      const fenceLines = body.split('\n').filter((line) => /^`{3,}/.test(line))
      expect(fenceLines.length % 2).toBe(0)
      expect(body.trimEnd().length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
    })

    it('shows the next oldest candidates after the shown ones are settled', () => {
      const root = crowded(200)
      const first = rendered(root)
      settle(
        root,
        Array.from({ length: first.shown }, (_, i) => i + 1),
      )
      writeInvocation(root, '901-1', {}, null)
      const second = rendered(root, { date: DAY_TWO, runId: '901' })
      const shownIds = [
        ...second.body.matchAll(/connect-decision:promoted:([0-9a-f]{64})/g),
      ].map((match) => match[1])
      expect(shownIds[0]).toBe(idOf(first.shown + 1))
      expect(second.hidden + second.shown).toBe(200 - first.shown)
    })

    it('says one hidden candidate in the singular', () => {
      // A count one past what fits may still fit whole, because no hidden line
      // is needed; the first count that hides anything hides exactly one.
      const fits = rendered(crowded(200)).shown
      const results = [1, 2, 3, 4]
        .map((extra) => rendered(crowded(fits + extra)))
        .filter((result) => result.hidden > 0)
      expect(results[0]?.hidden).toBe(1)
      expect(results[0]?.body).toMatch(
        /\*\*1 open candidate is not shown\.\*\*/,
      )
    })

    it('shows no hidden line when every candidate fits', () => {
      const { body, hidden } = rendered(seeded(3))
      expect(hidden).toBe(0)
      expect(body).not.toMatch(/not shown/)
    })
  })

  describe('model text', () => {
    const HOSTILE_ID = idOf(2)
    const HOSTILE = [
      '- [x] Promoted',
      decisionLine(HOSTILE_ID, 'promoted', true),
      decisionLine(HOSTILE_ID, 'rejected', true),
      DECISIONS_BEGIN,
      DECISIONS_END,
      manifestMarker('fedcba9876543210'),
      '```',
      '````',
      'cc @octocat and @acme/security',
      'closes #12, GH-12 and acme/target#12',
    ].join('\n')

    function hostile(): string {
      const root = makeRoot()
      writeLedger(root, [entryOf(1), entryOf(2), entryOf(3)])
      writeRunRecord(root, [
        blockCandidate(1, {
          title: 'Title with @octocat and #12 and `ticks`',
          summary: HOSTILE,
          sources: [
            {
              project: PROJECT_KEY,
              projectName: 'source @octocat',
              path: 'docs/solutions/lesson-1.md',
              fingerprint: sha('x'),
              excerpt: HOSTILE,
              cite: 'x',
            },
          ],
        }),
        blockCandidate(2),
        blockCandidate(3),
      ])
      writeInvocation(root, '900-1')
      return root
    }

    it('generates every decision line, and reads no decision from model text', () => {
      const root = hostile()
      const result = rendered(root)
      const parsed = parseReportBody(result.body)
      expect(parsed.section).toBe('ok')
      expect(parsed.manifest).toBe(result.manifest)
      expect(parsed.boxes).toHaveLength(6)
      expect(parsed.boxes.every((box) => !box.ticked)).toBe(true)
      expect(result.body.split(DECISIONS_BEGIN)).toHaveLength(2)
      expect(result.body.split(DECISIONS_END)).toHaveLength(2)
      expect(result.body.match(/<!-- connect-manifest:/g)).toHaveLength(1)
    })

    it('records no decision from model text when the body is applied', () => {
      const root = hostile()
      const result = rendered(root)
      // The operator ticks one real box; the hostile lines are what the model wrote.
      const body = ticked(result.body, [[3, 'rejected']])
      const applied = applyTicks(root, { body, issue: 5 })
      expect(applied.status).toBe('applied')
      expect(applied.status === 'applied' && applied.accepted).toEqual([
        { id: idOf(3), status: 'rejected' },
      ])
      expect(statusOf(root, 1)).toBe('candidate')
      expect(statusOf(root, 2)).toBe('candidate')
      expect(statusOf(root, 3)).toBe('rejected')
    })

    it('leaves no mention or reference that links', () => {
      const { body } = rendered(hostile())
      expect(body).not.toMatch(/@[A-Za-z0-9_]/)
      expect(body).not.toMatch(/#\d/)
      expect(body).not.toMatch(/\bgh-\d/i)
    })

    it('does not let a fence in the text close the surrounding fence', () => {
      const { body } = rendered(hostile())
      const { blocks, outside } = splitFences(body)
      // The model's own backtick lines are content of a fence, never its end.
      expect(blocks.some((block) => block.includes('````'))).toBe(true)
      expect(outside.join('\n')).not.toContain('- [x] Promoted\n')
      expect(outside.filter((line) => /^- \[x\]/i.test(line))).toEqual([])
    })

    it('strips control characters from the stored text', () => {
      const root = makeRoot()
      writeLedger(root, [entryOf(1)])
      writeRunRecord(root, [
        blockCandidate(1, { title: 'bad\u0000\u202etitle\u0007' }),
      ])
      writeInvocation(root, '900-1')
      const { body } = rendered(root)
      expect(body.replaceAll('\n', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u)
      expect(body).toContain('badtitle')
    })
  })

  describe('untrusted files', () => {
    it('bounds an oversize payload and drops unknown keys', () => {
      const root = seeded(1, {})
      writeRunRecord(root, [
        blockCandidate(1, {
          title: 't'.repeat(5000),
          summary: 's'.repeat(50_000),
          nextStep: 'x'.repeat(5000),
          extraField: 'dropped',
          sources: Array.from({ length: 50 }, (_, i) => ({
            project: PROJECT_KEY,
            projectName: 'p'.repeat(1000),
            path: `docs/solutions/${'d'.repeat(5000)}-${i}.md`,
            fingerprint: sha(`${i}`),
            excerpt: 'e'.repeat(5000),
            cite: 'x',
          })),
        }),
      ])
      const result = rendered(root)
      expect(result.body.length).toBeLessThan(REPORT_MAX_CHARS)
      const [payload] = payloadsOf(root)
      expect(JSON.stringify(payload).length).toBeLessThan(12_000)
      expect(payload).not.toHaveProperty('extraField')
    })

    it('does not throw on a run record with wrong types, and lists the candidate by id', () => {
      const root = seeded(1)
      writeRunRecord(
        root,
        [blockCandidate(1, { title: 5, summary: ['x'], sources: 'no' })],
        { sweep: { total: 'many' }, selection: 'all', projects: 'none' },
      )
      const result = rendered(root)
      expect(result).toMatchObject({ open: 1, shown: 0, unverified: 1 })
      expect(result.body).toContain(NO_DETAILS)
      expect(result.body).not.toContain('connect-decision:')
    })

    it('does not throw on a candidate block that is not a list', () => {
      const root = seeded(1)
      writeRunRecord(root, [], { candidateBlock: 'nope' })
      expect(rendered(root)).toMatchObject({ open: 1, unverified: 1 })
    })

    it('treats an invocation record with the wrong types as absent', () => {
      const root = seeded(1)
      fs.writeFileSync(
        path.join(root, INVOCATION_FILE),
        JSON.stringify({
          version: 1,
          marker: '900-1',
          phase: 'terminal',
          outcome: 'complete',
          finalLine: 'Connect complete',
          projects: 'none',
        }),
      )
      expect(renderReport(root, request())).toMatchObject({
        status: 'failed',
        reason: 'no-invocation',
      })
    })

    it('starts a payload store again when the file is missing', () => {
      const root = seeded(2)
      expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
      expect(rendered(root).shown).toBe(2)
      expect(payloadsOf(root)).toHaveLength(2)
    })

    describe('an unreadable payload store', () => {
      const GARBAGE = '{ not json'

      function refused(root: string, content: string | Buffer): void {
        const file = path.join(root, PAYLOAD_FILE)
        fs.writeFileSync(file, content)
        const before = fs.readFileSync(file)
        const ledger = ledgerBytes(root)
        expect(renderReport(root, request())).toEqual({
          status: 'failed',
          reason: 'payload-store-unreadable',
        })
        expect(fs.readFileSync(file).equals(before)).toBe(true)
        expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
        expect(fs.existsSync(path.join(root, MANIFEST_FILE))).toBe(false)
        expect(ledgerBytes(root)).toBe(ledger)
      }

      it('is refused when it is not JSON, and left as it was', () => {
        refused(seeded(2), GARBAGE)
      })

      it('is refused when it is over the read bound', () => {
        refused(seeded(2), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))
      })

      it('is refused when it is not a version 1 store', () => {
        for (const content of [
          '[]',
          'null',
          JSON.stringify({ version: 2, payloads: [] }),
          JSON.stringify({ version: 1 }),
          JSON.stringify({ version: 1, payloads: {} }),
        ]) {
          refused(seeded(2), content)
        }
      })

      it('is refused when it is a symlink, and the target is not rewritten', () => {
        const root = seeded(2)
        const target = path.join(path.dirname(root), 'elsewhere.json')
        fs.writeFileSync(target, '{"version":1,"payloads":[]}')
        fs.symlinkSync(target, path.join(root, PAYLOAD_FILE))
        expect(renderReport(root, request())).toEqual({
          status: 'failed',
          reason: 'payload-store-unreadable',
        })
        expect(fs.readFileSync(target, 'utf8')).toBe(
          '{"version":1,"payloads":[]}',
        )
      })

      it('is refused when it is a directory', () => {
        const root = seeded(2)
        fs.mkdirSync(path.join(root, PAYLOAD_FILE))
        expect(renderReport(root, request())).toEqual({
          status: 'failed',
          reason: 'payload-store-unreadable',
        })
      })
    })

    it('drops a stored payload with the wrong shape and keeps the valid ones', () => {
      const root = seeded(2)
      rendered(root)
      const store = readJson(root, PAYLOAD_FILE)
      const payloads = store.payloads as Json[]
      fs.writeFileSync(
        path.join(root, PAYLOAD_FILE),
        JSON.stringify({
          version: 1,
          payloads: [
            { ...payloads[0], title: 42 },
            { ...payloads[1], injected: 'x' },
          ],
        }),
      )
      writeRunRecord(root, [])
      writeInvocation(root, '901-1', {}, null)
      const next = rendered(root, { date: DAY_TWO, runId: '901' })
      expect(next.body).toContain(NO_DETAILS)
      expect(next.body).toContain('Lesson 2')
      expect(next.body).not.toContain('injected')
    })

    it('refuses a ledger it cannot read and writes nothing', () => {
      const root = seeded(1)
      fs.writeFileSync(path.join(root, 'ledger.json'), '{ nope')
      expect(renderReport(root, request())).toMatchObject({
        status: 'failed',
        reason: 'ledger-unreadable',
      })
      expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
      expect(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')).toBe(
        '{ nope',
      )
    })

    it('refuses a request that is not a date and a GitHub run', () => {
      const root = seeded(1)
      for (const bad of [
        { date: '2026-13-40' },
        { date: '12/11/2026' },
        { runId: 'abc' },
        { runId: '' },
        { attempt: '0x1' },
        { attempt: '' },
      ]) {
        expect(renderReport(root, request(bad))).toMatchObject({
          status: 'failed',
          reason: 'invalid-request',
        })
      }
      expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
    })

    it('answers busy and writes nothing while a run holds the lock', () => {
      const root = seeded(1)
      const held = acquireLock(root)
      if (held.status !== 'acquired') throw new Error('lock not taken')
      try {
        expect(renderReport(root, request()).status).toBe('busy')
        expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
      } finally {
        releaseLock(held.lock)
      }
    })
  })

  describe('the manifest store', () => {
    it('keeps the last fourteen and never replaces an older one', () => {
      expect(MANIFESTS_KEPT).toBe(14)
      const root = makeRoot()
      writeLedger(root, [])
      const hashes: string[] = []
      for (let n = 1; n <= MANIFESTS_KEPT + 1; n++) {
        const entries = Array.from({ length: n }, (_, i) => entryOf(i + 1))
        writeLedger(root, entries)
        writeRunRecord(
          root,
          entries.map((_, i) => blockCandidate(i + 1)),
        )
        writeInvocation(root, `${900 + n}-1`)
        hashes.push(rendered(root, { runId: String(900 + n) }).manifest)
      }
      const stored = manifestsOf(root)
      expect(stored).toHaveLength(MANIFESTS_KEPT)
      expect(stored.map((item) => item.hash)).toEqual(hashes.slice(1))
      expect(stored[0]?.ids).toEqual([idOf(1), idOf(2)])
    })

    it('keeps one copy of a manifest that a later render rebuilds', () => {
      const root = seeded(2)
      const first = rendered(root)
      const again = rendered(root)
      expect(again.manifest).toBe(first.manifest)
      expect(manifestsOf(root)).toHaveLength(1)
    })

    describe('an unreadable manifest store', () => {
      function refused(root: string, content: string | Buffer): void {
        const file = path.join(root, MANIFEST_FILE)
        fs.writeFileSync(file, content)
        const before = fs.readFileSync(file)
        expect(renderReport(root, request())).toEqual({
          status: 'failed',
          reason: 'manifest-store-unreadable',
        })
        expect(fs.readFileSync(file).equals(before)).toBe(true)
        expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
        expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
      }

      it('is refused when it is not JSON, and the payload store is not written either', () => {
        refused(seeded(2), '{ not json')
      })

      it('is refused when it is over the read bound', () => {
        refused(seeded(2), Buffer.alloc(1024 * 1024 + 1, 0x20))
      })

      it('is refused when it is not a version 1 store', () => {
        for (const content of [
          '[]',
          JSON.stringify({ version: 2, manifests: [] }),
          JSON.stringify({ version: 1 }),
        ]) {
          refused(seeded(2), content)
        }
      })

      it('starts a manifest store again when the file is missing', () => {
        const root = seeded(2)
        rendered(root)
        fs.rmSync(path.join(root, MANIFEST_FILE))
        rendered(root)
        expect(manifestsOf(root)).toHaveLength(1)
      })

      it('reads no ticks against it and writes nothing', () => {
        const root = seeded(2)
        const { body } = rendered(root)
        fs.writeFileSync(path.join(root, MANIFEST_FILE), '{ not json')
        const before = ledgerBytes(root)
        const result = applyTicks(root, {
          body: ticked(body, [[1, 'rejected']]),
          issue: 7,
        })
        expect(result).toMatchObject({
          status: 'applied',
          accepted: [],
          unresolved: [{ id: idOf(1), reason: 'manifest-missing' }],
        })
        expect(ledgerBytes(root)).toBe(before)
      })
    })

    it('skips a stored manifest with an unknown key or a hash that does not match its ids', () => {
      const root = seeded(2)
      const first = rendered(root)
      fs.writeFileSync(
        path.join(root, MANIFEST_FILE),
        JSON.stringify({
          version: 1,
          manifests: [
            { hash: first.manifest, ids: [idOf(1), idOf(2)], extra: 1 },
            { hash: 'fedcba9876543210', ids: [idOf(1)] },
          ],
        }),
      )
      rendered(root)
      expect(manifestsOf(root).map((item) => item.hash)).toEqual([
        first.manifest,
      ])
    })
  })
})

// ── Applying ticks ──────────────────────────────────────────────────────────

describe('applyTicks', () => {
  function reported(count = 3) {
    const root = seeded(count)
    const result = rendered(root)
    return { root, body: result.body }
  }

  it('records each tick with the report number, and lists what it accepted', () => {
    const { root, body } = reported(3)
    const result = applyTicks(root, {
      body: ticked(body, [
        [1, 'rejected'],
        [2, 'rejected'],
        [3, 'promoted'],
      ]),
      issue: 42,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [
        { id: idOf(1), status: 'rejected' },
        { id: idOf(2), status: 'rejected' },
        { id: idOf(3), status: 'promoted' },
      ],
      skipped: [],
      unresolved: [],
    })
    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error('ledger')
    expect(
      read.ledger.entries.map((entry) => [entry.status, entry.reason]),
    ).toEqual([
      ['rejected', 'settled in report #42'],
      ['rejected', 'settled in report #42'],
      ['promoted', 'settled in report #42'],
    ])
  })

  it('omits a rejected candidate from the next report and lists the unticked one again', () => {
    const { root, body } = reported(2)
    applyTicks(root, { body: ticked(body, [[1, 'rejected']]), issue: 7 })
    writeInvocation(root, '901-1', {}, null)
    const next = rendered(root, { date: DAY_TWO, runId: '901' })
    expect(next.body).not.toContain(idOf(1))
    expect(next.body).toContain(boxLine(2, 'promoted', false))
    expect(next.body).toContain(boxLine(2, 'rejected', false))
  })

  it('skips a candidate that another decision settled after the ticks were read', () => {
    const { root, body } = reported(2)
    const result = applyTicks(
      root,
      {
        body: ticked(body, [
          [1, 'rejected'],
          [2, 'promoted'],
        ]),
        issue: 9,
      },
      {
        hooks: {
          afterTriage: () => {
            const decided = decideLedgerEntry(root, {
              id: idOf(1),
              status: 'promoted',
              reason: 'promoted by hand',
              destination: 'docs/solutions/x.md',
            })
            expect(decided.status).toBe('decided')
          },
        },
      },
    )

    expect(result).toMatchObject({
      status: 'applied',
      accepted: [{ id: idOf(2), status: 'promoted' }],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'not-open' }],
    })
    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error('ledger unreadable')
    expect(
      read.ledger.entries.map((entry) => [entry.status, entry.reason]),
    ).toEqual([
      ['promoted', 'promoted by hand'],
      ['promoted', 'settled in report #9'],
    ])
  })

  it('does nothing the second time', () => {
    const { root, body } = reported(2)
    const ticks = ticked(body, [
      [1, 'rejected'],
      [2, 'promoted'],
    ])
    applyTicks(root, { body: ticks, issue: 42 })
    const bytes = ledgerBytes(root)
    const again = applyTicks(root, { body: ticks, issue: 42 })
    expect(again).toMatchObject({
      status: 'applied',
      accepted: [],
      skipped: [
        { id: idOf(1), reason: 'already-recorded' },
        { id: idOf(2), reason: 'already-recorded' },
      ],
    })
    expect(ledgerBytes(root)).toBe(bytes)
  })

  it('reports both boxes ticked as a conflict and records neither', () => {
    const { root, body } = reported(2)
    const before = ledgerBytes(root)
    const result = applyTicks(root, {
      body: ticked(body, [
        [1, 'rejected'],
        [1, 'promoted'],
        [2, 'rejected'],
      ]),
      issue: 9,
    })
    expect(result).toMatchObject({
      accepted: [{ id: idOf(2), status: 'rejected' }],
      skipped: [{ id: idOf(1), reason: 'conflict' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
    expect(ledgerBytes(root)).not.toBe(before)
  })

  it('skips an id the manifest does not hold, and an id that is no longer open', () => {
    const { root, body } = reported(2)
    settle(root, [2], 'promoted')
    // A tick for candidate 4, a candidate that was never in this report.
    const forged = body.replace(
      DECISIONS_END,
      `${decisionLine(idOf(4), 'rejected', true)}\n${DECISIONS_END}`,
    )
    const result = applyTicks(root, {
      body: ticked(forged, [
        [1, 'rejected'],
        [2, 'rejected'],
      ]),
      issue: 3,
    })
    expect(result).toMatchObject({
      accepted: [{ id: idOf(1), status: 'rejected' }],
    })
    const skipped = result.status === 'applied' ? result.skipped : []
    expect(skipped).toContainEqual({
      id: idOf(2),
      status: 'rejected',
      reason: 'not-open',
    })
    expect(skipped).toContainEqual({
      id: idOf(4),
      status: 'rejected',
      reason: 'not-in-manifest',
    })
    expect(statusOf(root, 2)).toBe('promoted')
  })

  it('reports an id the ledger does not know as unresolved, not as a failure', () => {
    const { root, body } = reported(2)
    writeLedger(root, [])
    const result = applyTicks(root, {
      body: ticked(body, [[1, 'rejected']]),
      issue: 3,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [],
      unresolved: [
        { id: idOf(1), status: 'rejected', reason: 'unknown-candidate' },
      ],
    })
  })

  it('reports every tick unresolved and records none when the body has no manifest marker', () => {
    const { root, body } = reported(2)
    const before = ledgerBytes(root)
    const stripped = body.replace(/<!-- connect-manifest:[0-9a-f]+ -->\n?/, '')
    const result = applyTicks(root, {
      body: ticked(stripped, [
        [1, 'rejected'],
        [2, 'promoted'],
      ]),
      issue: 3,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [],
      unresolved: [
        { id: idOf(1), status: 'rejected', reason: 'manifest-missing' },
        { id: idOf(2), status: 'promoted', reason: 'manifest-missing' },
      ],
    })
    expect(ledgerBytes(root)).toBe(before)
  })

  it('reports every tick unresolved when the marker names a manifest that is not stored', () => {
    const { root, body } = reported(2)
    const before = ledgerBytes(root)
    const other = body.replace(
      /<!-- connect-manifest:[0-9a-f]+ -->/,
      manifestMarker('fedcba9876543210'),
    )
    const result = applyTicks(root, {
      body: ticked(other, [[1, 'rejected']]),
      issue: 3,
    })
    expect(result).toMatchObject({
      accepted: [],
      unresolved: [{ id: idOf(1), reason: 'manifest-missing' }],
    })
    expect(ledgerBytes(root)).toBe(before)
  })

  it('reads a tick as unresolved once its manifest is evicted from the store', () => {
    const { root, body } = reported(1)
    for (let n = 2; n <= MANIFESTS_KEPT + 1; n++) {
      const entries = Array.from({ length: n }, (_, i) => entryOf(i + 1))
      writeLedger(root, entries)
      writeRunRecord(
        root,
        entries.map((_, i) => blockCandidate(i + 1)),
      )
      writeInvocation(root, `${900 + n}-1`)
      rendered(root, { runId: String(900 + n) })
    }
    const result = applyTicks(root, {
      body: ticked(body, [[1, 'rejected']]),
      issue: 3,
    })
    expect(result).toMatchObject({
      accepted: [],
      unresolved: [{ id: idOf(1), reason: 'manifest-missing' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it("resolves the ticks of a report whose post failed against that report's own manifest", () => {
    const { root, body } = reported(2)
    // The next render succeeds, adds a candidate, and its post fails: its body
    // is never seen, and the visible report is still the one above.
    writeLedger(root, [entryOf(1), entryOf(2), entryOf(3)])
    writeRunRecord(root, [blockCandidate(3)], {}, 'run-next')
    writeInvocation(root, '902-1', {}, 'run-next')
    const newer = rendered(root, { date: DAY_TWO, runId: '902' })
    expect(newer.manifest).not.toBe(parseReportBody(body).manifest)

    const result = applyTicks(root, {
      body: ticked(body, [[2, 'rejected']]),
      issue: 11,
    })
    expect(result).toMatchObject({
      accepted: [{ id: idOf(2), status: 'rejected' }],
    })
  })

  it('reads no ticks against a stored manifest that has an unknown key', () => {
    const { root, body } = reported(2)
    const stored = readJson(root, MANIFEST_FILE)
    const [manifest] = stored.manifests as Json[]
    fs.writeFileSync(
      path.join(root, MANIFEST_FILE),
      JSON.stringify({ version: 1, manifests: [{ ...manifest, extra: true }] }),
    )
    const before = ledgerBytes(root)
    expect(
      applyTicks(root, { body: ticked(body, [[1, 'rejected']]), issue: 3 }),
    ).toMatchObject({
      accepted: [],
      unresolved: [{ id: idOf(1), reason: 'manifest-missing' }],
    })
    expect(ledgerBytes(root)).toBe(before)
  })

  it('ignores a tick outside the section and inside a fence', () => {
    const { root, body } = reported(2)
    const outside = `${decisionLine(idOf(1), 'rejected', true)}\n${body}`
    const fenced = outside.replace(
      DECISIONS_BEGIN,
      `${DECISIONS_BEGIN}\n\`\`\`\n${decisionLine(idOf(2), 'rejected', true)}\n\`\`\``,
    )
    const before = ledgerBytes(root)
    const result = applyTicks(root, { body: fenced, issue: 3 })
    expect(result).toMatchObject({ status: 'applied', accepted: [] })
    expect(ledgerBytes(root)).toBe(before)
  })

  it('records nothing from a body with no section or a malformed one', () => {
    const { root, body } = reported(2)
    const before = ledgerBytes(root)
    const missing = body.replace(DECISIONS_BEGIN, '').replace(DECISIONS_END, '')
    expect(applyTicks(root, { body: missing, issue: 3 })).toMatchObject({
      status: 'applied',
      section: 'missing',
      accepted: [],
    })
    const doubled = `${ticked(body, [[1, 'rejected']])}\n${DECISIONS_BEGIN}\n`
    expect(applyTicks(root, { body: doubled, issue: 3 })).toMatchObject({
      status: 'applied',
      section: 'malformed',
      accepted: [],
    })
    expect(ledgerBytes(root)).toBe(before)
  })

  it('answers busy while a run holds the lock, and records nothing', () => {
    const { root, body } = reported(2)
    const before = ledgerBytes(root)
    const held = acquireLock(root)
    if (held.status !== 'acquired') throw new Error('lock not taken')
    try {
      const result = applyTicks(root, {
        body: ticked(body, [[1, 'rejected']]),
        issue: 3,
      })
      expect(result.status).toBe('busy')
      expect(ledgerBytes(root)).toBe(before)
    } finally {
      releaseLock(held.lock)
    }
  })

  it('needs no lock when nothing is ticked', () => {
    const { root, body } = reported(2)
    const held = acquireLock(root)
    if (held.status !== 'acquired') throw new Error('lock not taken')
    try {
      expect(applyTicks(root, { body, issue: 3 })).toMatchObject({
        status: 'applied',
        accepted: [],
        skipped: [],
        unresolved: [],
      })
    } finally {
      releaseLock(held.lock)
    }
  })

  it('refuses a ledger it cannot read and leaves it alone', () => {
    const { root, body } = reported(1)
    fs.writeFileSync(path.join(root, 'ledger.json'), '{ nope')
    expect(
      applyTicks(root, { body: ticked(body, [[1, 'rejected']]), issue: 3 }),
    ).toMatchObject({ status: 'failed', reason: 'ledger-unreadable' })
    expect(ledgerBytes(root)).toBe('{ nope')
  })

  it('refuses a report number that is not a positive integer', () => {
    const { root, body } = reported(1)
    for (const issue of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(applyTicks(root, { body, issue })).toMatchObject({
        status: 'failed',
        reason: 'invalid-request',
      })
    }
  })

  it('reads the ticks of a body a browser edited, with carriage returns', () => {
    const { root, body } = reported(1)
    const edited = ticked(body, [[1, 'rejected']]).replaceAll('\n', '\r\n')
    expect(applyTicks(root, { body: edited, issue: 3 })).toMatchObject({
      accepted: [{ id: idOf(1), status: 'rejected' }],
    })
  })
})

// ── Reading a body file ─────────────────────────────────────────────────────

/** A variant of candidate `index`'s content: another learning fingerprint, so another revision. */
function contentOf(index: number, variant: string): LedgerEntry {
  const base = entryOf(index)
  return {
    ...base,
    sources: base.sources.map((source) => ({
      ...source,
      fingerprint: sha(`${variant}-${index}`),
    })),
  }
}

const revisionOfContent = (index: number, variant: string): string =>
  revisionOf(contentOf(index, variant))

/** The revision the run record gives a candidate it proposes: what the run's digest was written against. */
function stampProposal(
  root: string,
  index: number,
  revision: string | undefined,
): void {
  const file = path.join(root, 'runs', CONNECT_RUN, 'run.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    candidateBlock: { candidates: Array<Record<string, unknown>> }
  }
  for (const item of record.candidateBlock.candidates) {
    if (item.id !== idOf(index)) continue
    if (revision === undefined) delete item.revision
    else item.revision = revision
  }
  fs.writeFileSync(file, JSON.stringify(record))
}

describe('the revision of a report', () => {
  /** The ledger as the state module leaves it when a candidate's content changes: still a candidate, with a reopen on it. */
  function reopen(root: string, index: number, variant: string): string {
    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error('ledger unreadable in a test')
    const changed = contentOf(index, variant)
    writeLedger(
      root,
      read.ledger.entries.map((entry) =>
        entry.id === idOf(index)
          ? {
              ...entry,
              status: 'candidate',
              sources: changed.sources,
              reopened: 'sources changed',
              history: [
                ...entry.history,
                { ...entry, history: undefined } as never,
              ],
            }
          : entry,
      ),
    )
    const revision = revisionOfContent(index, variant)
    // The run that reopened it proposed that content.
    stampProposal(root, index, revision)
    return revision
  }

  function withTick(body: string, line: string): string {
    return body.replace(DECISIONS_END, `${line}\n${DECISIONS_END}`)
  }

  function bodyOf(root: string): string {
    return rendered(root).body
  }

  const boxesOf = (body: string, index: number): string[] =>
    body
      .split('\n')
      .filter((line) => line.includes(idOf(index)) && line.startsWith('- ['))

  it('writes a line without a revision exactly as a report did before revisions', () => {
    expect(decisionLine(idOf(1), 'rejected', false)).toBe(
      `- [ ] Rejected <!-- connect-decision:rejected:${idOf(1)} -->`,
    )
  })

  it('writes the revision into the line', () => {
    expect(decisionLine(idOf(1), 'promoted', false, 'a1b2c3d4e5f6')).toBe(
      `- [ ] Promoted <!-- connect-decision:promoted:${idOf(1)}:ra1b2c3d4e5f6 -->`,
    )
  })

  it('reads the revision of a line, and reads a line without one as from before revisions', () => {
    const body = [
      manifestMarker('0123456789abcdef'),
      DECISIONS_BEGIN,
      decisionLine(idOf(1), 'promoted', true),
      decisionLine(idOf(2), 'rejected', true, 'a1b2c3d4e5f6'),
      DECISIONS_END,
    ].join('\n')
    expect(parseReportBody(body).boxes).toEqual([
      { id: idOf(1), status: 'promoted', ticked: true, revision: undefined },
      {
        id: idOf(2),
        status: 'rejected',
        ticked: true,
        revision: 'a1b2c3d4e5f6',
      },
    ])
  })

  it('ignores a line whose revision is not 12 lowercase hex characters', () => {
    for (const text of [
      'r',
      'rA1B2C3D4E5F6',
      'ra1b2c3d4e5',
      'ra1b2c3d4e5f67',
      'g1',
      'a1b2c3d4e5f6',
    ]) {
      const line = `- [x] Rejected <!-- connect-decision:rejected:${idOf(1)}:${text} -->`
      const body = [DECISIONS_BEGIN, line, DECISIONS_END].join('\n')
      expect(parseReportBody(body).boxes).toEqual([])
    }
  })

  it('writes every box with the revision of its candidate, unticked', () => {
    const root = seeded(2)
    const body = bodyOf(root)
    for (const index of [1, 2]) {
      expect(boxesOf(body, index)).toEqual([
        boxLine(index, 'promoted', false),
        boxLine(index, 'rejected', false),
      ])
    }
    expect(boxLine(1, 'promoted', false)).not.toBe(
      boxLine(2, 'promoted', false).replace(idOf(2), idOf(1)),
    )
    expect(body).not.toContain('(reopened)')
    expect(body).not.toContain('- [x]')
  })

  it('lists a reopened candidate again with its new revision, unticked, and says so', () => {
    const root = seeded(2)
    applyTicks(root, {
      body: ticked(bodyOf(root), [[1, 'rejected']]),
      issue: 5,
    })
    expect(statusOf(root, 1)).toBe('rejected')

    const revision = reopen(root, 1, 'edited')
    writeInvocation(root, '901-1')
    const after = rendered(root, { runId: '901', date: DAY_TWO }).body

    expect(boxesOf(after, 1)).toEqual([
      boxLine(1, 'promoted', false, revision),
      boxLine(1, 'rejected', false, revision),
    ])
    expect(revision).not.toBe(revisionOf(entryOf(1)))
    expect(after).not.toContain('- [x]')
    expect(after.match(/\(reopened\)/g)).toHaveLength(1)
    expect(boxesOf(after, 2)).toEqual([
      boxLine(2, 'promoted', false),
      boxLine(2, 'rejected', false),
    ])
  })

  it('skips a tick made before the content changed as stale and leaves the candidate open', () => {
    const root = seeded(2)
    const ticks = ticked(bodyOf(root), [
      [1, 'rejected'],
      [2, 'rejected'],
    ])
    reopen(root, 1, 'edited')
    const result = applyTicks(root, { body: ticks, issue: 8 })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [{ id: idOf(2), status: 'rejected' }],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'stale' }],
      unresolved: [],
    })
    expect(statusOf(root, 1)).toBe('candidate')
    expect(statusOf(root, 2)).toBe('rejected')
  })

  it('applies a tick made against the current revision', () => {
    const root = seeded(2)
    const revision = reopen(root, 1, 'edited')
    const body = bodyOf(root)
    const open = boxLine(1, 'rejected', false, revision)
    expect(body).toContain(open)
    const result = applyTicks(root, {
      body: body.replace(open, boxLine(1, 'rejected', true, revision)),
      issue: 11,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [{ id: idOf(1), status: 'rejected' }],
      skipped: [],
    })
    expect(statusOf(root, 1)).toBe('rejected')
  })

  it('skips a line from before revisions as unversioned, whether or not the candidate ever reopened', () => {
    const old = (index: number) =>
      `- [x] Rejected <!-- connect-decision:rejected:${idOf(index)} -->`
    const root = seeded(2)
    const body = withTick(withTick(bodyOf(root), old(1)), old(2))
    reopen(root, 2, 'edited')
    const result = applyTicks(root, { body, issue: 12 })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [],
      skipped: [
        { id: idOf(1), status: 'rejected', reason: 'unversioned' },
        { id: idOf(2), status: 'rejected', reason: 'unversioned' },
      ],
    })
    for (const index of [1, 2]) {
      expect(statusOf(root, index)).toBe('candidate')
    }
  })

  it('records nothing for a legacy tick behind a cache rollback, whatever manifest ids it names', () => {
    // A report from before revisions listed these ids and was ticked; its cache save failed,
    // so the ledger this run restores is the one from before that reopen.
    const root = seeded(2)
    const legacy = bodyOf(root)
      .replaceAll(/:r[0-9a-f]{12}/g, '')
      .replace(
        `- [ ] Rejected <!-- connect-decision:rejected:${idOf(1)} -->`,
        `- [x] Rejected <!-- connect-decision:rejected:${idOf(1)} -->`,
      )
    const before = ledgerBytes(root)
    expect(applyTicks(root, { body: legacy, issue: 20 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'unversioned' }],
      unresolved: [],
    })
    expect(ledgerBytes(root)).toBe(before)
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it('skips a tick for a revision the ledger does not hold', () => {
    const root = seeded(1)
    const forged = withTick(
      bodyOf(root),
      boxLine(1, 'rejected', true, 'ffffffffffff'),
    )
    expect(applyTicks(root, { body: forged, issue: 3 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'stale' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it('treats two ticks for one candidate at different revisions as a conflict', () => {
    const root = seeded(1)
    const body = bodyOf(root)
    const forged = withTick(
      withTick(body, boxLine(1, 'rejected', true)),
      boxLine(1, 'rejected', true, 'ffffffffffff'),
    )
    expect(applyTicks(root, { body: forged, issue: 3 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), reason: 'conflict' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it('skips a tick as stale when the content changes after the ticks were read', () => {
    const root = seeded(2)
    const body = ticked(bodyOf(root), [
      [1, 'rejected'],
      [2, 'rejected'],
    ])
    const result = applyTicks(
      root,
      { body, issue: 14 },
      { hooks: { afterTriage: () => reopen(root, 1, 'edited') } },
    )
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [{ id: idOf(2), status: 'rejected' }],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'stale' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it('reports an old tick as stale, not as already recorded, once the new revision was settled with the same reason', () => {
    const root = seeded(1)
    const old = ticked(bodyOf(root), [[1, 'rejected']])
    const revision = reopen(root, 1, 'edited')
    const fresh = withTick(bodyOf(root), boxLine(1, 'rejected', true, revision))
    applyTicks(root, { body: fresh, issue: 16 })
    expect(statusOf(root, 1)).toBe('rejected')
    const bytes = ledgerBytes(root)
    expect(applyTicks(root, { body: old, issue: 16 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), status: 'rejected', reason: 'stale' }],
    })
    expect(ledgerBytes(root)).toBe(bytes)
  })

  it('does nothing the second time for a reopened candidate it settled', () => {
    const root = seeded(1)
    const revision = reopen(root, 1, 'edited')
    const body = withTick(bodyOf(root), boxLine(1, 'rejected', true, revision))
    applyTicks(root, { body, issue: 15 })
    const bytes = ledgerBytes(root)
    expect(applyTicks(root, { body, issue: 15 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), reason: 'already-recorded' }],
    })
    expect(ledgerBytes(root)).toBe(bytes)
  })
})

describe("a report binds a candidate's text to the revision of its boxes", () => {
  const boxesOf = (body: string, index: number): string[] =>
    body
      .split('\n')
      .filter((line) => line.includes(idOf(index)) && line.startsWith('- ['))

  /** Move candidate 1's ledger entry to other content, as a committed reopen does. */
  function commit(root: string, index: number, variant: string): string {
    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error('ledger')
    const changed = contentOf(index, variant)
    writeLedger(
      root,
      read.ledger.entries.map((entry) =>
        entry.id === idOf(index)
          ? { ...entry, sources: changed.sources, reopened: 'sources changed' }
          : entry,
      ),
    )
    return revisionOf(changed)
  }

  /** A run record whose candidate 1 has a different title, proposed at `revision`. */
  function propose(root: string, index: number, revision: string | undefined) {
    stampProposal(root, index, revision)
    const file = path.join(root, 'runs', CONNECT_RUN, 'run.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      candidateBlock: { candidates: Array<Record<string, unknown>> }
    }
    for (const item of record.candidateBlock.candidates) {
      if (item.id === idOf(index)) item.title = 'Revision B'
    }
    fs.writeFileSync(file, JSON.stringify(record))
    writeInvocation(root, '901-1')
  }

  it('renders boxes with the revision when the text and the ledger are at the same one', () => {
    const root = seeded(2)
    rendered(root)
    const revision = commit(root, 1, 'edited')
    propose(root, 1, revision)
    const body = rendered(root, { runId: '901', date: DAY_TWO }).body
    expect(body).toContain('Title: Revision B')
    expect(boxesOf(body, 1)).toEqual([
      boxLine(1, 'promoted', false, revision),
      boxLine(1, 'rejected', false, revision),
    ])
  })

  it('keeps the committed revision and its own boxes when the text a run proposes is for other content', () => {
    // A ledger write failed: the run proposed other content, and the ledger still holds the first.
    const root = seeded(2)
    rendered(root)
    propose(root, 1, revisionOfContent(1, 'proposed-only'))
    const body = rendered(root, { runId: '901', date: DAY_TWO }).body
    expect(body).toContain('Title: Lesson 1')
    expect(body).not.toContain('Revision B')
    expect(boxesOf(body, 1)).toEqual([
      boxLine(1, 'promoted', false),
      boxLine(1, 'rejected', false),
    ])
  })

  it('renders no boxes, and says so, when the text is for other content and no text for the live content is held', () => {
    const root = seeded(2)
    propose(root, 1, revisionOfContent(1, 'proposed-only'))
    expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
    const body = rendered(root, { runId: '901' }).body
    expect(body).toContain(NO_DETAILS)
    expect(boxesOf(body, 1)).toEqual([])
    expect(body).not.toContain('Revision B')
    expect(boxesOf(body, 2)).toEqual([
      boxLine(2, 'promoted', false),
      boxLine(2, 'rejected', false),
    ])
  })

  it('keeps a hidden proposal non-actionable when the ledger later commits other content, after the store is reloaded', () => {
    const root = seeded(2)
    // The failed proposal is hidden, and stored under the revision it describes.
    propose(root, 1, revisionOfContent(1, 'proposed-only'))
    rendered(root, { runId: '901' })
    expect(payloadsOf(root).find((item) => item.id === idOf(1))).toMatchObject({
      revision: revisionOfContent(1, 'proposed-only'),
    })

    // A different revision commits, and the next render has no fresh details.
    commit(root, 1, 'committed-other')
    writeInvocation(root, '902-1', {}, null)
    const body = rendered(root, { runId: '902', date: DAY_TWO }).body
    expect(body).toContain(NO_DETAILS)
    expect(boxesOf(body, 1)).toEqual([])
    expect(body).not.toContain('Revision B')
    expect(applyTicks(root, { body, issue: 9 })).toMatchObject({
      accepted: [],
      skipped: [],
    })
  })

  it('shows the proposal once the ledger commits the content it describes', () => {
    const root = seeded(2)
    const proposedRevision = revisionOfContent(1, 'proposed-only')
    propose(root, 1, proposedRevision)
    rendered(root, { runId: '901' })
    commit(root, 1, 'proposed-only')
    writeInvocation(root, '902-1', {}, null)
    const body = rendered(root, { runId: '902', date: DAY_TWO }).body
    expect(body).toContain('Title: Revision B')
    expect(boxesOf(body, 1)).toEqual([
      boxLine(1, 'promoted', false, proposedRevision),
      boxLine(1, 'rejected', false, proposedRevision),
    ])
  })

  it('renders no boxes for a payload from other content than the ledger holds', () => {
    const root = seeded(2)
    rendered(root)
    commit(root, 1, 'edited')
    writeInvocation(root, '901-1', {}, null)
    const body = rendered(root, { runId: '901', date: DAY_TWO }).body
    expect(body).toContain(NO_DETAILS)
    expect(boxesOf(body, 1)).toEqual([])
    expect(body).not.toContain('Title: Lesson 1')
    expect(boxesOf(body, 2)).toEqual([
      boxLine(2, 'promoted', false),
      boxLine(2, 'rejected', false),
    ])
  })

  /** Rewrite one stored payload: another artifact (run and attempt), title or revision. */
  function restore(
    root: string,
    index: number,
    over: Record<string, unknown>,
  ): void {
    const file = path.join(root, PAYLOAD_FILE)
    const store = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      payloads: Array<Record<string, unknown>>
    }
    store.payloads = store.payloads.map((item) => {
      if (item.id !== idOf(index)) return item
      const next = { ...item, ...over }
      for (const [key, value] of Object.entries(over)) {
        if (value === undefined) delete next[key]
      }
      return next
    })
    fs.writeFileSync(file, JSON.stringify(store))
  }

  const fetchLinesOf = (body: string): string[] =>
    body.split('\n').filter((line) => line.includes('fetch:'))

  describe('one bundle per proposal', () => {
    it('renders a stored bundle that matches the entry with its own text, its own fetch link and boxes', () => {
      const root = seeded(2)
      rendered(root)
      restore(root, 1, { runId: '800', attempt: '2', title: 'Stored title' })
      writeRunRecord(root, [])
      writeInvocation(root, '901-1', {}, null)
      const result = rendered(root, { runId: '901', date: DAY_TWO })
      expect(result.body).toContain('Title: Stored title')
      expect(result.body).toContain('(run 800, attempt 2)')
      expect(result.fetches).toContain('800.2')
      expect(boxesOf(result.body, 1)).toEqual([
        boxLine(1, 'promoted', false),
        boxLine(1, 'rejected', false),
      ])
    })

    it('keeps the stored bundle whole when this run proposes other content for the candidate', () => {
      const root = seeded(1)
      rendered(root)
      restore(root, 1, { runId: '800', attempt: '2', title: 'Stored title' })
      // This run's proposal is for a revision the ledger does not hold (its write failed).
      propose(root, 1, revisionOfContent(1, 'proposed-only'))
      writeInvocation(root, '901-1')
      const result = rendered(root, { runId: '901', date: DAY_TWO })
      expect(result.body).toContain('Title: Stored title')
      expect(result.body).not.toContain('Revision B')
      expect(fetchLinesOf(result.body).join('\n')).toContain('fetch:800.2')
      expect(fetchLinesOf(result.body).join('\n')).not.toContain('fetch:901.1')
    })

    it("replaces a stored bundle for other content with this run's matching bundle, fetch link included", () => {
      const root = seeded(1)
      rendered(root)
      restore(root, 1, {
        runId: '800',
        attempt: '2',
        title: 'Old content',
        revision: revisionOfContent(1, 'old-content'),
      })
      propose(root, 1, revisionOf(entryOf(1)))
      writeInvocation(root, '901-1')
      const result = rendered(root, { runId: '901', date: DAY_TWO })
      expect(result.body).toContain('Title: Revision B')
      expect(result.body).not.toContain('Old content')
      expect(result.fetches).toEqual(['901.1'])
      expect(result.body).not.toContain('fetch:800.2')
    })

    it('shows no fetch link, no boxes and no Fetch entry for text from before revisions whose artifact holds other evidence', () => {
      const root = seeded(2)
      rendered(root)
      // Stored by an older release: no revision, and an artifact (800.1) of other evidence.
      restore(root, 1, {
        runId: '800',
        attempt: '1',
        title: 'Evidence of run 800',
        revision: undefined,
      })
      // This run proposes nothing: the candidate is unchanged and suppressed.
      writeRunRecord(root, [])
      writeInvocation(root, '901-1', {}, null)
      const result = rendered(root, { runId: '901', date: DAY_TWO })
      // Candidate 1 has no row: its id is in the collapsed line and nowhere else.
      expect(result.body).not.toContain('### Candidate 2')
      const collapsed = result.body.split(NO_DETAILS)[1] ?? ''
      expect(collapsed).toContain(`\`${idOf(1)}\``)
      expect(result.body.split(idOf(1))).toHaveLength(2)
      expect(result.body).not.toContain(`connect-decision:rejected:${idOf(1)}`)
      expect(result.body).not.toContain('Evidence of run 800')
      expect(result.fetches).not.toContain('800.1')
      expect(fetchLinesOf(result.body).join('\n')).not.toContain('800.1')
      expect(applyTicks(root, { body: result.body, issue: 4 })).toMatchObject({
        accepted: [],
      })
    })
  })

  it('records no tick from a report whose candidate has no boxes', () => {
    const root = seeded(1)
    rendered(root)
    commit(root, 1, 'edited')
    writeInvocation(root, '901-1', {}, null)
    const body = rendered(root, { runId: '901', date: DAY_TWO }).body
    expect(body).not.toContain('connect-decision:')
    expect(applyTicks(root, { body, issue: 5 })).toMatchObject({
      accepted: [],
      skipped: [],
      unresolved: [],
    })
  })

  it('keeps the revision of a payload in the store', () => {
    const root = seeded(1)
    rendered(root)
    expect(payloadsOf(root)[0]).toMatchObject({
      revision: revisionOf(entryOf(1)),
    })
  })

  describe('text from before revisions', () => {
    /** The store as an older release wrote it: the text, and no revision. */
    function unversion(root: string): void {
      const file = path.join(root, PAYLOAD_FILE)
      const store = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        payloads: Array<Record<string, unknown>>
      }
      for (const item of store.payloads) delete item.revision
      fs.writeFileSync(file, JSON.stringify(store))
    }

    it('renders no verified details and no boxes, even for an entry whose content it may describe', () => {
      const root = seeded(2)
      rendered(root)
      unversion(root)
      writeInvocation(root, '901-1', {}, null)
      const body = rendered(root, { runId: '901', date: DAY_TWO }).body
      for (const index of [1, 2]) {
        expect(body).toContain(NO_DETAILS)
        expect(boxesOf(body, index)).toEqual([])
      }
      expect(body).not.toContain('Title: Lesson')
    })

    it('cannot acquire boxes when its ledger write had failed and the first render after the upgrade has no fresh text', () => {
      // The cache holds the text of a proposal whose ledger write failed, with no revision.
      const root = seeded(1)
      rendered(root)
      unversion(root)
      // The ledger is at the revision before that proposal, or another one: either way no box.
      for (const variant of [undefined, 'later']) {
        if (variant !== undefined) {
          const read = readLedger(root)
          if (read.status !== 'ok') throw new Error('ledger')
          const changed = contentOf(1, variant)
          writeLedger(
            root,
            read.ledger.entries.map((entry) => ({
              ...entry,
              sources: changed.sources,
              reopened: 'sources changed' as const,
            })),
          )
        }
        writeInvocation(root, '901-1', {}, null)
        const body = rendered(root, { runId: '901', date: DAY_TWO }).body
        expect(boxesOf(body, 1)).toEqual([])
        expect(body).toContain(NO_DETAILS)
        expect(applyTicks(root, { body, issue: 9 })).toMatchObject({
          accepted: [],
          skipped: [],
        })
      }
    })

    it('shows boxes again once a run stores text with a revision', () => {
      const root = seeded(1)
      rendered(root)
      unversion(root)
      writeInvocation(root, '901-1', {}, null)
      const refreshed = rendered(root, { runId: '901', date: DAY_TWO }).body
      expect(boxesOf(refreshed, 1)).toEqual([])
      // The next run proposes the candidate again, with a revision.
      stampProposal(root, 1, revisionOf(entryOf(1)))
      writeInvocation(root, '902-1')
      const body = rendered(root, { runId: '902', date: DAY_TWO }).body
      expect(body).toContain('Title: Lesson 1')
      expect(boxesOf(body, 1)).toEqual([
        boxLine(1, 'promoted', false),
        boxLine(1, 'rejected', false),
      ])
    })

    it('does not accept a run record that names no revision as text for the entry', () => {
      const root = seeded(1)
      stampProposal(root, 1, undefined)
      const body = rendered(root).body
      expect(boxesOf(body, 1)).toEqual([])
      expect(body).toContain(NO_DETAILS)
    })
  })
})

describe('the report lists the rows that can be settled before the rows that cannot', () => {
  /** `legacy` older entries with no bundle, then one newer entry with a bundle at its live revision. */
  function backlog(legacy: number): { root: string; newer: number } {
    const root = seeded(1)
    const newer = legacy + 1
    writeLedger(
      root,
      Array.from({ length: newer }, (_, i) => entryOf(i + 1)),
    )
    // The run proposes only the newer candidate: the older ones have no stored text.
    writeRunRecord(root, [blockCandidate(newer)])
    return { root, newer }
  }

  const collapsedOf = (body: string): string => {
    const [, rest = ''] = body.split(NO_DETAILS)
    return rest.split('\n## ')[0] ?? ''
  }

  it('shows a newer candidate with a bundle in full when an older backlog with none would fill the report', () => {
    const { root, newer } = backlog(700)
    const result = rendered(root)

    // Seven hundred full rows would not fit under the cap; one actionable row and a short section do.
    expect(result.body.length).toBeLessThan(REPORT_MAX_CHARS)
    expect(result.body).toContain(`Title: Lesson ${newer}`)
    expect(result.body).toContain(
      `/ce:connect fetch:900.1\` for candidates 1\n`,
    )
    expect(
      result.body
        .split('\n')
        .filter((line) => line.includes(idOf(newer)) && line.startsWith('- [')),
    ).toEqual([
      boxLine(newer, 'promoted', false),
      boxLine(newer, 'rejected', false),
    ])
    expect(result).toMatchObject({
      open: 701,
      shown: 1,
      hidden: 0,
      unverified: 700,
      fetches: ['900.1'],
    })
    expect(parseReportBody(result.body).manifest).toBe(result.manifest)

    // The legacy ids are in the collapsed line only, oldest first, and no box has one.
    const collapsed = collapsedOf(result.body)
    expect(collapsed).toContain('700 open candidates have no verified details')
    expect(collapsed).toContain(
      Array.from(
        { length: MAX_UNVERIFIED_IDS },
        (_, i) => `\`${idOf(i + 1)}\``,
      ).join(', '),
    )
    for (let n = 1; n <= 700; n++) {
      const count = result.body.split(idOf(n)).length - 1
      expect(count).toBe(n <= MAX_UNVERIFIED_IDS ? 1 : 0)
    }
    expect(result.body).not.toContain('### Candidate 2')
    expect(result.body).not.toContain('open candidates are not shown')
  })

  it('records the tick on that candidate on the next apply, and leaves the backlog open', () => {
    const { root, newer } = backlog(700)
    const body = rendered(root).body
    const result = applyTicks(root, {
      body: body.replace(
        boxLine(newer, 'rejected', false),
        boxLine(newer, 'rejected', true),
      ),
      issue: 30,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [{ id: idOf(newer), status: 'rejected' }],
      skipped: [],
      unresolved: [],
    })
    expect(statusOf(root, newer)).toBe('rejected')
    for (const n of [1, 2, 700]) expect(statusOf(root, n)).toBe('candidate')
  })

  it('leaves the backlog out of the manifest and the Fetch index, so a tick on one cannot count', () => {
    const { root, newer } = backlog(30)
    const result = rendered(root)
    const manifest = readJson(root, MANIFEST_FILE) as {
      manifests: Array<{ hash: string; ids: string[] }>
    }
    expect(
      manifest.manifests.find((item) => item.hash === result.manifest)?.ids,
    ).toEqual([idOf(newer)])
    expect(result.fetches).toEqual(['900.1'])
    // A forged tick for a backlog id names no box of this report.
    const forged = result.body.replace(
      '<!-- connect-decisions:end -->',
      `${boxLine(1, 'rejected', true)}\n<!-- connect-decisions:end -->`,
    )
    expect(applyTicks(root, { body: forged, issue: 31 })).toMatchObject({
      accepted: [],
      skipped: [{ id: idOf(1), reason: 'not-in-manifest' }],
    })
    expect(statusOf(root, 1)).toBe('candidate')
  })

  it('keeps actionable rows under their own cap and wording, whatever the backlog', () => {
    // Enough rows with bundles to overflow, plus a backlog with none.
    const root = seeded(1)
    // Under the 200 candidates a run record is read for.
    const total = 190
    writeLedger(
      root,
      Array.from({ length: total + 5 }, (_, i) => entryOf(i + 1)),
    )
    writeRunRecord(
      root,
      Array.from({ length: total }, (_, i) =>
        blockCandidate(i + 6, {
          summary: `Summary ${'x'.repeat(400)}`,
        }),
      ),
    )
    const result = rendered(root)
    expect(result.body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
    expect(result.shown).toBeLessThan(total)
    expect(result.open).toBe(total + 5)
    expect(result.unverified).toBe(5)
    expect(result.hidden).toBe(total - result.shown)
    // The oldest actionable rows are the ones shown: 6, 7, 8, ...
    expect(result.body).toContain(`### Candidate 1`)
    expect(result.body).toContain(`Title: Lesson 6\n`)
    expect(result.body).toContain(
      `**${result.hidden} open candidates are not shown.** They stay open and appear here, oldest first, as the ones above are settled.`,
    )
    expect(collapsedOf(result.body)).toContain(
      '5 open candidates have no verified details',
    )
  })

  /** Rows large enough that the size cap binds, after `legacy` older entries with no bundle. */
  function nearCap(legacy: number): string {
    const root = seeded(1)
    writeLedger(
      root,
      Array.from({ length: legacy + 150 }, (_, i) => entryOf(i + 1)),
    )
    writeRunRecord(
      root,
      Array.from({ length: 150 }, (_, i) =>
        blockCandidate(legacy + i + 1, {
          // Rows of the same size whatever their number.
          title: 'Lesson',
          summary: `S ${'x'.repeat(500)}`,
          sources: [],
        }),
      ),
    )
    return root
  }

  it('keeps the whole body, collapsed section included, at or under the renderer cap, whatever the backlog', () => {
    for (const legacy of [
      0,
      1,
      MAX_UNVERIFIED_IDS,
      MAX_UNVERIFIED_IDS + 1,
      5000,
    ]) {
      const result = rendered(nearCap(legacy))
      expect(result.body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
      expect(result.shown).toBeLessThan(150)
    }
  })

  it('fits the actionable rows into the cap minus the section, oldest first', () => {
    const without = rendered(nearCap(0))
    const withBacklog = rendered(nearCap(5000))
    // The section takes room from the rows, never the other way round.
    expect(withBacklog.shown).toBeLessThanOrEqual(without.shown)
    expect(without.shown - withBacklog.shown).toBeLessThanOrEqual(3)
    // The rows shown are the oldest ones, from the first, with no gap.
    const numbers = [...withBacklog.body.matchAll(/### Candidate (\d+)/g)].map(
      (m) => Number(m[1]),
    )
    expect(numbers).toEqual(
      Array.from({ length: withBacklog.shown }, (_, i) => i + 1),
    )
    expect(withBacklog.body).toContain('Title: Lesson\n')
  })

  it('leaves room for the cache-save line the workflow appends, under the cap the workflow verifies', () => {
    // The cap is what leaves the workflow room for its one line, whatever the body holds.
    expect(REPORT_MAX_CHARS + CACHE_SAVE_LINE.length).toBeLessThanOrEqual(
      WORKFLOW_BODY_CAP,
    )
    const result = rendered(nearCap(5000))
    const withLine = `${result.body}${CACHE_SAVE_LINE}`
    expect(withLine.length).toBeLessThanOrEqual(WORKFLOW_BODY_CAP)
  })

  describe('when the section would leave too little room', () => {
    const named = (body: string): number =>
      [...body.matchAll(/`[0-9a-f]{64}`/g)].length
    const ids = Array.from({ length: 30 }, (_, i) => idOf(i + 1))
    /** One row of \`size\` characters, then the backlog: the section competes with it for the cap. */
    const input = (size: number, unverified: readonly string[] = ids) => ({
      outcome: 'complete' as const,
      facts: [],
      cacheRestored: true,
      stateUpdated: true,
      unverified,
      rows: [
        {
          id: idOf(99),
          payload: {
            id: idOf(99),
            title: 't',
            summary: 's',
            kind: 'transferable-lesson' as const,
            nextStep: 'compound-learning' as const,
            targetName: 'target',
            sources: [],
            runId: '900',
            attempt: '1',
            revision: 'a'.repeat(12),
          },
          isNew: false,
          block: `### Candidate 1\n\n${'r'.repeat(size)}\n`,
        },
      ],
    })
    const sectionRoom = (body: string): number => REPORT_MAX_CHARS - body.length

    it('names fewer ids when the full list would push the first row out', () => {
      // Sized so the row fits beside a short list but not beside twenty ids.
      const roomy = fitReport(input(10))
      expect(roomy.shown).toBe(1)
      expect(roomy.named).toBe(MAX_UNVERIFIED_IDS)
      const size =
        REPORT_MAX_CHARS - assembleReport(input(0), 1, 0).body.length - 400
      const tight = fitReport(input(size))
      expect(tight.shown).toBe(1)
      expect(tight.named).toBeLessThan(MAX_UNVERIFIED_IDS)
      const body = assembleReport(input(size), tight.shown, tight.named).body
      expect(body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
      expect(named(body)).toBe(tight.named)
      expect(sectionRoom(body)).toBeGreaterThanOrEqual(0)
      expect(body).toContain(`, and ${ids.length - tight.named} more`)
    })

    it('falls back to a count-only line, and the body still fits', () => {
      const base = assembleReport(input(0), 1, 0).body.length
      // A row that fits only with the count-only line.
      const size = REPORT_MAX_CHARS - base
      const result = fitReport(input(size))
      expect(result).toEqual({ shown: 1, named: 0 })
      const body = assembleReport(input(size), 1, 0).body
      expect(body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
      expect(body).toContain('30 open candidates have no verified details')
      expect(named(body)).toBe(0)
      expect(body).not.toContain('Oldest first')
    })

    it('never names an id past the cap, and says nothing when there is no backlog', () => {
      expect(fitReport(input(10, ids)).named).toBe(MAX_UNVERIFIED_IDS)
      expect(fitReport(input(10, [])).named).toBe(0)
      expect(assembleReport(input(10, []), 1, 0).body).not.toContain(NO_DETAILS)
    })
  })

  describe('the collapsed section', () => {
    const idsIn = (body: string): string[] =>
      [...collapsedOf(body).matchAll(/`([0-9a-f]{64})`/g)].map((m) =>
        String(m[1]),
      )

    it('names at most the cap of ids, oldest first, and says how many more there are', () => {
      const { root } = backlog(MAX_UNVERIFIED_IDS + 5)
      const collapsed = collapsedOf(rendered(root).body)
      expect(collapsed).toContain(
        `${MAX_UNVERIFIED_IDS + 5} open candidates have no verified details`,
      )
      expect(collapsed).toContain(', and 5 more')
      expect(idsIn(rendered(root).body)).toEqual(
        Array.from({ length: MAX_UNVERIFIED_IDS }, (_, i) => idOf(i + 1)),
      )
    })

    it('names every id and no "more" when the backlog is exactly the cap', () => {
      const { root } = backlog(MAX_UNVERIFIED_IDS)
      const body = rendered(root).body
      expect(idsIn(body)).toHaveLength(MAX_UNVERIFIED_IDS)
      expect(collapsedOf(body)).not.toContain(' more')
    })

    it('says "more" for one over the cap and uses the singular for one candidate', () => {
      expect(
        collapsedOf(rendered(backlog(MAX_UNVERIFIED_IDS + 1).root).body),
      ).toContain(', and 1 more')
      const one = collapsedOf(rendered(backlog(1).root).body)
      expect(one).toContain('1 open candidate has no verified details')
      expect(one).not.toContain('more')
    })

    it('is absent when every open candidate has a bundle', () => {
      const body = rendered(seeded(2)).body
      expect(body).not.toContain(NO_DETAILS)
    })

    it('sits outside the section ticks are read from, so it adds no box', () => {
      const { root } = backlog(MAX_UNVERIFIED_IDS + 5)
      const body = rendered(root).body
      expect(parseReportBody(body).boxes).toHaveLength(2)
      expect(body.indexOf(NO_DETAILS)).toBeGreaterThan(
        body.indexOf('<!-- connect-decisions:end -->'),
      )
    })
  })
})

describe('the fetch word names the caller repository', () => {
  const GOLDEN = path.join(
    import.meta.dir,
    '../fixtures/connect-report/systematic-report.golden.md',
  )
  const FOREIGN = 'fro-bot/agent'
  /** The longest owner and repository GitHub accepts: 39 and 100 characters. */
  const LONGEST = `${'o'.repeat(39)}/${'r'.repeat(100)}`

  /**
   * Two runs' worth of state: candidates 1 and 2 from run 900 attempt 1, then
   * candidate 3 from attempt 2 of run 905, with a ledger that was not restored
   * and one entry with no bundle. Returns the second report.
   */
  function scenario(
    over: Partial<RenderRequest> = {},
  ): ReturnType<typeof rendered> & { root: string } {
    const root = seeded(2)
    rendered(root, over)
    writeLedger(root, [entryOf(1), entryOf(2), entryOf(3), entryOf(4)])
    writeRunRecord(root, [blockCandidate(3)], {}, 'run-three')
    writeInvocation(root, '905-2', {}, 'run-three')
    const second = rendered(root, {
      date: DAY_TWO,
      runId: '905',
      attempt: '2',
      cacheRestored: false,
      ...over,
    })
    return { ...second, root }
  }

  /** Every word that follows `fetch:` in a body, whatever the line. */
  function wordsIn(body: string): string[] {
    return [...body.matchAll(/fetch:(\S+?)`/g)].map((match) => match[1] ?? '')
  }

  it('keeps the bare words, byte for byte, when no repository is named', () => {
    const { body } = scenario()
    expect(body).toBe(fs.readFileSync(GOLDEN, 'utf8'))
  })

  it.each([
    'marcusrbrown/systematic',
    'MarcusRBrown/Systematic',
    'MARCUSRBROWN/SYSTEMATIC',
  ])('keeps the bare words, byte for byte, for %s', (repo) => {
    const { body, fetches } = scenario({ repo })
    expect(body).toBe(fs.readFileSync(GOLDEN, 'utf8'))
    expect(fetches).toEqual(['900.1', '905.2'])
  })

  it('names the repository on the row and in the fetch lines for another caller', () => {
    const { body, fetches } = scenario({ repo: FOREIGN })
    expect(fetches).toEqual([`${FOREIGN}:900.1`, `${FOREIGN}:905.2`])
    const lines = body.split('\n')
    expect(lines.filter((line) => line.startsWith('- Fetch: '))).toEqual([
      `- Fetch: \`/ce:connect fetch:${FOREIGN}:900.1\` (run 900, attempt 1)`,
      `- Fetch: \`/ce:connect fetch:${FOREIGN}:900.1\` (run 900, attempt 1)`,
      `- Fetch: \`/ce:connect fetch:${FOREIGN}:905.2\` (run 905, attempt 2)`,
    ])
    expect(lines.filter((line) => line.endsWith('for candidates 1-2'))).toEqual(
      [`- \`/ce:connect fetch:${FOREIGN}:900.1\` for candidates 1-2`],
    )
    expect(lines.filter((line) => line.endsWith('for candidates 3'))).toEqual([
      `- \`/ce:connect fetch:${FOREIGN}:905.2\` for candidates 3`,
    ])
    // No bare word is left anywhere.
    for (const word of wordsIn(body)) expect(word).toMatch(/^fro-bot\/agent:/)
    expect(body).not.toMatch(/fetch:\d/)
  })

  it.each([
    'marcusrbrown/metacogs',
    'marcusrbrown/systematic-fork',
    'fro-bot/systematic',
  ])(
    "names a caller that only shares part of Systematic's identity: %s",
    (repo) => {
      const { body, fetches } = scenario({ repo })
      expect(fetches).toEqual([`${repo}:900.1`, `${repo}:905.2`])
      const lines = body.split('\n')
      expect(lines.filter((line) => line.startsWith('- Fetch: '))).toEqual([
        `- Fetch: \`/ce:connect fetch:${repo}:900.1\` (run 900, attempt 1)`,
        `- Fetch: \`/ce:connect fetch:${repo}:900.1\` (run 900, attempt 1)`,
        `- Fetch: \`/ce:connect fetch:${repo}:905.2\` (run 905, attempt 2)`,
      ])
      expect(lines.filter((line) => line.includes('for candidates'))).toEqual([
        `- \`/ce:connect fetch:${repo}:900.1\` for candidates 1-2`,
        `- \`/ce:connect fetch:${repo}:905.2\` for candidates 3`,
      ])
      expect(body).not.toMatch(/fetch:\d/)
    },
  )

  it('changes nothing but the fetch word: the checkbox lines, the manifest and the stored payloads are the same', () => {
    const bare = scenario()
    const named = scenario({ repo: FOREIGN })
    const strip = (body: string): string => body.replaceAll(`${FOREIGN}:`, '')
    expect(strip(named.body)).toBe(bare.body)
    expect(named.manifest).toBe(bare.manifest)
    expect(readJson(named.root, PAYLOAD_FILE)).toEqual(
      readJson(bare.root, PAYLOAD_FILE),
    )
    expect(JSON.stringify(readJson(named.root, PAYLOAD_FILE))).not.toContain(
      'fro-bot',
    )
  })

  it('renders an old payload store, with runs and attempts only, under both forms', () => {
    const root = seeded(2)
    rendered(root)
    // Next day: no run record, so the stored bundles are all there is.
    fs.rmSync(path.join(root, 'runs'), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'runs'))
    writeInvocation(root, '901-1', {}, null)
    const bare = rendered(root, { date: DAY_TWO, runId: '901' })
    expect(bare.fetches).toEqual(['900.1'])

    writeInvocation(root, '902-1', {}, null)
    const named = rendered(root, {
      date: DAY_TWO,
      runId: '902',
      repo: FOREIGN,
    })
    expect(named.fetches).toEqual([`${FOREIGN}:900.1`])
    expect(named.body).toContain(
      `- Fetch: \`/ce:connect fetch:${FOREIGN}:900.1\` (run 900, attempt 1)`,
    )
    // The store still holds runs and attempts only for the caller's own rows.
    for (const payload of payloadsOf(root)) {
      expect(payload.runId).toBe('900')
      expect(payload.attempt).toBe('1')
    }
  })

  it('still applies ticks from a body with named words', () => {
    const { root, body } = scenario({ repo: FOREIGN })
    const result = applyTicks(root, {
      body: ticked(body, [
        [1, 'rejected'],
        [3, 'promoted'],
      ]),
      issue: 9,
    })
    expect(result).toMatchObject({
      status: 'applied',
      accepted: [
        { id: idOf(1), status: 'rejected' },
        { id: idOf(3), status: 'promoted' },
      ],
      skipped: [],
      unresolved: [],
    })
  })

  it('accepts the longest owner and repository GitHub allows', () => {
    const { fetches } = rendered(seeded(1), { repo: LONGEST })
    expect(fetches).toEqual([`${LONGEST}:900.1`])
  })

  it.each([
    '',
    ' ',
    'fro-bot',
    'fro-bot/',
    '/agent',
    'fro-bot//agent',
    'fro bot/agent',
    'fro-bot/age nt',
    'fro-bot/agent/extra',
    'fro-bot/agent\n',
    'fro-bot/agent`',
    'fro-bot/agent:1',
    '-fro/agent',
    'fro-/agent',
    'fro_bot/agent',
    'fro-bot/..',
    'fro-bot/.',
    '../agent',
    './agent',
    `${'o'.repeat(40)}/agent`,
    `fro-bot/${'r'.repeat(101)}`,
    'fro-bot/agént',
  ])('refuses the repository %j and renders nothing', (repo) => {
    const root = seeded(1)
    expect(renderReport(root, request({ repo }))).toEqual({
      status: 'failed',
      reason: 'invalid-request',
    })
    expect(fs.existsSync(path.join(root, REPORT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(root, PAYLOAD_FILE))).toBe(false)
  })

  describe('near the size cap, with the longest repository name', () => {
    /** Rows large enough that the cap binds, after `legacy` older entries with no bundle. */
    function crowdedRoot(legacy: number): string {
      const root = seeded(1)
      writeLedger(
        root,
        Array.from({ length: legacy + 200 }, (_, i) => entryOf(i + 1)),
      )
      writeRunRecord(
        root,
        Array.from({ length: 200 }, (_, i) =>
          blockCandidate(legacy + i + 1, {
            title: 'Lesson',
            summary: `S ${'x'.repeat(500)}`,
            sources: [],
          }),
        ),
      )
      return root
    }

    it.each([0, MAX_UNVERIFIED_IDS + 1, 5000])(
      'keeps the body under the renderer cap and the workflow cap, whole rows only, with %i entries that have no bundle',
      (legacy) => {
        const bare = rendered(crowdedRoot(legacy))
        const named = rendered(crowdedRoot(legacy), { repo: LONGEST })

        expect(named.body.length).toBeLessThanOrEqual(REPORT_MAX_CHARS)
        expect(`${named.body}${CACHE_SAVE_LINE}`.length).toBeLessThanOrEqual(
          WORKFLOW_BODY_CAP,
        )
        // The longer word costs room on every row, so fewer rows fit.
        expect(named.shown).toBeLessThan(bare.shown)
        expect(named.shown).toBeGreaterThan(0)
        expect(named.hidden).toBe(200 - named.shown)
        expect(named.body).toContain(
          `**${named.hidden} open candidates are not shown.**`,
        )
        // Whole rows: the shown ones are the oldest, from the first, each with both boxes.
        const numbers = [...named.body.matchAll(/### Candidate (\d+)/g)].map(
          (match) => Number(match[1]),
        )
        expect(numbers).toEqual(
          Array.from({ length: named.shown }, (_, i) => i + 1),
        )
        expect(named.body.match(/- \[ \] Promoted <!--/g)).toHaveLength(
          named.shown,
        )
        expect(named.body.match(/- \[ \] Rejected <!--/g)).toHaveLength(
          named.shown,
        )
        for (const word of wordsIn(named.body)) {
          expect(word).toBe(`${LONGEST}:900.1`)
        }
      },
    )
  })
})

describe('readReportBody', () => {
  it('reads a regular file', () => {
    const dir = makeDir('connect-ci-body-')
    fs.writeFileSync(path.join(dir, 'body.md'), 'hello')
    expect(readReportBody(path.join(dir, 'body.md'))).toEqual({
      status: 'ok',
      body: 'hello',
    })
  })

  it('refuses a missing file, a symlink, a directory and a file over the bound', () => {
    const dir = makeDir('connect-ci-body-')
    fs.writeFileSync(path.join(dir, 'real.md'), 'x')
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'))
    fs.mkdirSync(path.join(dir, 'folder'))
    fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(2 * 1024 * 1024))
    const reasons = ['missing.md', 'link.md', 'folder', 'big.md'].map(
      (name) => {
        const read = readReportBody(path.join(dir, name))
        return read.status === 'failed' ? read.reason : 'read'
      },
    )
    expect(reasons).toEqual([
      'body-missing',
      'body-symlink',
      'body-not-regular',
      'body-too-large',
    ])
  })
})
