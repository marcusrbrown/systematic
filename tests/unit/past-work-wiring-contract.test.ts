import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { TRUNCATION_MARKER } from '../../src/lib/search-render.js'

// These tests pin the prose that wires past-work search into the researcher and
// the skills that dispatch it. They assert wiring text, not prompt length.

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const RESEARCHER = read('agents/research/learnings-researcher.md')
const PLAN = read('skills/ce-plan/SKILL.md')
const IDEATE = read('skills/ce-ideate/SKILL.md')
const BRAINSTORM = read('skills/ce-brainstorm/SKILL.md')
const DEEPEN = read('skills/deepen-plan/SKILL.md')
const DEEPENING_WORKFLOW = read(
  'skills/ce-plan/references/deepening-workflow.md',
)

/** The text under a heading, up to the next heading of any level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start === -1) throw new Error(`heading not found: ${heading}`)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^#{1,4} /m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** The line that holds `needle`, plus any indented lines that continue it. */
function paragraph(text: string, needle: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes(needle))
  if (at === -1) throw new Error(`text not found: ${needle}`)
  let end = at + 1
  while (end < lines.length && /^\s+\S/.test(lines[end] ?? '')) end += 1
  return lines.slice(at, end).join('\n')
}

const DISPATCH_ID = 'systematic:research:learnings-researcher'

describe('learnings-researcher scope block', () => {
  const scope = section(RESEARCHER, '## Scope')

  test('reads scope from a first-line scope: marker and an optional exclude: line', () => {
    expect(scope).toContain('`scope: <value>`')
    expect(scope).toMatch(/first line/i)
    expect(scope).toContain('`exclude: <')
  })

  test('solutions is the default and a missing line means solutions', () => {
    expect(scope).toMatch(/`solutions`[^\n]*default/i)
    expect(scope).toMatch(/no `scope:` line|missing/i)
  })

  test('an unknown value is named in the reply and treated as solutions', () => {
    expect(scope).toMatch(/unknown[^\n]*(name|named)[^\n]*`solutions`/i)
  })

  test('overlap mode forces solutions whatever the line says', () => {
    expect(scope).toMatch(/overlap[^\n]*`solutions`[^\n]*whatever/i)
  })

  test('the excluded path is dropped by exact path and Supersedes entries survive', () => {
    expect(scope).toMatch(/exact path/i)
    expect(scope).toMatch(/Supersedes:/)
  })
})

describe('learnings-researcher Step 0 under past-work', () => {
  const step0 = section(RESEARCHER, '### Step 0')

  test('lists all four directories', () => {
    for (const dir of [
      'docs/solutions/',
      'docs/plans/',
      'docs/brainstorms/',
      'docs/ideation/',
    ]) {
      expect(step0).toContain(dir)
    }
  })

  test('stops only when none of the four exists, and never reads a missing path', () => {
    expect(step0).toMatch(/none of the four/i)
    expect(step0).toMatch(/missing/i)
  })

  test('the solutions stop rule is still there', () => {
    expect(step0).toMatch(/does not exist or holds no `.md` files, stop/)
  })
})

