import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// These tests pin the prose that tells a parent agent to load the metacogs
// skills `counterfactual` and `synthesis` at four decision points. They assert
// wiring text and placement, not model behavior. The behavior evidence is the
// RED/GREEN scenario record kept with the change.

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const PLAN = read('skills/ce-plan/SKILL.md')
const REVIEW = read('skills/ce-review/SKILL.md')
const DEEPENING = read('skills/ce-plan/references/deepening-workflow.md')
const DEEPEN_PLAN = read('skills/deepen-plan/SKILL.md')

const P1_TEXT =
  "When you settle a question, or accept a requirement the plan builds on, and the answer rests on a claim that nothing in the origin document, the repo, or the research has checked (for example a requirement relayed from a meeting or a chat), and the answer affects architecture, scope, sequencing, or risk, load the `counterfactual` skill first if it is available. It comes from the separate metacogs plugin and is not a Systematic skill: load it by that bare name through the host's skill-loading mechanism, in the parent agent only, never in a dispatched sub-agent. Do not load it when the claim is already checked or the answer is mechanical. Carry its flip test into the plan as an assumption or open question rather than treating the claim as settled, with or without a user to ask. If the skill is not available, continue unchanged."

const P2_TEXT =
  "The metacogs skills `synthesis` and `counterfactual`, if you load them for such a conflict, come from a separate plugin and are not Systematic skills. Load them by their bare names through the host's skill-loading mechanism, in the parent agent only. If they are not available, continue unchanged."

const P3_TEXT =
  "   If two reviewers in one group state opposed severities, or opposed claims about whether the defect is real or already handled, load the `synthesis` skill before deciding that group, if it is available and the mode is interactive or autofix (never headless or report-only). It comes from the separate metacogs plugin: it is not a Systematic skill and not this stage's merge. Load it by that bare name through the host's skill-loading mechanism, in the parent agent only, never in a reviewer or validator sub-agent. Rewording of one defect is not a disagreement. If the skill is not available, continue unchanged."

const P3_MODE_CLAUSE =
  'if it is available and the mode is interactive or autofix (never headless or report-only)'

/** Index of `needle`, failing the test if it is missing or appears twice. */
function once(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(haystack.lastIndexOf(needle)).toBe(first)
  return first
}

/** True when `a < b < c`, with each already known to exist. */
const ordered = (a: number, b: number, c: number) => a < b && b < c

describe('P1: ce:plan Phase 2 loads `counterfactual` for an unchecked claim', () => {
  test('carries the exact inserted text once', () => {
    once(PLAN, P1_TEXT)
  })

  test('sits in Phase 2, after the question classification and before "Ask the user only when"', () => {
    const phase2 = once(PLAN, '### Phase 2: Resolve Planning Questions')
    const deferred = once(PLAN, '- **Deferred to implementation**')
    const text = once(PLAN, P1_TEXT)
    const ask = once(PLAN, 'Ask the user only when the answer materially')
    const phase3 = once(PLAN, '### Phase 3: Structure the Plan')
    expect(ordered(phase2, deferred, text)).toBe(true)
    expect(ordered(text, ask, phase3)).toBe(true)
  })

  test('triggers at settle time on an unchecked claim, not only at a later decision', () => {
    expect(P1_TEXT).toContain(
      'When you settle a question, or accept a requirement the plan builds on',
    )
    expect(P1_TEXT).toContain(
      'rests on a claim that nothing in the origin document, the repo, or the research has checked',
    )
  })

  test('says the skill is from another plugin, not Systematic', () => {
    expect(P1_TEXT).toContain('`counterfactual`')
    expect(P1_TEXT).toContain('separate metacogs plugin')
    expect(P1_TEXT).toContain('not a Systematic skill')
    expect(P1_TEXT).toContain('by that bare name')
  })

  test('is parent-only and fails open', () => {
    expect(P1_TEXT).toContain(
      'in the parent agent only, never in a dispatched sub-agent',
    )
    expect(P1_TEXT).toContain(
      'If the skill is not available, continue unchanged.',
    )
  })

  test('names no mode carve-out (pipeline runs carry the flip test as an assumption)', () => {
    expect(P1_TEXT).toContain('with or without a user to ask')
    expect(P1_TEXT).not.toMatch(/interactive mode only|never in pipeline/i)
  })
})

