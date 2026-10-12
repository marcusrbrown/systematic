import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Pushes to `release/pending` (the gated release PR branch) must never run
 * Renovate: the App-authored release commit is not Renovate's to touch.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/renovate.yaml',
)

function readOn(): Record<string, unknown> {
  const { JSON_SCHEMA } = yaml
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'), {
    schema: JSON_SCHEMA,
  }) as { on: Record<string, unknown> }
  return workflow.on
}

describe('renovate workflow push filter', () => {
  const push = () => readOn().push as { 'branches-ignore'?: string[] }

  test('release/** is ignored on push', () => {
    expect(push()['branches-ignore']).toContain('release/**')
  })

  test('main is still ignored on push', () => {
    expect(push()['branches-ignore']).toContain('main')
  })
})
