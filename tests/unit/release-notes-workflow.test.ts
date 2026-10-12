import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the shape of .github/workflows/release-notes.yaml: the release-notes
 * narrative runs in its own workflow on `release: published` (not inside
 * semantic-release's publish job), holds no secrets, and only triggers the docs
 * rebuild after the narrative step has verified the release body.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/release-notes.yaml',
)
const RELEASERC_PATH = path.resolve(process.cwd(), '.releaserc.yaml')

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping`)
  return value
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a sequence`)
  return value
}

function readSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8')
}

function readWorkflow(): RecordValue {
  const { JSON_SCHEMA } = yaml
  return asRecord(yaml.load(readSource(), { schema: JSON_SCHEMA }), 'workflow')
}

function getJobs(): RecordValue {
  return asRecord(readWorkflow().jobs, 'jobs')
}

/** The workflow has a single job; tests address it without hard-coding its id. */
function getJob(): RecordValue {
  const entries = Object.entries(getJobs())
  expect(entries).toHaveLength(1)
  return asRecord(entries[0]?.[1], 'job')
}

function getSteps(): readonly RecordValue[] {
  return asArray(getJob().steps, 'steps').map((step, i) =>
    asRecord(step, `step ${i}`),
  )
}

function findStep(name: string): RecordValue {
  const step = getSteps().find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step not found: ${name}`)
  return step
}

function indexOfStep(name: string): number {
  const index = getSteps().findIndex((candidate) => candidate.name === name)
  if (index === -1) throw new Error(`step not found: ${name}`)
  return index
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const GITHUB_TOKEN_EXPR = '${{ github.token }}'

const TAG_PATTERN = '^v[0-9]+\\.[0-9]+\\.[0-9]+$'

describe('release-notes workflow triggers', () => {
  test('triggers are exactly release: published and workflow_dispatch', () => {
    const on = asRecord(readWorkflow().on, 'on')
    expect(Object.keys(on).sort()).toEqual(['release', 'workflow_dispatch'])
    expect(asRecord(on.release, 'release').types).toEqual(['published'])
  })

  test('workflow_dispatch requires a string tag input', () => {
    const on = asRecord(readWorkflow().on, 'on')
    const dispatch = asRecord(on.workflow_dispatch, 'workflow_dispatch')
    const inputs = asRecord(dispatch.inputs, 'inputs')
    expect(Object.keys(inputs)).toEqual(['tag'])
    const tag = asRecord(inputs.tag, 'tag input')
    expect(tag.required).toBe(true)
    expect(tag.type).toBe('string')
  })

  test('prereleases are skipped on release events', () => {
    expect(String(getJob().if ?? '')).toContain(
      'github.event.release.prerelease',
    )
  })
})

describe('release-notes workflow credentials', () => {
  test('no `secrets.` reference appears anywhere in the file', () => {
    expect(readSource()).not.toContain('secrets.')
  })

  test('top-level permissions are exactly contents: read', () => {
    expect(readWorkflow().permissions).toEqual({ contents: 'read' })
  })

  test('job permissions are exactly contents: read and actions: write', () => {
    expect(getJob().permissions).toEqual({
      contents: 'read',
      actions: 'write',
    })
  })

  test('the narrative and docs-dispatch steps use the workflow github.token', () => {
    for (const name of ['Narrate release notes', 'Trigger docs rebuild']) {
      const env = asRecord(findStep(name).env, `${name} env`)
      expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    }
  })
})

describe('release-notes workflow target validation', () => {
  test('the author check references RELEASE_AUTHOR_LOGIN and ends cleanly on mismatch', () => {
    const step = findStep('Check release author')
    const serialized = JSON.stringify(step)

    expect(serialized).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(serialized).toContain("'mrbro-bot[bot]'")
    expect(serialized).toContain('github.event.release.author.login')
    expect(runOf(step)).toContain('proceed=false')
    expect(runOf(step)).not.toMatch(/exit 1/)
    expect(step.id).toBe('author')
  })

  test('tag validation checks the stable-tag pattern and, on dispatch, the published release', () => {
    const step = findStep('Validate release tag')
    const run = runOf(step)

    expect(run).toContain(TAG_PATTERN)
    expect(run).toContain('gh release view')
    expect(run).toContain('isDraft')
    expect(run).toContain('isPrerelease')
    expect(step.id).toBe('tag')
    expect(asRecord(step.env, 'validate env').GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
  })

  test('the npm view check exists and fails loudly', () => {
    const run = runOf(findStep('Verify package is published to npm'))
    expect(run).toMatch(/npm view "?@fro\.bot\/systematic@/)
    expect(run).toContain('::error::')
    expect(run).toContain('exit 1')
  })

  test('author check, tag validation, and npm check all come before checkout', () => {
    const checkout = indexOfStep('Checkout')
    for (const name of [
      'Check release author',
      'Validate release tag',
      'Verify package is published to npm',
    ]) {
      expect(indexOfStep(name)).toBeLessThan(checkout)
    }
  })

  test('checkout uses the default ref and does not persist credentials', () => {
    const checkout = findStep('Checkout')
    expect(String(checkout.uses)).toStartWith('actions/checkout@')
    const withBlock = asRecord(checkout.with, 'checkout with')
    expect(withBlock['persist-credentials']).toBe(false)
    expect(withBlock).not.toHaveProperty('ref')
  })

  test('every step after the author check is gated on its proceed output', () => {
    const steps = getSteps()
    const authorIndex = indexOfStep('Check release author')
    for (const step of steps.slice(authorIndex + 1)) {
      expect(String(step.if ?? '')).toContain(
        "steps.author.outputs.proceed == 'true'",
      )
    }
  })
})

describe('release-notes workflow narrative and docs dispatch', () => {
  test('the narrative step runs scripts/dispatch-release-notes.sh with the validated tag', () => {
    const step = findStep('Narrate release notes')
    expect(runOf(step)).toContain('scripts/dispatch-release-notes.sh "$TAG"')
    expect(JSON.stringify(step.env)).toContain('steps.tag.outputs.tag')
  })

  test('the docs dispatch step comes after the narrative step and passes the tag', () => {
    expect(indexOfStep('Trigger docs rebuild')).toBeGreaterThan(
      indexOfStep('Narrate release notes'),
    )
    const run = runOf(findStep('Trigger docs rebuild'))
    expect(run).toContain('gh workflow run docs.yaml')
    expect(run).toContain('--ref main')
    expect(run).toContain('-f tag="$TAG"')
  })

  test('a narrative failure cannot be masked: no always(), failure(), or continue-on-error', () => {
    const serialized = JSON.stringify(getJob())
    expect(serialized).not.toContain('always()')
    expect(serialized).not.toContain('failure()')
    expect(serialized).not.toContain('continue-on-error')
    expect(findStep('Trigger docs rebuild')).not.toHaveProperty(
      'if',
      'always()',
    )
  })

  test('untrusted values reach `run:` only through env, never inline expressions', () => {
    for (const step of getSteps()) {
      expect(runOf(step)).not.toContain('${{')
    }
  })
})

describe('release-notes workflow structure', () => {
  test('concurrency group includes the tag and does not cancel in-progress runs', () => {
    const concurrency = asRecord(readWorkflow().concurrency, 'concurrency')
    const group = String(concurrency.group)
    expect(group).toContain('release-notes-')
    expect(group).toContain('github.event.release.tag_name')
    expect(group).toContain('github.event.inputs.tag')
    expect(concurrency['cancel-in-progress']).toBe(false)
  })

  test('every `uses:` is pinned to a 40-hex commit SHA', () => {
    for (const step of getSteps()) {
      if (step.uses === undefined) continue
      expect(String(step.uses)).toMatch(/@[0-9a-f]{40}(\s|$)/)
    }
  })
})

describe('semantic-release no longer runs the narrative', () => {
  test('.releaserc.yaml contains no @semantic-release/exec and no successCmd', () => {
    const source = fs.readFileSync(RELEASERC_PATH, 'utf8')
    expect(source).not.toContain('@semantic-release/exec')
    expect(source).not.toContain('successCmd')
  })
})
