// Ties the `finalize` section of `pipeline-invocation.md` to the shipped
// validator. The section documents `parent_run_metadata`; the example it
// carries is extracted from the markdown and run through the real
// `validate-review.mjs finalize`, so the documented shape cannot drift from
// the schema the helper enforces. The three input shapes agents most often get
// wrong (persona strings for `selected_dispatches`, an offset timestamp, and an
// unknown key) must keep failing at the paths the section names.

import { describe, expect, test } from 'bun:test'
import { MAX_RUN_FINDINGS } from '../../src/lib/review-artifact-schema.js'
import {
  applyReviewAdjudication,
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import { ParentRunMetadataSchema } from '../../src/lib/review-pipeline-contract.js'
import {
  docSection,
  documentedJsonExample,
  hasBullet,
  hasMention,
  type JsonRecord,
  runShippedPhase,
} from '../helpers/ce-review-doc-contract.js'

/** Outcomes for which the dispatch never produced a screen result. */
const SCREEN_EXEMPT_OUTCOMES = new Set([
  'never_returned',
  'validation_unavailable',
])

const finalizeSection = () => docSection('finalize')

function documentedExample(): JsonRecord {
  return documentedJsonExample(finalizeSection()) as JsonRecord
}

/**
 * Builds a full finalize envelope around the given `parent_run_metadata`:
 * screens a zero-finding return for every dispatch that has a screen result,
 * then runs the real prepare and merge so the carried state is consistent.
 */
function buildEnvelope(metadata: JsonRecord): JsonRecord {
  const { selected_dispatches: dispatches } = ParentRunMetadataSchema.parse(
    documentedExample(),
  )
  const screenResults = dispatches
    .filter((d) => !SCREEN_EXEMPT_OUTCOMES.has(d.dispatch_outcome))
    .map((d) => ({
      reviewer: d.persona,
      result: screenReviewReturn({
        raw_return: JSON.stringify({
          reviewer: d.persona,
          findings: [],
          residual_risks: [],
          testing_gaps: [],
        }),
        expected_reviewer: d.persona,
        invoking_harness: 'opencode',
      }),
    }))
  const prepare = prepareReviewCandidates({
    raw_input: {
      screen_results: screenResults,
      selected_dispatches: dispatches,
    },
  })
  if (!prepare.ok) throw new Error('prepare rejected the documented dispatches')
  const merge = applyReviewAdjudication({
    prepared: prepare.value,
    decisions: [],
  })
  if (!merge.ok) throw new Error('merge rejected an empty adjudication')

  return {
    merge: merge.value,
    prepared: prepare.value,
    screen_results: screenResults,
    dispatch_records: dispatches,
    validator_lifecycle_results: [],
    plan_assessment: { verdict: 'All requirements met.', results: [] },
    parent_run_metadata: metadata,
  }
}

const runFinalize = (envelope: JsonRecord) =>
  runShippedPhase('finalize', envelope)

function mutated(mutate: (metadata: JsonRecord) => void): JsonRecord {
  const metadata = structuredClone(documentedExample())
  mutate(metadata)
  return metadata
}

function firstDispatch(metadata: JsonRecord): JsonRecord {
  const [dispatch] = metadata.selected_dispatches as JsonRecord[]
  if (dispatch === undefined) throw new Error('example has no dispatches')
  return dispatch
}

describe('pipeline-invocation.md finalize section', () => {
  test('the documented parent_run_metadata example is accepted by finalize', () => {
    const result = runFinalize(buildEnvelope(documentedExample()))

    expect(result.exitCode, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout) as {
      kind: string
      artifact: { dispatches: JsonRecord[] }
    }
    expect(output.kind).toBe('writing')
    // The artifact's derived `dispatches` carry `input_finding_count`; the
    // input dispatches do not.
    for (const dispatch of output.artifact.dispatches) {
      expect(dispatch).toHaveProperty('input_finding_count')
    }
  })

  test('names every parent_run_metadata field and enum value the schema accepts', () => {
    const section = finalizeSection()
    const { shape } = ParentRunMetadataSchema
    const topLevel = Object.keys(shape)
    const dispatchFields = Object.keys(shape.selected_dispatches.element.shape)
    const nested = [
      ...Object.keys(shape.timestamps.shape),
      ...Object.keys(shape.validation.shape),
    ]
    const enums = {
      mode: shape.mode.options,
      harness: shape.harness.options,
      dispatch_outcome:
        shape.selected_dispatches.element.shape.dispatch_outcome.options,
    }

    for (const field of [...topLevel, ...dispatchFields]) {
      expect(hasBullet(section, field), `field ${field}`).toBe(true)
    }
    for (const field of nested) {
      expect(hasMention(section, field), `nested field ${field}`).toBe(true)
    }
    for (const [name, values] of Object.entries(enums)) {
      for (const value of values) {
        expect(hasMention(section, value), `${name} value ${value}`).toBe(true)
      }
    }
    // The `applied_fixes` array bound.
    expect(section).toContain(
      `at most ${MAX_RUN_FINDINGS.toLocaleString('en-US')}`,
    )

    // `validation.status` accepts four values, but finalize rejects all
    // except this one, which is the only one the section documents.
    expect(hasMention(section, 'not_attempted'), 'validation status').toBe(true)
  })

  test.each([
    {
      name: 'persona strings for selected_dispatches',
      path: 'parent_run_metadata.selected_dispatches.0',
      code: 'invalid_type',
      mutate: (m: JsonRecord) => {
        m.selected_dispatches = (m.selected_dispatches as JsonRecord[]).map(
          (d) => d.persona,
        )
      },
    },
    {
      name: 'a +00:00 completed_at',
      path: 'parent_run_metadata.timestamps.completed_at',
      code: 'invalid_format',
      mutate: (m: JsonRecord) => {
        m.timestamps = {
          ...(m.timestamps as JsonRecord),
          completed_at: '2026-01-01T00:05:00+00:00',
        }
      },
    },
    {
      name: 'a +00:00 started_at',
      path: 'parent_run_metadata.timestamps.started_at',
      code: 'invalid_format',
      mutate: (m: JsonRecord) => {
        m.timestamps = {
          ...(m.timestamps as JsonRecord),
          started_at: '2026-01-01T00:00:00+00:00',
        }
      },
    },
    {
      name: 'input_finding_count on a dispatch',
      path: 'parent_run_metadata.selected_dispatches.0',
      code: 'unrecognized_keys',
      mutate: (m: JsonRecord) => {
        firstDispatch(m).input_finding_count = 0
      },
    },
    {
      name: 'an unknown key on parent_run_metadata',
      path: 'parent_run_metadata',
      code: 'unrecognized_keys',
      mutate: (m: JsonRecord) => {
        m.extra = true
      },
    },
    {
      name: 'an unknown key on timestamps',
      path: 'parent_run_metadata.timestamps',
      code: 'unrecognized_keys',
      mutate: (m: JsonRecord) => {
        m.timestamps = { ...(m.timestamps as JsonRecord), extra: true }
      },
    },
    {
      name: 'an unknown key on validation',
      path: 'parent_run_metadata.validation',
      code: 'unrecognized_keys',
      mutate: (m: JsonRecord) => {
        m.validation = { ...(m.validation as JsonRecord), extra: true }
      },
    },
  ])('rejects $name at $path ($code)', ({ path: issuePath, code, mutate }) => {
    const result = runFinalize(buildEnvelope(mutated(mutate)))

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`${issuePath} ${code}`)
  })
})
