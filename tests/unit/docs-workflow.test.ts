import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

// Literal GitHub Actions expressions as they appear in the YAML (not JS templates).
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const GITHUB_TOKEN_EXPR = '${{ github.token }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const TAG_OUTPUT_EXPR = '${{ steps.target.outputs.tag }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const PROCEED_OUTPUT_EXPR = '${{ steps.target.outputs.proceed }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const EVENT_NAME_EXPR = '${{ github.event_name }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const RELEASE_TAG_EXPR = '${{ github.event.release.tag_name }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const INPUT_TAG_EXPR = '${{ github.event.inputs.tag }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const RELEASE_AUTHOR_EXPR = '${{ github.event.release.author.login }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const DEFAULT_BRANCH_EXPR = '${{ github.event.repository.default_branch }}'

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

  test('there is no workflow-level concurrency (it would cancel before admission)', () => {
    expect(readWorkflow()).not.toHaveProperty('concurrency')
  })

  test('only the deploy job serializes on docs-deploy, queueing every pending run without cancelling', () => {
    expect(getJob('deploy').concurrency).toEqual({
      group: 'docs-deploy',
      'cancel-in-progress': false,
      queue: 'max',
    })
  })

  test('the build job has no concurrency, so rejected runs cannot cancel a deployment', () => {
    expect(getJob('build')).not.toHaveProperty('concurrency')
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
  test('validation is delegated to scripts/validate-release-target.sh and requires the latest release', () => {
    const step = findStep(getSteps('build'), 'Validate release target')
    const env = asRecord(step.env, 'validate env')

    expect(step.id).toBe('target')
    expect(runOf(step)).toContain('validate-release-target.sh')
    // Docs only ever deploy the current latest release.
    expect(env.REQUIRE_LATEST).toBe('true')
    expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    expect(env.EVENT_NAME).toBe(EVENT_NAME_EXPR)
    expect(env.RELEASE_TAG).toBe(RELEASE_TAG_EXPR)
    expect(env.INPUT_TAG).toBe(INPUT_TAG_EXPR)
    expect(env.RELEASE_AUTHOR).toBe(RELEASE_AUTHOR_EXPR)
  })

  test('the expected author references RELEASE_AUTHOR_LOGIN with the mrbro-bot[bot] default', () => {
    const step = findStep(getSteps('build'), 'Validate release target')
    const expected = String(asRecord(step.env, 'validate env').EXPECTED_AUTHOR)

    expect(expected).toContain('vars.RELEASE_AUTHOR_LOGIN')
    expect(expected).toContain("'mrbro-bot[bot]'")
  })

  test('untrusted inputs reach the script through env, not inline interpolation', () => {
    for (const step of getSteps('build')) {
      if (step.name === 'Build registry') continue
      expect(runOf(step)).not.toContain('${{')
    }
  })

  test('the validator is fetched from the workflow commit by sparse checkout, before it runs', () => {
    const steps = getSteps('build')
    const fetch = findStep(steps, 'Fetch release target validator')
    const withBlock = asRecord(fetch.with, 'validator checkout with')

    expect(isCheckoutStep(fetch)).toBe(true)
    expect(withBlock.ref).toBe(DEFAULT_BRANCH_EXPR)
    expect(withBlock['sparse-checkout']).toBe(
      'scripts/validate-release-target.sh',
    )
    expect(withBlock['sparse-checkout-cone-mode']).toBe(false)
    expect(withBlock['persist-credentials']).toBe(false)
    // A separate path, so the later tag checkout is unaffected.
    expect(withBlock.path).toBeTruthy()
    expect(runOf(findStep(steps, 'Validate release target'))).toContain(
      String(withBlock.path),
    )
    expect(
      stepIndex(steps, (s) => s.name === 'Fetch release target validator', 'f'),
    ).toBeLessThan(
      stepIndex(steps, (s) => s.name === 'Validate release target', 'v'),
    )
  })

  test('validation and the npm check live in the script, and both come before the tag checkout', () => {
    const steps = getSteps('build')
    const checkout = stepIndex(
      steps,
      (s) => s.name === 'Checkout',
      'tag checkout',
    )
    expect(
      stepIndex(steps, (s) => s.name === 'Validate release target', 'v'),
    ).toBeLessThan(checkout)
    // No leftover inline gate steps.
    for (const name of [
      'Check release author',
      'Validate release tag',
      'Verify package is published to npm',
    ]) {
      expect(steps.some((s) => s.name === name)).toBe(false)
    }
  })

  test('every step after validation is gated on its proceed output', () => {
    const steps = getSteps('build')
    const validate = stepIndex(
      steps,
      (s) => s.name === 'Validate release target',
      'validate',
    )
    for (const step of steps.slice(validate + 1)) {
      expect(String(step.if ?? '')).toContain(
        "steps.target.outputs.proceed == 'true'",
      )
    }
  })

  test('the build job exposes proceed and tag from the validation step', () => {
    expect(asRecord(getJob('build').outputs, 'outputs')).toEqual({
      proceed: PROCEED_OUTPUT_EXPR,
      tag: TAG_OUTPUT_EXPR,
    })
  })

  test('build checks out the resolved tag without persisting credentials', () => {
    const checkout = findStep(getSteps('build'), 'Checkout')
    const withBlock = asRecord(checkout.with, 'checkout with')

    expect(isCheckoutStep(checkout)).toBe(true)
    expect(withBlock.ref).toBe(TAG_OUTPUT_EXPR)
    expect(withBlock['persist-credentials']).toBe(false)
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
    expect(runOf(registry)).toContain('steps.target.outputs.version')
    expect(JSON.stringify(steps)).not.toContain('github.event.inputs.version')
    expect(JSON.stringify(steps)).not.toContain('inputs.version')
  })

  test('build runs no git push', () => {
    for (const step of getSteps('build')) {
      expect(runOf(step)).not.toContain('git push')
    }
  })
})

describe('docs workflow deploy freshness (executed)', () => {
  const STEP_NAME = 'Deploy to fro-bot/systematic'

  const GH_STUB = `#!/usr/bin/env bash
echo "gh $* :: GH_TOKEN=\${GH_TOKEN:-}" >> "$STUB_LOG"
if [ "\${1:-}" = release ] && [ "\${2:-}" = view ]; then
  [ -z "\${STUB_LATEST_FAIL:-}" ] || exit 1
  printf '%s\\n' "\${STUB_LATEST-}"
  exit 0
fi
if [ "\${1:-}" = api ]; then
  echo 12345
  exit 0
fi
exit 0
`

  const GIT_STUB = `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
if [ "\${1:-}" = clone ]; then
  mkdir -p "\${@: -1}"
fi
if [ "\${1:-}" = diff-index ]; then
  exit 1
fi
exit 0
`

  interface Run {
    readonly status: number | null
    readonly output: string
    readonly calls: readonly string[]
  }

  function runDeploy(latest: { value?: string; fail?: boolean }): Run {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-deploy-'))
    try {
      const bin = path.join(cwd, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 })
      fs.writeFileSync(path.join(bin, 'git'), GIT_STUB, { mode: 0o755 })
      fs.mkdirSync(path.join(cwd, 'docs', 'dist'), { recursive: true })
      fs.writeFileSync(path.join(cwd, 'docs', 'dist', 'index.html'), 'ok')
      const log = path.join(cwd, 'stub.log')
      fs.writeFileSync(log, '')

      const result = spawnSync(
        'bash',
        ['-e', '-c', runOf(findStep(getSteps('deploy'), STEP_NAME))],
        {
          cwd,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: cwd,
            STUB_LOG: log,
            STUB_LATEST: latest.value ?? '',
            ...(latest.fail ? { STUB_LATEST_FAIL: '1' } : {}),
            DEPLOY_TAG: 'v1.0.0',
            SOURCE_GH_TOKEN: 'source-token',
            GH_TOKEN: 'app-token',
            APP_SLUG: 'fro-bot',
            GITHUB_REPOSITORY: 'marcusrbrown/systematic',
          },
        },
      )
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  const pushed = (r: Run) => r.calls.some((c) => c.startsWith('git push'))
  const cloned = (r: Run) => r.calls.some((c) => c.startsWith('git clone'))

  test('the deploy step receives a separate source-repo read-only token', () => {
    const env = asRecord(
      findStep(getSteps('deploy'), STEP_NAME).env,
      'deploy env',
    )
    expect(env.SOURCE_GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    expect(env.GH_TOKEN).not.toBe(GITHUB_TOKEN_EXPR)
  })

  test('a stale artifact (Latest moved on) is not published', () => {
    const r = runDeploy({ value: 'v2.0.0' })

    expect(r.status).toBe(0)
    expect(r.output).toContain('::notice::')
    expect(r.output).toContain('v2.0.0')
    expect(cloned(r)).toBe(false)
    expect(pushed(r)).toBe(false)
  })

  test('a fresh artifact (Latest equals DEPLOY_TAG) is published', () => {
    const r = runDeploy({ value: 'v1.0.0' })

    expect(r.status).toBe(0)
    expect(cloned(r)).toBe(true)
    expect(pushed(r)).toBe(true)
  })

  test('the freshness lookup uses the source token and the app token is kept for the deploy repo', () => {
    const r = runDeploy({ value: 'v1.0.0' })

    const lookup = r.calls.find((c) => c.startsWith('gh release view'))
    expect(lookup).toBeDefined()
    expect(lookup).toContain('--repo marcusrbrown/systematic')
    expect(lookup).toContain('--json tagName')
    expect(lookup).toContain('GH_TOKEN=source-token')
    const clone = r.calls.find((c) => c.startsWith('git clone'))
    expect(clone).toContain('app-token')
    expect(clone).toContain('fro-bot/systematic.git')
  })

  test('the freshness check happens before the clone', () => {
    const r = runDeploy({ value: 'v1.0.0' })

    const lookup = r.calls.findIndex((c) => c.startsWith('gh release view'))
    const clone = r.calls.findIndex((c) => c.startsWith('git clone'))
    expect(lookup).toBeGreaterThanOrEqual(0)
    expect(lookup).toBeLessThan(clone)
  })

  test('a failed latest lookup fails closed without publishing', () => {
    const r = runDeploy({ fail: true })

    expect(r.status).not.toBe(0)
    expect(cloned(r)).toBe(false)
    expect(pushed(r)).toBe(false)
  })

  test('an empty latest value fails closed without publishing', () => {
    const r = runDeploy({ value: '' })

    expect(pushed(r)).toBe(false)
  })
})

describe('docs workflow deploy artifact check', () => {
  const STEP_NAME = 'Verify docs artifact'

  function runCheck(setup: (dist: string) => void) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-artifact-'))
    try {
      const dist = path.join(cwd, 'docs', 'dist')
      fs.mkdirSync(dist, { recursive: true })
      setup(dist)
      return spawnSync(
        'bash',
        ['-c', runOf(findStep(getSteps('deploy'), STEP_NAME))],
        { cwd, encoding: 'utf8' },
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  test('the artifact check runs after download and before the App token is created', () => {
    const steps = getSteps('deploy')
    const check = stepIndex(steps, (s) => s.name === STEP_NAME, STEP_NAME)
    const download = stepIndex(
      steps,
      (s) => s.name === 'Download docs site',
      'download',
    )
    const token = stepIndex(
      steps,
      (s) => s.name === 'Create GitHub App token',
      'token',
    )

    expect(check).toBeGreaterThan(download)
    expect(check).toBeLessThan(token)
    expect(findStep(steps, STEP_NAME)).not.toHaveProperty('uses')
  })

  test('an artifact containing .git/config is rejected', () => {
    const result = runCheck((dist) => {
      fs.mkdirSync(path.join(dist, '.git'))
      fs.writeFileSync(
        path.join(dist, '.git', 'config'),
        '[core]\n\tfsmonitor = touch pwned\n',
      )
      fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>')
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('::error::')
  })

  test('a nested .git entry (directory or file) is rejected', () => {
    const nestedDir = runCheck((dist) => {
      fs.mkdirSync(path.join(dist, 'a', '.git'), { recursive: true })
    })
    const nestedFile = runCheck((dist) => {
      fs.mkdirSync(path.join(dist, 'a'))
      fs.writeFileSync(path.join(dist, 'a', '.git'), 'gitdir: ../elsewhere\n')
    })

    expect(nestedDir.status).not.toBe(0)
    expect(nestedFile.status).not.toBe(0)
  })

  test('a symlink is rejected', () => {
    const result = runCheck((dist) => {
      fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>')
      fs.symlinkSync('/etc/passwd', path.join(dist, 'link'))
    })

    expect(result.status).not.toBe(0)
  })

  test('a special file (FIFO) is rejected', () => {
    const result = runCheck((dist) => {
      spawnSync('mkfifo', [path.join(dist, 'pipe')])
    })

    expect(result.status).not.toBe(0)
  })

  test('.nojekyll and .well-known/ocx.json are accepted', () => {
    const result = runCheck((dist) => {
      fs.writeFileSync(path.join(dist, '.nojekyll'), '')
      fs.mkdirSync(path.join(dist, '.well-known'))
      fs.writeFileSync(path.join(dist, '.well-known', 'ocx.json'), '{}')
      fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>')
    })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  test('the copy into the deploy clone excludes .git', () => {
    const deploy = findStep(getSteps('deploy'), 'Deploy to fro-bot/systematic')
    expect(runOf(deploy)).toMatch(/--exclude[= ]'?\.git'?/)
    expect(runOf(deploy)).not.toContain('cp -r ../docs/dist/. .')
  })
})
