import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the structural invariants the host-contract guard
 * (scripts/host-contract-guard.ts) depends on but cannot itself verify,
 * since they live in the workflow YAML, not in the guard script. Kept as a
 * sibling of host-contract-guard.test.ts (not merged into it) because these
 * assertions are about the workflow file's shape, not the guard's parsing
 * logic -- one file per concern keeps a workflow-YAML-format regression
 * from being misdiagnosed as a guard-logic regression.
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

function readWorkflow(): RecordValue {
  const source = fs.readFileSync(WORKFLOW_PATH, 'utf8')
  const { JSON_SCHEMA } = yaml
  return asRecord(yaml.load(source, { schema: JSON_SCHEMA }), 'workflow')
}

function findStep(steps: readonly unknown[], name: string): RecordValue {
  const step = steps.find(
    (candidate): candidate is RecordValue =>
      isRecord(candidate) && candidate.name === name,
  )
  if (!step) throw new Error(`step not found: ${name}`)
  return step
}

function normalizeCondition(condition: string): string {
  return condition.replace(/\s+/g, ' ').trim()
}

/**
 * The GitHub Actions status check functions. Per GitHub's own docs: "if
 * conditional [that doesn't contain] a status check function ... will be
 * substituted with `success()`", i.e. an `if:` with none of these applies
 * an IMPLICIT `success()` -- which is job-scoped and false once an earlier
 * step in the job fails, so a condition relying only on
 * `steps.<id>.outcome` comparisons (no status check function) would still
 * get skipped on exactly the failing run it was written to diagnose. This
 * is the defect that shipped twice in a row on this guard step (first a
 * job-scoped `failure()`, then no status check function at all), which is
 * why it is pinned here as its own mechanical check rather than trusted to
 * manual review.
 */
const STATUS_CHECK_FUNCTIONS = [
  'always()',
  'success()',
  'failure()',
  'cancelled()',
]

interface GuardConditionAnalysis {
  /** Contains at least one of the four status check functions, in any
   * form (bare or negated) -- this is what overrides GitHub's implicit
   * `success()` default. */
  readonly hasStatusCheckFunction: boolean
  /** Still requires the aggregator's own verdict that the suite was
   * required, so a run the gate skipped continues to skip this step. */
  readonly requiresSuiteRun: boolean
  /** Uses a bare (non-negated) `always()`, which would also run during
   * job cancellation -- broader than intended. */
  readonly usesBareAlways: boolean
}

function analyzeGuardCondition(condition: string): GuardConditionAnalysis {
  const normalized = normalizeCondition(condition)
  return {
    hasStatusCheckFunction: STATUS_CHECK_FUNCTIONS.some((fn) =>
      normalized.includes(fn),
    ),
    requiresSuiteRun: normalized.includes(
      "steps.verdict.outputs.run == 'true'",
    ),
    usesBareAlways: /(?<!!)\balways\(\)/.test(normalized),
  }
}

/** A `${{ ... }}`-wrapped expression and the bare expression are the same. */
function bareExpression(condition: unknown): string {
  const text = normalizeCondition(String(condition ?? ''))
  const wrapped = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(text)
  return wrapped?.[1] ? normalizeCondition(wrapped[1]) : text
}

/** A shell parameter expansion, `${name}`, built so lint does not read it as a stray template. */
function shVar(name: string): string {
  return `$${'{'}${name}}`
}

/** A GitHub Actions expression, `${{ inner }}`, built so lint does not read it as a stray template. */
function expr(inner: string): string {
  return `$${'{{'} ${inner} }}`
}

const REPO_ROOT = path.resolve(process.cwd())
const TIMINGS_PATH = 'tests/integration/host-contract-timings.json'
const SHARD_ARTIFACT_PREFIX = 'host-contract-v2-shard-'
const V1_JOBS = ['host-contract-v1-floor', 'host-contract-v1-current'] as const
const HOST_JOB_PREFIX = 'host-contract-'

function getJob(id: string): RecordValue {
  const workflow = readWorkflow()
  const jobs = asRecord(workflow.jobs, 'jobs')
  return asRecord(jobs[id], `${id} job`)
}

function jobSteps(id: string): readonly unknown[] {
  return asArray(getJob(id).steps, `${id} steps`)
}

interface ScriptResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly outputs: Record<string, string>
}

/**
 * Runs a workflow step's `run:` script the way the runner does (`bash -e`)
 * with the given environment and a fresh `GITHUB_OUTPUT` file, and reads the
 * outputs it wrote. Runs the real script from the workflow, so a change to it
 * is what these tests judge.
 */
