import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the release-related shape of .github/workflows/main.yaml:
 *
 * - `Release` is a credential-free check that reports on every PR and push.
 * - The credentialed publish lives in `legacy-release`, behind
 *   `vars.RELEASE_MODE == 'legacy'`, the `release` environment, and the
 *   `release-state` concurrency group.
 * - `release-mode` fails red on any value other than exactly `legacy`/`gated`.
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

describe('main workflow: legacy-release job', () => {
  const job = () => getJob('legacy-release')

  test('runs only on push in legacy mode', () => {
    const condition = normalize(String(job().if ?? ''))
    expect(condition).toContain("vars.RELEASE_MODE == 'legacy'")
    expect(condition).toContain("github.event_name == 'push'")
    expect(runsOnPullRequest(job())).toBe(false)
  })

  test('needs the same jobs the old release job needed', () => {
    expect(job().needs).toEqual([
      'build',
      'typecheck',
      'lint',
      'test',
      'host-contract',
    ])
  })

  test('declares environment release and the release-state concurrency group', () => {
    expect(job().environment).toBe('release')
    expect(job().concurrency).toEqual({
      group: 'release-state',
      'cancel-in-progress': false,
    })
  })

  test('has contents: read and id-token: write only', () => {
    expect(job().permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    })
  })

  test('uses the RELEASE App credentials, not the old application secrets', () => {
    const serialized = JSON.stringify(job())
    expect(serialized).toContain('secrets.RELEASE_APP_ID')
    expect(serialized).toContain('secrets.RELEASE_APP_PRIVATE_KEY')
    expect(serialized).not.toContain('APPLICATION_ID')
    expect(serialized).not.toContain('APPLICATION_PRIVATE_KEY')
    expect(readSource()).not.toContain('APPLICATION_ID')
  })

  test('keeps the build step and the release outputs', () => {
    expect(getSteps(job()).some((s) => runOf(s) === 'bun run build')).toBe(true)
    const outputs = asRecord(job().outputs, 'outputs')
    expect(Object.keys(outputs).sort()).toEqual([
      'new-release-published',
      'new-release-version',
    ])
  })

  test('runs semantic-release for real, with no dry-run flag', () => {
    const step = findStep(job(), 'Semantic Release')
    expect(step.id).toBe('semantic-release')
    expect(runOf(step)).toContain('npx semantic-release')
    expect(runOf(step)).not.toContain('dry-run')
  })

  test('NPM_TOKEN and NODE_AUTH_TOKEN appear only in the semantic-release step', () => {
    for (const step of getSteps(job())) {
      const serialized = JSON.stringify(step)
      if (step.name === 'Semantic Release') {
        expect(serialized).toContain('secrets.NPM_TOKEN')
        continue
      }
      expect(serialized).not.toContain('NPM_TOKEN')
      expect(serialized).not.toContain('NODE_AUTH_TOKEN')
    }
    const { steps: _steps, ...rest } = job()
    expect(JSON.stringify(rest)).not.toContain('NPM_TOKEN')
    expect(JSON.stringify(rest)).not.toContain('NODE_AUTH_TOKEN')
    // And nowhere else in the workflow.
    for (const [id, other] of Object.entries(getJobs())) {
      if (id === 'legacy-release') continue
      expect(JSON.stringify(other)).not.toContain('NPM_TOKEN')
    }
  })
})

describe('main workflow: release-mode guard job', () => {
  test('runs on push only', () => {
    const job = getJob('release-mode')
    expect(normalize(String(job.if ?? ''))).toBe("github.event_name == 'push'")
    expect(runsOnPullRequest(job)).toBe(false)
  })

  test('reads vars.RELEASE_MODE through env', () => {
    const job = getJob('release-mode')
    const step = getSteps(job).find((s) => runOf(s).includes('RELEASE_MODE'))
    expect(step).toBeDefined()
    const env = asRecord(step?.env, 'guard env')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
    expect(env.RELEASE_MODE).toBe('${{ vars.RELEASE_MODE }}')
    expect(runOf(step as RecordValue)).not.toContain('${{')
  })

  describe('guard script (executed)', () => {
    function runGuard(mode: string) {
      const job = getJob('release-mode')
      const step = getSteps(job).find((s) => runOf(s).includes('RELEASE_MODE'))
      const result = spawnSync(
        'bash',
        ['-e', '-c', runOf(step as RecordValue)],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', RELEASE_MODE: mode },
        },
      )
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      }
    }

    test.each(['', 'Gated', 'prod', 'LEGACY', ' gated', 'gated '])(
      'exits 1 with ::error:: for %j',
      (mode) => {
        const r = runGuard(mode)
        expect(r.status).toBe(1)
        expect(r.output).toContain('::error::')
      },
    )

    test.each(['legacy', 'gated'])('exits 0 for %j', (mode) => {
      expect(runGuard(mode).status).toBe(0)
    })
  })
})

describe('main workflow: publish-claude-code-plugin', () => {
  test('hangs off legacy-release, not release', () => {
    const job = getJob('publish-claude-code-plugin')
    expect(job.needs).toEqual([
      'build',
      'typecheck',
      'lint',
      'test',
      'legacy-release',
    ])
    const condition = normalize(String(job.if))
    expect(condition).toContain(
      "needs.legacy-release.outputs.new-release-published == 'true'",
    )
    expect(condition).not.toContain('needs.release.')
  })
})
