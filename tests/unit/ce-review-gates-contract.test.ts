/**
 * Contract tests for the verification-gate boundaries in `ce:review`.
 *
 * CI owns the build, typecheck, lint and broad-test gates. Skill text is not
 * code, so these tests pin the facts a run depends on: the role-by-mode table,
 * the wording each child-facing prompt carries, the probe criteria, and the
 * fixer's limits. They do not show how a live model behaves.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Slice from a heading to the next heading of the same or shallower level.
 * Lines inside a code fence are never headings, so a shell comment cannot end
 * the slice early.
 */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() === heading)
  if (index < 0) return ''
  const level = (lines[index]?.match(/^#+/) ?? [''])[0]?.length ?? 0
  const out: string[] = []
  let inFence = false
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().startsWith('```')) inFence = !inFence
    const next = inFence ? null : line.match(/^(#+)\s/)
    if (next && (next[1]?.length ?? 0) <= level) break
    out.push(line)
  }
  return out.join('\n')
}

/** From a bold label to the end of the text it sits in. */
function fromLabel(text: string, label: string): string {
  const index = text.indexOf(label)
  return index < 0 ? '' : text.slice(index)
}

/** The paragraph (blank-line separated block) that starts with a marker. */
function paragraph(text: string, startsWith: string): string {
  return (
    text
      .split(/\n\s*\n/)
      .find((block) => block.trim().startsWith(startsWith)) ?? ''
  )
}

interface TableRow {
  role: string
  mode: string
  allowed: string
  forbidden: string
}

function tableRows(text: string): TableRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 4 && cells[0] !== 'Role')
    .filter((cells) => !cells[0]?.startsWith('-'))
    .map(([role = '', mode = '', allowed = '', forbidden = '']) => ({
      role,
      mode,
      allowed,
      forbidden,
    }))
}

const SKILL = read('skills/ce-review/SKILL.md')
const REVIEWER_TEMPLATE = read(
  'skills/ce-review/references/subagent-template.md',
)
const VALIDATOR_TEMPLATE = read(
  'skills/ce-review/references/validator-template.md',
)
const CATALOG = read('skills/ce-review/references/persona-catalog.md')

const GATES_RAW = section(SKILL, '### Verification gates')
const GATES = normalize(GATES_RAW)
const ROWS = tableRows(GATES_RAW)
const PROBE_PARAGRAPH = normalize(paragraph(SKILL, '**Probe approval.**'))
const CATALOG_PROBES = normalize(
  section(CATALOG, '## Execution probes (separate parent decision)'),
)
const STAGE_4 = normalize(section(SKILL, '### Stage 4: Spawn sub-agents'))
const STAGE_5B = normalize(section(SKILL, '### Stage 5b: Validation pass'))
const HEADLESS_RULES = normalize(section(SKILL, '### Headless mode rules'))
const REPORT_ONLY_RULES = normalize(
  section(SKILL, '### Report-only mode rules'),
)
const HEADLESS_STEP_2 = normalize(
  fromLabel(
    section(SKILL, '#### Step 2: Choose policy by mode'),
    '**Headless mode**',
  ),
)
const STEP_3 = normalize(
  section(SKILL, '#### Step 3: Apply fixes with one fixer and bounded rounds'),
)
const REVIEWER_RULES = normalize(section(REVIEWER_TEMPLATE, '## Template'))
const VALIDATOR_RULES = normalize(section(VALIDATOR_TEMPLATE, '## Template'))
const CE_AGENT_BOUNDARY = normalize(
  paragraph(SKILL, '**CE agent gate boundary.**'),
)

function row(role: string, mode: string): TableRow {
  const found = ROWS.find((r) => r.role === role && r.mode === mode)
  if (!found) throw new Error(`no gate table row for ${role} / ${mode}`)
  return found
}

const ALIAS_EXAMPLES = ['`bun test`', '`bun run typecheck`', '`bunx tsc`']

