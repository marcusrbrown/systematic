import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * `Renovate / Renovate` is a required status context on main. A push to the
 * gated release PR's head branch (`release/pending`) is what reports it, so
 * that branch must not be ignored.
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

  test('pushes to release/** trigger Renovate: the required check comes from that run', () => {
    const ignored = push()['branches-ignore'] ?? []
    expect(ignored.some((pattern) => pattern.startsWith('release'))).toBe(false)
  })

  test('main is still ignored on push', () => {
    expect(push()['branches-ignore']).toEqual(['main'])
  })
})