function runStepScript(
  jobId: string,
  stepName: string,
  env: Record<string, string>,
  cwd?: string,
): ScriptResult {
  const step = findStep(jobSteps(jobId), stepName)
  const script = String(step.run ?? '')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-contract-step-'))
  const outputFile = path.join(dir, 'github-output')
  fs.writeFileSync(outputFile, '')
  try {
    const result = Bun.spawnSync(['bash', '-e', '-c', script], {
      env: { PATH: process.env.PATH ?? '', ...env, GITHUB_OUTPUT: outputFile },
      stdout: 'pipe',
      stderr: 'pipe',
      ...(cwd === undefined ? {} : { cwd }),
    })
    const outputs: Record<string, string> = {}
    for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      outputs,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('host-contract workflow structural invariants', () => {
  test('main.yaml has no publish job that could depend on host-contract', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')

    expect(jobs).not.toHaveProperty('legacy-release')
  })

  describe('the gate job', () => {
    test('exposes the verdict as a job output and has no job-level `if:`', () => {
      const gate = getJob('host-contract-gate')
      const outputs = asRecord(gate.outputs, 'gate outputs')

      expect(outputs.run).toBe(`${expr('steps.gate.outputs.run')}`)
      expect(gate).not.toHaveProperty('if')
    })

    test('the paths filter covers everything under .github, not just the main workflow', () => {
      const filterStep = findStep(
        jobSteps('host-contract-gate'),
        'Detect relevant path changes',
      )
      const filters = String(asRecord(filterStep.with, 'filter with').filters)

      expect(filters).toContain("- '.github/**'")
      expect(filters).not.toContain('.github/workflows/main.yaml')
    })

    const GATE_STEP = 'Determine whether to run the host contract suite'

    test.each(['push', 'workflow_dispatch', 'schedule'])(
      'a %s event does not run the suite',
      (eventName) => {
        const result = runStepScript('host-contract-gate', GATE_STEP, {
          EVENT_NAME: eventName,
          FILTER_RESULT: '',
        })

        expect(result.exitCode).toBe(0)
        expect(result.outputs.run).toBe('false')
      },
    )

    test.each([
      { filter: 'true', run: 'true' },
      { filter: 'false', run: 'false' },
    ])(
      'a pull request whose filter said $filter runs the suite: $run',
      ({ filter, run }) => {
        const result = runStepScript('host-contract-gate', GATE_STEP, {
          EVENT_NAME: 'pull_request',
          FILTER_RESULT: filter,
        })

        expect(result.exitCode).toBe(0)
        expect(result.outputs.run).toBe(run)
      },
    )

    test.each(['', 'maybe', 'TRUE', 'null'])(
      'a pull request whose filter said %j fails closed',
      (filter) => {
        const result = runStepScript('host-contract-gate', GATE_STEP, {
          EVENT_NAME: 'pull_request',
          FILTER_RESULT: filter,
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.outputs).not.toHaveProperty('run')
        expect(result.stdout).toContain(
          'paths-filter returned an unexpected value',
        )
      },
    )
  })

  describe('the shard jobs', () => {
    function matrixShards(): readonly unknown[] {
      const strategy = asRecord(
        getJob('host-contract-shard').strategy,
        'strategy',
      )
      const matrix = asRecord(strategy.matrix, 'matrix')
      return asArray(matrix.shard, 'matrix.shard')
    }

    function suiteRun(): string {
      const step = findStep(
        jobSteps('host-contract-shard'),
        'Run host contract suite',
      )
      return String(step.run ?? '')
    }

    test('run after the gate and only when it says the suite is required', () => {
      const shard = getJob('host-contract-shard')

      expect(shard.needs).toBe('host-contract-gate')
      expect(bareExpression(shard.if)).toBe(
        "needs.host-contract-gate.outputs.run == 'true'",
      )
    })

    test('form a four-way matrix that keeps running when one shard fails', () => {
      const shard = getJob('host-contract-shard')
      const strategy = asRecord(shard.strategy, 'strategy')

      expect(matrixShards()).toEqual([1, 2, 3, 4])
      expect(strategy['fail-fast']).toBe(false)
      expect(shard.name).toBe(
        `Host Contract v2 shard ${expr('matrix.shard')}/4`,
      )
    })

    test('the shard count in --shard matches the matrix', () => {
      const match = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(suiteRun())

      expect(match?.[1]).toBeDefined()
      expect(Number(match?.[1])).toBe(matrixShards().length)
    })

    test('the suite step targets the v2 host, requires it, and keeps the id the other steps rely on', () => {
      const step = findStep(
        jobSteps('host-contract-shard'),
        'Run host contract suite',
      )
      const env = asRecord(step.env, 'Run host contract suite env')

      expect(env.SYSTEMATIC_OPENCODE_HOST).toBe('v2')
      expect(env.SYSTEMATIC_OPENCODE_V2_BIN).toBe(
        expr('steps.opencode.outputs.bin'),
      )
      expect(env.SYSTEMATIC_REQUIRE_OPENCODE_V2).toBe('1')
      expect(env).not.toHaveProperty('SYSTEMATIC_REQUIRE_OPENCODE')
      expect(step.id).toBe('suite')
    })

    test('the suite runs its shard of the v2 profile against the committed timings and writes per-shard reports', () => {
      const run = suiteRun()

      expect(run).toContain('set -o pipefail')
      expect(run).toContain(
        'bun scripts/host-contract-guard.ts files --profile v2',
      )
      expect(run).toContain(`bun test "${shVar('file_list[@]')}"`)
      expect(run).not.toContain('bun test tests/integration')
      expect(run).toContain(`--shard=${expr('matrix.shard')}/4`)
      expect(run).toContain(`--timings=${TIMINGS_PATH}`)
      expect(run).toContain('--reporter=junit')
      expect(run).toContain(
        `--reporter-outfile=host-contract-v2-junit-${expr('matrix.shard')}.xml`,
      )
      expect(run).toContain(
        `tee host-contract-v2-log-${expr('matrix.shard')}.txt`,
      )
    })

    test('reads the file list in its own command, so a failed listing stops the step before any test runs', () => {
      const run = suiteRun()
      const listing = run.indexOf('files="$(bun scripts/host-contract-guard.ts')
      const testRun = run.indexOf('bun test')

      expect(listing).toBeGreaterThan(-1)
      expect(listing).toBeLessThan(testRun)
      expect(run).not.toMatch(/bun test[^\n]*\$\(/)
    })

    describe('the v2 CLI install', () => {
      const INSTALL_STEP = 'Install the OpenCode v2 CLI at its pin'

      function installRun(): string {
        return String(
          findStep(jobSteps('host-contract-shard'), INSTALL_STEP).run ?? '',
        )
      }

      test('runs before the suite and exposes the binary path to it', () => {
        const names = jobSteps('host-contract-shard').map((step) =>
          String(asRecord(step, 'step').name ?? ''),
        )
        const install = findStep(jobSteps('host-contract-shard'), INSTALL_STEP)

        expect(names.indexOf(INSTALL_STEP)).toBeGreaterThan(-1)
        expect(names.indexOf(INSTALL_STEP)).toBeLessThan(
          names.indexOf('Run host contract suite'),
        )
        expect(install.id).toBe('opencode')
        expect(installRun()).toContain('echo "bin=$bin" >> "$GITHUB_OUTPUT"')
      })

      test('installs the pinned version from the pin file into a local prefix, never globally', () => {
        const run = installRun()

        expect(run).toContain("jq -r '.v2' scripts/opencode-host-pins.json")
        expect(run).toContain('npm install --prefix "$prefix"')
        expect(run).toContain(`"@opencode/cli@${shVar('pin')}"`)
        expect(run).not.toMatch(/npm (install|i) (-g|--global)/)
        expect(run).not.toContain('bunx')
        expect(run).not.toContain('--ignore-scripts')
      })

      test('passes the script-allowing flag only to an npm that has it', () => {
        const run = installRun()

        expect(run).toContain('--dangerously-allow-all-scripts')
        expect(run).toMatch(/npm --version \| cut -d\. -f1\) >= 12/)
        const flagLine = run.indexOf('--dangerously-allow-all-scripts')
        const guardLine = run.indexOf('>= 12')
        expect(guardLine).toBeGreaterThan(-1)
        expect(guardLine).toBeLessThan(flagLine)
      })

      test('fails with the CLI output when --version fails or differs from the pin', () => {
        const run = installRun()

        expect(run).toContain('"$bin" --version 2>&1')
        expect(run).toContain('--version failed: $reported')
        expect(run).toContain(`"$reported" != "opencode v${shVar('pin')}"`)
        expect(run).toContain('exit 1')
      })

      test('its failure branches really exit non-zero (the step script run against a fake npm and CLI)', () => {
        const jq = Bun.which('jq')
        if (jq === null)
          throw new Error('jq must be installed to run this test')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-contract-npm-'))
        try {
          const binDir = path.join(dir, 'bin')
          fs.mkdirSync(binDir)
          const cli = path.join(dir, 'opencode-v2/node_modules/.bin/opencode')
          const fakeNpm = [
            '#!/bin/bash',
            'if [[ "$1" == "--version" ]]; then echo "$FAKE_NPM_VERSION"; exit 0; fi',
            `mkdir -p "$(dirname "${cli}")"`,
            `cp "$FAKE_CLI_TEMPLATE" "${cli}"`,
            `chmod +x "${cli}"`,
            'echo "$@" > "$FAKE_NPM_ARGS"',
          ].join('\n')
          fs.writeFileSync(path.join(binDir, 'npm'), fakeNpm, { mode: 0o755 })
          const pins: unknown = JSON.parse(
            fs.readFileSync(
              path.join(REPO_ROOT, 'scripts/opencode-host-pins.json'),
              'utf8',
            ),
          )
          const pin = String(asRecord(pins, 'pins').v2)

          function install(
            cliOutput: string,
            cliExit: number,
            npmVersion: string,
          ) {
            const template = path.join(dir, 'cli-template')
            fs.writeFileSync(
              template,
              `#!/bin/bash\necho "${cliOutput}"\nexit ${cliExit}\n`,
            )
            const npmArgs = path.join(dir, 'npm-args')
            const result = runStepScript(
              'host-contract-shard',
              INSTALL_STEP,
              {
                RUNNER_TEMP: dir,
                FAKE_CLI_TEMPLATE: template,
                FAKE_NPM_VERSION: npmVersion,
                FAKE_NPM_ARGS: npmArgs,
                PATH: `${binDir}:${path.dirname(jq as string)}:/usr/bin:/bin`,
              },
              REPO_ROOT,
            )
            const args = fs.existsSync(npmArgs)
              ? fs.readFileSync(npmArgs, 'utf8')
              : ''
            return { result, args }
          }

          const ok = install(`opencode v${pin}`, 0, '12.2.1')
          expect(ok.result.exitCode).toBe(0)
          expect(ok.result.outputs.bin).toBe(cli)
          expect(ok.args).toContain('--dangerously-allow-all-scripts')
          expect(ok.args).toContain(`@opencode/cli@${pin}`)

          const older = install(`opencode v${pin}`, 0, '11.4.2')
          expect(older.result.exitCode).toBe(0)
          expect(older.args).not.toContain('--dangerously-allow-all-scripts')

          const wrong = install('opencode v0.0.0', 0, '12.2.1')
          expect(wrong.result.exitCode).not.toBe(0)
          expect(wrong.result.stdout).toContain('opencode v0.0.0')

          const broken = install('placeholder failure text', 3, '12.2.1')
          expect(broken.result.exitCode).not.toBe(0)
          expect(broken.result.stdout).toContain('placeholder failure text')
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })
    })

    test('builds before running the suite', () => {
      const names = jobSteps('host-contract-shard').map((step) =>
        String(asRecord(step, 'step').name ?? ''),
      )

      expect(names.indexOf('Build')).toBeGreaterThan(-1)
      expect(names.indexOf('Build')).toBeLessThan(
        names.indexOf('Run host contract suite'),
      )
    })

    test('has a timeout well under the old whole-suite ceiling', () => {
      const timeout = getJob('host-contract-shard')['timeout-minutes']

      expect(typeof timeout).toBe('number')
      expect(timeout as number).toBeLessThanOrEqual(20)
    })

    test('uploads its reports whenever the run was not cancelled, and fails loudly when they are missing', () => {
      const upload = findStep(
        jobSteps('host-contract-shard'),
        'Upload shard results',
      )
      const withBlock = asRecord(upload.with, 'upload with')

      expect(bareExpression(upload.if)).toBe('!cancelled()')
      expect(withBlock.name).toBe(
        `host-contract-v2-shard-${expr('matrix.shard')}`,
      )
      expect(String(withBlock.path)).toContain(
        `host-contract-v2-junit-${expr('matrix.shard')}.xml`,
      )
      expect(String(withBlock.path)).toContain(
        `host-contract-v2-log-${expr('matrix.shard')}.txt`,
      )
      expect(withBlock['if-no-files-found']).toBe('error')
    })

    test('the committed timings file exists, parses, and names only real test files', () => {
      const timingsFile = path.join(REPO_ROOT, TIMINGS_PATH)
      const parsed: unknown = JSON.parse(fs.readFileSync(timingsFile, 'utf8'))
      const timings = asRecord(parsed, 'timings')
      const files = asRecord(timings.files, 'timings.files')

      expect(timings.version).toBe(1)
      expect(Object.keys(files).length).toBeGreaterThan(0)
      for (const [file, ms] of Object.entries(files)) {
        expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true)
        expect(typeof ms, file).toBe('number')
      }
    })
  })

  describe('the v1 jobs', () => {
    const PROFILES = [
      {
        id: 'host-contract-v1-floor',
        profile: 'v1-floor',
        line: 'floor',
        pinKey: 'v1Floor',
        versionStep: 'Report the OpenCode v1 floor version',
        artifact: 'host-contract-v1-floor-results',
      },
      {
        id: 'host-contract-v1-current',
        profile: 'v1-current',
        line: 'current',
        pinKey: 'v1',
        versionStep: 'Report the OpenCode v1 current version',
        artifact: 'host-contract-v1-current-results',
      },
    ]

    function suiteRun(id: string): string {
      return String(findStep(jobSteps(id), 'Run host contract suite').run ?? '')
    }

    test.each(PROFILES)(
      '$id runs after the gate, only when it says the suite is required, and is not sharded',
      ({ id }) => {
        const job = getJob(id)

        expect(job.needs).toBe('host-contract-gate')
        expect(bareExpression(job.if)).toBe(
          "needs.host-contract-gate.outputs.run == 'true'",
        )
        expect(job).not.toHaveProperty('strategy')
        expect(suiteRun(id)).not.toContain('--shard')
        expect(suiteRun(id)).not.toContain('--timings')
      },
    )

    test.each(PROFILES)(
      '$id targets the v1 host line it is named for and requires v1',
      ({ id, line }) => {
        const step = findStep(jobSteps(id), 'Run host contract suite')
        const env = asRecord(step.env, 'suite env')

        expect(env.SYSTEMATIC_OPENCODE_HOST).toBe('v1')
        expect(env.SYSTEMATIC_OPENCODE_V1_LINE).toBe(line)
        expect(env.SYSTEMATIC_REQUIRE_OPENCODE_V1).toBe('1')
        expect(env).not.toHaveProperty('SYSTEMATIC_OPENCODE_V2_BIN')
        expect(step.id).toBe('suite')
      },
    )

    test.each(PROFILES)(
      '$id runs its own profile file list and writes reports named for the profile',
      ({ id, profile }) => {
        const run = suiteRun(id)

        expect(run).toContain('set -o pipefail')
        expect(run).toContain(
          `bun scripts/host-contract-guard.ts files --profile ${profile}`,
        )
        expect(run).toContain(`bun test "${shVar('file_list[@]')}"`)
        expect(run).toContain(
          `--reporter-outfile=host-contract-${profile}-junit.xml`,
        )
        expect(run).toContain(`tee host-contract-${profile}-log.txt`)
      },
    )

    test.each(PROFILES)(
      '$id reports the version from the pin file before the suite, and fails when it differs',
      ({ id, pinKey, versionStep }) => {
        const names = jobSteps(id).map((step) =>
          String(asRecord(step, 'step').name ?? ''),
        )
        const run = String(findStep(jobSteps(id), versionStep).run ?? '')

        expect(names.indexOf(versionStep)).toBeGreaterThan(-1)
        expect(names.indexOf(versionStep)).toBeLessThan(
          names.indexOf('Run host contract suite'),
        )
        expect(run).toContain(
          `jq -r '.${pinKey}' scripts/opencode-host-pins.json`,
        )
        expect(run).toContain(`bunx "opencode-ai@${shVar('pin')}" --version`)
        expect(run).toContain('GITHUB_STEP_SUMMARY')
        expect(run).toContain('exit 1')
      },
    )

    test.each(PROFILES)(
      '$id uploads its reports under its own artifact name and fails when they are missing',
      ({ id, profile, artifact }) => {
        const upload = findStep(
          jobSteps(id),
          `Upload ${profile.replace('-', ' ')} results`,
        )
        const withBlock = asRecord(upload.with, 'upload with')

        expect(bareExpression(upload.if)).toBe('!cancelled()')
        expect(withBlock.name).toBe(artifact)
        expect(String(withBlock.path)).toContain(
          `host-contract-${profile}-junit.xml`,
        )
        expect(String(withBlock.path)).toContain(
          `host-contract-${profile}-log.txt`,
        )
        expect(withBlock['if-no-files-found']).toBe('error')
      },
    )

    test('every host job uploads under a different artifact name, none of which the v2 pattern also matches', () => {
      const shardName = String(
        asRecord(
          findStep(jobSteps('host-contract-shard'), 'Upload shard results')
            .with,
          'upload with',
        ).name,
      )
      const names = [
        shardName.replace(expr('matrix.shard'), '1'),
        ...PROFILES.map((entry) => entry.artifact),
      ]

      expect(new Set(names).size).toBe(names.length)
      for (const entry of PROFILES) {
        expect(entry.artifact.startsWith(SHARD_ARTIFACT_PREFIX)).toBe(false)
      }
    })

    test('the v1 jobs have a timeout well under the old whole-suite ceiling', () => {
      for (const { id } of PROFILES) {
        const timeout = getJob(id)['timeout-minutes']
        expect(typeof timeout).toBe('number')
        expect(timeout as number).toBeLessThanOrEqual(20)
      }
    })

    test('no v1 job installs the v2 CLI, and the shard job does not launch it through bunx', () => {
      for (const { id } of PROFILES) {
        expect(JSON.stringify(getJob(id))).not.toContain('@opencode/cli')
      }
    })
  })

  describe('the aggregator job', () => {
    const VERDICT_STEP = 'Decide whether the suite was required'
    const JOB_STEPS = [
      {
        step: 'Require the v2 shards to have succeeded',
        variable: 'V2_SHARDS_RESULT',
        job: 'host-contract-shard',
      },
      {
        step: 'Require the v1 floor job to have succeeded',
        variable: 'V1_FLOOR_RESULT',
        job: 'host-contract-v1-floor',
      },
      {
        step: 'Require the v1 current job to have succeeded',
        variable: 'V1_CURRENT_RESULT',
        job: 'host-contract-v1-current',
      },
    ]
    const GUARD_STEPS = [
      { step: 'Guard v2 skipped tests and pass floor', profile: 'v2' },
      {
        step: 'Guard v1 floor skipped tests and pass floor',
        profile: 'v1-floor',
      },
      {
        step: 'Guard v1 current skipped tests and pass floor',
        profile: 'v1-current',
      },
    ]

    function v2GuardStep(): string {
      const entry = GUARD_STEPS.find((candidate) => candidate.profile === 'v2')
      if (entry === undefined) throw new Error('missing v2 guard step')
      return entry.step
    }

    function neededJobs(): readonly unknown[] {
      return asArray(getJob('host-contract').needs, 'aggregator needs')
    }

    function jobStepEnv(
      stepName: string,
      required: string,
      variable: string,
      result: string,
    ): ScriptResult {
      return runStepScript('host-contract', stepName, {
        SUITE_REQUIRED: required,
        [variable]: result,
      })
    }

    test('is the required check: it needs the gate and every host job and always runs', () => {
      const aggregator = getJob('host-contract')

      expect(aggregator.name).toBe('Host Contract')
      expect(neededJobs()).toEqual([
        'host-contract-gate',
        'host-contract-shard',
        'host-contract-v1-floor',
        'host-contract-v1-current',
      ])
      expect(bareExpression(aggregator.if)).toBe('always()')
    })

    test('needs every job whose id starts with host-contract-, so a new host job cannot be left out', () => {
      const jobs = asRecord(readWorkflow().jobs, 'jobs')
      const hostJobs = Object.keys(jobs).filter((id) =>
        id.startsWith(HOST_JOB_PREFIX),
      )

      expect(hostJobs.length).toBeGreaterThan(1)
      expect([...neededJobs()].sort()).toEqual([...hostJobs].sort())
    })

    test('the needs check notices a host job that is missing from needs', () => {
      const jobs = asRecord(readWorkflow().jobs, 'jobs')
      const withNewJob = [...Object.keys(jobs), 'host-contract-v3-extra']
      const hostJobs = withNewJob.filter((id) => id.startsWith(HOST_JOB_PREFIX))

      expect([...neededJobs()].sort()).not.toEqual([...hostJobs].sort())
    })

    test('the needs check notices a v1 job dropped from needs', () => {
      for (const dropped of V1_JOBS) {
        const without = neededJobs().filter((id) => id !== dropped)
        const jobs = asRecord(readWorkflow().jobs, 'jobs')
        const hostJobs = Object.keys(jobs).filter((id) =>
          id.startsWith(HOST_JOB_PREFIX),
        )

        expect([...without].sort()).not.toEqual([...hostJobs].sort())
      }
    })

    test('reads the gate and each job result through env, never by interpolating them into a script', () => {
      const steps = jobSteps('host-contract')
      const verdict = findStep(steps, VERDICT_STEP)

      expect(asRecord(verdict.env, 'verdict env')).toMatchObject({
        GATE_RESULT: `${expr('needs.host-contract-gate.result')}`,
        GATE_RUN: `${expr('needs.host-contract-gate.outputs.run')}`,
      })
      for (const { step, variable, job } of JOB_STEPS) {
        expect(
          asRecord(findStep(steps, step).env, `${step} env`),
        ).toMatchObject({
          [variable]: `${expr(`needs.${job}.result`)}`,
          SUITE_REQUIRED: `${expr('steps.verdict.outputs.run')}`,
        })
      }
      for (const step of steps) {
        const run = String(asRecord(step, 'step').run ?? '')
        expect(run, String(asRecord(step, 'step').name)).not.toContain('${{')
      }
    })

    test('has no leftover single-variable shard verdict', () => {
      expect(JSON.stringify(getJob('host-contract'))).not.toContain(
        'SHARD_RESULT',
      )
    })

    test.each([
      { gate: 'failure', run: 'true' },
      { gate: 'skipped', run: 'false' },
      { gate: 'cancelled', run: '' },
    ])('a gate that ended $gate fails the check', ({ gate, run }) => {
      const result = runStepScript('host-contract', VERDICT_STEP, {
        GATE_RESULT: gate,
        GATE_RUN: run,
      })

      expect(result.exitCode).not.toBe(0)
    })

    test('a gate that decided to skip the suite passes without requiring anything else', () => {
      const result = runStepScript('host-contract', VERDICT_STEP, {
        GATE_RESULT: 'success',
        GATE_RUN: 'false',
      })

      expect(result.exitCode).toBe(0)
      expect(result.outputs.run).toBe('false')
    })

    test('a gate that decided to run the suite hands on to the job checks', () => {
      const result = runStepScript('host-contract', VERDICT_STEP, {
        GATE_RESULT: 'success',
        GATE_RUN: 'true',
      })

      expect(result.exitCode).toBe(0)
      expect(result.outputs.run).toBe('true')
    })

    test.each(['', 'yes', 'TRUE'])(
      'a successful gate with the verdict %j fails closed',
      (run) => {
        const result = runStepScript('host-contract', VERDICT_STEP, {
          GATE_RESULT: 'success',
          GATE_RUN: run,
        })

        expect(result.exitCode).not.toBe(0)
      },
    )

    describe.each(JOB_STEPS)('$step', ({ step, variable }) => {
      test.each(['failure', 'skipped', 'cancelled', ''])(
        'a required job that ended %j fails the check',
        (outcome) => {
          expect(jobStepEnv(step, 'true', variable, outcome).exitCode).not.toBe(
            0,
          )
        },
      )

      test('a required job that succeeded passes', () => {
        expect(jobStepEnv(step, 'true', variable, 'success').exitCode).toBe(0)
      })

      test('a job the gate did not require reports "not required" and passes', () => {
        const result = jobStepEnv(step, 'false', variable, 'skipped')

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('not required')
      })

      test.each(['', 'yes', 'TRUE'])(
        'a verdict of %j fails closed, even for a job that succeeded',
        (required) => {
          expect(
            jobStepEnv(step, required, variable, 'success').exitCode,
          ).not.toBe(0)
        },
      )

      test('runs whatever happened before it', () => {
        expect(
          bareExpression(findStep(jobSteps('host-contract'), step).if),
        ).toBe('always()')
      })
    })

    test('a failed or cancelled v1 job turns the check red even when every v2 shard passed, and the reverse', () => {
      const results = (shards: string, floor: string, current: string) =>
        JOB_STEPS.map(({ step, variable }) => {
          const outcome: Record<string, string> = {
            V2_SHARDS_RESULT: shards,
            V1_FLOOR_RESULT: floor,
            V1_CURRENT_RESULT: current,
          }
          return jobStepEnv(step, 'true', variable, outcome[variable] ?? '')
            .exitCode
        })
      const red = (codes: readonly number[]) => codes.some((code) => code !== 0)

      expect(red(results('success', 'success', 'success'))).toBe(false)
      expect(red(results('success', 'failure', 'success'))).toBe(true)
      expect(red(results('success', 'success', 'cancelled'))).toBe(true)
      expect(red(results('failure', 'success', 'success'))).toBe(true)
      expect(red(results('success', 'skipped', 'success'))).toBe(true)
    })

    test('downloads the v2 shard artifacts into one directory, and each v1 job into its own', () => {
      const steps = jobSteps('host-contract')
      const v2 = asRecord(
        findStep(steps, 'Download v2 shard results').with,
        'download with',
      )
      const floor = asRecord(
        findStep(steps, 'Download v1 floor results').with,
        'download with',
      )
      const current = asRecord(
        findStep(steps, 'Download v1 current results').with,
        'download with',
      )

      expect(
        String(findStep(steps, 'Download v2 shard results').uses),
      ).toStartWith('actions/download-artifact@')
      expect(v2.pattern).toBe(`${SHARD_ARTIFACT_PREFIX}*`)
      expect(v2['merge-multiple']).toBe(true)
      expect(floor.name).toBe('host-contract-v1-floor-results')
      expect(current.name).toBe('host-contract-v1-current-results')
      expect(floor).not.toHaveProperty('merge-multiple')
      expect(current).not.toHaveProperty('merge-multiple')
      const paths = [v2.path, floor.path, current.path]
      expect(new Set(paths).size).toBe(3)
    })

    test.each(GUARD_STEPS)(
      '$step judges its own profile from its own directory',
      ({ step, profile }) => {
        const run = String(findStep(jobSteps('host-contract'), step).run ?? '')

        expect(run).toContain(
          `bun scripts/host-contract-guard.ts --profile ${profile}`,
        )
        expect(run).not.toContain('cat <<')
        for (const other of ['v2', 'v1-floor', 'v1-current']) {
          if (other === profile) continue
          expect(run).not.toContain(`host-contract-results/${other}/`)
        }
        expect(run).toContain(`host-contract-results/${profile}/`)
      },
    )

    test('the v2 guard reads all four shard report pairs, matching the matrix', () => {
      const run = String(
        findStep(jobSteps('host-contract'), v2GuardStep()).run ?? '',
      )
      const matrix = asRecord(
        asRecord(getJob('host-contract-shard').strategy, 'strategy').matrix,
        'matrix',
      )

      for (const shard of [1, 2, 3, 4]) {
        expect(run).toContain(`host-contract-v2-junit-${shard}.xml`)
        expect(run).toContain(`host-contract-v2-log-${shard}.txt`)
      }
      expect(run.match(/host-contract-v2-junit-\d\.xml/g)).toHaveLength(
        asArray(matrix.shard, 'matrix.shard').length,
      )
      expect(run.match(/host-contract-v2-log-\d\.txt/g)).toHaveLength(4)
    })

    test('each v1 guard reads exactly one report pair, named like its job uploads it', () => {
      for (const profile of ['v1-floor', 'v1-current']) {
        const stepName = GUARD_STEPS.find((entry) => entry.profile === profile)
        if (stepName === undefined) throw new Error('missing guard step')
        const run = String(
          findStep(jobSteps('host-contract'), stepName.step).run ?? '',
        )

        expect(run.match(/-junit\.xml/g)).toHaveLength(1)
        expect(run.match(/-log\.txt/g)).toHaveLength(1)
        expect(run).toContain(`host-contract-${profile}-junit.xml`)
        expect(run).toContain(`host-contract-${profile}-log.txt`)
      }
    })

    test('the download and guard steps run after a job failure but not after cancellation or a skipped suite', () => {
      const steps = jobSteps('host-contract')
      const names = [
        'Download v2 shard results',
        'Download v1 floor results',
        'Download v1 current results',
        ...GUARD_STEPS.map((entry) => entry.step),
      ]
      for (const name of names) {
        expect(bareExpression(findStep(steps, name).if), name).toBe(
          "!cancelled() && steps.verdict.outputs.run == 'true'",
        )
      }
    })

    test('the path filters leave every host job skipped and the aggregator reporting "not required" on an unrelated change', () => {
      const gate = runStepScript(
        'host-contract-gate',
        'Determine whether to run the host contract suite',
        { EVENT_NAME: 'pull_request', FILTER_RESULT: 'false' },
      )
      expect(gate.outputs.run).toBe('false')

      const verdict = runStepScript('host-contract', VERDICT_STEP, {
        GATE_RESULT: 'success',
        GATE_RUN: gate.outputs.run ?? '',
      })
      expect(verdict.exitCode).toBe(0)
      expect(verdict.outputs.run).toBe('false')
      for (const { step, variable } of JOB_STEPS) {
        const result = jobStepEnv(step, 'false', variable, 'skipped')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('not required')
      }
      for (const id of ['host-contract-shard', ...V1_JOBS]) {
        expect(bareExpression(getJob(id).if)).toBe(
          "needs.host-contract-gate.outputs.run == 'true'",
        )
      }
    })
  })

  describe('guard condition properties (mechanically pinned, proven bidirectionally)', () => {
    function realCondition(): string {
      const guardStep = findStep(
        jobSteps('host-contract'),
        'Guard v2 skipped tests and pass floor',
      )
      return bareExpression(guardStep.if)
    }

    test('(a) the real condition contains a status check function', () => {
      expect(
        analyzeGuardCondition(realCondition()).hasStatusCheckFunction,
      ).toBe(true)
    })

    test('(a) bidirectional: a condition with no status check function fails this property (the exact bug that shipped)', () => {
      const mutated = realCondition().replace('!cancelled() && ', '')
      expect(mutated).not.toContain('cancelled()')
      expect(analyzeGuardCondition(mutated).hasStatusCheckFunction).toBe(false)
    })

    test('(b) the real condition still requires the suite to have been required', () => {
      expect(analyzeGuardCondition(realCondition()).requiresSuiteRun).toBe(true)
    })

    test('(b) bidirectional: a condition without it fails this property (a skipped suite would no longer skip this step)', () => {
      const mutated = realCondition().replace(
        " && steps.verdict.outputs.run == 'true'",
        '',
      )
      expect(mutated).not.toContain('steps.verdict.outputs.run')
      expect(analyzeGuardCondition(mutated).requiresSuiteRun).toBe(false)
    })

    test('(c) the real condition does not use a bare always()', () => {
      expect(analyzeGuardCondition(realCondition()).usesBareAlways).toBe(false)
    })

    test('(c) bidirectional: a condition using always() instead of !cancelled() fails this property (it would also run during cancellation)', () => {
      const mutated = realCondition().replace('!cancelled()', 'always()')
      expect(analyzeGuardCondition(mutated).usesBareAlways).toBe(true)
      // A bare always() is still a status check function, so it passes
      // property (a): (c) catches something (a) alone cannot.
      expect(analyzeGuardCondition(mutated).hasStatusCheckFunction).toBe(true)
    })
  })
})
