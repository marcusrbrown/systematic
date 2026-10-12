import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the shape of .github/workflows/release.yaml: the gated release
 * pipeline. Credentialed jobs (publish) run no repository code; repository
 * scripts run only in credential-free jobs (verify, build) that hand small
 * data artifacts to the publish job.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/release.yaml',
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
  // JSON_SCHEMA keeps the `on` key a string instead of YAML 1.1 boolean `true`.
  const { JSON_SCHEMA } = yaml
  return asRecord(yaml.load(readSource(), { schema: JSON_SCHEMA }), 'workflow')
}

function getJobs(): RecordValue {
  return asRecord(readWorkflow().jobs, 'jobs')
}

function getJob(id: string): RecordValue {
  const job = getJobs()[id]
  if (job === undefined) throw new Error(`job not found: ${id}`)
  return asRecord(job, `job ${id}`)
}

function getSteps(jobId: string): readonly RecordValue[] {
  return asArray(getJob(jobId).steps, `${jobId} steps`).map((step, i) =>
    asRecord(step, `${jobId} step ${i}`),
  )
}

function findStep(jobId: string, name: string): RecordValue {
  const step = getSteps(jobId).find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step not found: ${jobId} / ${name}`)
  return step
}

function indexOfStep(jobId: string, name: string): number {
  const index = getSteps(jobId).findIndex(
    (candidate) => candidate.name === name,
  )
  if (index === -1) throw new Error(`step not found: ${jobId} / ${name}`)
  return index
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

function envOf(step: RecordValue): RecordValue {
  return asRecord(step.env ?? {}, 'step env')
}

/** All `jobId / stepName` locations whose serialized step mentions `needle`. */
function stepsMentioning(needle: string): string[] {
  const hits: string[] = []
  for (const jobId of Object.keys(getJobs())) {
    for (const step of getSteps(jobId)) {
      if (JSON.stringify(step).includes(needle)) {
        hits.push(`${jobId} / ${String(step.name)}`)
      }
    }
  }
  return hits
}

/** Job-level (non-step) keys mentioning `needle`, e.g. job `env` or `with`. */
function jobLevelMentioning(needle: string): string[] {
  const hits: string[] = []
  for (const [jobId, job] of Object.entries(getJobs())) {
    const { steps: _steps, ...rest } = asRecord(job, jobId)
    if (JSON.stringify(rest).includes(needle)) hits.push(jobId)
  }
  return hits
}

function expr(inner: string): string {
  return `\${{ ${inner} }}`
}

const GITHUB_TOKEN_EXPR = expr('github.token')

const DIGEST_PIPELINE =
  /find dist -type f -print0 \| LC_ALL=C sort -z \| xargs -0 sha256sum \| sha256sum \| cut -d' ' -f1/

describe('release.yaml triggers and top-level settings', () => {
  test('triggers on push to main, hourly schedule, and dispatch without inputs', () => {
    const on = asRecord(readWorkflow().on, 'on')
    expect(Object.keys(on).sort()).toEqual([
      'push',
      'schedule',
      'workflow_dispatch',
    ])
    expect(asRecord(on.push, 'push').branches).toEqual(['main'])
    expect(on.schedule).toEqual([{ cron: '17 * * * *' }])
    const dispatch = on.workflow_dispatch
    expect(
      dispatch === null || dispatch === undefined || isRecord(dispatch),
    ).toBe(true)
    if (isRecord(dispatch)) expect(dispatch.inputs).toBeUndefined()
  })

  test('has empty top-level permissions and no top-level concurrency', () => {
    const workflow = readWorkflow()
    expect(workflow.permissions).toEqual({})
    expect(workflow.concurrency).toBeUndefined()
  })

  test('defines every pipeline job', () => {
    expect(Object.keys(getJobs())).toEqual(
      expect.arrayContaining([
        'mode',
        'verify',
        'build',
        'publish',
        'confirm',
        'render',
        'refresh',
      ]),
    )
  })

  test('build only runs in gated mode; verify adds the main-ref guard', () => {
    expect(getJob('build').if).toBe("needs.mode.outputs.mode == 'gated'")
    expect(getJob('verify').if).toBe(
      "needs.mode.outputs.mode == 'gated' && github.ref == 'refs/heads/main'",
    )
  })
})

describe('mode job', () => {
  test('has no permissions and exposes the mode output', () => {
    const job = getJob('mode')
    expect(job.permissions).toEqual({})
    expect(asRecord(job.outputs, 'outputs').mode).toBeDefined()
  })

  test('reads RELEASE_MODE from the repository variable', () => {
    const step = getSteps('mode').find((s) => runOf(s) !== '')
    expect(step).toBeDefined()
    expect(envOf(step as RecordValue).RELEASE_MODE).toBe(
      expr('vars.RELEASE_MODE'),
    )
  })

  function runModeScript(mode: string): { status: number | null; out: string } {
    const step = getSteps('mode').find((s) => runOf(s) !== '')
    const script = runOf(step as RecordValue)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-mode-'))
    try {
      const scriptPath = path.join(dir, 'step.sh')
      const outputPath = path.join(dir, 'github-output')
      fs.writeFileSync(scriptPath, script)
      fs.writeFileSync(outputPath, '')
      const result = spawnSync('bash', ['-e', scriptPath], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          RELEASE_MODE: mode,
          GITHUB_OUTPUT: outputPath,
        },
      })
      return {
        status: result.status,
        out: fs.readFileSync(outputPath, 'utf8') + result.stdout,
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test.each(['legacy', 'gated'])(
    'accepts exactly %p and sets the output',
    (mode) => {
      const result = runModeScript(mode)
      expect(result.status).toBe(0)
      expect(result.out).toContain(`mode=${mode}`)
    },
  )

  test.each(['', 'Gated', 'gated ', 'prod', ' legacy', 'legacy\n'])(
    'fails closed for %p',
    (mode) => {
      const result = runModeScript(mode)
      expect(result.status).toBe(1)
      expect(result.out).toContain(
        '::error::RELEASE_MODE must be exactly legacy or gated',
      )
      expect(result.out).not.toContain('mode=')
    },
  )
})

describe('verify job', () => {
  test('needs mode and has read-only permissions', () => {
    const job = getJob('verify')
    expect(job.needs).toBe('mode')
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      attestations: 'read',
    })
  })

  test('checks out full history at github.sha without persisting credentials', () => {
    const checkout = findStep('verify', 'Checkout')
    expect(String(checkout.uses)).toMatch(/^actions\/checkout@/)
    const withBlock = asRecord(checkout.with, 'with')
    expect(withBlock.ref).toBe(expr('github.sha'))
    expect(withBlock['fetch-depth']).toBe(0)
    expect(withBlock['persist-credentials']).toBe(false)
  })

  test('installs with a frozen lockfile and runs verify-merge per contract', () => {
    expect(runOf(findStep('verify', 'Install dependencies'))).toBe(
      'bun install --frozen-lockfile',
    )
    const step = findStep('verify', 'Verify release merge')
    const run = runOf(step)
    expect(run).toContain(
      'bun scripts/release/verify-merge.ts --sha "$GITHUB_SHA" --out "$RUNNER_TEMP/decision"',
    )
    expect(run).toContain('jq')
    expect(run).toContain('decision.json')
    expect(envOf(step).GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    expect(envOf(step).RELEASE_HOLD).toBe(expr('vars.RELEASE_HOLD'))
  })

  test('exposes kind and version outputs from the decision step', () => {
    const step = findStep('verify', 'Verify release merge')
    const id = String(step.id)
    expect(id).not.toBe('undefined')
    const outputs = asRecord(getJob('verify').outputs, 'outputs')
    expect(outputs.kind).toBe(expr(`steps.${id}.outputs.kind`))
    expect(outputs.version).toBe(expr(`steps.${id}.outputs.version`))
  })

  test('uploads the release-decision artifact even when verification fails', () => {
    const step = findStep('verify', 'Upload release decision')
    expect(String(step.uses)).toMatch(/^actions\/upload-artifact@/)
    expect(step.if).toBe('always()')
    const withBlock = asRecord(step.with, 'with')
    expect(withBlock.name).toBe('release-decision')
    expect(withBlock.path).toBe(`${expr('runner.temp')}/decision`)
  })
})

describe('build job', () => {
  test('needs mode and only reads contents', () => {
    const job = getJob('build')
    expect(job.needs).toBe('mode')
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  test('builds from a credential-free checkout at github.sha', () => {
    const checkout = findStep('build', 'Checkout')
    const withBlock = asRecord(checkout.with, 'with')
    expect(withBlock.ref).toBe(expr('github.sha'))
    expect(withBlock['persist-credentials']).toBe(false)
    expect(runOf(findStep('build', 'Install dependencies'))).toBe(
      'bun install --frozen-lockfile',
    )
    expect(runOf(findStep('build', 'Build'))).toBe('bun run build')
  })

  test('computes the dist digest and exposes it as dist-sha256', () => {
    const step = findStep('build', 'Compute dist digest')
    expect(runOf(step)).toMatch(DIGEST_PIPELINE)
    const id = String(step.id)
    expect(id).not.toBe('undefined')
    const outputs = asRecord(getJob('build').outputs, 'outputs')
    expect(outputs['dist-sha256']).toBe(expr(`steps.${id}.outputs.dist-sha256`))
    expect(runOf(step)).toContain('dist-sha256=')
    expect(runOf(step)).toContain('$GITHUB_OUTPUT')
  })

  test('uploads dist/ as release-dist', () => {
    const step = findStep('build', 'Upload dist')
    expect(String(step.uses)).toMatch(/^actions\/upload-artifact@/)
    const withBlock = asRecord(step.with, 'with')
    expect(withBlock.name).toBe('release-dist')
    expect(withBlock.path).toBe('dist/')
  })
})

describe('publish job', () => {
  test('is gated on mode == gated and a publish decision', () => {
    const job = getJob('publish')
    expect(job.needs).toEqual(['mode', 'verify', 'build'])
    expect(String(job.if)).toContain("needs.mode.outputs.mode == 'gated'")
    expect(String(job.if)).toContain("needs.verify.outputs.kind == 'publish'")
  })

  test('uses the release environment and the release-state concurrency group', () => {
    const job = getJob('publish')
    expect(job.environment).toBe('release')
    expect(job.concurrency).toEqual({
      group: 'release-state',
      'cancel-in-progress': false,
    })
  })

  test('has only contents:read and id-token:write', () => {
    expect(getJob('publish').permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    })
  })

  test('runs its steps in the specified order', () => {
    const order = [
      'Checkout',
      'Verify main tip is the release merge',
      'Setup Node.js',
      'Require npm >= 11.5.1',
      'Setup Bun',
      'Install dependencies',
      'Download dist',
      'Download release decision',
      'Verify dist digest',
      'Stage release inputs',
      'Create release App token',
      'Recheck release hold',
      'Publish with semantic-release',
    ]
    const indices = order.map((name) => indexOfStep('publish', name))
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(getSteps('publish')).toHaveLength(order.length)
  })

  test('checks out full history at github.sha without persisting credentials', () => {
    const withBlock = asRecord(findStep('publish', 'Checkout').with, 'with')
    expect(withBlock.ref).toBe(expr('github.sha'))
    expect(withBlock['fetch-depth']).toBe(0)
    expect(withBlock['persist-credentials']).toBe(false)
  })

  test('aborts when main moved past the release merge', () => {
    const step = findStep('publish', 'Verify main tip is the release merge')
    const run = runOf(step)
    expect(run).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha',
    )
    expect(run).toContain('$GITHUB_SHA')
    expect(run).toContain(
      '::error::superseded: main moved past the release merge',
    )
    expect(run).toContain('exit 1')
    expect(envOf(step).GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
  })

  test('sets up Node 24 without registry-url and requires npm >= 11.5.1', () => {
    const node = findStep('publish', 'Setup Node.js')
    expect(String(node.uses)).toMatch(/^actions\/setup-node@/)
    const withBlock = asRecord(node.with, 'with')
    expect(withBlock['node-version']).toBe(24)
    expect(withBlock['registry-url']).toBeUndefined()
    const run = runOf(findStep('publish', 'Require npm >= 11.5.1'))
    expect(run).toContain('npm --version')
    expect(run).toContain('11.5.1')
  })

  test('installs with a frozen lockfile and without lifecycle scripts', () => {
    const run = runOf(findStep('publish', 'Install dependencies'))
    expect(run).toContain('--frozen-lockfile')
    expect(run).toContain('--ignore-scripts')
  })

  test('downloads artifacts and recomputes the dist digest', () => {
    const dist = findStep('publish', 'Download dist')
    expect(String(dist.uses)).toMatch(/^actions\/download-artifact@/)
    expect(asRecord(dist.with, 'with')).toMatchObject({
      name: 'release-dist',
      path: 'dist/',
    })
    const decision = findStep('publish', 'Download release decision')
    expect(String(decision.uses)).toMatch(/^actions\/download-artifact@/)
    expect(asRecord(decision.with, 'with').name).toBe('release-decision')

    const verify = findStep('publish', 'Verify dist digest')
    expect(runOf(verify)).toMatch(DIGEST_PIPELINE)
    expect(JSON.stringify(verify)).toContain('needs.build.outputs.dist-sha256')
    expect(runOf(verify)).toContain('exit 1')
  })

  test('uses the same digest pipeline in build and publish', () => {
    const build = DIGEST_PIPELINE.exec(
      runOf(findStep('build', 'Compute dist digest')),
    )
    const publish = DIGEST_PIPELINE.exec(
      runOf(findStep('publish', 'Verify dist digest')),
    )
    expect(build).not.toBeNull()
    expect(publish).not.toBeNull()
    expect(publish?.[0]).toBe(build?.[0])
  })

  test('stages the approved notes and swaps in the gated config', () => {
    expect(runOf(findStep('publish', 'Stage release inputs')).trim()).toBe(
      'mkdir -p .release && cp "$RUNNER_TEMP/decision/notes.md" .release/notes.md && rm -f .releaserc.yaml && cp "$RUNNER_TEMP/decision/releaserc.json" .releaserc.json',
    )
  })

  test('mints the App token from the release secrets', () => {
    const step = findStep('publish', 'Create release App token')
    expect(step.id).toBe('app-token')
    expect(step.uses).toBe(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    )
    expect(asRecord(step.with, 'with')).toMatchObject({
      'app-id': expr('secrets.RELEASE_APP_ID'),
      'private-key': expr('secrets.RELEASE_APP_PRIVATE_KEY'),
    })
  })

  test('runs semantic-release with the credentials only on that step', () => {
    const step = findStep('publish', 'Publish with semantic-release')
    expect(runOf(step).trim()).toBe('npx --no-install semantic-release --ci')
    expect(envOf(step)).toEqual({
      GITHUB_TOKEN: expr('steps.app-token.outputs.token'),
      GH_TOKEN: expr('steps.app-token.outputs.token'),
      NPM_TOKEN: expr('secrets.NPM_TOKEN'),
      npm_config_ignore_scripts: 'true',
    })
  })

  describe('recheck release hold step (executed)', () => {
    const HOLD_STEP = 'Recheck release hold'
    const HOLD_ERROR =
      '::error::RELEASE_HOLD is set; only a maintainer approval can publish.'
    const READ_ERROR =
      '::error::Could not read RELEASE_HOLD; refusing to publish.'

    type HoldApi =
      | { kind: 'value'; value: string }
      | { kind: 'not-found' }
      | { kind: 'error' }

    function runHold(api: HoldApi, decision: Record<string, unknown> | null) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-hold-'))
      try {
        const bin = path.join(dir, 'bin')
        const runner = path.join(dir, 'runner')
        fs.mkdirSync(bin)
        fs.mkdirSync(path.join(runner, 'decision'), { recursive: true })
        if (decision !== null) {
          fs.writeFileSync(
            path.join(runner, 'decision', 'decision.json'),
            JSON.stringify(decision),
          )
        }
        const log = path.join(dir, 'gh.log')
        fs.writeFileSync(log, '')
        writeExecutable(
          path.join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            'echo "gh $*" >> "$STUB_LOG"',
            'echo "token=$GH_TOKEN" >> "$STUB_LOG"',
            'case "$STUB_MODE" in',
            '  value) printf \'%s\\n\' "$STUB_VALUE" ;;',
            '  not-found) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
            '  *) echo "gh: Internal Server Error (HTTP 500)" >&2; exit 1 ;;',
            'esac',
            '',
          ].join('\n'),
        )
        const result = spawnSync(
          'bash',
          ['-e', '-c', runOf(findStep('publish', HOLD_STEP))],
          {
            encoding: 'utf8',
            env: {
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              HOME: dir,
              RUNNER_TEMP: runner,
              GH_TOKEN: 'app-token',
              REPO: 'o/r',
              STUB_LOG: log,
              STUB_MODE: api.kind,
              STUB_VALUE: api.kind === 'value' ? api.value : '',
            },
          },
        )
        return {
          status: result.status,
          text: `${result.stdout}${result.stderr}`,
          log: fs.readFileSync(log, 'utf8'),
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    const held: HoldApi = { kind: 'value', value: 'true' }

    test('reads the live hold with the App token, not the job-start vars snapshot', () => {
      const step = findStep('publish', HOLD_STEP)
      expect(envOf(step)).toEqual({
        GH_TOKEN: expr('steps.app-token.outputs.token'),
        REPO: expr('github.repository'),
      })
      expect(JSON.stringify(step)).not.toContain('vars.RELEASE_HOLD')
      expect(runOf(step)).toContain(
        'gh api "repos/$REPO/actions/variables/RELEASE_HOLD" --jq .value',
      )
    })

    test('runs after the App token step and directly before semantic-release', () => {
      const hold = indexOfStep('publish', HOLD_STEP)
      expect(hold).toBeGreaterThan(
        indexOfStep('publish', 'Create release App token'),
      )
      expect(hold).toBe(
        indexOfStep('publish', 'Publish with semantic-release') - 1,
      )
    })

    test('queries the variable API with the App token', () => {
      const r = runHold(held, { approver: 'maintainer' })
      expect(r.log).toContain(
        'gh api repos/o/r/actions/variables/RELEASE_HOLD --jq .value',
      )
      expect(r.log).toContain('token=app-token')
    })

    test.each([
      ['gate', { kind: 'publish', approver: 'gate' }],
      ['an unknown approver', { kind: 'publish', approver: 'robot' }],
      ['no approver', { kind: 'publish' }],
      ['an empty approver', { kind: 'publish', approver: '' }],
      ['an empty decision', {}],
    ])(
      'a held variable with %s exits 1 with the hold error',
      (_name, decision) => {
        const r = runHold(held, decision)
        expect(r.status).toBe(1)
        expect(r.text).toContain(HOLD_ERROR)
      },
    )

    test('a held variable with a missing decision file fails closed', () => {
      expect(runHold(held, null).status).not.toBe(0)
    })

    test('a held variable lets a maintainer approval through', () => {
      expect(runHold(held, { approver: 'maintainer' }).status).toBe(0)
    })

    test('an unset variable (HTTP 404) does not hold a gate approval', () => {
      const r = runHold({ kind: 'not-found' }, { approver: 'gate' })
      expect(r.status).toBe(0)
      expect(r.text).not.toContain('::error::')
    })

    test.each(['', 'false', 'True'])(
      'a variable of %j does not hold a gate approval',
      (value) => {
        expect(
          runHold({ kind: 'value', value }, { approver: 'gate' }).status,
        ).toBe(0)
      },
    )

    test.each([
      ['gate', { approver: 'gate' }],
      ['maintainer', { approver: 'maintainer' }],
    ])(
      'any other API failure fails closed even for a %s approval',
      (_name, decision) => {
        const r = runHold({ kind: 'error' }, decision)
        expect(r.status).toBe(1)
        expect(r.text).toContain(READ_ERROR)
        expect(r.text).not.toContain(HOLD_ERROR)
      },
    )
  })

  test('runs no repository code', () => {
    for (const step of getSteps('publish')) {
      const run = runOf(step)
      expect(run).not.toContain('bun run')
      expect(run).not.toContain('bun scripts/')
      expect(run).not.toContain('scripts/')
    }
  })
})

describe('secrets and environments', () => {
  test('only the credentialed act jobs use environment: release', () => {
    const withEnvironment = Object.entries(getJobs())
      .filter(([, job]) => asRecord(job, 'job').environment !== undefined)
      .map(([id]) => id)
    expect(withEnvironment).toEqual(['publish', 'refresh'])
    for (const id of withEnvironment) {
      expect(getJob(id).environment).toBe('release')
    }
  })

  test('NPM_TOKEN appears only in the semantic-release step env', () => {
    expect(stepsMentioning('NPM_TOKEN')).toEqual([
      'publish / Publish with semantic-release',
    ])
    expect(jobLevelMentioning('NPM_TOKEN')).toEqual([])
    expect(readWorkflow().env).toBeUndefined()
  })

  test('release App secrets appear only in the App token steps', () => {
    for (const secret of ['RELEASE_APP_ID', 'RELEASE_APP_PRIVATE_KEY']) {
      expect(stepsMentioning(secret)).toEqual([
        'publish / Create release App token',
        'refresh / Create release App token',
      ])
      expect(jobLevelMentioning(secret)).toEqual([])
    }
  })

  test('only publish can mint an OIDC token', () => {
    for (const [id, job] of Object.entries(getJobs())) {
      const permissions = asRecord(
        asRecord(job, id).permissions ?? {},
        `${id} permissions`,
      )
      if (id === 'publish') {
        expect(permissions['id-token']).toBe('write')
      } else {
        expect(permissions['id-token']).toBeUndefined()
      }
    }
  })

  test('verify and build have no write permission', () => {
    for (const id of ['verify', 'build']) {
      const permissions = asRecord(getJob(id).permissions, `${id} permissions`)
      expect(Object.values(permissions).every((v) => v === 'read')).toBe(true)
    }
  })
})

describe('confirm job', () => {
  test('runs after a successful publish with read-only permissions', () => {
    const job = getJob('confirm')
    expect(job.needs).toEqual(['verify', 'publish'])
    expect(job.if).toBe("needs.publish.result == 'success'")
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  test('checks out nothing and installs nothing', () => {
    for (const step of getSteps('confirm')) {
      expect(String(step.uses ?? '')).not.toMatch(/checkout|setup-/)
      expect(runOf(step)).not.toMatch(/bun |scripts\//)
    }
  })

  test('asserts the npm version, trusted-publishing provenance, tag and release author', () => {
    const steps = getSteps('confirm')
    const run = steps.map(runOf).join('\n')
    const env = Object.assign({}, ...steps.map(envOf))
    expect(env.VERSION).toBe(expr('needs.verify.outputs.version'))
    expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)

    expect(run).toContain('npm view "@fro.bot/systematic@$VERSION" version')
    expect(run).toContain(
      'npm view "@fro.bot/systematic@$VERSION" _npmUser --json',
    )
    expect(run).toContain('npm-oidc-no-reply@github.com')
    expect(run).toContain(
      '::error::published with a token, not trusted publishing',
    )
    expect(run).toContain('git/ref/tags/v$VERSION')
    expect(run).toContain('author.login')
    expect(JSON.stringify(steps)).toContain(
      "vars.RELEASE_AUTHOR_LOGIN || 'systematic-release[bot]'",
    )
    expect(run).toContain('GITHUB_STEP_SUMMARY')
  })
})

describe('job timeouts', () => {
  test.each([
    ['publish', 20],
    ['refresh', 10],
    ['confirm', 10],
    ['verify', 10],
  ])('%s declares timeout-minutes %d', (id, minutes) => {
    expect(getJob(id)['timeout-minutes']).toBe(minutes)
  })
})

describe('ref guard', () => {
  test.each(['verify', 'publish', 'refresh'])(
    '%s only runs on refs/heads/main and keeps its other conditions',
    (id) => {
      expect(String(getJob(id).if)).toContain("github.ref == 'refs/heads/main'")
      expect(String(getJob(id).if)).toContain(
        "needs.mode.outputs.mode == 'gated'",
      )
    },
  )

  test('the other conditions of each guarded job are kept', () => {
    expect(String(getJob('publish').if)).toContain(
      "needs.verify.outputs.kind == 'publish'",
    )
    expect(String(getJob('refresh').if)).toContain(
      "needs.render.result == 'success'",
    )
  })
})

describe('release App login', () => {
  test('the verify step sets RELEASE_APP_LOGIN from the one shared variable', () => {
    expect(envOf(findStep('verify', 'Verify release merge'))).toMatchObject({
      RELEASE_APP_LOGIN: expr(
        "vars.RELEASE_AUTHOR_LOGIN || 'systematic-release[bot]'",
      ),
    })
  })
})

describe('action pins', () => {
  test('every uses: reference is pinned to a 40-hex commit SHA', () => {
    let count = 0
    for (const jobId of Object.keys(getJobs())) {
      for (const step of getSteps(jobId)) {
        if (step.uses === undefined) continue
        count++
        expect(String(step.uses)).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      }
    }
    expect(count).toBeGreaterThan(0)
  })

  test('pinned SHAs carry a version comment in the source', () => {
    const lines = readSource()
      .split('\n')
      .filter((line) => /\buses:\s/.test(line))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/)
    }
  })
})

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 })
}

function initGitRepo(dir: string): string {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const run = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  run('init', '-b', 'main')
  run('config', 'user.name', 'Fixture')
  run('config', 'user.email', 'fixture@example.com')
  run('config', 'commit.gpgsign', 'false')
  run('commit', '--allow-empty', '-m', 'chore: initial')
  return run('rev-parse', 'HEAD')
}

describe('render job', () => {
  test('is credential-free: contents:read only and no secrets', () => {
    const job = getJob('render')
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(job.environment).toBeUndefined()
    expect(job.concurrency).toBeUndefined()
    expect(JSON.stringify(job)).not.toContain('secrets.')
  })

  test('runs after publish unless publish failed or was cancelled', () => {
    const job = getJob('render')
    expect(job.needs).toEqual(['mode', 'publish'])
    const condition = String(job.if)
    expect(condition).toContain('always()')
    expect(condition).toContain("needs.mode.result == 'success'")
    expect(condition).toContain("needs.publish.result != 'failure'")
    expect(condition).toContain("needs.publish.result != 'cancelled'")
  })

  test('checks out the current main tip with tags, not github.sha', () => {
    const withBlock = asRecord(findStep('render', 'Checkout').with, 'with')
    expect(withBlock.ref).toBe('main')
    expect(withBlock['fetch-depth']).toBe(0)
    expect(withBlock['fetch-tags']).toBe(true)
    expect(withBlock['persist-credentials']).toBe(false)
  })

  test('installs with a frozen lockfile and runs render.ts per contract', () => {
    expect(runOf(findStep('render', 'Install dependencies'))).toBe(
      'bun install --frozen-lockfile',
    )
    expect(runOf(findStep('render', 'Render release'))).toContain(
      'bun scripts/release/render.ts --sha HEAD --out "$RUNNER_TEMP/render"',
    )
  })

  test('exposes kind, version, title and base-sha outputs', () => {
    const id = String(findStep('render', 'Render release').id)
    expect(id).not.toBe('undefined')
    const outputs = asRecord(getJob('render').outputs, 'outputs')
    expect(outputs).toEqual({
      kind: expr(`steps.${id}.outputs.kind`),
      version: expr(`steps.${id}.outputs.version`),
      title: expr(`steps.${id}.outputs.title`),
      'base-sha': expr(`steps.${id}.outputs.base-sha`),
    })
  })

  test('uploads the release-render artifact', () => {
    const step = findStep('render', 'Upload rendered release')
    expect(String(step.uses)).toMatch(/^actions\/upload-artifact@/)
    expect(asRecord(step.with, 'with')).toMatchObject({
      name: 'release-render',
      path: `${expr('runner.temp')}/render`,
    })
  })

  describe('render script', () => {
    interface RenderRun {
      status: number | null
      output: string
      stderr: string
    }

    function runRender(renderJson: string): RenderRun {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-render-'))
      try {
        const bin = path.join(dir, 'bin')
        const repo = path.join(dir, 'repo')
        const runner = path.join(dir, 'runner')
        fs.mkdirSync(bin)
        fs.mkdirSync(repo)
        fs.mkdirSync(runner)
        initGitRepo(repo)
        // Stub bun: write the canned render.json into the --out directory.
        writeExecutable(
          path.join(bin, 'bun'),
          [
            '#!/usr/bin/env bash',
            'while [ $# -gt 0 ]; do',
            '  if [ "$1" = "--out" ]; then out="$2"; fi',
            '  shift',
            'done',
            'mkdir -p "$out"',
            'printf \'%s\' "$STUB_RENDER_JSON" > "$out/render.json"',
            '',
          ].join('\n'),
        )
        const scriptPath = path.join(dir, 'step.sh')
        const outputPath = path.join(dir, 'github-output')
        fs.writeFileSync(
          scriptPath,
          runOf(findStep('render', 'Render release')),
        )
        fs.writeFileSync(outputPath, '')
        const result = spawnSync('bash', ['-e', scriptPath], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: dir,
            RUNNER_TEMP: runner,
            GITHUB_OUTPUT: outputPath,
            STUB_RENDER_JSON: renderJson,
          },
        })
        return {
          status: result.status,
          output: fs.readFileSync(outputPath, 'utf8'),
          stderr: result.stdout + result.stderr,
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    test('exports a well-formed release title and version', () => {
      const sha = 'a'.repeat(40)
      const result = runRender(
        JSON.stringify({
          kind: 'release',
          version: '3.22.0',
          title: 'chore(release): v3.22.0',
          baseSha: sha,
        }),
      )
      expect(result.status).toBe(0)
      const lines = result.output.trim().split('\n')
      expect(lines).toContain('kind=release')
      expect(lines).toContain('version=3.22.0')
      expect(lines).toContain('title=chore(release): v3.22.0')
      expect(lines).toContain(`base-sha=${sha}`)
      const title = lines.find((l) => l.startsWith('title='))?.slice(6)
      expect(title).toMatch(/^chore\(release\): v\d+\.\d+\.\d+$/)
    })

    test.each([
      'chore(release): v3.22',
      'chore(release): v3.22.0; echo pwned',
      'feat: v3.22.0',
      'chore(release): v3.22.0\nmore',
    ])('refuses a malformed title %p', (title) => {
      const result = runRender(
        JSON.stringify({
          kind: 'release',
          version: '3.22.0',
          title,
          baseSha: 'a'.repeat(40),
        }),
      )
      expect(result.status).not.toBe(0)
      expect(result.output).not.toContain('title=')
    })

    test('refuses a title that disagrees with the version', () => {
      const result = runRender(
        JSON.stringify({
          kind: 'release',
          version: '3.22.0',
          title: 'chore(release): v9.9.9',
          baseSha: 'a'.repeat(40),
        }),
      )
      expect(result.status).not.toBe(0)
    })

    test('for none, exports kind and falls back to the checked-out HEAD', () => {
      const result = runRender(JSON.stringify({ kind: 'none' }))
      expect(result.status).toBe(0)
      const lines = result.output.trim().split('\n')
      expect(lines).toContain('kind=none')
      expect(lines.some((l) => /^base-sha=[0-9a-f]{40}$/.test(l))).toBe(true)
    })
  })

  test('writes the dark-launch preview to the job summary', () => {
    const step = findStep('render', 'Write job summary')
    const run = runOf(step)
    expect(run).toContain('GITHUB_STEP_SUMMARY')
    expect(run).toContain('Nothing releasable.')
    expect(run).toContain('body.md')

    for (const [kind, expectation] of [
      ['release', 'chore(release): v3.22.0 body text'],
      ['none', 'Nothing releasable.'],
    ] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-summary-'))
      try {
        const render = path.join(dir, 'render')
        fs.mkdirSync(render)
        fs.writeFileSync(
          path.join(render, 'body.md'),
          'chore(release): v3.22.0 body text\n',
        )
        const scriptPath = path.join(dir, 'step.sh')
        const summary = path.join(dir, 'summary.md')
        fs.writeFileSync(scriptPath, run)
        fs.writeFileSync(summary, '')
        const result = spawnSync('bash', ['-e', scriptPath], {
          cwd: dir,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: summary,
            KIND: kind,
            VERSION: '3.22.0',
          },
        })
        expect(result.status).toBe(0)
        expect(fs.readFileSync(summary, 'utf8')).toContain(expectation)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

describe('refresh job', () => {
  const REFRESH_STEP = 'Refresh release PR'
  const BOT = 'systematic-release[bot]'
  const BASE = 'b'.repeat(40)

  test('is gated on gated mode and a successful render', () => {
    const job = getJob('refresh')
    expect(job.needs).toEqual(['mode', 'render'])
    expect(String(job.if)).toContain("needs.mode.outputs.mode == 'gated'")
    expect(String(job.if)).toContain("needs.render.result == 'success'")
  })

  test('uses the release environment and the release-state group', () => {
    const job = getJob('refresh')
    expect(job.environment).toBe('release')
    expect(job.concurrency).toEqual({
      group: 'release-state',
      'cancel-in-progress': false,
    })
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  test('runs no repository code: no checkout, bun, install or scripts/', () => {
    for (const step of getSteps('refresh')) {
      expect(String(step.uses ?? '')).not.toMatch(/checkout|setup-/)
      const run = runOf(step)
      expect(run).not.toMatch(/\bbun\b/)
      expect(run).not.toContain('scripts/')
      expect(run).not.toMatch(/npm (ci|install)/)
    }
  })

  test('downloads release-render and mints the App token before refreshing', () => {
    const download = findStep('refresh', 'Download rendered release')
    expect(String(download.uses)).toMatch(/^actions\/download-artifact@/)
    expect(asRecord(download.with, 'with')).toMatchObject({
      name: 'release-render',
      path: `${expr('runner.temp')}/render`,
    })
    const token = findStep('refresh', 'Create release App token')
    expect(token.id).toBe('app-token')
    expect(indexOfStep('refresh', 'Create release App token')).toBeLessThan(
      indexOfStep('refresh', REFRESH_STEP),
    )
  })

  test('passes the App token and render outputs as step env', () => {
    const env = envOf(findStep('refresh', REFRESH_STEP))
    expect(env).toMatchObject({
      GH_TOKEN: expr('steps.app-token.outputs.token'),
      KIND: expr('needs.render.outputs.kind'),
      VERSION: expr('needs.render.outputs.version'),
      TITLE: expr('needs.render.outputs.title'),
      BASE_SHA: expr('needs.render.outputs.base-sha'),
      REPO: expr('github.repository'),
    })
    expect(JSON.stringify(env)).toContain(
      "vars.RELEASE_AUTHOR_LOGIN || 'systematic-release[bot]'",
    )
  })

  test('never puts the PR body on the command line and pins the merge head', () => {
    const run = runOf(findStep('refresh', REFRESH_STEP))
    expect(run).toContain('--body-file')
    expect(run).not.toMatch(/--body(?!-file)\s+(?!"")\S/)
    expect(run).toContain('--match-head-commit')
    expect(run).toContain('--auto')
    expect(run).toContain('--squash')
  })

  test('uses the Git Data API with no explicit author or committer', () => {
    const run = runOf(findStep('refresh', REFRESH_STEP))
    for (const endpoint of [
      'git/blobs',
      'git/trees',
      'git/commits',
      'git/refs',
    ]) {
      expect(run).toContain(endpoint)
    }
    expect(run).not.toMatch(/\bauthor\b\s*:|\bcommitter\b\s*:/)
    expect(run).not.toMatch(/-f\s+(author|committer)/)
  })

  describe('refresh script (stub gh)', () => {
    interface Scenario {
      kind?: 'release' | 'none'
      tip?: string
      prs?: unknown[]
      parent?: string
      remoteBlob?: string
      refCount?: number
      mergeFails?: boolean
      treeMatchesBase?: boolean
    }

    interface Outcome {
      status: number | null
      log: string
      output: string
      localBlob: string
    }

    const CHANGELOG = '# Changelog\n\n## 3.22.0\n\n* a change\n'

    function pr(overrides: Record<string, unknown> = {}): unknown {
      return {
        number: 9,
        headRefOid: 'c'.repeat(40),
        author: { login: BOT, is_bot: true },
        headRepositoryOwner: { login: 'o' },
        ...overrides,
      }
    }

    function scenarioEnv(
      scenario: Scenario,
      localBlob: string,
    ): Record<string, string> {
      return {
        STUB_TIP: scenario.tip ?? BASE,
        STUB_PRS: JSON.stringify(scenario.prs ?? []),
        STUB_PARENT: scenario.parent ?? BASE,
        STUB_REMOTE_BLOB: scenario.remoteBlob ?? localBlob,
        STUB_REF_COUNT: String(scenario.refCount ?? 0),
        STUB_MERGE_FAIL: scenario.mergeFails ? '1' : '',
        STUB_TREE_SHA: scenario.treeMatchesBase ? 'basetree' : 'treesha',
      }
    }

    function runRefresh(scenario: Scenario = {}): Outcome {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-refresh-'))
      try {
        const bin = path.join(dir, 'bin')
        const runner = path.join(dir, 'runner')
        const render = path.join(runner, 'render')
        const work = path.join(dir, 'work')
        for (const d of [bin, render, work])
          fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(render, 'CHANGELOG.md'), CHANGELOG)
        fs.writeFileSync(
          path.join(render, 'body.md'),
          'PR body $(echo pwned)\n',
        )
        fs.writeFileSync(
          path.join(render, 'render.json'),
          JSON.stringify({ kind: scenario.kind ?? 'release' }),
        )

        const log = path.join(dir, 'gh.log')
        fs.writeFileSync(log, '')
        writeExecutable(
          path.join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            'echo "gh $*" >> "$STUB_LOG"',
            'prev=""',
            'for a in "$@"; do',
            '  if [ "$prev" = "--input" ]; then echo "  input: $(cat "$a")" >> "$STUB_LOG"; fi',
            '  prev="$a"',
            'done',
            'args="$*"',
            'case "$args" in',
            '  "pr list "*) printf \'%s\' "$STUB_PRS" ;;',
            '  "pr create "*) echo "https://github.com/o/r/pull/7" ;;',
            '  "pr merge "*) if [ -n "$STUB_MERGE_FAIL" ]; then exit 1; fi ;;',
            '  "pr "*) ;;',
            '  *"git/ref/heads/main"*) printf \'%s\\n\' "$STUB_TIP" ;;',
            '  *"matching-refs"*) printf \'%s\\n\' "$STUB_REF_COUNT" ;;',
            '  *"contents/CHANGELOG.md"*) printf \'%s\\n\' "$STUB_REMOTE_BLOB" ;;',
            '  *"git/commits/"*) echo basetree ;;',
            '  *"/commits/"*) printf \'%s\\n\' "$STUB_PARENT" ;;',
            '  *"git/blobs"*) echo blobsha ;;',
            '  *"git/trees"*) printf \'%s\\n\' "$STUB_TREE_SHA" ;;',
            '  *"git/commits"*) echo newcommitsha ;;',
            '  *"git/refs"*) ;;',
            '  *) echo "unexpected gh call: $args" >&2; exit 99 ;;',
            'esac',
            '',
          ].join('\n'),
        )

        const scriptPath = path.join(dir, 'step.sh')
        const outputPath = path.join(dir, 'github-output')
        fs.writeFileSync(scriptPath, runOf(findStep('refresh', REFRESH_STEP)))
        fs.writeFileSync(outputPath, '')

        const hash = spawnSync(
          'git',
          ['hash-object', path.join(render, 'CHANGELOG.md')],
          { cwd: work, encoding: 'utf8' },
        )
        const localBlob = hash.stdout.trim()

        const result = spawnSync('bash', ['-e', scriptPath], {
          cwd: work,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: dir,
            RUNNER_TEMP: runner,
            GITHUB_OUTPUT: outputPath,
            GH_TOKEN: 'app-token',
            KIND: scenario.kind ?? 'release',
            VERSION: '3.22.0',
            TITLE: 'chore(release): v3.22.0',
            BASE_SHA: BASE,
            REPO: 'o/r',
            BOT_LOGIN: BOT,
            STUB_LOG: log,
            ...scenarioEnv(scenario, localBlob),
            MERGE_RETRY_DELAY: '0',
          },
        })
        return {
          status: result.status,
          log: fs.readFileSync(log, 'utf8'),
          output: result.stdout + result.stderr,
          localBlob,
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    const WRITE = /pr (create|edit|close|merge)|--method|git\/refs/

    test('exits quietly without writing when main moved', () => {
      const outcome = runRefresh({ tip: 'f'.repeat(40) })
      expect(outcome.status).toBe(0)
      expect(outcome.output).toContain(
        '::notice::main moved; a newer run will refresh',
      )
      expect(outcome.log).not.toMatch(WRITE)
    })

    test('KIND=none with an open PR comments and closes it', () => {
      const outcome = runRefresh({ kind: 'none', prs: [pr()] })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/pr close 9 .*--repo o\/r/)
      expect(outcome.log).toContain('Nothing releasable on main; closing.')
      expect(outcome.log).not.toMatch(
        /pr (create|edit|merge)|git\/refs|git\/blobs/,
      )
    })

    test('KIND=none with no PR does nothing', () => {
      const outcome = runRefresh({ kind: 'none' })
      expect(outcome.status).toBe(0)
      expect(outcome.log).not.toMatch(WRITE)
    })

    test('unchanged content edits the PR body, writes no ref, and re-arms auto-merge on the existing head', () => {
      const outcome = runRefresh({ prs: [pr()], parent: BASE })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/pr edit 9 .*--body-file/)
      expect(outcome.log).toMatch(
        new RegExp(
          `pr merge 9 --repo o/r --auto --squash --match-head-commit ${'c'.repeat(40)} --subject chore\\(release\\): v3\\.22\\.0 --body $`,
          'm',
        ),
      )
      expect(outcome.log).not.toMatch(
        /git\/refs|git\/blobs|git\/trees|git\/commits |pr create|--method/,
      )
    })

    test('unchanged content warns instead of failing when auto-merge cannot be re-armed', () => {
      const outcome = runRefresh({
        prs: [pr()],
        parent: BASE,
        mergeFails: true,
      })
      expect(outcome.status).toBe(0)
      expect(outcome.output).toContain('::warning::')
      expect(
        outcome.log.split('\n').filter((l) => l.startsWith('gh pr merge 9 ')),
      ).toHaveLength(3)
      expect(outcome.log).not.toMatch(/--method/)
    })

    test('new content with no branch POSTs the ref, opens the PR and arms auto-merge', () => {
      const outcome = runRefresh({ refCount: 0 })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/--method POST repos\/o\/r\/git\/blobs/)
      expect(outcome.log).toContain(`"base_tree":"basetree"`)
      expect(outcome.log).toContain(`"parents":["${BASE}"]`)
      expect(outcome.log).toContain('"message":"chore(release): v3.22.0"')
      expect(outcome.log).not.toMatch(/"(author|committer)"/)
      expect(outcome.log).toMatch(/--method POST repos\/o\/r\/git\/refs /)
      expect(outcome.log).toContain(
        '"ref":"refs/heads/release/pending","sha":"newcommitsha"',
      )
      expect(outcome.log).not.toContain('--method PATCH')
      expect(outcome.log).toMatch(
        /pr create .*--base main --head release\/pending --title chore\(release\): v3\.22\.0 --body-file \S+body\.md/,
      )
      expect(outcome.log).toMatch(
        /pr merge 7 --repo o\/r --auto --squash --match-head-commit newcommitsha --subject chore\(release\): v3\.22\.0 --body $/m,
      )
    })

    test('an existing branch is force-updated with PATCH', () => {
      const outcome = runRefresh({
        refCount: 1,
        prs: [pr()],
        parent: 'd'.repeat(40),
      })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(
        /--method PATCH repos\/o\/r\/git\/refs\/heads\/release\/pending/,
      )
      expect(outcome.log).toContain('"sha":"newcommitsha","force":true')
      expect(outcome.log).not.toMatch(/--method POST repos\/o\/r\/git\/refs /)
      expect(outcome.log).toMatch(/pr edit 9 /)
      expect(outcome.log).not.toMatch(/pr create/)
      expect(outcome.log).toMatch(
        /pr merge 9 .*--match-head-commit newcommitsha/,
      )
    })

    test('a changed rendered changelog on the same base also force-updates', () => {
      const outcome = runRefresh({
        refCount: 1,
        prs: [pr()],
        parent: BASE,
        remoteBlob: 'e'.repeat(40),
      })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toContain('--method PATCH')
    })

    test('ignores a same-named PR from another author', () => {
      const outcome = runRefresh({
        prs: [pr({ author: { login: 'mallory', is_bot: false } })],
        parent: BASE,
      })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/pr create /)
      expect(outcome.log).not.toMatch(/pr edit 9/)
      expect(outcome.log).not.toMatch(/pr close/)
    })

    test('ignores a same-named PR from a fork', () => {
      const outcome = runRefresh({
        prs: [pr({ headRepositoryOwner: { login: 'mallory' } })],
      })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/pr create /)
      expect(outcome.log).not.toMatch(/pr edit 9/)
    })

    test('accepts the gh app/ login form for the bot author', () => {
      const outcome = runRefresh({
        prs: [
          pr({ author: { login: 'app/systematic-release', is_bot: true } }),
        ],
        parent: BASE,
      })
      expect(outcome.status).toBe(0)
      expect(outcome.log).toMatch(/pr edit 9 /)
      expect(outcome.log).not.toMatch(/pr create/)
    })

    test('fails when more than one trusted release PR is open', () => {
      const outcome = runRefresh({ prs: [pr(), pr({ number: 10 })] })
      expect(outcome.status).not.toBe(0)
      expect(outcome.log).not.toMatch(WRITE)
    })

    test.each([
      ['no release PR is open', []],
      ['a stale release PR is open', [pr()]],
    ])(
      'an unchanged tree fails with no commit, ref, PR or merge call when %s',
      (_name, prs) => {
        const outcome = runRefresh({
          prs,
          parent: 'd'.repeat(40),
          treeMatchesBase: true,
        })
        expect(outcome.status).toBe(1)
        expect(outcome.output).toContain(
          '::error::Rendered CHANGELOG.md matches main; a release entry is already on main without a publish. See RELEASING.md.',
        )
        expect(outcome.log).not.toMatch(
          /pr (create|edit|close|merge)|git\/refs|--method POST \S+\/git\/commits /,
        )
      },
    )

    test('warns instead of failing when auto-merge cannot be armed', () => {
      const outcome = runRefresh({ mergeFails: true })
      expect(outcome.status).toBe(0)
      expect(outcome.output).toContain('::warning::')
      expect(outcome.log).toMatch(/pr merge 7 /)
    })
  })
})