describe('ce:review verification gates: the role-by-mode table', () => {
  test('has one Verification gates section that opens with the CI ownership statement', () => {
    expect(GATES.length).toBeGreaterThan(0)
    expect(GATES).toMatch(
      /CI owns the build, typecheck, lint, and broad-test gates/i,
    )
  })

  test('lists exactly the six role and mode rows', () => {
    expect(ROWS.map((r) => `${r.role} / ${r.mode}`)).toEqual([
      'Parent / report-only, headless',
      'Parent / interactive, autofix',
      'Reviewers / every mode',
      'CE agents / every mode',
      'Finding validators / every mode',
      'Headless fixer / headless',
    ])
  })

  test('the parent in report-only and headless runs no build, typecheck, lint or broad test', () => {
    const parent = row('Parent', 'report-only, headless')
    expect(parent.forbidden).toMatch(/build, typecheck, lint at any scope/i)
    expect(parent.forbidden).toMatch(
      /broad tests? through any alias or wrapper/i,
    )
    expect(parent.allowed).toMatch(/non-mutating inspection/i)
    expect(parent.allowed).toMatch(/one parent-approved probe per finding/i)
  })

  test('the parent in interactive and autofix runs is unchanged', () => {
    const parent = row('Parent', 'interactive, autofix')
    expect(parent.allowed).toBe('Unchanged')
    expect(parent.forbidden).toBe('Unchanged')
  })

  test.each([
    ['Reviewers', 'every mode'],
    ['CE agents', 'every mode'],
    ['Finding validators', 'every mode'],
  ])(
    '%s run no build, typecheck, lint, test or probe in any mode',
    (role, mode) => {
      const child = row(role, mode)
      expect(child.forbidden).toMatch(/build, typecheck, lint/i)
      expect(child.forbidden).toMatch(/any test or probe run/i)
      expect(child.allowed).toMatch(/non-mutating inspection/i)
    },
  )

  test('the headless fixer may run only targeted tests of the files it changed', () => {
    const fixer = row('Headless fixer', 'headless')
    expect(fixer.allowed).toMatch(/targeted tests of the files it changed/i)
    expect(fixer.forbidden).toMatch(/build, typecheck, lint/i)
    expect(fixer.forbidden).toMatch(/broad suites/i)
    expect(fixer.forbidden).toMatch(
      /verified when targeted tests could not verify/i,
    )
  })

  test('the fixer is the only role in the table that may run tests', () => {
    const mayRunTests = ROWS.filter(
      (r) =>
        /targeted tests/i.test(r.allowed) ||
        /(^|[^-])\btests?\b/i.test(r.allowed.replace(/broad tests?/gi, '')),
    ).map((r) => r.role)
    expect(mayRunTests).toEqual(['Headless fixer'])
  })
})

describe('ce:review verification gates: the rule and its aliases', () => {
  test('forbids build, typecheck and lint at any scope and broad tests through any alias or wrapper', () => {
    expect(GATES).toMatch(
      /no build, typecheck, or lint at any scope, and no repository-wide, directory-wide, or workspace test, through any alias or wrapper/i,
    )
  })

  test('names concrete aliases and a named file that launches a suite', () => {
    for (const alias of ALIAS_EXAMPLES) {
      expect(GATES, alias).toContain(alias)
    }
    expect(GATES).toMatch(/named test file[^.]*runner expands to a suite/i)
  })

  test('the report-only and headless parent rules point at the gate rule', () => {
    for (const rules of [REPORT_ONLY_RULES, HEADLESS_RULES]) {
      expect(rules).toMatch(/Verification gates/)
      expect(rules).toMatch(/no build, typecheck, or lint/i)
    }
  })

  test('an inferred unattended run is covered by the parent rule', () => {
    expect(GATES).toMatch(/inferred unattended default/i)
  })
})

