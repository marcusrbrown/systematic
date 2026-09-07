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

  test('the "Guard skipped tests and pass floor" step runs on both suite outcomes, gated on the suite step specifically', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const guardStep = findStep(steps, 'Guard skipped tests and pass floor')
    const condition = String(guardStep.if ?? '')
      .replace(/\s+/g, ' ')
      .trim()

    // Asserts the exact expression rather than substring-checking for
    // 'failure()' alone: a lone substring check also passes for the
    // opposite-meaning `!failure()`, which would silently reintroduce the
    // bug this condition exists to fix (the guard step skipped exactly
    // when the suite step fails). Also asserts the condition is scoped to
    // steps.suite specifically (not the job-wide success()/failure()
    // status functions), so an unrelated earlier-step failure (Install
    // dependencies, Build) -- which leaves the suite step itself
    // 'skipped' -- also skips this step, instead of running it against
    // artifacts the suite step never produced.
    expect(condition).toBe(
      "steps.gate.outputs.run == 'true' && (steps.suite.outcome == 'success' || steps.suite.outcome == 'failure')",
    )
  })

  test('the "Guard skipped tests and pass floor" step does not run on cancellation', () => {
    const workflow = readWorkflow()
    const jobs = asRecord(workflow.jobs, 'jobs')
    const hostContract = asRecord(jobs['host-contract'], 'host-contract job')
    const steps = asArray(hostContract.steps, 'host-contract steps')
    const guardStep = findStep(steps, 'Guard skipped tests and pass floor')
    const condition = String(guardStep.if ?? '')

    // `always()` would also run during a cancellation. A cancelled suite
    // step's outcome is neither 'success' nor 'failure' either, so the
    // steps.suite.outcome-scoped condition asserted above already excludes
    // cancellation -- this asserts `always()` specifically isn't used, since
    // that would be a strictly broader (and wrong) condition.
    expect(condition).not.toContain('always()')
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
