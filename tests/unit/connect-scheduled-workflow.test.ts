// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the workflow's expressions are literal text in these tests
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const ROOT = process.cwd()
const WRAPPER_PATH = path.join(ROOT, '.github/workflows/connect-scheduled.yaml')
const CALLEE_PATH = path.join(ROOT, '.github/workflows/connect.yaml')
const RENOVATE_PATH = path.join(ROOT, '.github/renovate.json5')

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

function load(file: string): { source: string; workflow: RecordValue } {
  const source = fs.readFileSync(file, 'utf8')
  // JSON_SCHEMA keeps the `on` key a string instead of a YAML 1.1 boolean.
  return {
    source,
    workflow: asRecord(
      yaml.load(source, { schema: yaml.JSON_SCHEMA }),
      path.basename(file),
    ),
  }
}

const { source: WRAPPER_SOURCE, workflow: WRAPPER } = load(WRAPPER_PATH)
const { workflow: CALLEE } = load(CALLEE_PATH)

/** The wrapper's text without comment lines, which explain what it avoids. */
const WRAPPER_CODE = WRAPPER_SOURCE.split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')

const CALLEE_PATH_REFERENCE = './.github/workflows/connect.yaml'
const WRAPPER_JOBS = asRecord(WRAPPER.jobs, 'jobs')

/** The wrapper's one job, which calls the callee. */
function callJob(): RecordValue {
  const [only] = Object.values(WRAPPER_JOBS)
  return asRecord(only, 'call job')
}

function calleeCall(): RecordValue {
  return asRecord(asRecord(CALLEE.on, 'callee on').workflow_call, 'callee call')
}

function calleeInputs(): string[] {
  return Object.keys(asRecord(calleeCall().inputs, 'callee inputs')).sort()
}

function calleeSecrets(): string[] {
  return Object.keys(asRecord(calleeCall().secrets, 'callee secrets')).sort()
}

function calleeRequiredInputs(): string[] {
  return Object.entries(asRecord(calleeCall().inputs, 'callee inputs'))
    .filter(([name, value]) => asRecord(value, name).required === true)
    .map(([name]) => name)
    .sort()
}

/** The caller's repository variable each callee input is read from. */
const EXPECTED_INPUT_VARIABLES: Readonly<Record<string, string>> = {
  projects: 'FRO_BOT_CONNECT_PROJECTS',
  'parent-model': 'FRO_BOT_MODEL',
  'researcher-model': 'FRO_BOT_CONNECT_MODEL',
  variant: 'FRO_BOT_CONNECT_VARIANT',
  'step-timeout-minutes': 'FRO_BOT_CONNECT_STEP_TIMEOUT',
}

describe('connect-scheduled wrapper triggers', () => {
  it('runs on the one daily cron and on manual dispatch, and on nothing else', () => {
    const on = asRecord(WRAPPER.on, 'on')
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(on.schedule).toEqual([{ cron: '41 5 * * *' }])
  })

  it('keeps the display name the pre-cutover workflow had', () => {
    expect(WRAPPER.name).toBe('Connect')
  })
})

describe('connect-scheduled wrapper permissions', () => {
  it('grants nothing at the top level', () => {
    expect(WRAPPER.permissions).toEqual({})
  })

  it('grants the call job exactly contents read and issues write', () => {
    expect(callJob().permissions).toEqual({
      contents: 'read',
      issues: 'write',
    })
  })
})

