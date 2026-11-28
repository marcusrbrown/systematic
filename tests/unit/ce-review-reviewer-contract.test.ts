/**
 * Contract tests for what a `ce:review` reviewer is shown and must return.
 *
 * The reviewer template carries a reviewer-rooted schema view and one
 * populated example. These tests run that example, and a finding on a deleted
 * file, through the packaged validator's `screen` phase and through
 * `screenReviewReturn`, so the text a reviewer sees cannot drift from what
 * `screen` accepts. They also pin the contrast with a parent-owned payload.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateReviewerReturnSchemaContent,
  REVIEWER_RETURN_SCHEMA_RELATIVE_PATH,
} from '../../scripts/generate-review-artifact-schema.js'
import { screenReviewReturn } from '../../src/lib/review-pipeline.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const VALIDATOR = path.join(
  REPO_ROOT,
  'skills/ce-review/scripts/validate-review.mjs',
)
const TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, 'skills/ce-review/references/subagent-template.md'),
  'utf8',
)
const SKILL = fs.readFileSync(
  path.join(REPO_ROOT, 'skills/ce-review/SKILL.md'),
  'utf8',
)
const VIEW_PATH = path.join(REPO_ROOT, REVIEWER_RETURN_SCHEMA_RELATIVE_PATH)

const REVIEWER = 'correctness'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('expected an object')
  return value
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The populated example, with the `{reviewer_name}` slot filled the way a spawn fills it. */
function templateExample(): JsonRecord {
  const match = /<example-return>\s*([\s\S]*?)\s*<\/example-return>/.exec(
    TEMPLATE,
  )
  if (!match?.[1]) throw new Error('template has no <example-return> block')
  const filled = match[1].replaceAll('{reviewer_name}', REVIEWER)
  return asRecord(JSON.parse(filled))
}

function packagedScreen(payload: unknown): { status: number; stdout: string } {
  const result = spawnSync(
    'node',
    [VALIDATOR, 'screen', '--reviewer', REVIEWER, '--harness', 'opencode'],
    { input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000 },
  )
  return { status: result.status ?? -1, stdout: result.stdout ?? '' }
}

function inProcessScreen(payload: unknown) {
  return screenReviewReturn({
    expected_reviewer: REVIEWER,
    invoking_harness: 'opencode',
    raw_return: JSON.stringify(payload),
  })
}

function firstFinding(example: JsonRecord): JsonRecord {
  const findings = example.findings
  if (!Array.isArray(findings)) throw new Error('example has no findings')
  return asRecord(findings[0])
}

describe('reviewer schema view', () => {
  const view = asRecord(JSON.parse(fs.readFileSync(VIEW_PATH, 'utf8')))
  const full = asRecord(
    JSON.parse(
      fs.readFileSync(
        path.join(
          REPO_ROOT,
          'skills/ce-review/references/findings-schema.json',
        ),
        'utf8',
      ),
    ),
  )

  test('the committed view is the generator output', () => {
    expect(fs.readFileSync(VIEW_PATH, 'utf8')).toBe(
      generateReviewerReturnSchemaContent(),
    )
  })

  test('the view is rooted at the reviewer return, not the parent record', () => {
    expect(view.$ref).toBe('#/definitions/subAgentReturn')
    expect(full.$ref).toBe('#/definitions/parentRecord')
  })

  test('the reviewer template slot is filled from the view, not the full schema', () => {
    expect(TEMPLATE).toContain('`references/reviewer-return-schema.json`')
    expect(TEMPLATE).not.toContain('`references/findings-schema.json`')
    expect(SKILL).toContain('@./references/reviewer-return-schema.json')
    expect(SKILL).not.toContain('@./references/findings-schema.json')
  })
})

