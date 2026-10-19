import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the release-related shape of .github/workflows/main.yaml:
 *
 * - `Release` is a credential-free check that reports on every PR and push.
 * - main.yaml never publishes: publishing lives in release.yaml only.
 * - No dry-run input or flag survives anywhere.
 */

const WORKFLOW_PATH = path.resolve(process.cwd(), '.github/workflows/main.yaml')

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

function getSteps(job: RecordValue): readonly RecordValue[] {
  return asArray(job.steps, 'steps').map((step, i) =>
    asRecord(step, `step ${i}`),
  )
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

function normalize(condition: string): string {
  return condition.replace(/\s+/g, ' ').trim()
}

/** The job whose display name is `Release` (the required status context). */
function getReleaseCheckJob(): RecordValue {
  const match = Object.values(getJobs())
    .map((job) => asRecord(job, 'job'))
    .filter((job) => job.name === 'Release')
  expect(match).toHaveLength(1)
  return match[0] as RecordValue
}

/**
 * A job runs on `pull_request` unless its `if` excludes it. Excluded here means
 * the condition gates on a push event and never mentions pull_request.
 */
function runsOnPullRequest(job: RecordValue): boolean {
  if (job.if === undefined) return true
  const condition = normalize(String(job.if))
  if (
    condition.includes("github.event_name == 'push'") &&
    !condition.includes('pull_request')
  ) {
    return false
  }
  return true
}

function permissionsOf(job: RecordValue): RecordValue {
  return isRecord(job.permissions) ? job.permissions : {}
}

describe('main workflow: triggers and concurrency', () => {
  test('the dry-run input is gone and workflow_dispatch is removed', () => {
    const on = asRecord(readWorkflow().on, 'on')
    expect(on).not.toHaveProperty('workflow_dispatch')
    expect(JSON.stringify(on)).not.toContain('dry-run')
    expect(readSource()).not.toContain('dry-run')
    expect(readSource()).not.toContain('DRY_RUN')
    expect(readSource()).not.toContain('CI_FLAG')
  })

  test('no `--dry-run` appears anywhere', () => {
    expect(readSource()).not.toContain('--dry-run')
  })

  test('workflow-level concurrency cancels only on pull requests', () => {
    const concurrency = asRecord(readWorkflow().concurrency, 'concurrency')
    expect(concurrency['cancel-in-progress']).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
      "${{ github.event_name == 'pull_request' }}",
    )
  })
})

describe('main workflow: pull_request jobs are credential-free', () => {
  test('at least one job runs on pull_request (sanity)', () => {
    const prJobs = Object.values(getJobs()).filter((job) =>
      runsOnPullRequest(asRecord(job, 'job')),
    )
    expect(prJobs.length).toBeGreaterThan(0)
  })

  test('no pull_request job references a secret, id-token: write, or an environment', () => {
    for (const [id, raw] of Object.entries(getJobs())) {
      const job = asRecord(raw, id)
      if (!runsOnPullRequest(job)) continue
      expect(JSON.stringify(job), `${id} references secrets`).not.toContain(
        'secrets.',
      )
      expect(permissionsOf(job)['id-token'], `${id} id-token`).not.toBe('write')
      expect(job, `${id} environment`).not.toHaveProperty('environment')
    }
  })

  test('the workflow-level permissions are exactly contents: read', () => {
    expect(readWorkflow().permissions).toEqual({ contents: 'read' })
  })
})

