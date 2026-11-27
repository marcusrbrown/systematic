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

const RECORD_DECLINED =
  'When writing the plan, record each distinct hazard declined in 1.4 or 1.5 in Risks & Dependencies, even for Lightweight plans. Write `Declined — covered by <backstop>` or `Declined — not established at the current pin`. Neither creates implementation work.'

const HAZARD_SCOPE =
  'This applies to proposed hazard mitigations anywhere in the list below.'

const AUTO_OR_INTERACTIVE =
  "Use this test in auto mode. In interactive mode, honor the user's final Accept or Reject in 5.3.6b, subject to the existing edit limits."

const FAILED_ADMISSION =
  'On failed admission, record the covering backstop or `not established at the current pin`, set `recommended_action: Skip`, and bypass the persona tie-break. Later routing must preserve this recommendation.'

const NEVER_QUEUE =
  'Never queue an admission failure for silent apply. In interactive mode, route failures at anchors 75/100 as Proposed fixes with Skip recommended, reclassifying a `safe_auto` failure to `gated_auto` so it reaches the walk-through; apply only if the user explicitly chooses Apply for that finding. Anchor 50 remains non-actionable.'

const RECORD_IN_DEEPENING =
  'Record each hazard declined here in Risks & Dependencies as `Declined — covered by <backstop>` or `Declined — not established at the current pin`.'

const DECLINED_RENDER =
  'Render admission failures only under `Declined:`, with the recorded reason and no suggested fix. Do not nest a failed finding under an actionable root. Dependents of a declined root are non-actionable in this run.'

const HANDOFF_CONSUMES =
  'address P0/P1 items in Proposed fixes and Decisions only; do not act on Declined or FYI observations.'

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
const review37 = section(
  SYNTHESIS,
  '### 3.7 Route by Autofix Class',
  '### 3.8 Sort',
)
const applyStep = section(
  SYNTHESIS,
  '### Apply safe_auto fixes',
  '### Route Remaining Findings',
)
const routeRemaining = section(
  SYNTHESIS,
  '### Route Remaining Findings',
  '**Headless mode:** Do not use interactive question tools.',
)
const envelope = section(
  SYNTHESIS,
  '**Headless mode:** Do not use interactive question tools.',
  '**Interactive mode:**\n',
)
const HANDOFF = read('skills/ce-plan/references/plan-handoff.md')
const handoff538 = section(
  HANDOFF,
  '## 5.3.8 Document Review',
  '## 5.3.9 Final Checks and Cleanup',
)
const REVIEW_SKILL = read('skills/document-review/SKILL.md')
const reviewPhase0 = section(
  REVIEW_SKILL,
  '**Headless mode** changes the interaction model',
  'Callers invoke headless mode by including',
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

  test('1.4 records declined hazards from both 1.4 and 1.5, with no Risks clause in 1.5', () => {
    once(plan14, RECORD_DECLINED)
    expect(plan14.indexOf(RECORD_DECLINED)).toBeGreaterThan(
      plan14.indexOf(RULE),
    )
    expect(plan15).not.toContain('Risks')
  })

  test('the rule follows the last 1.4 research bullet', () => {
    const last = once(
      plan14,
      '- Any constraints that should materially shape the plan',
    )
    expect(plan14.indexOf(RULE)).toBeGreaterThan(last)
  })
})