describe('reviewer template example', () => {
  const view = asRecord(JSON.parse(fs.readFileSync(VIEW_PATH, 'utf8')))
  const definitions = asRecord(view.definitions)

  test('exits 0 through the packaged screen and admits one finding', () => {
    const result = packagedScreen(templateExample())

    expect(result.status, result.stdout).toBe(0)
    const output = asRecord(JSON.parse(result.stdout))
    expect(output.dispatch_outcome).toBe('findings')
    expect(output.admitted_findings).toHaveLength(1)
  })

  test('is admitted by screenReviewReturn', () => {
    expect(inProcessScreen(templateExample()).dispatch_outcome).toBe('findings')
  })

  test('carries every required field of the view and no field outside it', () => {
    const example = templateExample()
    const returnShape = asRecord(definitions.subAgentReturn)
    const findingShape = asRecord(definitions.subAgentFinding)

    expect(Object.keys(example).sort()).toEqual(
      [...(returnShape.required as string[])].sort(),
    )
    const finding = firstFinding(example)
    for (const name of findingShape.required as string[]) {
      expect(Object.keys(finding), name).toContain(name)
    }
    const allowed = Object.keys(asRecord(findingShape.properties))
    for (const name of Object.keys(finding)) {
      expect(allowed, name).toContain(name)
    }
  })

  test('populates residual_risks and testing_gaps', () => {
    const example = templateExample()

    expect((example.residual_risks as unknown[]).length).toBeGreaterThan(0)
    expect((example.testing_gaps as unknown[]).length).toBeGreaterThan(0)
  })

  test('fails when a schema bound is violated instead of passing silently', () => {
    const finding = firstFinding(templateExample())
    const broken = {
      ...templateExample(),
      findings: [{ ...finding, line: 0 }],
    }

    expect(packagedScreen(broken).status).toBe(1)
    expect(inProcessScreen(broken).dispatch_outcome).toBe('malformed')
  })

  test('echoes the reviewer name slot instead of a fixed persona', () => {
    expect(TEMPLATE).toContain('"reviewer": "{reviewer_name}"')
  })
})

describe('deleted-file finding', () => {
  function deletedFileReturn(): JsonRecord {
    const example = templateExample()
    const finding = firstFinding(example)
    return {
      ...example,
      findings: [
        {
          ...finding,
          file: 'src/auth/guard.ts',
          line: 12,
          evidence: [
            'Deleted file: base-side path and line, src/auth/guard.ts:12 no longer exists at head.',
            'The removed guard at src/auth/guard.ts:12 rejected unauthenticated callers.',
          ],
        },
      ],
    }
  }

  test('a base-side path and line, stated in the first evidence entry, exits 0 through the packaged screen', () => {
    const result = packagedScreen(deletedFileReturn())

    expect(result.status, result.stdout).toBe(0)
    const output = asRecord(JSON.parse(result.stdout))
    expect(output.dispatch_outcome).toBe('findings')
  })

  test('the template tells the reviewer to cite the base side and say so first', () => {
    const text = normalize(TEMPLATE)

    expect(text).toMatch(
      /deleted file[^.]*base-side path and line[^.]*first evidence entry/i,
    )
  })
})

describe('parent-owned fields', () => {
  const parentOwned: readonly (readonly [
    string,
    (p: JsonRecord) => JsonRecord,
  ])[] = [
    ['harness', (p) => ({ ...p, harness: 'opencode' })],
    ['dispatch_outcome', (p) => ({ ...p, dispatch_outcome: 'findings' })],
    [
      'a finding disposition',
      (p) => ({
        ...p,
        findings: [{ ...firstFinding(p), disposition: 'surviving' }],
      }),
    ],
  ]

  for (const [label, mutate] of parentOwned) {
    test(`screen rejects a payload with ${label}`, () => {
      const payload = mutate(templateExample())

      expect(packagedScreen(payload).status).toBe(1)
      expect(inProcessScreen(payload).dispatch_outcome).toBe('malformed')
    })
  }

  test('the template names them as parent-owned next to the schema', () => {
    const text = normalize(TEMPLATE)

    expect(text).toMatch(
      /exactly the `subAgentReturn` shape[^.]*`harness`, `dispatch_outcome`,? and `disposition`[^.]*parent-owned/i,
    )
  })
})

describe('traps the schema enforces', () => {
  const text = normalize(TEMPLATE)

  test('paths and evidence are repository-relative with the checkout prefix stripped', () => {
    expect(text).toMatch(
      /repository-relative[^.]*checkout prefix[^.]*(?:stripped|removed)/i,
    )
    expect(text).toMatch(/evidence[^.]*(?:absolute|begins with)/i)
  })

  test('line is one positive integer', () => {
    expect(text).toMatch(/`line` is one positive integer/i)
  })

  test('confidence is 0 to 1', () => {
    expect(text).toMatch(/`confidence` is a number from 0 to 1/i)
  })

  test('reviewer echoes the Reviewer name value exactly', () => {
    expect(text).toMatch(
      /`reviewer` (?:is|must be)[^.]*Reviewer name[^.]*exactly/i,
    )
  })

  test('shows the autofix_class and owner pairing from the routing table', () => {
    expect(text).toMatch(/`safe_auto`[^.]*`review-fixer`/)
    expect(text).toMatch(/`advisory`[^.]*`human`[^.]*`release`/)
    expect(text).toMatch(/`gated_auto`[^.]*`downstream-resolver`[^.]*`human`/)
  })
})

