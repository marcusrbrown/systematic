import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Repo-wide invariants of the publish path: release.yaml is the only workflow
 * that publishes, it authenticates to npm through OIDC alone, and nothing
 * waits on the npm registry or switches between publish paths.
 */

const WORKFLOWS_DIR = path.resolve(process.cwd(), '.github/workflows')

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Workflow {
  readonly file: string
  readonly source: string
  readonly jobs: Readonly<Record<string, RecordValue>>
}

function loadWorkflows(): readonly Workflow[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')
      // JSON_SCHEMA keeps the `on` key a string instead of YAML 1.1 boolean.
      const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA })
      const jobs: Record<string, RecordValue> = {}
      if (isRecord(parsed) && isRecord(parsed.jobs)) {
        for (const [id, job] of Object.entries(parsed.jobs)) {
          if (isRecord(job)) jobs[id] = job
        }
      }
      return { file, source, jobs }
    })
}

const workflows = loadWorkflows()

/** Every `file / job / step` run script in the repo's workflows. */
function runScripts(): readonly { where: string; run: string }[] {
  const scripts: { where: string; run: string }[] = []
  for (const { file, jobs } of workflows) {
    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job.steps) ? job.steps : []
      steps.forEach((step: unknown, index) => {
        if (!isRecord(step) || typeof step.run !== 'string') return
        const name = typeof step.name === 'string' ? step.name : `#${index}`
        scripts.push({ where: `${file} / ${jobId} / ${name}`, run: step.run })
      })
    }
  }
  return scripts
}

describe('publish path: workflow inventory', () => {
  test('the workflow directory is non-empty (sanity)', () => {
    expect(workflows.length).toBeGreaterThan(5)
    expect(runScripts().length).toBeGreaterThan(20)
  })
})

describe('publish path: no mode switch, no npm token', () => {
  test('no workflow references RELEASE_MODE', () => {
    const hits = workflows
      .filter(({ source }) => source.includes('RELEASE_MODE'))
      .map(({ file }) => file)
    expect(hits).toEqual([])
  })

  test('no workflow references NPM_TOKEN or NODE_AUTH_TOKEN', () => {
    const hits = workflows
      .filter(
        ({ source }) =>
          source.includes('NPM_TOKEN') || source.includes('NODE_AUTH_TOKEN'),
      )
      .map(({ file }) => file)
    expect(hits).toEqual([])
  })

  test('no workflow job is named legacy-release or release-mode', () => {
    for (const { file, jobs } of workflows) {
      expect(Object.keys(jobs), file).not.toContain('legacy-release')
      expect(Object.keys(jobs), file).not.toContain('release-mode')
    }
  })
})

describe('publish path: release.yaml is the only publisher', () => {
  test('no job outside release.yaml runs semantic-release for real or npm publish', () => {
    const offenders = runScripts()
      .filter(({ where }) => !where.startsWith('release.yaml /'))
      .filter(
        ({ run }) =>
          /\bnpm\s+publish\b/.test(run) ||
          (/semantic-release/.test(run) && !/--dry-run|\s-d\b/.test(run)),
      )
      .map(({ where }) => where)
    expect(offenders).toEqual([])
  })

  test('release.yaml runs semantic-release exactly once, in the publish job', () => {
    const release = workflows.find(({ file }) => file === 'release.yaml')
    expect(release).toBeDefined()
    const runners = Object.entries(release?.jobs ?? {})
      .filter(([, job]) =>
        JSON.stringify(job.steps).includes('semantic-release --ci'),
      )
      .map(([id]) => id)
    expect(runners).toEqual(['publish'])
  })
})

describe('publish path: authentication is OIDC only', () => {
  const publish = (): RecordValue => {
    const release = workflows.find(({ file }) => file === 'release.yaml')
    const job = release?.jobs.publish
    if (!job) throw new Error('release.yaml has no publish job')
    return job
  }

  test('the publish job runs in the release environment with id-token: write', () => {
    expect(publish().environment).toBe('release')
    expect(isRecord(publish().permissions)).toBe(true)
    expect((publish().permissions as RecordValue)['id-token']).toBe('write')
  })

  test('no publish step carries an npm token or writes an .npmrc', () => {
    const serialized = JSON.stringify(publish())
    expect(serialized).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/i)
    expect(serialized).not.toContain('registry-url')
    expect(serialized).not.toContain('.npmrc')
  })
})

describe('publish path: no waiting on the npm registry', () => {
  test('no step runs npm view inside a retry loop', () => {
    const offenders = runScripts()
      .filter(({ run }) => /\bnpm\s+view\b/.test(run))
      .filter(({ run }) => /\b(for|while|until|retry|sleep)\b/.test(run))
      .map(({ where }) => where)
    expect(offenders).toEqual([])
  })

  test('no workflow mentions NPM_RETRY_DELAY', () => {
    const hits = workflows
      .filter(({ source }) => source.includes('NPM_RETRY_DELAY'))
      .map(({ file }) => file)
    expect(hits).toEqual([])
  })

  test('no workflow gates on the package being visible on npm', () => {
    const hits = runScripts()
      .filter(({ run }) => /\bnpm\s+view\b/.test(run))
      .map(({ where }) => where)
    expect(hits).toEqual([])
  })
})