describe('ce:review verification gates: child-facing prompts', () => {
  test('the reviewer template forbids gates, tests and probes without a mode slot', () => {
    expect(REVIEWER_RULES).toMatch(
      /never run a build, typecheck, or lint at any scope/i,
    )
    expect(REVIEWER_RULES).toMatch(/never run a test or a probe/i)
    for (const alias of ALIAS_EXAMPLES) {
      expect(REVIEWER_RULES, alias).toContain(alias)
    }
    expect(REVIEWER_RULES).toMatch(
      /named test file[^.]*runner expands to a suite/i,
    )
    const gateRule = REVIEWER_RULES.match(
      /You are operationally read-only[\s\S]*?the parent decides/i,
    )?.[0]
    expect(gateRule ?? '').not.toMatch(
      /report-only|headless|autofix|interactive/i,
    )
  })

  test('reviewers report the claim and the command they would use, and the parent decides', () => {
    expect(REVIEWER_RULES).toMatch(
      /report the claim and the exact command you would use[^.]*`testing_gaps`/i,
    )
    expect(REVIEWER_RULES).toMatch(/the parent decides/i)
  })

  test('the reviewer template keeps its operationally read-only rule', () => {
    expect(REVIEWER_RULES).toMatch(/You are operationally read-only/)
    expect(REVIEWER_RULES).toMatch(
      /non-mutating inspection commands, including read-oriented `git` \/ `gh` commands/,
    )
  })

  test('the validator template stays static and is given no approved command', () => {
    expect(VALIDATOR_RULES).toMatch(
      /never run a build, typecheck, or lint at any scope/i,
    )
    expect(VALIDATOR_RULES).toMatch(/never run a test or a probe/i)
    expect(VALIDATOR_RULES).toMatch(/static/i)
    expect(VALIDATOR_RULES).toMatch(/no approved command/i)
    for (const alias of ALIAS_EXAMPLES) {
      expect(VALIDATOR_RULES, alias).toContain(alias)
    }
    expect(VALIDATOR_RULES).toMatch(
      /named test file[^.]*runner expands to a suite/i,
    )
  })

  test('the validator dispatch notes hand over no command to run', () => {
    const notes = normalize(section(VALIDATOR_TEMPLATE, '## Dispatch Notes'))
    expect(notes).toMatch(/Do not pass an approved command/i)
  })

  test('the CE-agent dispatch carries the same boundary in every mode', () => {
    expect(CE_AGENT_BOUNDARY.length).toBeGreaterThan(0)
    expect(STAGE_4).toContain(CE_AGENT_BOUNDARY)
    expect(CE_AGENT_BOUNDARY).toMatch(
      /never run a build, typecheck, or lint at any scope/i,
    )
    expect(CE_AGENT_BOUNDARY).toMatch(/never run a test or a probe/i)
    for (const alias of ALIAS_EXAMPLES) {
      expect(CE_AGENT_BOUNDARY, alias).toContain(alias)
    }
    expect(CE_AGENT_BOUNDARY).toMatch(/named test file that launches a suite/i)
    expect(CE_AGENT_BOUNDARY).toMatch(
      /report the claim and the exact command[^.]*parent decides/i,
    )
    expect(CE_AGENT_BOUNDARY).toMatch(/every mode/i)
  })

  test('the Stage 4 read-only sentence defers to the gate rule', () => {
    expect(STAGE_4).toMatch(
      /Reviewer sub-agents[^.]*never run a build, typecheck, lint, test, or probe[^.]*Verification gates/i,
    )
  })
})