describe('closed values block', () => {
  const view = asRecord(JSON.parse(fs.readFileSync(VIEW_PATH, 'utf8')))
  const findingProps = asRecord(
    asRecord(asRecord(view.definitions).subAgentFinding).properties,
  )

  function schemaEnum(field: string): string[] {
    const values = asRecord(findingProps[field]).enum
    if (!Array.isArray(values)) throw new Error(`${field} has no enum`)
    return values.map(String)
  }

  const CLOSED_FIELDS = ['severity', 'autofix_class', 'owner'] as const

  const EXAMPLE_END = '</example-return>'
  const RUBRIC_START = 'Confidence rubric'

  /** The text between the example and the confidence rubric, or null when it is not there in that order. */
  function blockText(template: string): string | null {
    const exampleEnd = template.indexOf(EXAMPLE_END)
    const rubricStart = template.indexOf(RUBRIC_START)
    if (exampleEnd === -1 || rubricStart === -1 || rubricStart < exampleEnd) {
      return null
    }
    const between = template.slice(exampleEnd + EXAMPLE_END.length, rubricStart)
    return /Closed values/.test(between) ? between : null
  }

  function backtickTokens(text: string): string[] {
    return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')
  }

  /** The allowed-value list a field's bullet states, i.e. the tokens before the first "Never". */
  function listedValues(block: string, field: string): string[] {
    const line = block
      .split('\n')
      .find((l) => l.trimStart().startsWith(`- \`${field}\``))
    if (!line) throw new Error(`closed values block has no ${field} bullet`)
    const afterField = line.slice(
      line.indexOf(`\`${field}\``) + field.length + 2,
    )
    const beforeNever = afterField.split(/\bNever\b/)[0] ?? ''
    return backtickTokens(beforeNever)
  }

  test('sits between the example and the confidence rubric', () => {
    const block = blockText(TEMPLATE)

    expect(block).not.toBeNull()
  })

  test('says any other value fails validation and rejects the whole return', () => {
    const block = normalize(blockText(TEMPLATE) ?? '')

    expect(block).toMatch(
      /any other value fails validation and the whole return is rejected/i,
    )
  })

  for (const field of CLOSED_FIELDS) {
    test(`${field} lists exactly the schema's allowed values`, () => {
      const block = blockText(TEMPLATE) ?? ''

      expect(listedValues(block, field).sort()).toEqual(
        schemaEnum(field).sort(),
      )
    })
  }

  test('names the wrong values production reviewers returned', () => {
    const block = normalize(blockText(TEMPLATE) ?? '')

    expect(block).toMatch(/`severity`[^.]*\.\s*never[^.]*`high`/i)
    expect(block).toMatch(/`autofix_class`[^.]*\.\s*never[^.]*`safe`/i)
    expect(block).toMatch(/`owner`[^.]*\.\s*never[^.]*`pr_author`/i)
  })

  test('evidence is an array of 1 to 5 strings of at most 500 characters, never one string', () => {
    const evidence = asRecord(findingProps.evidence)
    const item = asRecord(
      (evidence.items as { anyOf: unknown[] }).anyOf[0] as JsonRecord,
    )
    const block = normalize(blockText(TEMPLATE) ?? '')

    expect(block).toContain(
      `\`evidence\`: a JSON array of ${evidence.minItems} to ${evidence.maxItems} strings, each at most ${item.maxLength} characters. Never one string.`,
    )
  })

  test('states the autofix_class to owner pairings', () => {
    const block = normalize(blockText(TEMPLATE) ?? '')

    expect(block).toContain(
      '`safe_auto` with `review-fixer`; `gated_auto` or `manual` with `downstream-resolver` or `human`; `advisory` with `human` or `release`.',
    )
  })

  test('each closed-value list appears once: no second list outside the block and the example', () => {
    const block = blockText(TEMPLATE) ?? ''
    const outside = TEMPLATE.replace(block, '').replace(
      /<example-return>[\s\S]*?<\/example-return>/,
      '',
    )
    const allowedByField = CLOSED_FIELDS.map(
      (field) => [field, schemaEnum(field)] as const,
    )

    for (const line of outside.split('\n')) {
      const tokens = new Set(backtickTokens(line))
      const bare = new Set(line.match(/\bP[0-3]\b/g) ?? [])
      for (const [field, values] of allowedByField) {
        // Naming some values is guidance ("classify it as `safe_auto` or
        // `gated_auto`"); naming all of them is a second copy of the list.
        const named = values.filter((v) => tokens.has(v) || bare.has(v))
        expect(
          named.length,
          `${field} list restated outside the block: ${line.trim()}`,
        ).toBeLessThan(values.length)
      }
    }
  })
})
