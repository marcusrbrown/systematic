import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the shape of .github/workflows/publish-claude-code-plugin.yaml: the
 * Claude Code plugin publish runs on `release: published` (same in legacy and
 * gated release mode), builds the plugin in a credential-free job, and pushes
 * the built bundle from a second job that holds the only write credential and
 * runs no repository code.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/publish-claude-code-plugin.yaml',
)

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

function getJob(id: string): RecordValue {
  return asRecord(getJobs()[id], `job ${id}`)
}

function getSteps(job: RecordValue): readonly RecordValue[] {
  return asArray(job.steps, 'steps').map((step, i) =>
    asRecord(step, `step ${i}`),
  )
}

function findStep(job: RecordValue, name: string): RecordValue {
  const step = getSteps(job).find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step not found: ${name}`)
  return step
}

function indexOfStep(job: RecordValue, name: string): number {
  const index = getSteps(job).findIndex((candidate) => candidate.name === name)
  if (index === -1) throw new Error(`step not found: ${name}`)
  return index
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

function isCheckout(step: RecordValue): boolean {
  return String(step.uses ?? '').startsWith('actions/checkout@')
}

describe('publish-claude-code-plugin triggers', () => {
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

  test('top-level permissions are empty', () => {
    expect(readWorkflow().permissions).toEqual({})
  })

  test('concurrency is claude-code-plugin and never cancels in-progress runs', () => {
    expect(readWorkflow().concurrency).toEqual({
      group: 'claude-code-plugin',
      'cancel-in-progress': false,
    })
  })

  test('the workflow has exactly the build and push jobs', () => {
    expect(Object.keys(getJobs()).sort()).toEqual(['build', 'push'])
  })
})

describe('publish-claude-code-plugin credentials', () => {
  test('no `secrets.` reference appears anywhere in the file', () => {
    expect(readSource()).not.toContain('secrets.')
  })

  test('build has exactly contents: read and no environment', () => {
    const build = getJob('build')
    expect(build.permissions).toEqual({ contents: 'read' })
    expect(build).not.toHaveProperty('environment')
  })

  test('only push holds a write permission', () => {
    expect(getJob('push').permissions).toEqual({ contents: 'write' })
    for (const [id, raw] of Object.entries(getJobs())) {
      if (id === 'push') continue
      expect(JSON.stringify(asRecord(raw, id).permissions)).not.toContain(
        'write',
      )
    }
  })

  test('the push credential is the workflow github.token, as in the old main.yaml job', () => {
    const serialized = JSON.stringify(getJob('push'))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(serialized).toContain('${{ github.token }}')
    expect(serialized).not.toContain('create-github-app-token')
  })

  test('checkouts never persist credentials', () => {
    for (const step of getSteps(getJob('build')).filter(isCheckout)) {
      expect(asRecord(step.with, 'checkout with')['persist-credentials']).toBe(
        false,
      )
    }
  })
})

describe('publish-claude-code-plugin build job', () => {
  const build = () => getJob('build')

  test('prereleases are skipped on release events', () => {
    expect(String(build().if ?? '')).toContain(
      'github.event.release.prerelease',
    )
  })

  test('the validator is fetched from the default branch before validating', () => {
    const fetch = findStep(build(), 'Fetch release target validator')
    expect(isCheckout(fetch)).toBe(true)
    const withBlock = asRecord(fetch.with, 'fetch with')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(withBlock.ref).toBe('${{ github.event.repository.default_branch }}')
    expect(withBlock['persist-credentials']).toBe(false)
    expect(indexOfStep(build(), 'Fetch release target validator')).toBeLessThan(
      indexOfStep(build(), 'Validate release target'),
    )
  })

  test('validation uses scripts/validate-release-target.sh with the systematic-release default author', () => {
    const step = findStep(build(), 'Validate release target')
    const env = asRecord(step.env, 'validate env')

    expect(step.id).toBe('target')
    expect(runOf(step)).toContain('validate-release-target.sh')
    expect(String(env.EXPECTED_AUTHOR)).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(String(env.EXPECTED_AUTHOR)).toContain("'systematic-release[bot]'")
    expect(String(env.EXPECTED_AUTHOR)).not.toContain('mrbro-bot')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(env.EVENT_NAME).toBe('${{ github.event_name }}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(env.RELEASE_TAG).toBe('${{ github.event.release.tag_name }}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(env.INPUT_TAG).toBe('${{ github.event.inputs.tag }}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(env.RELEASE_AUTHOR).toBe('${{ github.event.release.author.login }}')
    expect(env.REQUIRE_LATEST).toBe('true')
  })

  test('every step after validation is gated on its proceed output', () => {
    const steps = getSteps(build())
    const validateIndex = indexOfStep(build(), 'Validate release target')
    for (const step of steps.slice(validateIndex + 1)) {
      expect(String(step.if ?? '')).toContain(
        "steps.target.outputs.proceed == 'true'",
      )
    }
  })

  test('the validated tag is what gets checked out, without persisted credentials', () => {
    const checkouts = getSteps(build()).filter(
      (s) => isCheckout(s) && s.name !== 'Fetch release target validator',
    )
    expect(checkouts).toHaveLength(1)
    const withBlock = asRecord(checkouts[0]?.with, 'checkout with')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(withBlock.ref).toBe('${{ steps.target.outputs.tag }}')
    expect(withBlock['persist-credentials']).toBe(false)
  })

  test('requires the version on npm with retries and ends cleanly with ::notice:: otherwise', () => {
    const step = findStep(build(), 'Confirm package is on npm')
    const run = runOf(step)
    expect(step.id).toBe('npm')
    expect(run).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal shell expansion
      'npm view "@fro.bot/systematic@${VERSION}" version',
    )
    expect(run).toMatch(/for attempt in/)
    expect(run).toContain('::notice::')
    expect(run).not.toContain('exit 1')
  })

  test('installs and builds the plugin, then guards the bundle before upload', () => {
    const names = getSteps(build()).map((s) => s.name)
    const install = getSteps(build()).findIndex(
      (s) => runOf(s) === 'bun install --frozen-lockfile',
    )
    const buildIndex = getSteps(build()).findIndex(
      (s) => runOf(s) === 'bun run claude-code:build',
    )
    const guard = indexOfStep(build(), 'Guard built bundle')
    const upload = getSteps(build()).findIndex((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact@'),
    )
    expect(names).toContain('Guard built bundle')
    expect(install).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(install)
    expect(guard).toBeGreaterThan(buildIndex)
    expect(upload).toBeGreaterThan(guard)
  })

  test('the bundle guard keeps every required-artifact check from the old job', () => {
    const run = runOf(findStep(build(), 'Guard built bundle'))
    for (const required of [
      'claude-code/.claude-plugin/plugin.json',
      'claude-code/skills/using-systematic/SKILL.md',
      'claude-code/output-styles/systematic.md',
      'claude-code/hooks/hooks.json',
      'claude-code/bin/systematic-validate-review-artifact',
      'claude-code/agents',
    ]) {
      expect(run).toContain(required)
    }
    expect(run).toContain(
      '-x "claude-code/bin/systematic-validate-review-artifact"',
    )
  })

  test('the plugin is uploaded as a tar so file modes survive the artifact', () => {
    const run = runOf(findStep(build(), 'Pack plugin bundle'))
    expect(run).toContain('tar')
    const upload = getSteps(build()).find((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact@'),
    )
    const withBlock = asRecord(upload?.with, 'upload with')
    expect(withBlock['if-no-files-found']).toBe('error')
    expect(String(withBlock.path)).toContain('.tar')
  })

  test('exposes the publish decision, tag and source commit as outputs', () => {
    const outputs = asRecord(build().outputs, 'outputs')
    expect(Object.keys(outputs).sort()).toEqual(['publish', 'sha', 'tag'])
  })
})

describe('publish-claude-code-plugin push job', () => {
  const push = () => getJob('push')

  test('depends on build and runs only when build produced output', () => {
    expect(push().needs).toBe('build')
    expect(String(push().if ?? '')).toContain(
      "needs.build.outputs.publish == 'true'",
    )
  })

  test('runs no repository code: no checkout, no bun, no install, no scripts/', () => {
    for (const step of getSteps(push())) {
      expect(isCheckout(step)).toBe(false)
      expect(String(step.uses ?? '')).not.toContain('setup-bun')
      expect(String(step.uses ?? '')).not.toContain('setup-node')
      const run = runOf(step)
      expect(run).not.toMatch(/\bbun\b/)
      expect(run).not.toMatch(/\bnpm\b|\bnpx\b/)
      expect(run).not.toContain('scripts/')
    }
  })

  test('downloads the built plugin artifact', () => {
    const download = getSteps(push()).find((s) =>
      String(s.uses ?? '').startsWith('actions/download-artifact@'),
    )
    expect(download).toBeDefined()
    const upload = getSteps(getJob('build')).find((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact@'),
    )
    expect(asRecord(download?.with, 'download with').name).toBe(
      asRecord(upload?.with, 'upload with').name,
    )
  })

  test('reproduces the old push target and commit message', () => {
    const serialized = getSteps(push()).map(runOf).join('\n')
    expect(serialized).toContain('claude-code-plugin')
    expect(serialized).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal shell expansion
      'build(claude-code): publish marcusrbrown/systematic@${SHA}',
    )
    expect(serialized).toContain('git push origin claude-code-plugin')
    expect(serialized).toContain('github-actions[bot]')
    expect(serialized).toContain(
      '41898282+github-actions[bot]@users.noreply.github.com',
    )
    expect(serialized).toContain('No changes to publish.')
  })

  test('untrusted values reach `run:` only through env, never inline expressions', () => {
    for (const step of getSteps(push())) {
      expect(runOf(step)).not.toContain('${{')
    }
  })
})

describe('publish-claude-code-plugin supply chain', () => {
  test('every `uses:` is pinned to a 40-hex commit SHA', () => {
    for (const job of Object.values(getJobs())) {
      for (const step of getSteps(asRecord(job, 'job'))) {
        if (step.uses === undefined) continue
        expect(String(step.uses)).toMatch(/@[0-9a-f]{40}(\s|$)/)
      }
    }
  })
})
