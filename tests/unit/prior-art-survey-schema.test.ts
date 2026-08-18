import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'

const schemaPath = path.resolve(
  import.meta.dir,
  '../../skills/ce-plan/references/prior-art-survey-schema.json',
)
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<
  string,
  unknown
>
const ajv = new Ajv({ strict: false })
const validate = ajv.compile(schema)

type Survey = Record<string, unknown>

const baseBudget = {
  max_search_passes: 3,
  max_candidate_inspections: 10,
  exhausted: false,
}

const baseCandidate = {
  path_or_symbol: 'src/matching/ConcernMatcher.ts',
  description: 'Owns trigger matching and candidate selection.',
  disposition: 'reuse',
}

const baseSurvey: Survey = {
  verdict: 'reuse',
  scope: 'workspace root',
  budget: baseBudget,
  candidates: [baseCandidate],
}

function surveyWith(changes: Survey): Survey {
  return {
    ...baseSurvey,
    ...changes,
  }
}

function hasKeyword(keyword: string, pathSuffix: string): boolean {
  return (validate.errors ?? []).some(
    (error) =>
      error.keyword === keyword &&
      (error.instancePath ?? '').endsWith(pathSuffix),
  )
}

function hasAdditionalProperty(
  property: string,
  instancePath: string,
): boolean {
  return (validate.errors ?? []).some((error) => {
    const params = error.params as { additionalProperty?: string }
    return (
      error.keyword === 'additionalProperties' &&
      error.instancePath === instancePath &&
      params.additionalProperty === property
    )
  })
}

describe('prior-art survey schema', () => {
  test('accepts a reuse verdict naming one candidate with a disposition', () => {
    expect(validate(baseSurvey)).toBe(true)
  })

  test('accepts an unresolved verdict while preserving reached dispositions', () => {
    expect(
      validate(
        surveyWith({
          verdict: 'unresolved',
          candidates: [
            baseCandidate,
            {
              ...baseCandidate,
              path_or_symbol: 'src/other/FirstCandidate.ts',
              disposition: 'undispositioned',
            },
            {
              ...baseCandidate,
              path_or_symbol: 'src/other/SecondCandidate.ts',
              disposition: 'undispositioned',
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  test('round-trips the minimal valid form of every verdict', () => {
    const surveys: Survey[] = [
      baseSurvey,
      surveyWith({
        verdict: 'extend',
        candidates: [{ ...baseCandidate, disposition: 'extend' }],
      }),
      surveyWith({
        verdict: 'build-new-within-scope',
        candidates: [
          {
            ...baseCandidate,
            disposition: 'insufficient',
            insufficiency_reason: 'Does not cover the required state boundary.',
          },
        ],
      }),
      surveyWith({
        verdict: 'unscoped',
        candidates: [],
        scopes_considered: ['workspace root', 'packages/adapter'],
      }),
      surveyWith({
        verdict: 'unresolved',
        candidates: [{ ...baseCandidate, disposition: 'undispositioned' }],
      }),
    ]

    for (const survey of surveys) {
      expect(validate(survey)).toBe(true)
    }
  })

  test('accepts a user acceptance record only for an unscoped verdict', () => {
    expect(
      validate(
        surveyWith({
          verdict: 'unscoped',
          candidates: [],
          scopes_considered: ['workspace root'],
          acceptance: {
            accepted_by_user: true,
            accepted_verdict: 'unscoped',
            reason: 'The user accepted the bounded planning limitation.',
          },
        }),
      ),
    ).toBe(true)
  })

  test('rejects build-new-within-scope without candidates at the minItems constraint', () => {
    expect(
      validate(
        surveyWith({
          verdict: 'build-new-within-scope',
          candidates: [],
        }),
      ),
    ).toBe(false)
    expect(hasKeyword('minItems', '/candidates')).toBe(true)
  })

  test('rejects unscoped without scopes considered at the required constraint', () => {
    expect(
      validate(
        surveyWith({
          verdict: 'unscoped',
          candidates: [],
        }),
      ),
    ).toBe(false)
    expect(hasKeyword('required', '')).toBe(true)
    expect(
      (validate.errors ?? []).some(
        (error) =>
          error.keyword === 'required' &&
          (error.params as { missingProperty?: string }).missingProperty ===
            'scopes_considered',
      ),
    ).toBe(true)
  })

  test('rejects unresolved without an undispositioned candidate at contains', () => {
    expect(
      validate(
        surveyWith({
          verdict: 'unresolved',
          candidates: [baseCandidate],
        }),
      ),
    ).toBe(false)
    expect(hasKeyword('contains', '/candidates')).toBe(true)
  })

  test('rejects a verdict outside the vocabulary at enum', () => {
    expect(validate(surveyWith({ verdict: 'investigate-later' }))).toBe(false)
    expect(hasKeyword('enum', '/verdict')).toBe(true)
  })

  test('rejects an ownership description beyond its maxLength boundary', () => {
    expect(
      validate(
        surveyWith({
          candidates: [{ ...baseCandidate, description: 'x'.repeat(501) }],
        }),
      ),
    ).toBe(false)
    expect(hasKeyword('maxLength', '/candidates/0/description')).toBe(true)
  })

  test('rejects an unknown top-level field at additionalProperties', () => {
    expect(validate(surveyWith({ NOT_PART_OF_CONTRACT: true }))).toBe(false)
    expect(hasAdditionalProperty('NOT_PART_OF_CONTRACT', '')).toBe(true)
  })

  test('rejects an unknown candidate field at additionalProperties', () => {
    expect(
      validate(
        surveyWith({
          candidates: [{ ...baseCandidate, NOT_PART_OF_CONTRACT: true }],
        }),
      ),
    ).toBe(false)
    expect(hasAdditionalProperty('NOT_PART_OF_CONTRACT', '/candidates/0')).toBe(
      true,
    )
  })

  test('rejects acceptance on a resolved verdict at the verdict enum constraint', () => {
    expect(
      validate(
        surveyWith({
          acceptance: {
            accepted_by_user: true,
            accepted_verdict: 'reuse',
            reason: 'This must not be accepted for a resolved verdict.',
          },
        }),
      ),
    ).toBe(false)
    expect(hasKeyword('enum', '/verdict')).toBe(true)
  })
})
