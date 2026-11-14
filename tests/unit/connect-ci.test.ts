import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyTicks,
  DECISIONS_BEGIN,
  DECISIONS_END,
  decisionLine,
  fenceText,
  MANIFEST_FILE,
  MANIFESTS_KEPT,
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

function ticked(
  body: string,
  ticks: ReadonlyArray<readonly [number, 'promoted' | 'rejected']>,
): string {
  let out = body
  for (const [index, status] of ticks) {
    const open = decisionLine(idOf(index), status, false)
    if (!out.includes(open)) throw new Error(`no box for ${index} ${status}`)
    out = out.replace(open, decisionLine(idOf(index), status, true))
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
      { id: idOf(1), status: 'promoted', ticked: true },
      { id: idOf(1), status: 'rejected', ticked: false },
    ])
  })

  it('accepts an upper-case X and carriage returns, as GitHub and a browser write them', () => {
    const text = body(decisionLine(idOf(1), 'rejected', true)).replace(
      '[x]',
      '[X]',
    )
    const parsed = parseReportBody(text.replaceAll('\n', '\r\n'))
    expect(parsed.boxes).toEqual([
      { id: idOf(1), status: 'rejected', ticked: true },
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
    expect(second.body).toContain(decisionLine(idOf(2), 'rejected', false))
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

  it('lists a candidate with no payload by id, with a details-unavailable line', () => {
    const root = seeded(1)
    writeLedger(root, [entryOf(1), entryOf(2)])
    const { body } = rendered(root)
    expect(body).toContain(`Details unavailable for \`${idOf(2)}\``)
    expect(body).toContain(decisionLine(idOf(2), 'rejected', false))
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
      expect(last.body).not.toContain('Details unavailable')
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
          expect(result.shown).toBe(2)
          expect(result.body).toContain('Connect busy')
          expect(result.body).toMatch(/State not updated/)
          expect(parseReportBody(result.body).boxes).toHaveLength(4)
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

    it('still lists open candidates when the run failed', () => {
      const root = seeded(2)
      writeInvocation(
        root,
        '900-1',
        { outcome: 'failed', finalLine: 'Connect failed', reason: 'aborted' },
        null,
      )
      expect(rendered(root).shown).toBe(2)
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
      expect(result.shown).toBe(1)
      expect(result.body).toContain(`Details unavailable for \`${idOf(1)}\``)
    })

    it('does not throw on a candidate block that is not a list', () => {
      const root = seeded(1)
      writeRunRecord(root, [], { candidateBlock: 'nope' })
      expect(rendered(root).shown).toBe(1)
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
      expect(next.body).toContain(`Details unavailable for \`${idOf(1)}\``)
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
    expect(next.body).toContain(decisionLine(idOf(2), 'promoted', false))
    expect(next.body).toContain(decisionLine(idOf(2), 'rejected', false))
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