describe('connect-scheduled wrapper call', () => {
  it('has one job and it only calls the local callee, with no steps', () => {
    expect(Object.keys(WRAPPER_JOBS)).toHaveLength(1)
    const job = callJob()
    expect(job.uses).toBe(CALLEE_PATH_REFERENCE)
    expect(job).not.toHaveProperty('steps')
    expect(job).not.toHaveProperty('runs-on')
    expect(job).not.toHaveProperty('if')
  })

  it('points at a callee file that exists and takes workflow_call', () => {
    expect(fs.existsSync(path.join(ROOT, CALLEE_PATH_REFERENCE))).toBe(true)
    expect(Object.keys(asRecord(CALLEE.on, 'callee on'))).toEqual([
      'workflow_call',
    ])
  })

  it('supplies every callee input, required and optional', () => {
    const supplied = Object.keys(asRecord(callJob().with, 'with')).sort()
    expect(supplied).toEqual(calleeInputs())
    for (const name of calleeRequiredInputs()) expect(supplied).toContain(name)
  })

  it('reads each input from its repository variable as a bare reference', () => {
    const inputs = asRecord(callJob().with, 'with')
    expect(Object.keys(inputs).sort()).toEqual(
      Object.keys(EXPECTED_INPUT_VARIABLES).sort(),
    )
    for (const [input, variable] of Object.entries(EXPECTED_INPUT_VARIABLES)) {
      expect(inputs[input]).toBe(`\${{ vars.${variable} }}`)
    }
  })

  it('adds no fallback of its own: the callee normalizes an empty input', () => {
    for (const [name, value] of Object.entries(
      asRecord(callJob().with, 'with'),
    )) {
      expect(String(value), name).not.toContain('||')
      expect(String(value), name).not.toContain('??')
    }
  })

  it('passes every callee secret by name from the caller secret of the same name', () => {
    const secrets = asRecord(callJob().secrets, 'secrets')
    expect(Object.keys(secrets).sort()).toEqual(calleeSecrets())
    for (const [name, value] of Object.entries(secrets)) {
      expect(value, name).toBe(`\${{ secrets.${name} }}`)
    }
  })

  it('never uses secrets: inherit, which is unavailable across owners', () => {
    expect(callJob().secrets).not.toBe('inherit')
    expect(WRAPPER_CODE).not.toMatch(/secrets:\s*inherit/)
  })
})

describe('connect-scheduled wrapper concurrency', () => {
  it('sets no concurrency of its own, so it cannot collide with the callee group', () => {
    expect(WRAPPER).not.toHaveProperty('concurrency')
    expect(callJob()).not.toHaveProperty('concurrency')
    expect(WRAPPER_CODE).not.toMatch(/\bconcurrency\s*:/)
  })

  it('leaves the callee its own group name', () => {
    const concurrency = asRecord(CALLEE.concurrency, 'callee concurrency')
    expect(concurrency.group).toBe('ce-connect-callee')
  })
})

describe('connect-scheduled wrapper and callee stay in step', () => {
  it('passes exactly the inputs the callee declares', () => {
    expect(Object.keys(asRecord(callJob().with, 'with')).sort()).toEqual(
      calleeInputs(),
    )
  })

  it('passes exactly the secrets the callee declares', () => {
    expect(Object.keys(asRecord(callJob().secrets, 'secrets')).sort()).toEqual(
      calleeSecrets(),
    )
  })
})

describe('connect-scheduled wrapper and Renovate', () => {
  interface RegexManager {
    customType?: string
    managerFilePatterns?: string[]
  }
  const config = asRecord(
    Bun.JSON5.parse(fs.readFileSync(RENOVATE_PATH, 'utf8')),
    'renovate',
  )
  /** Renovate's `/regex/` file patterns, as RegExp. */
  function patternsMatching(file: string): RegExp[] {
    return asArray(config.customManagers, 'customManagers')
      .map((manager) => manager as RegexManager)
      .filter((manager) => manager.customType === 'regex')
      .flatMap((manager) => manager.managerFilePatterns ?? [])
      .map((pattern) => new RegExp(pattern.slice(1, -1)))
      .filter((pattern) => pattern.test(file))
  }

  it('still matches the callee, which holds the Systematic version pin', () => {
    expect(patternsMatching('.github/workflows/connect.yaml')).toHaveLength(1)
  })

  it('does not match the wrapper, which holds no pin', () => {
    expect(
      patternsMatching('.github/workflows/connect-scheduled.yaml'),
    ).toHaveLength(0)
    expect(WRAPPER_CODE).not.toMatch(/SYSTEMATIC_VERSION/)
  })
})
