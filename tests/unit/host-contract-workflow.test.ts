import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
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
  /** References the given step id's `.outcome`, which is what actually
   * excludes "an earlier step failed, so this step never ran"
   * (`outcome == 'skipped'`) from the cases where the guard runs. */
  readonly referencesStepOutcome: boolean
  /** Still requires the path-gate output, so a path-gated-out pull
   * request continues to skip this step. */
  readonly requiresPathGate: boolean
  /** Uses a bare (non-negated) `always()`, which would also run during
   * job cancellation -- broader than intended. */
  readonly usesBareAlways: boolean
}

function analyzeGuardCondition(
  condition: string,
  suiteStepId: string,
): GuardConditionAnalysis {
  const normalized = normalizeCondition(condition)
  return {
    hasStatusCheckFunction: STATUS_CHECK_FUNCTIONS.some((fn) =>
      normalized.includes(fn),
    ),
    referencesStepOutcome: normalized.includes(`steps.${suiteStepId}.outcome`),
    requiresPathGate: normalized.includes("steps.gate.outputs.run == 'true'"),
    usesBareAlways: /(?<!!)\balways\(\)/.test(normalized),
  }
}

describe('host-contract workflow structural invariants', () => {
  test('the host-contract job has no job-level `if:`', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')

    // A job-level `if:` that evaluates false would skip the job (and its
    // `needs` dependents would treat that as satisfied), silently
    // publishing a release without the host contract suite ever running.
    // Path gating for this job is deliberately step-level (steps.gate)
    // instead.
    expect(hostContract).not.toHaveProperty('if')
  })

  test('release.needs includes host-contract', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const release = asRecord(jobs.release, 'release job')
    const needs = asArray(release.needs, 'release.needs')

    expect(needs).toContain('host-contract')
  })

  test('the "Run host contract suite" step sets SYSTEMATIC_REQUIRE_OPENCODE=1', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const suiteStep = findStep(steps, 'Run host contract suite')
    const env = asRecord(suiteStep.env, 'Run host contract suite env')

    expect(env.SYSTEMATIC_REQUIRE_OPENCODE).toBe('1')
  })

  test('the "Run host contract suite" step has the id the guard step depends on', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const suiteStep = findStep(steps, 'Run host contract suite')

    expect(suiteStep.id).toBe('suite')
  })

  test('the "Guard skipped tests and pass floor" step condition is exactly the intended expression', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const guardStep = findStep(steps, 'Guard skipped tests and pass floor')
    const condition = normalizeCondition(String(guardStep.if ?? ''))

    // Pinned to the exact expression, not a substring, so no individual
    // clause can quietly regress (e.g. `!failure()` instead of `failure()`,
    // or dropping `!cancelled()` and losing the status-check-function
    // override -- both shipped as real regressions on this same step in
    // prior rounds). `!cancelled()` is what overrides GitHub's implicit
    // `success()` default (see analyzeGuardCondition's doc comment) while
    // staying true on both a passing and a failing suite; the
    // steps.suite.outcome checks do the rest, excluding both 'skipped'
    // (an earlier step failed first) and 'cancelled' (the suite step
    // itself was interrupted).
    expect(condition).toBe(
      "steps.gate.outputs.run == 'true' && !cancelled() && (steps.suite.outcome == 'success' || steps.suite.outcome == 'failure')",
    )
  })

  describe('guard condition properties (mechanically pinned, proven bidirectionally)', () => {
    function realCondition(): string {
      const workflow = readWorkflow()
      const jobs = asRecord(workflow.jobs, 'jobs')
      const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
      const steps = asArray(hostContract.steps, 'host-contract steps')
      const guardStep = findStep(steps, 'Guard skipped tests and pass floor')
      return normalizeCondition(String(guardStep.if ?? ''))
    }

    test('(a) the real condition contains a status check function', () => {
      expect(
        analyzeGuardCondition(realCondition(), 'suite').hasStatusCheckFunction,
      ).toBe(true)
    })

    test('(a) bidirectional: a condition with no status check function fails this property (the exact bug that shipped)', () => {
      // Mutates the extracted condition STRING, not the real workflow file
      // -- this is what "an `if:` with no status check function silently
      // gets an implicit success()" looks like once written out.
      const mutated = realCondition().replace('!cancelled() && ', '')
      expect(mutated).not.toContain('cancelled()')
      expect(
        analyzeGuardCondition(mutated, 'suite').hasStatusCheckFunction,
      ).toBe(false)
    })

    test('(b) the real condition references steps.suite.outcome', () => {
      expect(
        analyzeGuardCondition(realCondition(), 'suite').referencesStepOutcome,
      ).toBe(true)
    })

    test('(b) bidirectional: a condition referencing a different step id fails this property (the earlier-step-failure exclusion would be silently dropped)', () => {
      const mutated = realCondition().replaceAll(
        'steps.suite.outcome',
        'steps.build.outcome',
      )
      expect(
        analyzeGuardCondition(mutated, 'suite').referencesStepOutcome,
      ).toBe(false)
    })

    test('(c) the real condition still requires the path gate', () => {
      expect(
        analyzeGuardCondition(realCondition(), 'suite').requiresPathGate,
      ).toBe(true)
    })

    test('(c) bidirectional: a condition without the path gate fails this property (a path-gated-out pull request would no longer skip this step)', () => {
      const mutated = realCondition().replace(
        "steps.gate.outputs.run == 'true' && ",
        '',
      )
      expect(mutated).not.toContain('steps.gate.outputs.run')
      expect(analyzeGuardCondition(mutated, 'suite').requiresPathGate).toBe(
        false,
      )
    })

    test('(d) the real condition does not use a bare always()', () => {
      expect(
        analyzeGuardCondition(realCondition(), 'suite').usesBareAlways,
      ).toBe(false)
    })

    test('(d) bidirectional: a condition using always() instead of !cancelled() fails this property (it would also run during cancellation)', () => {
      const mutated = realCondition().replace('!cancelled()', 'always()')
      expect(analyzeGuardCondition(mutated, 'suite').usesBareAlways).toBe(true)
      // A bare always() is still a status check function, so it would
      // pass property (a) -- proving (d) is catching something (a) alone
      // cannot.
      expect(
        analyzeGuardCondition(mutated, 'suite').hasStatusCheckFunction,
      ).toBe(true)
    })
  })

  test('the guard step invokes the extracted script, not an inline heredoc', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const guardStep = findStep(steps, 'Guard skipped tests and pass floor')
    const run = String(guardStep.run ?? '')

    expect(run).toContain('bun scripts/host-contract-guard.ts')
    expect(run).not.toContain('cat <<')
  })
})
