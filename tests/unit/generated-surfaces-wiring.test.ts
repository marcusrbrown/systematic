/**
 * Wiring tests for the consumers of the generated-surface list (U5).
 *
 * CI, `postupgrade` and the Fro Bot autoheal prompt all call
 * `surfaces:regen` / `surfaces:drift` instead of keeping their own lists of
 * generators. These tests parse the workflow YAML and `package.json` (no
 * brittle line numbers, no step-name pinning) and assert:
 *   - CI has one drift step, in the job that fetches full history;
 *   - the autoheal prompt points at that command, ahead of `docs:verify`;
 *   - the prompt's never-hand-edit list names every surface output (R14).
 *
 * Read-only: nothing here writes a tracked file.
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  GENERATED_SURFACES,
  type GeneratedSurface,
  literalPrefix,
} from '../../scripts/lib/generated-surfaces.js'
import { ROOT_DIR } from './git-worktree-fixtures.js'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a sequence`)
  }
  return value
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  }
  return value
}

function parseWorkflow(source: string): RecordValue {
  const { JSON_SCHEMA } = yaml
  return asRecord(yaml.load(source, { schema: JSON_SCHEMA }), 'workflow')
}

function readWorkflowSource(file: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, '.github/workflows', file), 'utf8')
}

function jobSteps(
  workflow: RecordValue,
  jobId: string,
): readonly RecordValue[] {
  const jobs = asRecord(workflow.jobs, 'jobs')
  const job = asRecord(jobs[jobId], `${jobId} job`)
  return asArray(job.steps, `${jobId} steps`).map((step, index) =>
    asRecord(step, `${jobId} step ${index}`),
  )
}

/** The per-surface check commands the single drift step replaces. */
function perSurfaceDriftCommands(
  surfaces: readonly GeneratedSurface[],
): string[] {
  return surfaces.map((surface) => `bun run ${surface.checkScript}`)
}

const SINGLE_DRIFT_COMMAND = 'bun run surfaces:drift'

/**
 * Problems with the `build` job's drift wiring; empty when it is right.
 * Takes the parsed workflow so a test can hand it a mutated copy.
 */
function buildJobDriftProblems(
  workflow: RecordValue,
  surfaces: readonly GeneratedSurface[],
): string[] {
  const steps = jobSteps(workflow, 'build')
  const problems: string[] = []

  const driftSteps = steps.filter(
    (step) =>
      typeof step.run === 'string' && step.run.trim() === SINGLE_DRIFT_COMMAND,
  )
  if (driftSteps.length !== 1) {
    problems.push(
      `expected exactly one \`${SINGLE_DRIFT_COMMAND}\` step, found ${driftSteps.length}`,
    )
  }

  const checkout = steps.find(
    (step) =>
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/checkout@'),
  )
  const checkoutWith = checkout?.with
  if (!isRecord(checkoutWith) || checkoutWith['fetch-depth'] !== 0) {
    problems.push('the build job checkout must use fetch-depth: 0')
  }

  for (const command of perSurfaceDriftCommands(surfaces)) {
    const stragglers = steps.filter(
      (step) => typeof step.run === 'string' && step.run.includes(command),
    )
    if (stragglers.length > 0) {
      problems.push(`a step still calls \`${command}\` directly`)
    }
  }
  return problems
}

/**
 * The text of the never-hand-edit bullet in the autoheal prompt: from the
 * "Never manually edit generated artifacts" sentence to the next blank line.
 */
function neverHandEditSection(prompt: string): string {
  const start = prompt.indexOf('Never manually edit generated artifacts')
  if (start < 0) {
    throw new Error('never-hand-edit bullet not found in the autoheal prompt')
  }
  const end = prompt.indexOf('\n\n', start)
  return prompt.slice(start, end < 0 ? undefined : end)
}

/**
 * Backticked tokens in `text`, parsed across line wraps: a token that wraps
 * onto the next line loses the wrap whitespace. Paths never contain spaces,
 * so dropping all whitespace inside a token is safe.
 */
function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) =>
    (match[1] ?? '').replace(/\s+/g, ''),
  )
}

/**
 * Outputs whose literal prefix is not covered by any backticked token in the
 * prompt's never-hand-edit list. An output is covered when its literal prefix
 * starts with a token, so `docs/public/schemas/` covers `docs/public/schemas/v`.
 */
function uncoveredOutputs(
  prompt: string,
  surfaces: readonly GeneratedSurface[],
): string[] {
  const tokens = backtickedTokens(neverHandEditSection(prompt))
  const gaps: string[] = []
  for (const surface of surfaces) {
    for (const output of surface.outputs) {
      const prefix = literalPrefix(output)
      if (!tokens.some((token) => prefix.startsWith(token))) {
        gaps.push(`${surface.name}: ${output}`)
      }
    }
  }
  return gaps
}

function autohealPrompt(): string {
  const workflow = parseWorkflow(readWorkflowSource('fro-bot.yaml'))
  const env = asRecord(workflow.env, 'workflow env')
  return asString(env.AUTOHEAL_PROMPT, 'AUTOHEAL_PROMPT')
}

