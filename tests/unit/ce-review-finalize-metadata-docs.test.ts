// Ties the `finalize` section of `pipeline-invocation.md` to the shipped
// validator. The section documents `parent_run_metadata`; the example it
// carries is extracted from the markdown and run through the real
// `validate-review.mjs finalize`, so the documented shape cannot drift from
// the schema the helper enforces. The three input shapes agents most often get
// wrong (persona strings for `selected_dispatches`, an offset timestamp, and an
// unknown key) must keep failing at the paths the section names.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { DispatchOutcomeSchema } from '../../src/lib/review-artifact-schema.js'
import {
  applyReviewAdjudication,
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import { ParentRunMetadataSchema } from '../../src/lib/review-pipeline-contract.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const DOC_PATH = path.join(
  ROOT_DIR,
  'skills/ce-review/references/pipeline-invocation.md',
)
const VALIDATOR_PATH = path.join(
  ROOT_DIR,
  'skills/ce-review/scripts/validate-review.mjs',
)

type JsonRecord = Record<string, unknown>

/** Outcomes for which the dispatch never produced a screen result. */
const SCREEN_EXEMPT_OUTCOMES = new Set([
  'never_returned',
  'validation_unavailable',
])

function finalizeSection(): string {
  const doc = fs.readFileSync(DOC_PATH, 'utf8')
  const section = doc.split(/^## /m).find((s) => s.startsWith('finalize\n'))
  if (section === undefined) throw new Error('no "## finalize" section found')
  return section
}

function documentedExample(): JsonRecord {
  const block = /```json\n([\s\S]*?)\n```/.exec(finalizeSection())
  if (block?.[1] === undefined) {
    throw new Error('no fenced json example in the finalize section')
  }
  return JSON.parse(block[1]) as JsonRecord
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

function runFinalize(envelope: JsonRecord): {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(process.execPath, [VALIDATOR_PATH, 'finalize'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    input: JSON.stringify(envelope),
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

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
    const hasBullet = (name: string) => section.includes(`\n- \`${name}\` --`)
    const mode = ParentRunMetadataSchema.shape.mode.options
    const dispatchFields = [
      'persona',
      'dispatch_outcome',
      'selection_surface',
      'selection_reason',
    ]

    for (const field of [
      ...Object.keys(ParentRunMetadataSchema.shape),
      ...dispatchFields,
    ]) {
      expect(hasBullet(field), `field ${field}`).toBe(true)
    }
    for (const value of [...mode, ...DispatchOutcomeSchema.options]) {
      expect(section.includes(`\`${value}\``), `enum value ${value}`).toBe(true)
    }
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
