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

/** Slice from a heading/label to the next heading of the same or shallower level. */
function sectionByPrefix(text: string, prefix: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) =>
    line.trim().toLowerCase().startsWith(prefix.toLowerCase()),
  )
  if (index < 0) return ''
  const opening = lines[index] ?? ''
  const level = (opening.match(/^#+/) ?? [''])[0]?.length ?? 0
  const out: string[] = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const heading = line.match(/^(#+)\s/)
    if (heading && (heading[1]?.length ?? 0) <= level) break
    out.push(line)
  }
  return out.join('\n')
}

/** Slice from one literal label to the next occurrence of any stop label. */
function blockBetween(
  text: string,
  startLabel: string,
  stopLabels: readonly string[],
): string {
  const start = text.indexOf(startLabel)
  if (start < 0) return ''
  let end = text.length
  for (const stop of stopLabels) {
    const candidate = text.indexOf(stop, start + startLabel.length)
    if (candidate >= 0 && candidate < end) end = candidate
  }
  return text.slice(start, end)
}

function tableFirstColumn(section: string): string[] {
  return section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => (line.split('|')[1] ?? '').trim().replaceAll('`', ''))
    .filter(
      (cell) =>
        cell.length > 0 &&
        !/^-+$/.test(cell) &&
        cell.toLowerCase() !== 'persona' &&
        cell.toLowerCase() !== 'agent' &&
        cell.toLowerCase() !== 'scenario',
    )
}

const SKILL = read('skills/ce-review/SKILL.md')
const CATALOG = read('skills/ce-review/references/persona-catalog.md')
const TEMPLATE = read('skills/ce-review/references/subagent-template.md')
const OUTPUT = read('skills/ce-review/references/review-output-template.md')

const SKILL_NORM = normalize(SKILL)
const CATALOG_NORM = normalize(CATALOG)
const TEMPLATE_NORM = normalize(TEMPLATE)
const OUTPUT_NORM = normalize(OUTPUT)

function rowContaining(text: string, needle: string): string {
  return text.split('\n').find((line) => line.includes(needle)) ?? ''
}

const ADVERSARIAL_RULE_TOKENS: readonly RegExp[] = [
  />=?\s*50/,
  /executable production code/i,
  /\btests?\b/i,
  /generated/i,
  /lockfile/i,
  /instruction\/prose Markdown|prose\/instruction|instruction-prose/i,
  /JSON schemas?/i,
  /config/i,
  /auth[^.]*payments?[^.]*data mutations?[^.]*external API/i,
  /regardless of file type/i,
]

const CORE = ['correctness', 'testing', 'project-standards']
const EXISTING_CROSS_CUTTING = [
  'security',
  'performance',
  'api-contract',
  'data-migrations',
  'reliability',
  'adversarial',
  'cli-readiness',
  'previous-comments',
]
const CE_CONDITIONAL = [
  'agent-native-reviewer',
  'learnings-researcher',
  'deployment-verification-agent',
]

describe('ce:review selection taxonomy (U6)', () => {
  test('the persona catalog always-on layer is exactly the three core reviewers', () => {
    const always = sectionByPrefix(CATALOG, '## Always-on')
    const names = tableFirstColumn(always).sort()
    expect(names).toEqual([...CORE].sort())
    for (const demoted of ['maintainability', 'agent-native', 'learnings']) {
      expect(always.toLowerCase()).not.toContain(demoted)
    }
  })

  test('the catalog conditional layer adds maintainability and retains every specialist', () => {
    const conditional = sectionByPrefix(CATALOG, '## Conditional')
    const names = tableFirstColumn(conditional)
    expect(names).toContain('maintainability')
    for (const specialist of EXISTING_CROSS_CUTTING) {
      expect(names, specialist).toContain(specialist)
    }
    // Maintainability trigger text: structural decisions, not tiny prose edits.
    expect(normalize(conditional)).toMatch(
      /abstract|coupling|control-flow|control flow|complexity|naming|ownership|dead code|refactor/i,
    )
  })

  test('kieran-typescript remains the stack-specific conditional', () => {
    const stack = sectionByPrefix(CATALOG, '## Stack-Specific Conditional')
    expect(tableFirstColumn(stack)).toContain('kieran-typescript')
  })

  test('agent-native, learnings, and deployment-verification are CE conditional agents', () => {
    const ce = sectionByPrefix(CATALOG, '## CE Conditional Agents')
    for (const name of CE_CONDITIONAL) {
      expect(ce, name).toContain(name)
    }
    const ceNorm = normalize(ce)
    expect(ceNorm).toMatch(
      /agent-facing|agent parity|discoverability|CLI|tool|workflow|access path/i,
    )
    expect(ceNorm).toMatch(
      /bug|regression|hardening|recurring|documented solution|prior art/i,
    )
    expect(ceNorm).toMatch(/migration|backfill/i)
  })

  test('SKILL always-on table lists only the three core reviewers', () => {
    const always = blockBetween(SKILL, '**Always-on (every review):**', [
      '**Cross-cutting conditional',
    ])
    for (const core of [
      'correctness-reviewer',
      'testing-reviewer',
      'project-standards-reviewer',
    ]) {
      expect(always, core).toContain(core)
    }
    expect(always).not.toContain('maintainability-reviewer')
    expect(always).not.toContain('agent-native-reviewer')
    expect(always).not.toContain('learnings-researcher')
  })

  test('SKILL keeps the structured and CE conditional taxonomy', () => {
    const cross = blockBetween(SKILL, '**Cross-cutting conditional', [
      '**Stack-specific conditional',
    ])
    expect(cross).toContain('maintainability-reviewer')
    for (const specialist of EXISTING_CROSS_CUTTING) {
      expect(cross, specialist).toContain(`${specialist}-reviewer`)
    }

    const stack = blockBetween(SKILL, '**Stack-specific conditional', [
      '**CE conditional',
    ])
    expect(stack).toContain('kieran-typescript-reviewer')

    const ce = blockBetween(SKILL, '**CE conditional', ['## Review Scope'])
    for (const name of CE_CONDITIONAL) {
      expect(ce, name).toContain(name)
    }
  })

  test('no authoritative stale floor statement survives', () => {
    const stale = [
      /6 reviewers/i,
      /4 always-on/i,
      /all 4 always-on/i,
      /2 CE always-on/i,
      /spawns all 4/i,
      /maintainability \(always\)/i,
      /agent-native-reviewer \(always\)/i,
      /learnings-researcher \(always\)/i,
      /all 4 always-on personas plus the 2 CE always-on agents/i,
    ]
    for (const doc of [SKILL_NORM, CATALOG_NORM]) {
      for (const pattern of stale) {
        expect(doc, `${pattern} in authoritative text`).not.toMatch(pattern)
      }
    }
  })

  test('all four modes share one reviewer-selection policy', () => {
    expect(SKILL_NORM).toMatch(
      /interactive, autofix, report-only, and headless/i,
    )
    expect(SKILL_NORM).toMatch(/same (?:reviewer-)?selection policy/i)
  })

  test('selection reason and surface are recorded and passed to prompts', () => {
    expect(SKILL_NORM).toMatch(/selection_reason/)
    expect(SKILL_NORM).toMatch(/selection_surface/)
    expect(SKILL_NORM).toMatch(
      /core personas may omit|core personas may omit both/i,
    )
    expect(SKILL_NORM).toMatch(
      /CE conditional agents?[^.]*(?:reason|surface)[^.]*Coverage|Coverage[^.]*(?:reason|surface)[^.]*CE conditional/i,
    )
    // The template exposes bounded selection slots without changing raw output.
    expect(TEMPLATE_NORM).toMatch(/selection-reason|selection reason/i)
    expect(TEMPLATE_NORM).toMatch(/selection-surface|selection surface/i)
    expect(TEMPLATE_NORM).toMatch(/exactly one JSON payload/i)
  })

  test('team and Coverage distinguish core, conditional, none, and failed', () => {
    expect(SKILL_NORM).toMatch(
      /intentionally no conditional|no conditional selected/i,
    )
    expect(SKILL_NORM).toMatch(
      /selected-but-failed|selected but failed|selected[- ]but[- ](?:failed|malformed|unavailable)/i,
    )
    expect(SKILL_NORM).toMatch(/malformed/)
    expect(SKILL_NORM).toMatch(/validation_unavailable|validation unavailable/)
  })

  test('a rejected reviewer return gets one same-session re-ask and one terminal result', () => {
    expect(SKILL_NORM).toMatch(/at most 2 returns and 2 screens/)
    expect(SKILL_NORM).toMatch(/resume the same reviewer session once/)
    expect(SKILL_NORM).toMatch(/Assemble each persona's terminal screen result/)
    expect(SKILL_NORM).toMatch(/continuation unavailable/)
    expect(SKILL_NORM).toMatch(
      /malformed, never-returned and validation-unavailable stay three distinct/i,
    )
  })

  test('execution probes are a separate parent decision with a boundary', () => {
    expect(SKILL_NORM).toMatch(
      /probe(?:s)?[^.]*(?:separate|not a reviewer|not reviewers)/i,
    )
    expect(SKILL_NORM).toMatch(/probe[^.]*permission boundary/i)
    expect(SKILL_NORM).toMatch(/probe[^.]*target/i)
  })

  test('a selected risk-critical failure cannot vanish by shrinking the team', () => {
    expect(SKILL_NORM).toMatch(
      /risk-critical[^.]*(?:cannot disappear|not disappear|shrinking the reported team|blocking)/i,
    )
  })

  test('intent may clarify surface but never selects without a changed surface', () => {
    expect(SKILL_NORM).toMatch(
      /never selects a reviewer without a corresponding changed|selected without a corresponding/i,
    )
    expect(SKILL_NORM).not.toMatch(/not which reviewers are selected/i)
  })

  test('scenario contracts are explicit in the catalog', () => {
    const scenarios = sectionByPrefix(CATALOG, '## Selection scenarios')
    const text = normalize(scenarios)
    expect(text).toMatch(/prose|fixture/i)
    expect(text).toMatch(/no runtime probe/i)
    expect(text).toMatch(/maintainability/i)
    expect(text).toMatch(/agent-native/i)
    expect(text).toMatch(/learnings-researcher/i)
    for (const specialist of [
      'security',
      'data-migrations',
      'api-contract',
      'reliability',
      'performance',
    ]) {
      expect(text, specialist).toContain(specialist)
    }
    expect(text).toMatch(/execution probe/i)
  })

  test('learnings and agent-native output sections render conditionally', () => {
    expect(OUTPUT_NORM).toMatch(
      /Learnings & Past Solutions[^.]*(?:only when|omit|selected)/i,
    )
    expect(OUTPUT_NORM).toMatch(
      /Agent-Native Gaps[^.]*(?:only when|omit|selected)/i,
    )
  })

  test('adversarial trigger is semantically identical on both surfaces', () => {
    const skillRow = rowContaining(SKILL, 'adversarial-reviewer')
    const catalogRow = rowContaining(
      sectionByPrefix(CATALOG, '## Conditional'),
      'adversarial',
    )
    expect(skillRow.length).toBeGreaterThan(0)
    expect(catalogRow.length).toBeGreaterThan(0)
    for (const row of [skillRow, catalogRow]) {
      for (const token of ADVERSARIAL_RULE_TOKENS) {
        expect(row, token.source).toMatch(token)
      }
    }
    // Stage 3 file-type awareness keeps the same executable-code accounting.
    const stage3 = normalize(
      sectionByPrefix(SKILL, '### Stage 3: Select reviewers'),
    )
    expect(stage3).toMatch(/adversarial[\s\S]{0,500}line-count/i)
    expect(stage3).toMatch(/executable production code/i)
  })

  test('Stage 4 structured-persona inputs include selection reason and surface', () => {
    const spawning = SKILL.slice(
      SKILL.indexOf('#### Spawning'),
      SKILL.indexOf('#### Raw return admission'),
    )
    expect(spawning).toMatch(/selection_reason/)
    expect(spawning).toMatch(/selection_surface/)
    expect(spawning).toMatch(/core personas receive empty/i)

    const selectionIndex = spawning.indexOf('selection_reason')
    const standardsIndex = spawning.indexOf('project-standards` only')
    expect(selectionIndex).toBeGreaterThanOrEqual(0)
    expect(standardsIndex).toBeGreaterThan(selectionIndex)
  })

  test('summary-table agent-native trigger matches Stage 3 and catalog', () => {
    const reviewers = sectionByPrefix(SKILL, '## Reviewers')
    const row = rowContaining(reviewers, 'agent-native-reviewer')
    expect(row).toMatch(/user-\s*(?:or|\/)\s*agent-facing/i)
    expect(SKILL_NORM).toMatch(/user-\s*or\s*agent-facing/i)
    expect(CATALOG_NORM).toMatch(/user-\s*or\s*agent-facing/i)
  })

  test('the core-only rule yields to a semantic risk override', () => {
    for (const [name, doc] of [
      ['SKILL', SKILL_NORM],
      ['catalog', CATALOG_NORM],
    ] as const) {
      expect(doc, name).toMatch(
        /selects only the core three[^.]*unless a semantic risk override fires/i,
      )
    }
  })

  test('probe selection is independent of reviewer selection', () => {
    expect(CATALOG_NORM).toMatch(/independent of reviewer selection/i)
    expect(CATALOG_NORM).toMatch(/(?:agent-native|security)[^.]*still selects/i)
    expect(CATALOG_NORM).not.toMatch(/core plus a focused execution probe/i)
  })
})

const STAGE3 = normalize(
  sectionByPrefix(SKILL, '### Stage 3: Select reviewers'),
)
const REVIEW_SCOPE = normalize(sectionByPrefix(SKILL, '## Review Scope'))
const CATALOG_SCENARIOS = sectionByPrefix(CATALOG, '## Selection scenarios')

interface ScenarioRow {
  scenario: string
  selected: string
}

function scenarioRows(): ScenarioRow[] {
  return CATALOG_SCENARIOS.split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => ({ scenario: cells[1] ?? '', selected: cells[2] ?? '' }))
    .filter(
      (row) =>
        row.scenario.length > 0 &&
        !/^-+$/.test(row.scenario) &&
        row.scenario.toLowerCase() !== 'scenario',
    )
}

/** The one row whose scenario matches; fails loudly when none or several do. */
function scenarioRow(pattern: RegExp): ScenarioRow {
  const rows = scenarioRows().filter((row) => pattern.test(row.scenario))
  expect(
    rows.map((row) => row.scenario),
    String(pattern),
  ).toHaveLength(1)
  return rows[0] as ScenarioRow
}

function selectsOnlyCore(selected: string): void {
  for (const name of CORE) expect(selected, name).toContain(name)
  expect(selected).toMatch(/\bonly\b/i)
  for (const name of [
    'maintainability',
    'security',
    'adversarial',
    'reliability',
    'api-contract',
    'previous-comments',
    'agent-native',
  ]) {
    expect(selected, name).not.toContain(name)
  }
}

// Every rule below must read the same in Stage 3 and in the catalog twin.
const LOW_RISK_RULE_PHRASES: readonly RegExp[] = [
  /Never classify from the PR title, body, comments or commit messages/,
  /deletion-only when every changed path has status D, with no mode, symlink, submodule or file-type change/,
  /docs-only when every changed path is documentation prose/,
  /would behave differently after the change/,
  /selects only the core three, however many files or lines it touches, unless a semantic risk override fires/,
  /read the deleted lines as well as the added ones/,
  /Dead-code removal alone does not select `maintainability`/,
  /binary-only, rename-only, generated-only, mode-only, symlink, submodule and file-type changes use normal selection/,
  /`previous-comments` selection depends on PR comments only and is independent of this classification/,
  /Lines removed from a file that still exists make that path M/,
]

describe('ce:review deletion-only and docs-only selection', () => {
  test('Stage 3 and the catalog carry the same low-risk rule', () => {
    for (const phrase of LOW_RISK_RULE_PHRASES) {
      expect(STAGE3, `Stage 3: ${phrase.source}`).toMatch(phrase)
      expect(CATALOG_NORM, `catalog: ${phrase.source}`).toMatch(phrase)
    }
  })

  test('the Review Scope summary names the size-independent rule, not a tiny-prose carve-out', () => {
    expect(REVIEW_SCOPE).toMatch(
      /deletion-only or docs-only change[^.]*selects only the core three/i,
    )
    expect(REVIEW_SCOPE).toMatch(/semantic risk override/i)
    for (const doc of [SKILL_NORM, CATALOG_NORM]) {
      expect(doc).not.toMatch(/tiny prose or fixture correction/i)
    }
  })

  test('a 28-file pure deletion selects the core three only', () => {
    const row = scenarioRow(/^Deletion-only change .*however many files/i)
    selectsOnlyCore(row.selected)
    expect(row.selected).toMatch(/no runtime probe/i)
    expect(row.scenario).toMatch(/every path has status D/i)
  })

  test('a docs-only prose change selects the core three only', () => {
    const row = scenarioRow(/^Docs-only change/i)
    selectsOnlyCore(row.selected)
    expect(row.selected).toMatch(/no runtime probe/i)
  })

  test('deleting an authorization guard selects security and adversarial despite being deletion-only', () => {
    const row = scenarioRow(
      /^Deletion-only change whose deleted lines remove a guard/i,
    )
    expect(row.selected).toMatch(/^core plus /)
    expect(row.selected).toContain('security')
    expect(row.selected).toContain('adversarial')
  })

  test('a mixed change that removes a guard and adds code evaluates both sides', () => {
    const row = scenarioRow(/^Mixed change that removes a guard/i)
    expect(row.scenario).toMatch(/adds code/i)
    expect(row.selected).toMatch(/both sides/i)
    expect(row.selected).toContain('security')
  })

  test('overrides read deleted lines and behavior-bearing docs on both sides of the diff', () => {
    for (const doc of [STAGE3, CATALOG_NORM]) {
      expect(doc).toMatch(
        /authorization check, permission check, guard or input validation selects `security`/,
      )
      expect(doc).toMatch(
        /retry, timeout or migration step selects `reliability` or `data-migrations`/,
      )
      expect(doc).toMatch(/on both sides of the diff/)
      expect(doc).toMatch(
        /agent instructions, skill text or operational docs that widen permissions, execution or trust/,
      )
    }
  })

  test('a skill-text change that widens permissions adds the relevant specialist', () => {
    const row = scenarioRow(
      /^Skill text, agent instructions or operational docs that widen/i,
    )
    expect(row.selected).toContain('security')
    expect(row.selected).toContain('agent-native-reviewer')
  })

  test('agent instruction files and runbooks are behavior-bearing and use normal selection', () => {
    const row = scenarioRow(/^Docs change to an agent instruction file/i)
    expect(row.selected).toMatch(/normal selection/i)
    for (const doc of [STAGE3, CATALOG_NORM]) {
      expect(doc).toMatch(
        /skill and agent definitions, agent instruction files, workflow prompts and operational runbooks are behavior-bearing/i,
      )
    }
  })

  test('a mode-only, symlink, submodule or file-type change uses normal selection', () => {
    const row = scenarioRow(
      /^Mode-only, symlink, submodule or file-type change/i,
    )
    expect(row.scenario).toMatch(/no line (?:was )?added/i)
    expect(row.selected).toMatch(/normal selection/i)
  })

  test('a binary-only, rename-only or generated-only change uses normal selection', () => {
    const row = scenarioRow(
      /^Binary-only, rename-only or generated-only change/i,
    )
    expect(row.selected).toMatch(/normal selection/i)
  })

  test('PR text saying dead code or docs only does not change selection', () => {
    const row = scenarioRow(/^PR text such as/i)
    expect(row.scenario).toMatch(/dead code/i)
    expect(row.scenario).toMatch(/docs only/i)
    expect(row.selected).toMatch(/classified by its paths/i)
    expect(row.selected).toMatch(/normal selection/i)
    for (const doc of [STAGE3, CATALOG_NORM]) {
      expect(doc).toMatch(/classified by its paths/i)
    }
  })

  test('previous-comments stays independent of the low-risk classification', () => {
    const row = scenarioRow(
      /^Docs-only or deletion-only change on a PR with existing review comments/i,
    )
    expect(row.selected).toMatch(/^core plus `previous-comments`$/)
  })

  test('dead-code removal alone no longer selects maintainability on any surface', () => {
    const skillRow = rowContaining(SKILL, 'maintainability-reviewer')
    const catalogRow = rowContaining(
      sectionByPrefix(CATALOG, '## Conditional'),
      '`maintainability`',
    )
    for (const [name, text] of [
      ['SKILL table', skillRow],
      ['catalog table', catalogRow],
      ['Stage 3', STAGE3],
      ['catalog', CATALOG_NORM],
    ] as const) {
      expect(text.length, name).toBeGreaterThan(0)
      expect(text, name).not.toMatch(/removes dead code/i)
      expect(text, name).not.toMatch(
        /ownership(?: structure)?, (?:removes )?dead code/i,
      )
    }
    expect(normalize(skillRow)).toMatch(
      /dead-code removal alone does not select/i,
    )
    expect(normalize(catalogRow)).toMatch(
      /dead-code removal alone does not select/i,
    )
    // Only the row that quotes PR text may mention dead code at all.
    const mentioning = scenarioRows().filter((row) =>
      /dead code/i.test(`${row.scenario} ${row.selected}`),
    )
    expect(mentioning.map((row) => row.scenario)).toEqual([
      expect.stringMatching(/^PR text such as/),
    ])
  })

  test('deleted lines do not count toward the adversarial size threshold, and the high-risk trigger stays', () => {
    const skillRow = rowContaining(SKILL, 'adversarial-reviewer')
    const catalogRow = rowContaining(
      sectionByPrefix(CATALOG, '## Conditional'),
      '`adversarial`',
    )
    for (const [name, text] of [
      ['SKILL table', normalize(skillRow)],
      ['catalog table', normalize(catalogRow)],
      ['Stage 3', STAGE3],
    ] as const) {
      expect(text, name).toMatch(/deleted lines/i)
      expect(text, name).toMatch(
        /not count|excluding deleted|excludes? deleted/i,
      )
      expect(text, name).toMatch(/>=\s*50/)
      expect(text, name).toMatch(/regardless of file type/i)
    }
  })

  test('a deletion-only change with 80 deleted production lines does not trip the adversarial threshold', () => {
    const row = scenarioRow(/^Deletion-only change .*80 lines/i)
    const exclusion =
      'deleted lines do not count toward the `adversarial` size threshold'
    expect(row.selected).toContain(exclusion)
    selectsOnlyCore(row.selected.replace(exclusion, ''))
  })

  test('classification reads the manifest and diff, and the manifest source is stated', () => {
    expect(STAGE3).toMatch(/diff headers/)
    expect(STAGE3).toMatch(/git diff --name-status/)
  })

  test('the pinned selection phrases survive the rewrite', () => {
    expect(SKILL_NORM).toMatch(
      /interactive, autofix, report-only, and headless/i,
    )
    expect(SKILL_NORM).toMatch(/same (?:reviewer-)?selection policy/i)
    expect(SKILL_NORM).toMatch(
      /never selects a reviewer without a corresponding changed/i,
    )
  })
})