describe('learnings-researcher Step 1b under past-work', () => {
  const step1b = section(RESEARCHER, '### Step 1b')

  const calls = paragraph(step1b, '**Past-work scope.**')

  test('past-work makes one search per kind, merged by path', () => {
    expect(calls).toMatch(/one search per kind/i)
    for (const kind of ['solution', 'plan', 'brainstorm', 'ideation']) {
      expect(calls).toContain(`\`${kind}\``)
    }
    expect(calls).toMatch(/by (repo-root )?path/i)
  })

  test('each per-kind call asks for at most 5 results', () => {
    expect(calls).toContain('limit: 5')
    expect(calls).toContain('--limit 5')
    expect(calls).not.toMatch(/limit:? 12/)
  })

  test('the researcher never searches kind all, with the tool or the command', () => {
    for (const text of [calls, step1b, RESEARCHER]) {
      expect(text).not.toMatch(/kind: "?all"?/)
      expect(text).not.toMatch(/--kind all/)
    }
  })

  const tableRow = (needle: string) =>
    step1b
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(needle))

  test('a kind whose header says none contributes nothing, and only four nones stop', () => {
    const row = tableRow('`corpus: none`')
    expect(row).toBeDefined()
    expect(row).toMatch(/adds nothing/i)
    expect(row).toMatch(/not a stop/i)
    expect(row).toMatch(/while another kind has docs/i)
    expect(row).toMatch(/all four[^|]*`none`/i)
  })

  test('a kind whose header says empty contributes nothing', () => {
    const row = tableRow('`corpus: empty`')
    expect(row).toBeDefined()
    expect(row).toMatch(/adds nothing/i)
  })

  test('the routing table has a truncation row that says results were cut and to narrow the query', () => {
    const row = step1b
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(TRUNCATION_MARKER))
    expect(row).toBeDefined()
    expect(row).toMatch(/cut/i)
    expect(row).toMatch(/narrow/i)
  })

  test('Step 3b stays solution-only', () => {
    expect(step1b).toMatch(/Step 3b stays solution-only/)
  })

  const COUNT_WORDS: Record<string, number> = {
    once: 1,
    twice: 2,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  }

  /** The call counts a line names, as numbers, in the order they appear. */
  function countsNamedIn(line: string): number[] {
    return [
      ...line.matchAll(/\b(once|twice|two|three|four|five|six|\d+)\b/gi),
    ].map((match) => {
      const word = (match[1] ?? '').toLowerCase()
      return COUNT_WORDS[word] ?? Number(word)
    })
  }

  const efficiencyRule = RESEARCHER.split('\n').find((line) =>
    line.includes('call the search tool more than'),
  )

  test('the efficiency rule allows one call in solutions scope and four in past-work scope', () => {
    expect(efficiencyRule).toBeDefined()
    const rule = efficiencyRule ?? ''
    expect(rule).toMatch(/`solutions` scope/)
    expect(rule).toMatch(/`past-work` scope/)
    expect(countsNamedIn(rule)).toEqual([1, 4])
  })

  test('no line of the prompt caps past-work at two calls', () => {
    expect(RESEARCHER).not.toMatch(/\btwice\b/i)
    expect(RESEARCHER).not.toMatch(/\btwo (search|call)/i)
  })

  test('the count reader sees a stale two-call cap', () => {
    expect(
      countsNamedIn(
        'call the search tool more than once (twice in `past-work` scope)',
      ),
    ).toEqual([1, 2])
  })
})

describe('learnings-researcher past-work grep fallback', () => {
  const fallback = section(RESEARCHER, '### Past-work grep fallback')

  test('covers all four directories and the frontmatter fields', () => {
    expect(fallback).toMatch(/each of the four directories/)
    for (const field of [
      'title',
      'topic',
      'status',
      'type',
      'origin',
      'date',
    ]) {
      expect(fallback).toContain(field)
    }
    expect(fallback).toMatch(/filename/i)
  })

  test('may grep docs/plans for a brainstorm origin link', () => {
    expect(fallback).toMatch(/`origin:`/)
    expect(fallback).toContain('docs/plans/')
  })
})

