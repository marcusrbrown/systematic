import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the privilege-separation invariants of .github/workflows/docs.yaml:
 *
 * - `build` runs repo code (bun install, docs/scripts, registry build) with
 *   read-only credentials and never sees the deploy key.
 * - `deploy` is the only job that touches FRO_BOT_APPLICATION_* and runs no
 *   repo code, only the clone/replace/force-push of the downloaded artifact.
 * - A manual dispatch can only rebuild an existing published release tag.
 *
 * These are properties of the workflow YAML, not of any script, so they are
 * asserted against the parsed file.
 */

const WORKFLOW_PATH = path.resolve(process.cwd(), '.github/workflows/docs.yaml')

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

function getJob(name: string): RecordValue {
  const jobs = asRecord(readWorkflow().jobs, 'jobs')
  return asRecord(jobs[name], `${name} job`)
}

function getSteps(jobName: string): readonly RecordValue[] {
  return asArray(getJob(jobName).steps, `${jobName} steps`).map((step, i) =>
    asRecord(step, `${jobName} step ${i}`),
  )
}

function findStep(steps: readonly RecordValue[], name: string): RecordValue {
  const step = steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step not found: ${name}`)
  return step
}

function stepIndex(
  steps: readonly RecordValue[],
  predicate: (step: RecordValue) => boolean,
  label: string,
): number {
  const index = steps.findIndex(predicate)
  if (index === -1) throw new Error(`step not found: ${label}`)
  return index
}

function isCheckoutStep(step: RecordValue): boolean {
  return String(step.uses ?? '').startsWith('actions/checkout@')
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

function stepsWhere(
  steps: readonly RecordValue[],
  predicate: (step: RecordValue) => boolean,
): readonly RecordValue[] {
  return steps.filter(predicate)
}

// Literal GitHub Actions expressions as they appear in the YAML (not JS templates).
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const GITHUB_TOKEN_EXPR = '${{ github.token }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const TAG_OUTPUT_EXPR = '${{ steps.tag.outputs.tag }}'

const TAG_PATTERN = '^v[0-9]+\\.[0-9]+\\.[0-9]+$'

describe('docs workflow privilege separation', () => {
  test('the workflow defines exactly the build and deploy jobs', () => {
    const jobs = asRecord(readWorkflow().jobs, 'jobs')
    expect(Object.keys(jobs).sort()).toEqual(['build', 'deploy'])
  })

  test('only the deploy job references FRO_BOT_APPLICATION_ID / FRO_BOT_APPLICATION_PRIVATE_KEY', () => {
    const jobs = asRecord(readWorkflow().jobs, 'jobs')
    const secretPattern =
      /FRO_BOT_APPLICATION_ID|FRO_BOT_APPLICATION_PRIVATE_KEY/

    expect(JSON.stringify(jobs.deploy)).toMatch(secretPattern)
    expect(JSON.stringify(jobs.build)).not.toMatch(secretPattern)

    // And nothing outside the deploy job (workflow-level env, etc.).
    const { jobs: _jobs, ...rest } = readWorkflow()
    expect(JSON.stringify(rest)).not.toMatch(secretPattern)
  })

  test('deploy declares environment: docs and needs: build', () => {
    const deploy = getJob('deploy')
    expect(deploy.environment).toBe('docs')
    const needs = deploy.needs
    expect(Array.isArray(needs) ? needs : [needs]).toEqual(['build'])
  })

  test('deploy only runs when the build resolved a trusted target', () => {
    const condition = String(getJob('deploy').if ?? '')
    expect(condition).toContain('needs.build.outputs.proceed')
  })

  test("build's permissions are exactly contents: read", () => {
    expect(getJob('build').permissions).toEqual({ contents: 'read' })
  })

  test('no job (or the workflow) grants write permissions', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const permissionBlocks = [
      workflow.permissions,
      ...Object.values(jobs).map((job) => asRecord(job, 'job').permissions),
    ]

    for (const block of permissionBlocks) {
      if (block === undefined) continue
      expect(block).not.toBe('write-all')
      for (const value of Object.values(asRecord(block, 'permissions'))) {
        expect(value).not.toBe('write')
      }
    }
  })

  test('deploy grants contents: read only', () => {
    expect(getJob('deploy').permissions).toEqual({ contents: 'read' })
  })

  test('deploy runs no bun install, bun run, npm, or repo scripts', () => {
    const forbidden = /\b(bun|bunx|npm|npx|pnpm|yarn)\b/
    const repoScripts = /(^|[\s"'/])scripts\//m

    for (const step of getSteps('deploy')) {
      const run = runOf(step)
      expect(run).not.toMatch(forbidden)
      expect(run).not.toMatch(repoScripts)
    }
  })

  test('deploy performs the clone / replace / force-push to fro-bot/systematic', () => {
    const run = getSteps('deploy').map(runOf).join('\n')
    expect(run).toContain('fro-bot/systematic.git')
    expect(run).toContain('git push --force origin gh-pages')
  })

  test('deploy downloads the site artifact into docs/dist', () => {
    const download = findStep(getSteps('deploy'), 'Download docs site')
    expect(String(download.uses)).toStartWith('actions/download-artifact@')
    const withBlock = asRecord(download.with, 'download with')
    expect(withBlock.path).toBe('docs/dist')
  })

  test('build uploads docs/dist (including dotfiles) as an artifact', () => {
    const upload = findStep(getSteps('build'), 'Upload docs site')
    expect(String(upload.uses)).toStartWith('actions/upload-artifact@')
    const withBlock = asRecord(upload.with, 'upload with')
    expect(withBlock.path).toBe('docs/dist')
    // .nojekyll and .well-known/ are dotfiles; upload-artifact drops them by default.
    expect(withBlock['include-hidden-files']).toBe(true)
    expect(withBlock['if-no-files-found']).toBe('error')
    // Upload and download must agree on the artifact name.
    const download = findStep(getSteps('deploy'), 'Download docs site')
    expect(asRecord(download.with, 'download with').name).toBe(withBlock.name)
  })

  test('the docs-deploy concurrency group cancels in-progress runs', () => {
    expect(readWorkflow().concurrency).toEqual({
      group: 'docs-deploy',
      'cancel-in-progress': true,
    })
  })

  test('every `uses:` is pinned to a 40-hex commit SHA', () => {
    for (const jobName of ['build', 'deploy']) {
      for (const step of getSteps(jobName)) {
        if (step.uses === undefined) continue
        expect(String(step.uses)).toMatch(/@[0-9a-f]{40}(\s|$)/)
      }
    }
  })
})

describe('docs workflow triggers', () => {
  test('keeps release: published', () => {
    const on = asRecord(readWorkflow().on, 'on')
    expect(asRecord(on.release, 'release').types).toEqual(['published'])
  })

  test('workflow_dispatch requires a tag input and has no version input', () => {
    const on = asRecord(readWorkflow().on, 'on')
    const dispatch = asRecord(on.workflow_dispatch, 'workflow_dispatch')
    const inputs = asRecord(dispatch.inputs, 'inputs')

    expect(inputs).not.toHaveProperty('version')
    const tag = asRecord(inputs.tag, 'tag input')
    expect(tag.required).toBe(true)
    expect(tag.type).toBe('string')
  })

  test('prereleases are still skipped', () => {
    const condition = String(getJob('build').if ?? '')
    expect(condition).toContain('github.event.release.prerelease')
  })
})

describe('docs workflow build job target validation', () => {
  test('tag validation checks the stable-tag pattern and calls gh release view', () => {
    const step = findStep(getSteps('build'), 'Validate release tag')
    const run = runOf(step)

    expect(run).toContain(TAG_PATTERN)
    expect(run).toContain('gh release view')
    // Draft / prerelease dispatch targets are rejected.
    expect(run).toContain('isDraft')
    expect(run).toContain('isPrerelease')
    expect(asRecord(step.env, 'validate env').GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
  })

  test('a manual dispatch fails when the release author is not the expected release author', () => {
    const step = findStep(getSteps('build'), 'Validate release tag')
    const run = runOf(step)
    const env = asRecord(step.env, 'validate env')

    // Dispatch has no release payload, so the author is read from the release.
    expect(run).toContain('gh release view')
    expect(run).toMatch(/--json[^\n]*\bauthor\b/)
    expect(run).toContain('.author.login')
    // Same trust anchor as the release-event author check.
    expect(String(env.EXPECTED_AUTHOR)).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(String(env.EXPECTED_AUTHOR)).toContain("'mrbro-bot[bot]'")
    // A mismatch is loud (error + non-zero exit), not a silent skip.
    expect(run).toMatch(/"\$author" != "\$EXPECTED_AUTHOR"[\s\S]*?exit 1/)
    expect(run).toMatch(/::error::[^\n]*author/i)
  })

  test('untrusted inputs reach the script through env, not inline interpolation', () => {
    const step = findStep(getSteps('build'), 'Validate release tag')
    expect(runOf(step)).not.toContain('${{')
  })

  test('tag validation, author check, and npm check all come before checkout', () => {
    const steps = getSteps('build')
    const checkout = stepIndex(steps, isCheckoutStep, 'checkout')

    for (const name of [
      'Check release author',
      'Validate release tag',
      'Verify package is published to npm',
    ]) {
      expect(stepIndex(steps, (s) => s.name === name, name)).toBeLessThan(
        checkout,
      )
    }
  })

  test('the release author check references RELEASE_AUTHOR_LOGIN with the mrbro-bot[bot] default', () => {
    const step = findStep(getSteps('build'), 'Check release author')
    const serialized = JSON.stringify(step)

    expect(serialized).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(serialized).toContain("'mrbro-bot[bot]'")
    expect(serialized).toContain('github.event.release.author.login')
    // A mismatch ends cleanly (no failure) and says why.
    expect(runOf(step)).toContain('proceed=false')
    expect(runOf(step)).not.toMatch(/exit 1/)
  })

  test('the npm check runs `npm view @fro.bot/systematic@<version>` and fails loudly', () => {
    const step = findStep(
      getSteps('build'),
      'Verify package is published to npm',
    )
    const run = runOf(step)

    expect(run).toMatch(/npm view "?@fro\.bot\/systematic@/)
    expect(run).toContain('::error::')
    expect(run).toContain('exit 1')
  })

  test('build checks out the resolved tag without persisting credentials', () => {
    const checkout = stepsWhere(getSteps('build'), isCheckoutStep)
    expect(checkout).toHaveLength(1)
    const withBlock = asRecord(checkout[0]?.with, 'checkout with')

    expect(withBlock.ref).toBe(TAG_OUTPUT_EXPR)
    expect(withBlock['persist-credentials']).toBe(false)
  })

  test('the tag step has the id the checkout and registry steps depend on', () => {
    expect(findStep(getSteps('build'), 'Validate release tag').id).toBe('tag')
  })

  test('docs generate and build steps receive the read-only github token', () => {
    const steps = getSteps('build')
    for (const name of ['Generate reference content', 'Build docs']) {
      const env = asRecord(findStep(steps, name).env, `${name} env`)
      expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    }
  })

  test('the registry is versioned from the validated tag, not raw event inputs', () => {
    const steps = getSteps('build')
    const registry = findStep(steps, 'Build registry')
    expect(runOf(registry)).toContain('steps.tag.outputs.version')
    expect(JSON.stringify(steps)).not.toContain('github.event.inputs.version')
    expect(JSON.stringify(steps)).not.toContain('inputs.version')
  })

  test('build runs no git push', () => {
    for (const step of getSteps('build')) {
      expect(runOf(step)).not.toContain('git push')
    }
  })
})