describe('main workflow: Release check job', () => {
  test('has only contents: read, no secrets, no environment', () => {
    const job = getReleaseCheckJob()
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toContain('secrets.')
    expect(job).not.toHaveProperty('environment')
    expect(job).not.toHaveProperty('if')
  })

  test('checks out full history without persisted credentials, then installs', () => {
    const steps = getSteps(getReleaseCheckJob())
    const checkout = steps.find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout@'),
    )
    expect(checkout).toBeDefined()
    const withBlock = asRecord(checkout?.with, 'checkout with')
    expect(withBlock['fetch-depth']).toBe(0)
    expect(withBlock['persist-credentials']).toBe(false)

    const setupBun = steps.findIndex((s) =>
      String(s.uses ?? '').startsWith('oven-sh/setup-bun@'),
    )
    const install = steps.findIndex(
      (s) => runOf(s).trim() === 'bun install --frozen-lockfile',
    )
    expect(setupBun).toBeGreaterThan(steps.indexOf(checkout as RecordValue))
    expect(install).toBeGreaterThan(setupBun)
  })

  test('renders the release into $RUNNER_TEMP/render and summarizes it', () => {
    const job = getReleaseCheckJob()
    const render = getSteps(job).find((s) =>
      runOf(s).includes('bun scripts/release/render.ts'),
    )
    expect(render).toBeDefined()
    const run = runOf(render as RecordValue)
    expect(run).toContain('--sha')
    expect(run).toContain('--out "$RUNNER_TEMP/render"')

    const summary = getSteps(job).find((s) =>
      runOf(s).includes('GITHUB_STEP_SUMMARY'),
    )
    expect(summary).toBeDefined()
    expect(runOf(summary as RecordValue)).toContain('jq')
    expect(runOf(summary as RecordValue)).toContain('render.json')
    expect(runOf(summary as RecordValue)).toContain('nothing releasable')
  })

  test('renders the parent of the PR head on release/pending PRs', () => {
    const job = getReleaseCheckJob()
    const serialized = JSON.stringify(job)
    expect(serialized).toContain('release/pending')
    expect(serialized).toContain('HEAD^')
    expect(serialized).toContain('github.event.pull_request.head.sha')
  })

  test('a release/pending-only step fails unless CHANGELOG.md has the version heading and matches the render byte for byte', () => {
    const job = getReleaseCheckJob()
    const step = getSteps(job).find(
      (s) =>
        String(s.if ?? '').includes("github.head_ref == 'release/pending'") &&
        runOf(s).includes('CHANGELOG.md'),
    )
    expect(step).toBeDefined()
    const condition = normalize(String(step?.if))
    expect(condition).toContain("github.event_name == 'pull_request'")
    const run = runOf(step as RecordValue)
    expect(run).toContain('exit 1')
    expect(run).toContain('grep')
    expect(run).toContain('cmp')
    expect(run).toContain('$RUNNER_TEMP/render/CHANGELOG.md')
  })
})

describe('main workflow: no publish path', () => {
  test('the only release job is the credential-free Release check', () => {
    expect(getJobs()).not.toHaveProperty('legacy-release')
    expect(getJobs()).not.toHaveProperty('release-mode')
    expect(Object.keys(getJobs()).sort()).toEqual([
      'build',
      'docs',
      'host-contract',
      'host-contract-gate',
      'host-contract-shard',
      'lint',
      'registry',
      'release',
      'test',
      'typecheck',
    ])
  })

  test('no job holds the release environment, an OIDC grant or the release App', () => {
    for (const [id, raw] of Object.entries(getJobs())) {
      const job = asRecord(raw, id)
      expect(job, `${id} environment`).not.toHaveProperty('environment')
      expect(permissionsOf(job)['id-token'], `${id} id-token`).toBeUndefined()
      expect(JSON.stringify(job), `${id} App`).not.toContain('RELEASE_APP')
    }
  })

  test('RELEASE_MODE, NPM_TOKEN and NODE_AUTH_TOKEN appear nowhere', () => {
    for (const needle of ['RELEASE_MODE', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
      expect(readSource()).not.toContain(needle)
    }
  })

  test('semantic-release and npm publish never run from main.yaml', () => {
    expect(readSource()).not.toContain('semantic-release')
    expect(readSource()).not.toContain('npm publish')
  })

  test('no job depends on a removed release job', () => {
    for (const [id, raw] of Object.entries(getJobs())) {
      const needs = asRecord(raw, id).needs
      const list = Array.isArray(needs)
        ? needs
        : needs === undefined
          ? []
          : [needs]
      for (const dependency of list) {
        expect(getJobs(), `${id} needs ${String(dependency)}`).toHaveProperty(
          String(dependency),
        )
      }
    }
  })
})

describe('main workflow: publish-claude-code-plugin moved out', () => {
  test('the job is gone (it lives in publish-claude-code-plugin.yaml)', () => {
    expect(getJobs()).not.toHaveProperty('publish-claude-code-plugin')
  })

  test('no job in main.yaml publishes the claude-code-plugin branch', () => {
    expect(readSource()).not.toContain('git push origin claude-code-plugin')
  })
})