describe('learnings-researcher past-work output', () => {
  const output = section(RESEARCHER, '## Past-Work Output')

  const GROUPS = {
    lessons: 'Proven lessons',
    decisions: 'Recorded decisions and their rationale',
    existing: 'Existing or completed work',
    rejected: 'Rejected, deferred or superseded directions',
    open: 'Conflicts and open questions',
  } as const

  /** The groups each backticked status is mapped to by the status table. */
  function statusRows(): Map<string, string[]> {
    const rows = new Map<string, string[]>()
    const tableRows = output
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) => line.split('|').map((cell) => cell.trim()))
    for (const [, statuses = '', group = ''] of tableRows) {
      for (const [, status = ''] of statuses.matchAll(/`([^`]+)`/g)) {
        rows.set(status, [...(rows.get(status) ?? []), group])
      }
    }
    return rows
  }

  test('five groups appear in a fixed order', () => {
    const positions = Object.values(GROUPS).map((name) =>
      output.indexOf(`### ${name}`),
    )
    expect(positions.every((position) => position !== -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  test('each recorded status maps to exactly one group', () => {
    const rows = statusRows()
    const expected: Record<string, string> = {
      completed: GROUPS.existing,
      abandoned: GROUPS.rejected,
      deferred: GROUPS.rejected,
      archived: GROUPS.rejected,
      superseded: GROUPS.rejected,
      draft: GROUPS.open,
      active: GROUPS.open,
      unspecified: GROUPS.open,
    }
    for (const [status, group] of Object.entries(expected)) {
      expect(rows.get(status)?.length).toBe(1)
      expect(rows.get(status)?.[0]?.startsWith(group)).toBe(true)
    }
  })

  test('draft, active and unspecified are reported as proposed in <path>, never as decided or done', () => {
    expect(output).toContain('proposed in <path>')
    expect(output).toMatch(
      /never[^\n]*(implemented|shipped)[^\n]*(decided|decision)/i,
    )
    const proposal = output
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('`draft`'))
    expect(proposal).toContain('proposed in')
    expect(proposal).not.toMatch(/decisions|Existing or completed/)
  })

  test('decisions come from body sections of settled documents, not proposals', () => {
    const line = output
      .split('\n')
      .find((text) => text.startsWith('Recorded decisions and their rationale'))
    expect(line).toMatch(/Key Decisions/)
    expect(line).toMatch(/never from an item proposed in/i)
  })

  test('every item carries its path and recorded status', () => {
    expect(output).toMatch(/every item[^\n]*path[^\n]*(recorded )?status/i)
  })

  test('states the absence wording without implying absence from the repo', () => {
    expect(output).toContain(
      'no recorded plan or solution found in the results',
    )
    expect(output).toMatch(/not[^\n]*(repo|repository)/i)
  })

  test('sets the 12-item and 3-full-read budgets', () => {
    expect(output).toMatch(/at most 12 items/)
    expect(output).toMatch(/at most 3 full reads/)
  })

  test('states the method once on one line, including the origin lookup form', () => {
    expect(output).toMatch(/method[^\n]*once/i)
    expect(output).toContain('search, plus origin lookups by grep')
    expect(output).toMatch(/grep \(/)
  })

  test('the solutions output template is untouched', () => {
    const template = RESEARCHER.slice(
      RESEARCHER.indexOf('## Output Format'),
      RESEARCHER.indexOf('## Past-Work Output'),
    )
    expect(template).toContain('## Institutional Learnings Search Results')
    expect(template).toContain('Overlap:')
  })
})

describe('dispatch sites pass scope: past-work on the first line of the prompt', () => {
  const sites: Array<[string, () => string]> = [
    ['ce-plan Phase 1.1', () => paragraph(PLAN, `Dispatch \`${DISPATCH_ID}\``)],
    [
      'ce-ideate Phase 1',
      () => paragraph(IDEATE, `dispatch \`${DISPATCH_ID}\``),
    ],
    [
      'ce-brainstorm Standard and Deep',
      () => paragraph(BRAINSTORM, `dispatch \`${DISPATCH_ID}\``),
    ],
    ['deepen-plan', () => paragraph(DEEPEN, `\`${DISPATCH_ID}\` (`)],
    [
      'deepening-workflow',
      () => paragraph(DEEPENING_WORKFLOW, `\`${DISPATCH_ID}\` (`),
    ],
  ]

  test.each(sites)('%s', (_name, getText) => {
    const text = getText()
    expect(text).toContain('`scope: past-work`')
    expect(text).toMatch(/first line/i)
  })

  test('ce-plan also describes the exclude line and omits it without an origin', () => {
    const dispatch = paragraph(PLAN, `Dispatch \`${DISPATCH_ID}\``)
    expect(dispatch).toContain('`exclude: <')
    expect(dispatch).toMatch(/origin/i)
    expect(dispatch).toMatch(/omit/i)
  })
})

describe('ce-plan origin discovery', () => {
  const discovery = section(PLAN, '#### 0.2')

  test('keeps the relevance criteria and adds a brainstorm-kind search when the tool exists', () => {
    expect(discovery).toContain('Relevance criteria')
    expect(discovery).toMatch(/kind: "brainstorm"/)
    expect(discovery).toMatch(/tool exists|search tool/i)
    expect(discovery).toMatch(/30 days/)
  })
})

describe('ce-brainstorm wiring', () => {
  const scan = section(BRAINSTORM, '#### 1.1 Existing Context Scan')

  test('Lightweight searches directly with kind all', () => {
    const lightweight = paragraph(scan, '**Lightweight**')
    expect(lightweight).toMatch(/kind: "all"/)
    expect(lightweight).toMatch(/search tool/i)
    expect(lightweight).not.toContain(DISPATCH_ID)
  })

  test('Standard and Deep dispatch the researcher', () => {
    expect(paragraph(scan, '**Standard and Deep**')).toBeDefined()
    expect(scan).toContain(`dispatch \`${DISPATCH_ID}\``)
  })

  test('resume detection does not mention past work', () => {
    const resume = section(BRAINSTORM, '#### 0.1')
    expect(resume).toContain('Found an existing requirements doc for [topic]')
    expect(resume).not.toMatch(/past-work/)
  })
})

describe('cite and differentiate', () => {
  const citeParagraph = (text: string) =>
    paragraph(text, 'recorded as completed in <path>')

  test.each([
    ['ce-plan', PLAN],
    ['ce-ideate', IDEATE],
    ['ce-brainstorm', BRAINSTORM],
    ['deepen-plan', DEEPEN],
    ['deepening-workflow', DEEPENING_WORKFLOW],
  ])('%s carries the bounded, never-block rule', (_name, text) => {
    const cite = citeParagraph(text)
    expect(cite).toMatch(/same behavior or surface/i)
    expect(cite).toMatch(/at most 3/i)
    expect(cite).toMatch(/how the new work differs/i)
    expect(cite).toMatch(/path and status only/i)
    expect(cite).toMatch(/gitignored/i)
    expect(cite).toMatch(/never block|does not block|do not block/i)
  })

  test('ce-plan places cites in Sources & References or Key Technical Decisions, never the prior-art JSON', () => {
    const cite = citeParagraph(PLAN)
    expect(cite).toMatch(/Sources & References|Key Technical Decisions/)
    expect(cite).toMatch(/never in the prior-art/i)
  })

  test('ce-ideate places cites in rejection or survivor reasoning', () => {
    expect(citeParagraph(IDEATE)).toMatch(/rejection|survivor/i)
  })

  test('ce-brainstorm places cites in Key Decisions', () => {
    expect(citeParagraph(BRAINSTORM)).toContain('Key Decisions')
  })

  test.each([
    ['deepen-plan', DEEPEN],
    ['deepening-workflow', DEEPENING_WORKFLOW],
  ])('%s cites wherever findings are integrated', (_name, text) => {
    expect(citeParagraph(text)).toMatch(/integrat/i)
  })
})

describe('ce-review and ce-compound stay on solutions', () => {
  test.each([
    ['ce-review', read('skills/ce-review/SKILL.md')],
    ['ce-compound', read('skills/ce-compound/SKILL.md')],
  ])('%s dispatch text has no past-work scope', (_name, text) => {
    expect(text).toContain(DISPATCH_ID)
    expect(text).not.toMatch(/past-work/)
    expect(text).not.toMatch(/^scope:/m)
  })
})