describe('P2: deepening conflict clarifier in ce:plan and deepen-plan', () => {
  test('ce:plan deepening-workflow carries the exact text once, after the conflict bullets and before 5.3.6b', () => {
    const conflict = once(DEEPENING, 'If agent outputs conflict:')
    const tradeoff = once(
      DEEPENING,
      '- If a real tradeoff remains, record it explicitly in the plan',
    )
    const text = once(DEEPENING, P2_TEXT)
    const next = once(DEEPENING, '## 5.3.6b Interactive Finding Review')
    expect(ordered(conflict, tradeoff, text)).toBe(true)
    expect(text).toBeLessThan(next)
  })

  test('deepen-plan carries the exact text once, after the conflict bullets and before Phase 5', () => {
    const conflict = once(DEEPEN_PLAN, 'If agent outputs conflict:')
    const tradeoff = once(
      DEEPEN_PLAN,
      '- If a real tradeoff remains, record it explicitly in the plan',
    )
    const text = once(DEEPEN_PLAN, P2_TEXT)
    const next = once(
      DEEPEN_PLAN,
      '### Phase 5: Synthesize and Rewrite the Plan',
    )
    expect(ordered(conflict, tradeoff, text)).toBe(true)
    expect(text).toBeLessThan(next)
  })

  test('names both skills, says they are not Systematic skills, and keeps the loader neutral', () => {
    expect(P2_TEXT).toContain('`synthesis` and `counterfactual`')
    expect(P2_TEXT).toContain('come from a separate plugin')
    expect(P2_TEXT).toContain('not Systematic skills')
    expect(P2_TEXT).toContain('by their bare names')
    expect(P2_TEXT).toContain("host's skill-loading mechanism")
  })

  test('is a clarifier, not a trigger: loads are conditional on the agent already choosing to', () => {
    expect(P2_TEXT).toContain('if you load them for such a conflict')
    expect(P2_TEXT).not.toMatch(/\b(must|always|before choosing)\b/i)
  })

  test('is parent-only and fails open in both files', () => {
    expect(P2_TEXT).toContain('in the parent agent only')
    expect(P2_TEXT).toContain('If they are not available, continue unchanged.')
  })
})

describe('P3: ce:review Stage 5 loads `synthesis` on opposed reviewers', () => {
  const stage5 = REVIEW.slice(
    once(REVIEW, '### Stage 5: Merge findings'),
    once(REVIEW, '### Stage 5b: Validation pass'),
  )

  test('carries the exact inserted text once', () => {
    once(REVIEW, P3_TEXT)
    once(stage5, P3_TEXT)
  })

  test('sits inside list item 3, after the worked example and before item 4', () => {
    const item3 = once(stage5, '3. **Adjudicate every candidate group.**')
    const example = once(
      stage5,
      '   Worked example: at `src/lib/model-availability.ts:139`',
    )
    const text = once(stage5, P3_TEXT)
    const item4 = once(stage5, '4. **Run `merge`.**')
    expect(ordered(item3, example, text)).toBe(true)
    expect(text).toBeLessThan(item4)
    // Indented three spaces and preceded by a blank line, so it stays in item 3.
    expect(stage5.slice(0, text).endsWith('\n\n')).toBe(true)
    // Item 4 follows directly, with no stray blank-line paragraph in between.
    expect(stage5.slice(text + P3_TEXT.length)).toStartWith(
      '\n4. **Run `merge`.**',
    )
  })

  test('triggers on opposed severities or opposed real-versus-handled claims, not rewording', () => {
    expect(P3_TEXT).toContain('opposed severities')
    expect(P3_TEXT).toContain(
      'opposed claims about whether the defect is real or already handled',
    )
    expect(P3_TEXT).toContain('Rewording of one defect is not a disagreement.')
  })

  test('runs in interactive and autofix modes only, never headless or report-only', () => {
    expect(P3_TEXT).toContain(P3_MODE_CLAUSE)
    expect(P3_TEXT).toContain('headless')
    expect(P3_TEXT).toContain('report-only')
  })

  test('says the skill is from another plugin and is not the stage merge', () => {
    expect(P3_TEXT).toContain('`synthesis`')
    expect(P3_TEXT).toContain('separate metacogs plugin')
    expect(P3_TEXT).toContain('not a Systematic skill')
    expect(P3_TEXT).toContain("not this stage's merge")
    expect(P3_TEXT).toContain('by that bare name')
  })

  test('is parent-only, never in a reviewer or validator, and fails open', () => {
    expect(P3_TEXT).toContain(
      'in the parent agent only, never in a reviewer or validator sub-agent',
    )
    expect(P3_TEXT).toContain(
      'If the skill is not available, continue unchanged.',
    )
  })
})

describe('reviewer, validator and persona templates stay out of it', () => {
  const templates = [
    'skills/ce-review/references/subagent-template.md',
    'skills/ce-review/references/validator-template.md',
    'skills/document-review/references/subagent-template.md',
  ]

  for (const rel of templates) {
    test(`${rel} mentions neither metacogs skill`, () => {
      const text = read(rel)
      expect(text).not.toMatch(/`counterfactual`|`synthesis`|metacogs/)
      expect(text).not.toMatch(/\bcounterfactual\b/i)
    })
  }
})

describe('the wiring adds no harness tool syntax', () => {
  test('inserted texts hold none of the neutral-v1 forbidden identifiers', () => {
    const banned =
      /task\(|subagent_type|todowrite|TodoWrite|request_user_input|ask_user|AskUserQuestion|update_plan|`question`/
    for (const text of [P1_TEXT, P2_TEXT, P3_TEXT]) {
      expect(text).not.toMatch(banned)
    }
  })
})
