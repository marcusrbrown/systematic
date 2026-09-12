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

  test('core-only prose case also excludes specialist surfaces', () => {
    expect(CATALOG_NORM).toMatch(
      /no structural decision[^.]*no user-\s*or\s*agent-facing[^.]*specialist surface/i,
    )
  })

  test('probe selection is independent of reviewer selection', () => {
    expect(CATALOG_NORM).toMatch(/independent of reviewer selection/i)
    expect(CATALOG_NORM).toMatch(/(?:agent-native|security)[^.]*still selects/i)
    expect(CATALOG_NORM).not.toMatch(/core plus a focused execution probe/i)
  })
})