describe('generated-surface wiring: main.yaml', () => {
  const source = readWorkflowSource('main.yaml')

  test('the build job runs one drift step in the job that fetches full history', () => {
    const workflow = parseWorkflow(source)

    expect(buildJobDriftProblems(workflow, GENERATED_SURFACES)).toEqual([])
  })

  test('the drift step runs after install, build and the Claude Code build', () => {
    const steps = jobSteps(parseWorkflow(source), 'build')
    const runIndex = (command: string) =>
      steps.findIndex(
        (step) => typeof step.run === 'string' && step.run.trim() === command,
      )

    const drift = runIndex(SINGLE_DRIFT_COMMAND)
    expect(drift).toBeGreaterThan(runIndex('bun install --frozen-lockfile'))
    expect(drift).toBeGreaterThan(runIndex('bun run build'))
    expect(drift).toBeGreaterThan(runIndex('bun run claude-code:build'))
  })

  test('a copy that re-adds a per-surface drift step is reported', () => {
    const mutated = source.replace(
      `        run: ${SINGLE_DRIFT_COMMAND}\n`,
      `        run: ${SINGLE_DRIFT_COMMAND}\n\n      - name: Registry drift check\n        run: bun run registry:drift\n`,
    )
    expect(mutated).not.toBe(source)

    const problems = buildJobDriftProblems(
      parseWorkflow(mutated),
      GENERATED_SURFACES,
    )
    expect(problems).toContain(
      'a step still calls `bun run registry:drift` directly',
    )
  })

  test('a copy with two surfaces:drift steps or no full-history checkout is reported', () => {
    const doubled = source.replace(
      `        run: ${SINGLE_DRIFT_COMMAND}\n`,
      `        run: ${SINGLE_DRIFT_COMMAND}\n\n      - name: Again\n        run: ${SINGLE_DRIFT_COMMAND}\n`,
    )
    expect(
      buildJobDriftProblems(parseWorkflow(doubled), GENERATED_SURFACES)[0],
    ).toContain('found 2')

    const shallow = source.replace('          fetch-depth: 0\n', '')
    expect(shallow).not.toBe(source)
    expect(
      buildJobDriftProblems(parseWorkflow(shallow), GENERATED_SURFACES),
    ).toContain('the build job checkout must use fetch-depth: 0')
  })
})

describe('generated-surface wiring: Fro Bot autoheal prompt', () => {
  test('names the single drift command in the code-quality bullets', () => {
    const prompt = autohealPrompt()

    expect(prompt).toContain(SINGLE_DRIFT_COMMAND)
    expect(prompt.indexOf(SINGLE_DRIFT_COMMAND)).toBeLessThan(
      prompt.indexOf('QUALITY GATES VERIFICATION'),
    )
  })

  test('the quality gates run drift before docs:verify', () => {
    const prompt = autohealPrompt()
    const start = prompt.indexOf('QUALITY GATES VERIFICATION')
    const end = prompt.indexOf('PROGRESSIVE IMPROVEMENT', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const gates = prompt.slice(start, end)

    const drift = gates.indexOf(SINGLE_DRIFT_COMMAND)
    const docsVerify = gates.indexOf('bun run docs:verify')
    expect(drift).toBeGreaterThanOrEqual(0)
    expect(docsVerify).toBeGreaterThanOrEqual(0)
    // docs:verify regenerates the mdx and the schema, which would hide drift.
    expect(drift).toBeLessThan(docsVerify)
  })

  test('does not list per-surface drift commands', () => {
    const prompt = autohealPrompt()

    for (const command of perSurfaceDriftCommands(GENERATED_SURFACES)) {
      expect(prompt).not.toContain(command)
    }
  })

  test('names surfaces:regen as the canonical regenerate command', () => {
    expect(neverHandEditSection(autohealPrompt())).toContain(
      'bun run surfaces:regen',
    )
  })

  test('the never-hand-edit list names every surface output (R14)', () => {
    expect(uncoveredOutputs(autohealPrompt(), GENERATED_SURFACES)).toEqual([])
  })

  test('the never-hand-edit list keeps naming build outputs', () => {
    const tokens = backtickedTokens(neverHandEditSection(autohealPrompt()))

    for (const buildOutput of [
      'dist/registry/',
      'dist/schemas/',
      'dist/index.js',
    ]) {
      expect(tokens).toContain(buildOutput)
    }
  })

  test('the superset check names the surface whose token was removed', () => {
    const prompt = autohealPrompt()
    const token = '`skills/ce-review/scripts/validate-review.mjs`'
    expect(neverHandEditSection(prompt)).toContain(token)

    const mutated = prompt.replace(
      token,
      '`skills/ce-review/scripts/elsewhere`',
    )
    expect(uncoveredOutputs(mutated, GENERATED_SURFACES)).toEqual([
      'validator: skills/ce-review/scripts/validate-review.mjs',
    ])
  })

  test('tokens that wrap across lines still count', () => {
    const wrapped = [
      'Never manually edit generated artifacts: `docs/public/',
      'schemas/`, `a.md`.',
    ].join('\n')
    const surfaces: readonly GeneratedSurface[] = [
      {
        name: 'fake',
        regenScript: 'fake:generate',
        checkScript: 'fake:drift',
        outputs: ['docs/public/schemas/v*/x.json'],
        triggers: ['x'],
      },
    ]

    expect(uncoveredOutputs(wrapped, surfaces)).toEqual([])
  })
})

describe('generated-surface wiring: postupgrade', () => {
  test('runs the build first and ends with surfaces:regen', () => {
    const packageJson = asRecord(
      JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')),
      'package.json',
    )
    const scripts = asRecord(packageJson.scripts, 'scripts')
    const postupgrade = asString(scripts.postupgrade, 'postupgrade')
    const commands = postupgrade.split('&&').map((command) => command.trim())

    expect(commands[0]).toBe('bun run build')
    expect(commands.at(-1)).toBe('bun run surfaces:regen')
    expect(commands.indexOf('bun run surfaces:regen')).toBeGreaterThan(
      commands.indexOf('bun run build'),
    )
  })
})
