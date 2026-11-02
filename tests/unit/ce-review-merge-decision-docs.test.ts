// Ties the `merge` section of `pipeline-invocation.md` to the shipped
// validator. The section documents both adjudication decision forms; the
// example it carries is extracted from the markdown, matched with a `prepared`
// built from the real `screen` and `prepare` phases, and run through the real
// `validate-review.mjs merge`, so the documented shape cannot drift from the
// schema the helper enforces. The shapes agents most often get wrong (`kind`
// for `disposition`, a missing `decision_id`, `input_ids` for
// `input_finding_ids`) must keep failing at the paths the section names.

import { describe, expect, test } from 'bun:test'
import {
  MAX_DECISION_FACTS,
  MAX_INPUT_ID_LENGTH,
  MAX_PERSONAS,
  MAX_REASON_LENGTH,
  MAX_RUN_FINDINGS,
} from '../../src/lib/review-artifact-schema.js'
import {
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import { AdjudicationEnvelopeSchema } from '../../src/lib/review-pipeline-contract.js'
import {
  docSection,
  documentedJsonExample,
  hasBullet,
  hasMention,
  type JsonRecord,
  runShippedPhase,
} from '../helpers/ce-review-doc-contract.js'
import { buildScreenReturn } from './review-run-fixtures.js'

const FILE = 'src/auth/session.ts'
/** Where a credited persona's own finding sits: outside the group. */
const OTHER_FILE = 'src/auth/other.ts'
/** Where a declined member sits: apart from every merged group's `line`. */
const DECLINED_LINE = 90

const mergeSection = () => docSection('merge')

function documentedExample(): JsonRecord {
  return documentedJsonExample(mergeSection()) as JsonRecord
}

function decisionsOf(adjudication: JsonRecord): JsonRecord[] {
  return adjudication.decisions as JsonRecord[]
}

/** Input IDs are `<persona>#<index>`; the documented example cites them. */
function parseInputId(inputId: string): { persona: string; index: number } {
  const [persona, index] = inputId.split('#')
  if (persona === undefined || index === undefined) {
    throw new Error(`input id ${inputId} is not <persona>#<index>`)
  }
  return { persona, index: Number(index) }
}

/**
 * Builds a `merge` envelope around the given adjudication: one finding per
 * input ID the documented example cites (a merged decision's members share its
 * `line`, a declined one sits at `DECLINED_LINE`), one finding on another file
 * for each credited persona that cites none (so it has returned without
 * submitting to the group), then the real `screen` and `prepare` phases over
 * them.
 */
function buildEnvelope(adjudication: JsonRecord): JsonRecord {
  const { decisions } = AdjudicationEnvelopeSchema.parse(documentedExample())
  const lineByInputId = new Map<string, number>()
  const personas = new Set<string>()
  for (const decision of decisions) {
    if (decision.disposition === 'merged') {
      for (const id of decision.input_finding_ids) {
        lineByInputId.set(id, decision.line)
      }
      for (const persona of decision.eligible_agreement_credit ?? []) {
        personas.add(persona)
      }
    } else {
      lineByInputId.set(decision.input_finding_id, DECLINED_LINE)
    }
  }

  const findingsByPersona = new Map<string, number>()
  for (const id of lineByInputId.keys()) {
    const { persona, index } = parseInputId(id)
    personas.add(persona)
    findingsByPersona.set(
      persona,
      Math.max(findingsByPersona.get(persona) ?? 0, index + 1),
    )
  }

  const findingsFor = (persona: string) =>
    findingsByPersona.has(persona)
      ? Array.from(
          { length: findingsByPersona.get(persona) ?? 0 },
          (_, index) => ({
            file: FILE,
            line: lineByInputId.get(`${persona}#${index}`) ?? 1,
          }),
        )
      : [{ file: OTHER_FILE, line: 1 }]
  const screenResults = [...personas].map((persona) => ({
    reviewer: persona,
    result: screenReviewReturn({
      raw_return: JSON.stringify(
        buildScreenReturn({
          reviewer: persona,
          findings: findingsFor(persona),
        }),
      ),
      expected_reviewer: persona,
      invoking_harness: 'opencode',
    }),
  }))
  const prepare = prepareReviewCandidates({
    raw_input: {
      screen_results: screenResults,
      selected_dispatches: screenResults.map((entry) => ({
        persona: entry.reviewer,
        dispatch_outcome: entry.result.dispatch_outcome,
      })),
    },
  })
  if (!prepare.ok) throw new Error('prepare rejected the documented citations')

  return { prepared: prepare.value, adjudication }
}

const runMerge = (adjudication: JsonRecord) =>
  runShippedPhase('merge', buildEnvelope(adjudication))

function mutated(mutate: (adjudication: JsonRecord) => void): JsonRecord {
  const adjudication = structuredClone(documentedExample())
  mutate(adjudication)
  return adjudication
}

function decisionAt(adjudication: JsonRecord, index: number): JsonRecord {
  const decision = decisionsOf(adjudication)[index]
  if (decision === undefined) throw new Error(`no decision ${index}`)
  return decision
}

interface DecisionShape {
  readonly disposition: { readonly value: string }
}

/** Every key of one decision form is a bullet under its own list. */
function expectFormDocumented(text: string, shape: DecisionShape): void {
  expect(hasMention(text, shape.disposition.value)).toBe(true)
  for (const field of Object.keys(shape)) {
    expect(
      hasBullet(text, field),
      `${shape.disposition.value} field ${field}`,
    ).toBe(true)
  }
}

/** Every `proposed_route` key and enum value is named in backticks. */
function expectRouteDocumented(
  text: string,
  route: Record<string, object>,
): void {
  for (const [field, schema] of Object.entries(route)) {
    expect(hasMention(text, field), `route field ${field}`).toBe(true)
    const values = 'options' in schema ? (schema.options as string[]) : []
    for (const value of values) {
      expect(hasMention(text, value), `${field} value ${value}`).toBe(true)
    }
  }
}

describe('pipeline-invocation.md merge section', () => {
  test('the documented adjudication example is accepted by merge', () => {
    const adjudication = documentedExample()
    const result = runMerge(adjudication)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout) as {
      merged_findings: { finding_id: string; title: string }[]
    }
    // Every decision becomes one finding keyed by its `decision_id`; true
    // singletons pass through under their input IDs.
    const decisions = decisionsOf(adjudication)
    const findingIds = output.merged_findings.map((f) => f.finding_id)
    for (const decision of decisions) {
      expect(findingIds).toContain(decision.decision_id as string)
    }
    const merged = decisions.find((d) => d.disposition === 'merged')
    expect(
      output.merged_findings.find((f) => f.finding_id === merged?.decision_id)
        ?.title,
    ).toBe(merged?.title as string | undefined)
  })

  test('names every decision field, enum value and bound the schemas accept', () => {
    const section = mergeSection()
    const mergedStart = section.indexOf('**Merged decision')
    const declinedStart = section.indexOf('**Declined decision')
    expect(mergedStart, 'merged decision list').toBeGreaterThan(-1)
    expect(declinedStart, 'declined decision list').toBeGreaterThan(mergedStart)
    const mergedText = section.slice(mergedStart, declinedStart)
    const declinedText = section.slice(
      declinedStart,
      section.indexOf('\n**', declinedStart + 1),
    )

    const [merged, declined] =
      AdjudicationEnvelopeSchema.shape.decisions.element.options

    expectFormDocumented(mergedText, merged.shape)
    expectFormDocumented(declinedText, declined.shape)
    expectRouteDocumented(
      mergedText,
      merged.shape.proposed_route.unwrap().shape,
    )

    // Bounds the schemas derive from shared constants.
    for (const bound of [
      `at most ${MAX_DECISION_FACTS}`,
      `at most ${MAX_PERSONAS}`,
      `at most ${MAX_RUN_FINDINGS.toLocaleString('en-US')}`,
      `${MAX_INPUT_ID_LENGTH} characters`,
      `${MAX_REASON_LENGTH} characters`,
    ]) {
      expect(section, `bound ${bound}`).toContain(bound)
    }
  })

  test.each([
    {
      name: 'kind instead of disposition',
      path: 'adjudication.decisions.0.disposition',
      code: 'invalid_union',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 0)
        decision.kind = decision.disposition
        delete decision.disposition
      },
    },
    {
      name: 'a missing decision_id',
      path: 'adjudication.decisions.0.decision_id',
      code: 'invalid_type',
      mutate: (a: JsonRecord) => {
        delete decisionAt(a, 0).decision_id
      },
    },
    {
      name: 'input_ids instead of input_finding_ids',
      path: 'adjudication.decisions.0.input_finding_ids',
      code: 'invalid_type',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 0)
        decision.input_ids = decision.input_finding_ids
        delete decision.input_finding_ids
      },
    },
    {
      name: 'input_ids instead of input_finding_ids (unknown key)',
      path: 'adjudication.decisions.0',
      code: 'unrecognized_keys',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 0)
        decision.input_ids = decision.input_finding_ids
        delete decision.input_finding_ids
      },
    },
    {
      name: 'plural input_finding_ids on a declined decision',
      path: 'adjudication.decisions.1.input_finding_id',
      code: 'invalid_type',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 1)
        decision.input_finding_ids = [decision.input_finding_id]
        delete decision.input_finding_id
      },
    },
    {
      name: 'a single input_finding_ids entry on a merged decision',
      path: 'adjudication.decisions.0.input_finding_ids',
      code: 'too_small',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 0)
        decision.input_finding_ids = (
          decision.input_finding_ids as string[]
        ).slice(0, 1)
      },
    },
    {
      name: 'an unknown key on a decision',
      path: 'adjudication.decisions.1',
      code: 'unrecognized_keys',
      mutate: (a: JsonRecord) => {
        decisionAt(a, 1).extra = true
      },
    },
    {
      name: 'an unknown key on proposed_route',
      path: 'adjudication.decisions.0.proposed_route',
      code: 'unrecognized_keys',
      mutate: (a: JsonRecord) => {
        const decision = decisionAt(a, 0)
        decision.proposed_route = {
          ...(decision.proposed_route as JsonRecord),
          extra: true,
        }
      },
    },
    {
      name: 'an unknown key on the adjudication',
      path: 'adjudication',
      code: 'unrecognized_keys',
      mutate: (a: JsonRecord) => {
        a.extra = true
      },
    },
    {
      name: 'a proposed_route without route_narrowing_reason',
      path: 'adjudication.decisions.0.route_narrowing_reason',
      code: 'custom',
      mutate: (a: JsonRecord) => {
        delete decisionAt(a, 0).route_narrowing_reason
      },
    },
    {
      name: 'a repeated decision_id',
      path: 'adjudication.decisions.1.decision_id',
      code: 'custom',
      mutate: (a: JsonRecord) => {
        decisionAt(a, 1).decision_id = decisionAt(a, 0).decision_id
      },
    },
  ])('rejects $name at $path ($code)', ({ path: issuePath, code, mutate }) => {
    const result = runMerge(mutated(mutate))

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`${issuePath} ${code}`)
  })
})
