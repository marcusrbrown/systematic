import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// These tests pin the hazard-admission rule and where it sits at the five
// points where planning and review fold lane output into a plan. They assert
// wiring text and placement, not model behavior.

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const PLAN = read('skills/ce-plan/SKILL.md')
const DEEPENING = read('skills/ce-plan/references/deepening-workflow.md')
const DEEPEN_PLAN = read('skills/deepen-plan/SKILL.md')
const SYNTHESIS = read(
  'skills/document-review/references/synthesis-and-presentation.md',
)

const RULE =
  'Admit a hazard only if it bites at the current pin and no existing backstop covers it; otherwise decline it and name the backstop.'

const MINIMAL_CHANGE =
  'Before research, state the minimal change in one or two sentences, and size the plan to it.'

const RISKS_CLAUSE =
  "A declined hazard goes in the plan's Risks table, with the backstop as its mitigation."

const AUTO_MODE_CLAUSE =
  'In auto mode, the same test decides whether to integrate each finding.'

/** Index of `needle`, failing the test if it is missing or appears twice. */
function once(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(haystack.lastIndexOf(needle)).toBe(first)
  return first
}

/** Text between two anchors, each required to occur exactly once. */
function section(haystack: string, from: string, to?: string): string {
  const start = once(haystack, from)
  const end = to === undefined ? haystack.length : once(haystack, to)
  expect(end).toBeGreaterThan(start)
  return haystack.slice(start, end)
}

/** True when `a < b < c`, with each already known to exist. */
const ordered = (a: number, b: number, c: number) => a < b && b < c

const plan14 = section(
  PLAN,
  '#### 1.4 Consolidate Research',
  '#### 1.4b Reclassify Depth',
)
const plan15 = section(
  PLAN,
  '#### 1.5 Flow and Edge-Case Analysis (Conditional)',
  '### Phase 2: Resolve Planning Questions',
)
const deepening537 = section(
  DEEPENING,
  '## 5.3.7 Synthesize and Update the Plan',
)
const deepenPlanPhase5 = section(
  DEEPEN_PLAN,
  '### Phase 5: Synthesize and Rewrite the Plan',
  '### Phase 6: Final Checks and Write the File',
)
const review35b = section(
  SYNTHESIS,
  '### 3.5b Deterministic Recommended-Action Tie-Break',
  '### 3.5c Premise-Dependency Chain Linking',
)

describe('the admission rule appears once at each of five sites', () => {
  const sites = [
    ['ce:plan 1.4 Consolidate Research', plan14],
    ['ce:plan 1.5 Flow and Edge-Case Analysis', plan15],
    ['deepening-workflow 5.3.7', deepening537],
    ['deepen-plan Phase 5', deepenPlanPhase5],
    ['document-review 3.5b', review35b],
  ] as const

  for (const [name, text] of sites) {
    test(`${name} carries the exact rule once`, () => {
      once(text, RULE)
    })
  }

  test('each source file carries the rule the expected number of times', () => {
    const count = (text: string) => text.split(RULE).length - 1
    expect(count(PLAN)).toBe(2)
    expect(count(DEEPENING)).toBe(1)
    expect(count(DEEPEN_PLAN)).toBe(1)
    expect(count(SYNTHESIS)).toBe(1)
  })
})

describe('ce:plan placement', () => {
  test('the minimal-change sentence sits after Phase 0.7 and before Phase 1', () => {
    const phase07 = once(PLAN, '#### 0.7 Solo-Mode Scoping Synthesis')
    const headless = once(
      PLAN,
      'Continue to Phase 1 research as normal. At plan-write time (Phase 5.2)',
    )
    const text = once(PLAN, MINIMAL_CHANGE)
    const phase1 = once(PLAN, '### Phase 1: Gather Context')
    expect(ordered(phase07, headless, text)).toBe(true)
    expect(text).toBeLessThan(phase1)
  })

  test('the rule closes 1.4, with nothing after it', () => {
    expect(plan14.trimEnd().endsWith(RULE)).toBe(true)
  })

  test('the rule closes 1.5 with the Risks-table clause', () => {
    expect(plan15.trimEnd().endsWith(`${RULE} ${RISKS_CLAUSE}`)).toBe(true)
  })

  test('the rule follows the last 1.4 research bullet', () => {
    const last = once(
      plan14,
      '- Any constraints that should materially shape the plan',
    )
    expect(plan14.indexOf(RULE)).toBeGreaterThan(last)
  })
})

describe('deepening treats the rule as the meaning of "where justified"', () => {
  test('deepening-workflow 5.3.7 extends the item and gates auto mode', () => {
    const item = once(
      deepening537,
      '- Expand system-wide impact, risks, or rollout treatment where justified',
    )
    const rule = once(deepening537, RULE)
    const auto = once(deepening537, AUTO_MODE_CLAUSE)
    const next = once(
      deepening537,
      '- Reclassify open questions between `Resolved During Planning`',
    )
    expect(ordered(item, rule, auto)).toBe(true)
    expect(auto).toBeLessThan(next)
  })

  test('deepen-plan Phase 5 extends the item', () => {
    const item = once(
      deepenPlanPhase5,
      '- Expand system-wide impact, risks, or rollout treatment where justified',
    )
    const rule = once(deepenPlanPhase5, RULE)
    const next = once(
      deepenPlanPhase5,
      '- Reclassify open questions between `Resolved During Planning`',
    )
    expect(ordered(item, rule, next)).toBe(true)
  })
})

describe('document-review 3.5b applies the rule before action selection', () => {
  const mapping = once(review35b, '**Persona-to-action mapping.**')
  const tieBreak = once(review35b, '**Tie-break order')

  test('the rule sits ahead of the tie-break order and the persona-to-action mapping', () => {
    const rule = once(review35b, RULE)
    expect(rule).toBeLessThan(tieBreak)
    expect(tieBreak).toBeLessThan(mapping)
  })

  test('scopes the rule to any finding whose fix adds a mitigation, whatever its autofix class', () => {
    const before = review35b.slice(0, mapping)
    expect(before).toContain('every finding whose fix adds a mitigation')
    expect(before).toContain(
      '(a new mechanism, unit, requirement or test), whatever its autofix class',
    )
  })

  test('routes a failing finding to Skip with the backstop named, never silent safe_auto', () => {
    const before = review35b.slice(0, mapping)
    expect(before).toContain('`recommended_action: Skip`')
    expect(before).toContain('its backstop named')
    expect(before).toMatch(/never takes the silent `safe_auto` path/)
  })

  test('excludes mechanical fixes and keeps an explicit user choice on top', () => {
    const before = review35b.slice(0, mapping)
    expect(before).toContain(
      'Mechanical fixes, such as wrong counts or stale references, are not hazards.',
    )
    expect(before).toContain('An explicit user choice still wins.')
  })
})

describe('the rule text adds no harness tool syntax or banned strings', () => {
  test('rule and clauses hold none of the neutral-v1 forbidden identifiers or content-integrity banned strings', () => {
    const banned =
      /task\(|subagent_type|todowrite|TodoWrite|request_user_input|ask_user|AskUserQuestion|update_plan|`question`|Claude Code|TaskCreate|compound-engineering:|CLAUDE\.md|CLAUDE_PLUGIN_ROOT|\.claude\//
    for (const text of [RULE, MINIMAL_CHANGE, RISKS_CLAUSE, AUTO_MODE_CLAUSE]) {
      expect(text).not.toMatch(banned)
    }
  })
})
