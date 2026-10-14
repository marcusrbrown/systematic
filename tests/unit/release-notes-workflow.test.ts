import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const DEFAULT_BRANCH_EXPR = '${{ github.event.repository.default_branch }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const EVENT_NAME_EXPR = '${{ github.event_name }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const RELEASE_TAG_EXPR = '${{ github.event.release.tag_name }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const INPUT_TAG_EXPR = '${{ github.event.inputs.tag }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const RELEASE_AUTHOR_EXPR = '${{ github.event.release.author.login }}'

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
  test('validation is delegated to scripts/validate-release-target.sh without requiring the latest release', () => {
    const step = findStep('Validate release target')
    const env = asRecord(step.env, 'validate env')

    expect(step.id).toBe('target')
    expect(runOf(step)).toContain('scripts/validate-release-target.sh')
    // Narration is allowed for historical releases; only docs need the latest.
    expect(env.REQUIRE_LATEST).toBe('false')
    expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    expect(env.EVENT_NAME).toBe(EVENT_NAME_EXPR)
    expect(env.RELEASE_TAG).toBe(RELEASE_TAG_EXPR)
    expect(env.INPUT_TAG).toBe(INPUT_TAG_EXPR)
    expect(env.RELEASE_AUTHOR).toBe(RELEASE_AUTHOR_EXPR)
  })

  test('the expected author references RELEASE_AUTHOR_LOGIN with the systematic-release[bot] default', () => {
    const expected = String(
      asRecord(findStep('Validate release target').env, 'env').EXPECTED_AUTHOR,
    )
    expect(expected).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(expected).toContain("'systematic-release[bot]'")
    expect(expected).not.toContain('mrbro-bot')
  })

  test('no inline author, tag, or npm gate steps remain in the workflow', () => {
    for (const name of [
      'Check release author',
      'Validate release tag',
      'Verify package is published to npm',
    ]) {
      expect(getSteps().some((s) => s.name === name)).toBe(false)
    }
  })

  test('the trusted default branch is checked out (never the release tag) before validating', () => {
    const checkout = findStep('Checkout')
    expect(String(checkout.uses)).toStartWith('actions/checkout@')
    const withBlock = asRecord(checkout.with, 'checkout with')
    expect(withBlock['persist-credentials']).toBe(false)
    // A release event's default checkout is the tagged commit, which is not
    // trusted: both scripts run with an actions: write token.
    expect(withBlock.ref).toBe(DEFAULT_BRANCH_EXPR)
    expect(checkout).not.toHaveProperty('if')
    expect(indexOfStep('Checkout')).toBeLessThan(
      indexOfStep('Validate release target'),
    )
  })

  test('every step after validation is gated on its proceed output', () => {
    const steps = getSteps()
    const validateIndex = indexOfStep('Validate release target')
    for (const step of steps.slice(validateIndex + 1)) {
      expect(String(step.if ?? '')).toContain(
        "steps.target.outputs.proceed == 'true'",
      )
    }
  })
})

describe('release-notes workflow narrative and docs dispatch', () => {
  test('the narrative step runs scripts/dispatch-release-notes.sh with the validated tag', () => {
    const step = findStep('Narrate release notes')
    expect(runOf(step)).toContain('scripts/dispatch-release-notes.sh "$TAG"')
    expect(JSON.stringify(step.env)).toContain('steps.target.outputs.tag')
  })

  test('the docs dispatch step comes after the narrative step', () => {
    expect(indexOfStep('Trigger docs rebuild')).toBeGreaterThan(
      indexOfStep('Narrate release notes'),
    )
  })

  test('the docs dispatch targets the LATEST release tag, not the narrated tag', () => {
    const step = findStep('Trigger docs rebuild')
    const run = runOf(step)

    // Resolved the same way the validator does: no tag argument = Latest.
    expect(run).toMatch(/gh release view --repo "\$GH_REPO" --json tagName/)
    expect(run).toContain('.tagName')
    expect(run).toContain('gh workflow run docs.yaml')
    expect(run).toContain('--ref main')
    expect(run).toContain('-f tag="$LATEST"')
    // A historical tag must never reach docs.yaml (it would downgrade the site).
    expect(run).not.toContain('-f tag="$TAG"')
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

describe('release-notes workflow Trigger docs rebuild (executed)', () => {
  const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
if [ "\${1:-}" = release ] && [ "\${2:-}" = view ]; then
  [ -z "\${STUB_LATEST_FAIL:-}" ] || exit 1
  printf '%s\\n' "\${STUB_LATEST-}"
  exit 0
fi
exit 0
`

  function runTrigger(latest: { value?: string; fail?: boolean }) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'))
    try {
      const bin = path.join(cwd, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 })
      const log = path.join(cwd, 'stub.log')
      fs.writeFileSync(log, '')

      const result = spawnSync(
        'bash',
        ['-e', '-c', runOf(findStep('Trigger docs rebuild'))],
        {
          cwd,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: cwd,
            STUB_LOG: log,
            STUB_LATEST: latest.value ?? '',
            ...(latest.fail ? { STUB_LATEST_FAIL: '1' } : {}),
            TAG: 'v1.0.0',
            GH_TOKEN: 'token',
            GH_REPO: 'marcusrbrown/systematic',
          },
        },
      )
      const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        dispatches: calls.filter((c) => c.startsWith('gh workflow run')),
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  test('narrating v1.0.0 while v2.0.0 is Latest dispatches docs for v2.0.0', () => {
    const r = runTrigger({ value: 'v2.0.0' })

    expect(r.status).toBe(0)
    expect(r.dispatches).toEqual([
      'gh workflow run docs.yaml --ref main -f tag=v2.0.0',
    ])
  })

  test('a failed latest lookup dispatches nothing and fails', () => {
    const r = runTrigger({ fail: true })

    expect(r.status).not.toBe(0)
    expect(r.dispatches).toEqual([])
  })

  test.each(['latest', '', 'v2.0', 'v2.0.0-rc.1', 'v2.0.0 --ref evil'])(
    'a malformed latest value (%j) dispatches nothing and fails',
    (value) => {
      const r = runTrigger({ value })

      expect(r.status).not.toBe(0)
      expect(r.output).toContain('::error::')
      expect(r.dispatches).toEqual([])
    },
  )
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