describe('deepening applies the rule to proposed hazard mitigations', () => {
  test('deepening-workflow 5.3.7 puts the gate before Allowed changes, after the interactive-mode line', () => {
    const interactive = once(deepening537, '**In interactive mode:**')
    const gate = once(deepening537, `**Admission test.** ${RULE}`)
    const allowed = once(deepening537, 'Allowed changes:')
    expect(ordered(interactive, gate, allowed)).toBe(true)
    const para = deepening537.slice(gate, allowed)
    expect(para).toContain(HAZARD_SCOPE)
    expect(para).toContain(AUTO_OR_INTERACTIVE)
    expect(para).toContain(RECORD_IN_DEEPENING)
    expect(para).not.toContain('governs every change')
  })

  test('deepen-plan Phase 5 puts the gate before Allowed changes', () => {
    const gate = once(deepenPlanPhase5, `**Admission test.** ${RULE}`)
    const allowed = once(deepenPlanPhase5, 'Allowed changes:')
    expect(gate).toBeLessThan(allowed)
    const para = deepenPlanPhase5.slice(gate, allowed)
    expect(para).toContain(HAZARD_SCOPE)
    expect(para).toContain(RECORD_IN_DEEPENING)
    expect(para).not.toContain('governs every change')
  })
})

describe('document-review 3.5b applies the rule before action selection', () => {
  const mapping = once(review35b, '**Persona-to-action mapping.**')
  const tieBreak = once(review35b, '**Tie-break order')
  const admissionStart = once(review35b, '**Admission test.**')
  const admission = review35b.slice(admissionStart, tieBreak)

  test('the rule sits ahead of the tie-break order and the persona-to-action mapping', () => {
    const rule = once(review35b, RULE)
    expect(rule).toBeGreaterThan(admissionStart)
    expect(rule).toBeLessThan(tieBreak)
    expect(tieBreak).toBeLessThan(mapping)
  })

  test('scopes the rule to any finding whose fix adds a mitigation, whatever its autofix class', () => {
    expect(admission).toContain('every finding whose fix adds a mitigation')
    expect(admission).toContain(
      '(a new mechanism, unit, requirement or test), whatever its autofix class',
    )
  })

  test('records the backstop, sets Skip, and bypasses the persona tie-break', () => {
    once(admission, FAILED_ADMISSION)
    expect(admission).toContain('`recommended_action: Skip`')
  })

  test('excludes mechanical fixes and keeps an explicit user choice on top', () => {
    expect(admission).toContain(
      'Mechanical fixes, such as wrong counts or stale references, are not hazards.',
    )
    expect(admission).toContain('An explicit user choice still wins.')
  })
})

describe('document-review routes an admission failure away from silent apply', () => {
  test('3.7 never queues a failure for silent apply and keeps explicit Apply', () => {
    once(review37, NEVER_QUEUE)
  })

  test('a reclassified admission failure reaches the Phase 4 routing question', () => {
    expect(routeRemaining).toContain(
      'including admission failures 3.7 reclassified to `gated_auto` → enter the routing question',
    )
  })

  test('the 3.7 table no longer hardcodes Apply as the recommendation', () => {
    expect(review37).not.toContain('Apply marked (recommended)')
    expect(review37).toContain('the 3.5b recommendation')
  })

  test('Phase 4 applies only what 3.7 queued, with one authority for the exclusion', () => {
    expect(applyStep).toContain(
      'Apply only the findings 3.7 queued for silent apply',
    )
    expect(applyStep).not.toContain('failed the admission test')
  })

  test('the no-fix downgrade only turns Apply into Defer, never touching Skip', () => {
    expect(review35b).toContain(
      'if the winning action is `Apply` but the merged finding has no `suggested_fix`',
    )
  })
})

describe('headless output lists admission failures as Declined, not as findings to address', () => {
  test('the envelope has a Declined: label and renders failures only there', () => {
    expect(envelope).toContain('\nDeclined:\n')
    once(envelope, DECLINED_RENDER)
  })

  test('document-review Phase 0 qualifies silent apply and lists Declined: as non-actionable', () => {
    expect(reviewPhase0).toContain('eligible under 3.7')
    expect(reviewPhase0).toContain('`Declined:`')
  })

  test('the ce:plan handoff consumes only Proposed fixes and Decisions', () => {
    once(handoff538, HANDOFF_CONSUMES)
    expect(handoff538).not.toContain('Address any P0/P1 findings')
  })
})