describe('ce:review verification gates: probes', () => {
  test('only the parent runs a probe, for a concrete finding, with every criterion named', () => {
    expect(PROBE_PARAGRAPH).toMatch(/Only the parent runs a probe/i)
    expect(PROBE_PARAGRAPH).toMatch(/concrete finding/i)
    expect(PROBE_PARAGRAPH).toMatch(/the exact command/i)
    expect(PROBE_PARAGRAPH).toMatch(/the claim (?:the command|it) tests/i)
    expect(PROBE_PARAGRAPH).toMatch(/named test file rather than a suite/i)
    expect(PROBE_PARAGRAPH).toMatch(/result in Coverage/i)
  })

  test('caps the run at one per finding and merges duplicate proposals into one run', () => {
    expect(PROBE_PARAGRAPH).toMatch(/at most one probe per finding/i)
    expect(PROBE_PARAGRAPH).toMatch(
      /two reviewers propose the same probe for the same finding[^.]*once/i,
    )
  })

  test('a named file whose runner expands to a suite is not a probe', () => {
    expect(PROBE_PARAGRAPH).toMatch(
      /named (?:test )?file whose runner expands to a suite is not a probe/i,
    )
  })

  test('a denied, unavailable or inconclusive probe is uncertainty, never a pass', () => {
    expect(PROBE_PARAGRAPH).toMatch(
      /denied, unavailable, or inconclusive probe leaves the finding uncertain and is never reported as a pass/i,
    )
  })

  test('no probe runs on a fork PR or a PR from an author without write access', () => {
    expect(PROBE_PARAGRAPH).toMatch(
      /never run a probe on a fork PR or a PR from an author without write access/i,
    )
    expect(PROBE_PARAGRAPH).toMatch(
      /cannot be established[^.]*skip the probe|skip the probe[^.]*cannot be established/i,
    )
  })

  test('reviewers and CE agents report the command rather than run it', () => {
    expect(PROBE_PARAGRAPH).toMatch(
      /Reviewers and CE agents report the claim and the command they would use/i,
    )
  })

  test('the persona catalog carries the same probe criteria', () => {
    expect(CATALOG_PROBES).toMatch(/Only the parent runs a probe/i)
    expect(CATALOG_PROBES).toMatch(/at most one probe per finding/i)
    expect(CATALOG_PROBES).toMatch(/named test file rather than a suite/i)
    expect(CATALOG_PROBES).toMatch(/never reported as a pass/i)
    expect(CATALOG_PROBES).toMatch(
      /fork PR or a PR from an author without write access/i,
    )
    expect(CATALOG_PROBES).toMatch(/permission boundary/i)
  })

  test('the pinned probe selection wording survives', () => {
    expect(normalize(SKILL)).toMatch(
      /execution probe[^.]*separate parent decision/i,
    )
    expect(normalize(SKILL)).toMatch(/probe[^.]*permission boundary/i)
    expect(normalize(SKILL)).toMatch(/probe[^.]*target/i)
  })
})

describe('ce:review verification gates: validators and the fixer', () => {
  test('Stage 5b states validators are static and handed no approved command', () => {
    expect(STAGE_5B).toMatch(/Validators stay static/i)
    expect(STAGE_5B).toMatch(/no approved command/i)
    expect(STAGE_5B).toMatch(
      /never runs? a build, typecheck, or lint at any scope/i,
    )
  })

  test('Stage 5b keeps its validation requirement for the gated band', () => {
    expect(STAGE_5B).toMatch(
      /Dispatch validators for exactly the findings `merge`'s `validator_requests` names/,
    )
    expect(STAGE_5B).toMatch(/P0\/P1-or-`requires_verification` gating band/)
    expect(STAGE_5B).toMatch(/Every request needs a result/)
    expect(normalize(VALIDATOR_TEMPLATE)).toMatch(
      /A finding is \*\*gated\*\* \(eligible for validation\) when it is P0 or P1 severity, or when `requires_verification: true`/,
    )
  })

  test('the headless fixer runs targeted tests of changed files only and reports unverified fixes', () => {
    for (const text of [HEADLESS_RULES, HEADLESS_STEP_2]) {
      expect(text).toMatch(/targeted tests of the files it changed/i)
      expect(text).toMatch(/no build, typecheck, lint, or broad suite/i)
      expect(text).toMatch(/reports? (?:that|the) fix as unverified/i)
      expect(text).toMatch(/"Review complete" does not imply/i)
    }
  })

  test('the shared fixer step still bounds verification to targeted tests', () => {
    expect(STEP_3).toMatch(/runs the relevant targeted tests in one pass/)
    expect(STEP_3).toMatch(/Verification gates/)
  })
})
