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

/** A GitHub Actions expression, `${{ inner }}`, built so lint does not read it as a stray template. */
function expr(inner: string): string {
  return `$${'{{'} ${inner} }}`
}

const REPO_ROOT = path.resolve(process.cwd())
const TIMINGS_PATH = 'tests/integration/host-contract-timings.json'
const SHARD_ARTIFACT_PREFIX = 'host-contract-shard-'

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
      expect(shard.name).toBe(`Host Contract shard ${expr('matrix.shard')}/4`)
    })

    test('the shard count in --shard matches the matrix', () => {
      const match = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(suiteRun())

      expect(match?.[1]).toBeDefined()
      expect(Number(match?.[1])).toBe(matrixShards().length)
    })

    test('the suite step sets SYSTEMATIC_REQUIRE_OPENCODE=1 and keeps the id the other steps rely on', () => {
      const step = findStep(
        jobSteps('host-contract-shard'),
        'Run host contract suite',
      )
      const env = asRecord(step.env, 'Run host contract suite env')

      expect(env.SYSTEMATIC_REQUIRE_OPENCODE).toBe('1')
      expect(step.id).toBe('suite')
    })

    test('the suite runs its shard against the committed timings and writes per-shard reports', () => {
      const run = suiteRun()

      expect(run).toContain('set -o pipefail')
      expect(run).toContain('bun test tests/integration')
      expect(run).toContain(`--shard=${expr('matrix.shard')}/4`)
      expect(run).toContain(`--timings=${TIMINGS_PATH}`)
      expect(run).toContain('--reporter=junit')
      expect(run).toContain(
        `--reporter-outfile=host-contract-junit-${expr('matrix.shard')}.xml`,
      )
      expect(run).toContain(`tee host-contract-log-${expr('matrix.shard')}.txt`)
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
      expect(withBlock.name).toBe(`host-contract-shard-${expr('matrix.shard')}`)
      expect(String(withBlock.path)).toContain(
        `host-contract-junit-${expr('matrix.shard')}.xml`,
      )
      expect(String(withBlock.path)).toContain(
        `host-contract-log-${expr('matrix.shard')}.txt`,
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

  describe('the aggregator job', () => {
    const VERDICT_STEP = 'Decide whether the suite was required'
    const SHARDS_STEP = 'Require every shard to have succeeded'
    const GUARD_STEP = 'Guard skipped tests and pass floor'

    test('is the required check: it needs the gate and the shards and always runs', () => {
      const aggregator = getJob('host-contract')

      expect(aggregator.name).toBe('Host Contract')
      expect(aggregator.needs).toEqual([
        'host-contract-gate',
        'host-contract-shard',
      ])
      expect(bareExpression(aggregator.if)).toBe('always()')
    })

    test('reads the gate and shard results through env, never by interpolating them into a script', () => {
      const steps = jobSteps('host-contract')
      const verdict = findStep(steps, VERDICT_STEP)
      const shards = findStep(steps, SHARDS_STEP)

      expect(asRecord(verdict.env, 'verdict env')).toMatchObject({
        GATE_RESULT: `${expr('needs.host-contract-gate.result')}`,
        GATE_RUN: `${expr('needs.host-contract-gate.outputs.run')}`,
      })
      expect(asRecord(shards.env, 'shards env')).toMatchObject({
        SHARD_RESULT: `${expr('needs.host-contract-shard.result')}`,
      })
      for (const step of steps) {
        const run = String(asRecord(step, 'step').run ?? '')
        expect(run, String(asRecord(step, 'step').name)).not.toContain('${{')
      }
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

    test('a gate that decided to run the suite hands on to the shard checks', () => {
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

    test('shard results other than success fail the check, and success passes it', () => {
      const outcomes = ['failure', 'skipped', 'cancelled', ''].map(
        (shard) =>
          runStepScript('host-contract', SHARDS_STEP, { SHARD_RESULT: shard })
            .exitCode,
      )

      expect(outcomes.every((code) => code !== 0)).toBe(true)
      expect(
        runStepScript('host-contract', SHARDS_STEP, { SHARD_RESULT: 'success' })
          .exitCode,
      ).toBe(0)
    })

    test('downloads every shard artifact into one directory', () => {
      const download = findStep(
        jobSteps('host-contract'),
        'Download shard results',
      )
      const withBlock = asRecord(download.with, 'download with')

      expect(String(download.uses)).toStartWith('actions/download-artifact@')
      expect(withBlock.pattern).toBe(`${SHARD_ARTIFACT_PREFIX}*`)
      expect(withBlock['merge-multiple']).toBe(true)
    })

    test('guards all four report pairs from the downloaded directory', () => {
      const run = String(
        findStep(jobSteps('host-contract'), GUARD_STEP).run ?? '',
      )

      expect(run).toContain('bun scripts/host-contract-guard.ts')
      expect(run).not.toContain('cat <<')
      for (const shard of [1, 2, 3, 4]) {
        expect(run).toContain(`host-contract-junit-${shard}.xml`)
        expect(run).toContain(`host-contract-log-${shard}.txt`)
      }
      expect(run.match(/host-contract-junit-\d\.xml/g)).toHaveLength(4)
      expect(run.match(/host-contract-log-\d\.txt/g)).toHaveLength(4)
    })

    test('the pair count matches the shard matrix', () => {
      const matrix = asRecord(
        asRecord(getJob('host-contract-shard').strategy, 'strategy').matrix,
        'matrix',
      )
      const run = String(
        findStep(jobSteps('host-contract'), GUARD_STEP).run ?? '',
      )

      expect(run.match(/host-contract-junit-\d\.xml/g)).toHaveLength(
        asArray(matrix.shard, 'matrix.shard').length,
      )
    })

    test('the guard and download steps run after a shard failure but not after cancellation or a skipped suite', () => {
      const steps = jobSteps('host-contract')
      for (const name of ['Download shard results', GUARD_STEP]) {
        expect(bareExpression(findStep(steps, name).if), name).toBe(
          "!cancelled() && steps.verdict.outputs.run == 'true'",
        )
      }
    })

    test('the final shard check runs whatever happened before it, once the suite was required', () => {
      const step = findStep(jobSteps('host-contract'), SHARDS_STEP)

      expect(bareExpression(step.if)).toBe(
        "always() && steps.verdict.outputs.run == 'true'",
      )
    })
  })

  describe('guard condition properties (mechanically pinned, proven bidirectionally)', () => {
    function realCondition(): string {
      const guardStep = findStep(
        jobSteps('host-contract'),
        'Guard skipped tests and pass floor',
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
