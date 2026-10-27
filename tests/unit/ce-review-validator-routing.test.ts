// U4 routing proof: `src/ce-review-validator.ts`'s `screen` subcommand wires
// `screenReviewReturn` to real stdin/argv, reuses the existing bounded
// stdin reader from `review-return-validator.ts`, matches the established
// exit-code convention, and never echoes a stack trace, exception message,
// or payload content on any non-success path. Admission is invariant to the
// subprocess's environment -- `screen` never reads `process.env`. `return`
// and `artifact` keep their pre-existing behavior unchanged.
//
// The whole battery runs the real entry point (`src/ce-review-validator.ts`)
// as a subprocess -- never by importing and calling the exported function
// in-process -- so routing bugs that only show up under genuine process
// execution (argv/stdin/env plumbing, process-scope exception handlers)
// are actually exercised.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CE_REVIEW_SCREEN_REJECTED_MESSAGE,
  formatAggregateRejection,
} from '../../src/ce-review-validator.js'
import { MAX_RUN_FINDINGS } from '../../src/lib/review-artifact-schema.js'
import {
  applyReviewAdjudication,
  type PrepareOutput,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'
import { AGGREGATE_STDIN_BYTE_CAP } from '../../src/lib/review-pipeline-contract.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'
import { buildScreenReturn, runPipeline } from './review-run-fixtures.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const VALIDATOR_ENTRY = path.join(ROOT_DIR, 'src/ce-review-validator.ts')
const CONFORMING_ARTIFACT_FIXTURE = path.join(
  ROOT_DIR,
  'tests/fixtures/review-artifacts/conforming-review-summary.json',
)

const BASE_FINDING = {
  autofix_class: 'gated_auto',
  confidence: 0.85,
  evidence: ['src/example.ts:42 demonstrates the failure path.'],
  file: 'src/example.ts',
  line: 42,
  owner: 'downstream-resolver',
  pre_existing: false,
  requires_verification: true,
  severity: 'P1',
  suggested_fix: 'Handle the failure before continuing.',
  title: 'Example issue',
  why_it_matters: 'The example path can fail during normal execution.',
}

const VALID_RETURN = {
  findings: [BASE_FINDING],
  residual_risks: [],
  reviewer: 'correctness',
  testing_gaps: [],
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// A minimal, fixed environment for most subprocess invocations here. Only
// PATH is required to resolve `bun`; `screen` no longer reads `process.env`
// for admission, so this is not a workaround for nondeterminism -- it is
// just a small, predictable spawn environment.
const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: process.env.PATH ?? '',
}

// Deliberately polluted environment -- including a short secret-named
// variable (KEYTIMEOUT=1, present by default in macOS/zsh shells) and a long
// high-entropy value -- used to prove admission is environment-invariant now
// that `screen` never reads `process.env`.
const POLLUTED_ENV: Readonly<Record<string, string>> = {
  HIGH_ENTROPY_TOKEN: 'q7Z3xR9mK2pL8vN4wJ6tH1sF5dG0cB3yA',
  KEYTIMEOUT: '1',
  PATH: process.env.PATH ?? '',
  SECURITYSESSIONID: '186b1',
}

function runValidator(
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly input?: string | Buffer
    readonly env?: Readonly<Record<string, string>>
    readonly timeout?: number
  } = {},
): RunResult {
  const result = spawnSync('bun', [VALIDATOR_ENTRY, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? SAFE_ENV,
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

const tempDirs = createTempDirTracker()

afterAll(tempDirs.cleanup)

function makeCwd(): string {
  return tempDirs.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-validator-routing-')),
    ),
  )
}

function snapshotTree(root: string): string {
  const entries: string[] = []
  function visit(directory: string, relative = ''): void {
    for (const child of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.join(relative, child.name)
      const childPath = path.join(directory, child.name)
      if (child.isDirectory()) {
        entries.push(`${childRelative}/`)
        visit(childPath, childRelative)
      } else {
        entries.push(
          `${childRelative}:${fs.readFileSync(childPath).toString('base64')}`,
        )
      }
    }
  }
  visit(root)
  return entries.join('\n')
}

const SCREEN_ARGS = [
  'screen',
  '--reviewer',
  'correctness',
  '--harness',
  'claude-code',
] as const

const ADMITTED_FINDING = {
  ...BASE_FINDING,
  disposition: 'surviving',
  input_id: 'correctness#0',
}

const VALID_PREPARE_INPUT = {
  screen_results: [
    {
      result: {
        admitted_findings: [ADMITTED_FINDING],
        dispatch_outcome: 'findings',
        harness: 'claude-code',
        residual_risks: [],
        testing_gaps: [],
      },
      reviewer: 'correctness',
    },
  ],
  selected_dispatches: [
    {
      dispatch_outcome: 'findings',
      persona: 'correctness',
      selection_surface: ['src/example.ts'],
    },
  ],
}

const PREPARE_ARGS = ['prepare'] as const

const MERGE_ARGS = ['merge'] as const

function survivingFindingFixture(inputId: string): Record<string, unknown> {
  return {
    ...BASE_FINDING,
    disposition: 'surviving',
    input_id: inputId,
    reviewer: inputId.split('#')[0],
  }
}

const MERGE_CANDIDATE_GROUP = {
  file: 'src/example.ts',
  members: [
    { input_id: 'correctness#0', line: 42 },
    { input_id: 'security#0', line: 42 },
  ],
}

const MERGE_SURVIVING_FINDINGS = [
  survivingFindingFixture('correctness#0'),
  survivingFindingFixture('security#0'),
]

const VALID_MERGE_INPUT = {
  adjudication: {
    decisions: [
      {
        decision_id: 'merge-1',
        disposition: 'merged',
        evidence: ['src/example.ts:42 shows the merged issue.'],
        input_finding_ids: ['correctness#0', 'security#0'],
        line: 42,
        suggested_fix: 'Apply the shared fix once.',
        title: 'Duplicate finding across reviewers',
        why_it_matters: 'Both reviewers independently caught the same defect.',
      },
    ],
  },
  prepared: {
    candidate_groups: [MERGE_CANDIDATE_GROUP],
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    surviving_findings: MERGE_SURVIVING_FINDINGS,
  },
}

// Schema-valid but structurally rejected: the candidate group's members are
// never cited by any decision, so `applyReviewAdjudication` rejects with
// `'omitted eligible input id'` -- distinct from a malformed-envelope
// (schema-level) rejection.
const MERGE_REJECTED_INPUT = {
  adjudication: { decisions: [] },
  prepared: {
    candidate_groups: [MERGE_CANDIDATE_GROUP],
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    surviving_findings: MERGE_SURVIVING_FINDINGS,
  },
}

const FINALIZE_ARGS = ['finalize'] as const

// The smallest schema-conforming finalize envelope: a report-only run with
// zero dispatches, so every join and coverage check has nothing to
// reconcile and the run reaches a clean, empty report projection.
const VALID_FINALIZE_INPUT = {
  merge: {
    disagreement_facts: [],
    merged_findings: [],
    validator_requests: [],
  },
  prepared: {
    candidate_groups: [],
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    surviving_findings: [],
  },
  screen_results: [],
  dispatch_records: [],
  validator_lifecycle_results: [],
  plan_assessment: { results: [], verdict: 'clean' },
  parent_run_metadata: {
    applied_fixes: [],
    branch: 'main',
    harness: 'opencode',
    head_sha: 'a'.repeat(40),
    mode: 'report-only',
    run_id: 'run-1',
    selected_dispatches: [],
    timestamps: {
      completed_at: '2026-01-01T00:05:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    },
    validation: { reason: 'no autofix applied', status: 'not_attempted' },
  },
}

// Schema-invalid: `parent_run_metadata.mode` is not one of the recognized
// enum values, so `FinalizeInputSchema.safeParse` rejects before
// `finalizeReview` ever runs.
const FINALIZE_SCHEMA_INVALID_INPUT = {
  ...VALID_FINALIZE_INPUT,
  parent_run_metadata: {
    ...VALID_FINALIZE_INPUT.parent_run_metadata,
    mode: 'not-a-real-mode',
  },
}

describe('screen: conforming input', () => {
  test('exits 0 with a parseable envelope and writes nothing to the cwd', () => {
    const cwd = makeCwd()
    const before = snapshotTree(cwd)

    const result = runValidator(SCREEN_ARGS, {
      cwd,
      input: JSON.stringify(VALID_RETURN),
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      dispatch_outcome: string
      admitted_findings: readonly unknown[]
    }
    expect(parsed.dispatch_outcome).toBe('findings')
    expect(parsed.admitted_findings).toHaveLength(1)
    expect(snapshotTree(cwd)).toBe(before)
  })
})

describe('screen: flag parsing', () => {
  test('missing --reviewer exits 2 with a usage message', () => {
    const result = runValidator(['screen', '--harness', 'claude-code'], {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('missing --harness exits 2 with a usage message', () => {
    const result = runValidator(['screen', '--reviewer', 'correctness'], {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('duplicate --reviewer exits 2', () => {
    const result = runValidator(
      [
        'screen',
        '--reviewer',
        'correctness',
        '--reviewer',
        'security',
        '--harness',
        'claude-code',
      ],
      { input: JSON.stringify(VALID_RETURN) },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('an unknown flag exits 2', () => {
    const result = runValidator([...SCREEN_ARGS, '--bogus', 'x'], {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('a stray positional argument exits 2', () => {
    const result = runValidator(['screen', 'extra', ...SCREEN_ARGS.slice(1)], {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('a flag consumed as another flag value exits 2', () => {
    // `--harness` would otherwise be swallowed as `--reviewer`'s value,
    // leaving no `--harness` flag at all.
    const result = runValidator(
      ['screen', '--reviewer', '--harness', 'claude-code'],
      { input: JSON.stringify(VALID_RETURN) },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('an unrecognized --harness value exits 2 with a usage message', () => {
    const result = runValidator(
      ['screen', '--reviewer', 'correctness', '--harness', 'bogus-harness'],
      { input: JSON.stringify(VALID_RETURN) },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('an empty --reviewer value exits 2 with a usage message, never reaching screenReviewReturn', () => {
    const result = runValidator(
      ['screen', '--reviewer', '', '--harness', 'claude-code'],
      { input: JSON.stringify(VALID_RETURN) },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stderr).not.toContain(CE_REVIEW_SCREEN_REJECTED_MESSAGE)
    expect(result.stdout).toBe('')
  })

  test('an over-long --reviewer value exits 2 with a usage message', () => {
    const result = runValidator(
      ['screen', '--reviewer', 'x'.repeat(65), '--harness', 'claude-code'],
      { input: JSON.stringify(VALID_RETURN) },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('a valid --reviewer value still exits 0', () => {
    const result = runValidator(SCREEN_ARGS, {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode, result.stderr).toBe(0)
  })

  test.each(['opencode', 'pi', 'claude-code'] as const)(
    'a valid --harness value of %s exits 0 and the result carries that harness',
    (harness) => {
      const result = runValidator(
        ['screen', '--reviewer', 'correctness', '--harness', harness],
        { input: JSON.stringify(VALID_RETURN) },
      )
      expect(result.exitCode, result.stderr).toBe(0)
      const parsed = JSON.parse(result.stdout) as { readonly harness: string }
      expect(parsed.harness).toBe(harness)
    },
  )
})

describe('screen: stdin bounds', () => {
  test('oversized stdin exits 1 without echoing content', () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x20)
    const result = runValidator(SCREEN_ARGS, { input: oversized })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('1 MiB')
    expect(result.stdout).toBe('')
  })

  test('empty stdin exits 2 with the empty-stdin message, not a malformed-payload rejection', () => {
    const result = runValidator(SCREEN_ARGS, { input: '' })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('empty stdin')
    expect(result.stderr).not.toContain(CE_REVIEW_SCREEN_REJECTED_MESSAGE)
    expect(result.stdout).toBe('')
  })
})

describe('screen: rejection outcomes', () => {
  test('malformed JSON exits 1', () => {
    // Per KTD21, unparseable JSON's finding count is genuinely unknowable,
    // so screenReviewReturn emits no rejected_summary row at all -- the CLI
    // falls back to its generic rejection message rather than echoing a
    // reason derived from a summary that does not exist.
    const result = runValidator(SCREEN_ARGS, { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('screen rejected the reviewer return')
    expect(result.stdout).toBe('')
  })

  test('a reviewer identity mismatch exits 1', () => {
    const result = runValidator(SCREEN_ARGS, {
      input: JSON.stringify({ ...VALID_RETURN, reviewer: 'security' }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('field reviewer')
    expect(result.stdout).toBe('')
  })
})

describe('screen: environment invariance', () => {
  test('admission is byte-identical under a clean environment and a polluted one', () => {
    const raw = {
      ...VALID_RETURN,
      findings: [
        {
          ...BASE_FINDING,
          severity: 'P1',
          why_it_matters:
            'process.env.API_KEY is logged in plaintext at startup.',
        },
      ],
    }
    const payload = JSON.stringify(raw)

    const clean = runValidator(SCREEN_ARGS, { env: SAFE_ENV, input: payload })
    const polluted = runValidator(SCREEN_ARGS, {
      env: POLLUTED_ENV,
      input: payload,
    })

    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(polluted.exitCode, polluted.stderr).toBe(0)
    expect(polluted.stdout).toBe(clean.stdout)

    const parsed = JSON.parse(clean.stdout) as {
      admitted_findings: readonly unknown[]
    }
    expect(parsed.admitted_findings).toHaveLength(1)
  })
})

describe('screen: exception boundary', () => {
  test('a thrown error during output exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_RETURN))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...SCREEN_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => { throw new Error('boom from outputSink: should never reach stderr') },
        errorSink: (message) => console.error(message),
      })
      console.log('EXIT:' + exitCode)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('EXIT:1')
    expect(result.stderr).toContain('internal error in screen')
    expect(result.stderr).not.toContain('boom from outputSink')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
  })

  test('an unhandled rejected promise exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_RETURN))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...SCREEN_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => console.error(message),
      })
      console.log('SYNC_EXIT:' + exitCode)
      Promise.reject(new Error('boom from rejected promise: should never reach stderr'))
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('SYNC_EXIT:0')
    expect(result.stderr).toContain('internal error in screen')
    expect(result.stderr).not.toContain('boom from rejected promise')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
    expect(result.status).toBe(1)
  })
})

describe('prepare: conforming input', () => {
  test('exits 0 with a parseable envelope and writes nothing to the cwd', () => {
    const cwd = makeCwd()
    const before = snapshotTree(cwd)

    const result = runValidator([...PREPARE_ARGS], {
      cwd,
      input: JSON.stringify(VALID_PREPARE_INPUT),
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      confidence_dispositions: readonly unknown[]
    }
    expect(parsed.confidence_dispositions).toHaveLength(1)
    expect(snapshotTree(cwd)).toBe(before)
  })
})

describe('prepare: argument parsing', () => {
  test('an unknown flag exits 2', () => {
    const result = runValidator([...PREPARE_ARGS, '--bogus', 'x'], {
      input: JSON.stringify(VALID_PREPARE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('a stray positional argument exits 2', () => {
    const result = runValidator([...PREPARE_ARGS, 'extra'], {
      input: JSON.stringify(VALID_PREPARE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })
})

describe('prepare: stdin bounds', () => {
  test('an over-cap payload exits 1 without echoing content', () => {
    const oversized = Buffer.alloc(AGGREGATE_STDIN_BYTE_CAP + 1, 0x20)
    const result = runValidator([...PREPARE_ARGS], { input: oversized })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('byte cap')
    expect(result.stdout).toBe('')
  })

  test('empty stdin exits 2 with the empty-stdin message, not a malformed-envelope rejection', () => {
    const result = runValidator([...PREPARE_ARGS], { input: '' })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('empty stdin')
    expect(result.stderr).not.toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })
})

describe('prepare: rejection outcomes', () => {
  test('a malformed envelope exits 1', () => {
    const result = runValidator([...PREPARE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })

  test('malformed JSON prints the context line, the fixed reason and the root path', () => {
    const result = runValidator([...PREPARE_ARGS], { input: '{ not json' })
    expect(result.stderr.trim()).toBe(
      'prepare rejected the aggregate envelope: malformed JSON at $',
    )
  })
})

describe('prepare: environment invariance', () => {
  test('preparation is byte-identical under a clean environment and a polluted one', () => {
    const payload = JSON.stringify(VALID_PREPARE_INPUT)

    const clean = runValidator([...PREPARE_ARGS], {
      env: SAFE_ENV,
      input: payload,
    })
    const polluted = runValidator([...PREPARE_ARGS], {
      env: POLLUTED_ENV,
      input: payload,
    })

    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(polluted.exitCode, polluted.stderr).toBe(0)
    expect(polluted.stdout).toBe(clean.stdout)
  })
})

describe('prepare: exception boundary', () => {
  test('a thrown error during output exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_PREPARE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...PREPARE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => { throw new Error('boom from outputSink: should never reach stderr') },
        errorSink: (message) => console.error(message),
      })
      console.log('EXIT:' + exitCode)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('EXIT:1')
    expect(result.stderr).toContain('internal error in prepare')
    expect(result.stderr).not.toContain('boom from outputSink')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
  })

  test('an unhandled rejected promise exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_PREPARE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...PREPARE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => console.error(message),
      })
      console.log('SYNC_EXIT:' + exitCode)
      Promise.reject(new Error('boom from rejected promise: should never reach stderr'))
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('SYNC_EXIT:0')
    expect(result.stderr).toContain('internal error in prepare')
    expect(result.stderr).not.toContain('boom from rejected promise')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
    expect(result.status).toBe(1)
  })
})

describe('merge: conforming input', () => {
  test('exits 0 with a parseable merge result and writes nothing to the cwd', () => {
    const cwd = makeCwd()
    const before = snapshotTree(cwd)

    const result = runValidator([...MERGE_ARGS], {
      cwd,
      input: JSON.stringify(VALID_MERGE_INPUT),
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      merged_findings: readonly { finding_id: string }[]
    }
    expect(parsed.merged_findings).toHaveLength(1)
    expect(parsed.merged_findings[0]?.finding_id).toBe('merge-1')
    expect(snapshotTree(cwd)).toBe(before)
  })
})

describe('merge: argument parsing', () => {
  test('an unknown flag exits 2', () => {
    const result = runValidator([...MERGE_ARGS, '--bogus', 'x'], {
      input: JSON.stringify(VALID_MERGE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('a stray positional argument exits 2', () => {
    const result = runValidator([...MERGE_ARGS, 'extra'], {
      input: JSON.stringify(VALID_MERGE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })
})

describe('merge: stdin bounds', () => {
  test('an over-cap payload exits 1 without echoing content', () => {
    const oversized = Buffer.alloc(AGGREGATE_STDIN_BYTE_CAP + 1, 0x20)
    const result = runValidator([...MERGE_ARGS], { input: oversized })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('byte cap')
    expect(result.stdout).toBe('')
  })

  test('empty stdin exits 2 with the empty-stdin message, not a malformed-envelope rejection', () => {
    const result = runValidator([...MERGE_ARGS], { input: '' })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('empty stdin')
    expect(result.stderr).not.toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })
})

describe('merge: rejection outcomes', () => {
  test('a malformed envelope exits 1', () => {
    const result = runValidator([...MERGE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })

  test('malformed JSON prints the context line, the fixed reason and the root path, as prepare does', () => {
    const result = runValidator([...MERGE_ARGS], { input: '{ not json' })
    expect(result.stderr.trim()).toBe(
      'merge rejected the aggregate envelope: malformed JSON at $',
    )
  })

  test('an adjudication rejection from applyReviewAdjudication exits 1 with the fixed reason and a path', () => {
    const result = runValidator([...MERGE_ARGS], {
      input: JSON.stringify(MERGE_REJECTED_INPUT),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('merge rejected the aggregate envelope')
    expect(result.stderr).toContain('omitted eligible input id')
    expect(result.stderr).toContain(' at ')
    expect(result.stdout).toBe('')
  })

  test('a schema-invalid envelope exits 1 wrapped in the same rejection shape as every other phase, with a path and code but not the offending value', () => {
    const result = runValidator([...MERGE_ARGS], { input: '{}' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe(
      [
        'merge rejected the aggregate envelope: schema validation',
        'prepared invalid_type',
        'adjudication invalid_type',
      ].join('\n'),
    )
    expect(result.stdout).toBe('')
  })
})

describe('merge: environment invariance', () => {
  test('merge is byte-identical under a clean environment and a polluted one', () => {
    const payload = JSON.stringify(VALID_MERGE_INPUT)

    const clean = runValidator([...MERGE_ARGS], {
      env: SAFE_ENV,
      input: payload,
    })
    const polluted = runValidator([...MERGE_ARGS], {
      env: POLLUTED_ENV,
      input: payload,
    })

    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(polluted.exitCode, polluted.stderr).toBe(0)
    expect(polluted.stdout).toBe(clean.stdout)
  })
})

describe('merge: exception boundary', () => {
  test('a thrown error during output exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_MERGE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...MERGE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => { throw new Error('boom from outputSink: should never reach stderr') },
        errorSink: (message) => console.error(message),
      })
      console.log('EXIT:' + exitCode)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('EXIT:1')
    expect(result.stderr).toContain('internal error in merge')
    expect(result.stderr).not.toContain('boom from outputSink')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
  })

  test('an unhandled rejected promise exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_MERGE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...MERGE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => console.error(message),
      })
      console.log('SYNC_EXIT:' + exitCode)
      Promise.reject(new Error('boom from rejected promise: should never reach stderr'))
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('SYNC_EXIT:0')
    expect(result.stderr).toContain('internal error in merge')
    expect(result.stderr).not.toContain('boom from rejected promise')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
    expect(result.status).toBe(1)
  })
})

describe('finalize: conforming input', () => {
  test('exits 0 with a parseable finalize result and writes nothing to the cwd', () => {
    const cwd = makeCwd()
    const before = snapshotTree(cwd)

    const result = runValidator([...FINALIZE_ARGS], {
      cwd,
      input: JSON.stringify(VALID_FINALIZE_INPUT),
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as { kind: string }
    expect(['writing', 'report_only']).toContain(parsed.kind)
    expect(snapshotTree(cwd)).toBe(before)
  })
})

describe('finalize: argument parsing', () => {
  test('an unknown flag exits 2', () => {
    const result = runValidator([...FINALIZE_ARGS, '--bogus', 'x'], {
      input: JSON.stringify(VALID_FINALIZE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })

  test('a stray positional argument exits 2', () => {
    const result = runValidator([...FINALIZE_ARGS, 'extra'], {
      input: JSON.stringify(VALID_FINALIZE_INPUT),
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
    expect(result.stdout).toBe('')
  })
})

describe('finalize: TTY', () => {
  test('a TTY stdin exits 2 without reading stdin', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      let readCalled = false
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...FINALIZE_ARGS])},
        isTTY: true,
        readChunk: () => { readCalled = true; return 0 },
        outputSink: () => {},
        errorSink: (message) => console.error(message),
      })
      console.log('EXIT:' + exitCode)
      console.log('READ:' + readCalled)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('EXIT:2')
    expect(result.stdout).toContain('READ:false')
    expect(result.stderr).toContain('interactive input is not supported')
  })
})

describe('finalize: stdin bounds', () => {
  test('an over-cap payload exits 1 without echoing content', () => {
    const oversized = Buffer.alloc(AGGREGATE_STDIN_BYTE_CAP + 1, 0x20)
    const result = runValidator([...FINALIZE_ARGS], { input: oversized })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('byte cap')
    expect(result.stdout).toBe('')
  })

  test('empty stdin exits 2 with the empty-stdin message, not a malformed-envelope rejection', () => {
    const result = runValidator([...FINALIZE_ARGS], { input: '' })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('empty stdin')
    expect(result.stderr).not.toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })
})

describe('finalize: rejection outcomes', () => {
  test('malformed JSON exits 1 with the fixed rejected message and empty stdout', () => {
    const result = runValidator([...FINALIZE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('finalize rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })

  test('malformed JSON prints the context line, the fixed reason and the root path, as prepare does', () => {
    const result = runValidator([...FINALIZE_ARGS], { input: '{ not json' })
    expect(result.stderr.trim()).toBe(
      'finalize rejected the aggregate envelope: malformed JSON at $',
    )
  })

  test('a schema-invalid envelope exits 1 wrapped in the same rejection shape as every other phase, with a path and code but not the offending value', () => {
    const result = runValidator([...FINALIZE_ARGS], {
      input: JSON.stringify(FINALIZE_SCHEMA_INVALID_INPUT),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe(
      [
        'finalize rejected the aggregate envelope: schema validation',
        'parent_run_metadata.mode invalid_value',
      ].join('\n'),
    )
    expect(result.stderr).not.toContain('not-a-real-mode')
    expect(result.stdout).toBe('')
  })
})

describe('finalize: environment invariance', () => {
  test('finalize is byte-identical under a clean environment and a polluted one', () => {
    const payload = JSON.stringify(VALID_FINALIZE_INPUT)

    const clean = runValidator([...FINALIZE_ARGS], {
      env: SAFE_ENV,
      input: payload,
    })
    const polluted = runValidator([...FINALIZE_ARGS], {
      env: POLLUTED_ENV,
      input: payload,
    })

    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(polluted.exitCode, polluted.stderr).toBe(0)
    expect(polluted.stdout).toBe(clean.stdout)
  })
})

describe('finalize: exception boundary', () => {
  test('a thrown error during output exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_FINALIZE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...FINALIZE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => { throw new Error('boom from outputSink: should never reach stderr') },
        errorSink: (message) => console.error(message),
      })
      console.log('EXIT:' + exitCode)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('EXIT:1')
    expect(result.stderr).toContain('internal error in finalize')
    expect(result.stderr).not.toContain('boom from outputSink')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
  })

  test('an unhandled rejected promise exits through the boundary with no stack text on stderr', () => {
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const bytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_FINALIZE_INPUT))})
      let offset = 0
      const exitCode = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...FINALIZE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (offset >= bytes.length) return 0
          const n = Math.min(length, bytes.length - offset)
          bytes.copy(buffer, bufferOffset, offset, offset + n)
          offset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => console.error(message),
      })
      console.log('SYNC_EXIT:' + exitCode)
      Promise.reject(new Error('boom from rejected promise: should never reach stderr'))
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('SYNC_EXIT:0')
    expect(result.stderr).toContain('internal error in finalize')
    expect(result.stderr).not.toContain('boom from rejected promise')
    expect(result.stderr).not.toContain('Error:')
    expect(result.stderr).not.toContain('.ts:')
    expect(result.stderr).not.toMatch(/at\s+\S+\s+\(/)
    expect(result.status).toBe(1)
  })
})

describe('return and artifact keep their existing behavior', () => {
  test('return still validates a conforming payload from stdin', () => {
    const result = runValidator(['return'], {
      input: JSON.stringify(VALID_RETURN),
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('Review return is valid')
  })

  test('return still rejects malformed JSON from stdin (exit 1)', () => {
    const result = runValidator(['return'], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not valid JSON')
  })

  test('artifact still validates a conforming path argument, no stdin used', () => {
    const cwd = makeCwd()
    const artifactDir = path.join(cwd, '.context/systematic/ce-review')
    fs.mkdirSync(artifactDir, { recursive: true })
    fs.copyFileSync(
      CONFORMING_ARTIFACT_FIXTURE,
      path.join(artifactDir, 'review-summary.json'),
    )
    const before = snapshotTree(cwd)

    const result = runValidator(
      ['artifact', '.context/systematic/ce-review/review-summary.json'],
      { cwd },
    )

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('Review artifact is valid')
    expect(snapshotTree(cwd)).toBe(before)
  })

  test('unknown subcommands still exit 2 and mention return|artifact', () => {
    const result = runValidator([])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('return|artifact')
  })
})

describe('process exception boundary: sink freshness across repeated calls', () => {
  test('two sequential runCeReviewValidator calls with different injected sinks each receive their own fatal output', () => {
    // The process-scope unhandledRejection/uncaughtException listener is
    // installed only once per process (U6). This proves it still routes a
    // fatal error through the CURRENT call's injected errorSink -- not the
    // FIRST call's -- by making two successful synchronous calls with
    // distinct sinks and then triggering one unhandled rejection: it must
    // land only in the second call's sink.
    const driver = `
      const mod = await import(${JSON.stringify(pathToFileURL(VALIDATOR_ENTRY).href)})
      const sinkAMessages = []
      const sinkBMessages = []

      const screenBytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_RETURN))})
      let screenOffset = 0
      const exitA = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...SCREEN_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (screenOffset >= screenBytes.length) return 0
          const n = Math.min(length, screenBytes.length - screenOffset)
          screenBytes.copy(buffer, bufferOffset, screenOffset, screenOffset + n)
          screenOffset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => sinkAMessages.push(message),
      })
      console.log('EXIT_A:' + exitA)

      const prepareBytes = Buffer.from(${JSON.stringify(JSON.stringify(VALID_PREPARE_INPUT))})
      let prepareOffset = 0
      const exitB = mod.runCeReviewValidator({
        argv: ${JSON.stringify([...PREPARE_ARGS])},
        isTTY: false,
        readChunk: (_fd, buffer, bufferOffset, length) => {
          if (prepareOffset >= prepareBytes.length) return 0
          const n = Math.min(length, prepareBytes.length - prepareOffset)
          prepareBytes.copy(buffer, bufferOffset, prepareOffset, prepareOffset + n)
          prepareOffset += n
          return n
        },
        outputSink: () => {},
        errorSink: (message) => sinkBMessages.push(message),
      })
      console.log('EXIT_B:' + exitB)

      Promise.reject(new Error('boom after both calls: should route to sinkB only'))

      setTimeout(() => {
        console.log('SINK_A:' + JSON.stringify(sinkAMessages))
        console.log('SINK_B:' + JSON.stringify(sinkBMessages))
      }, 50)
    `
    const result = spawnSync('bun', ['-e', driver], {
      encoding: 'utf8',
      env: SAFE_ENV,
      timeout: 30_000,
    })

    expect(result.stdout).toContain('EXIT_A:0')
    expect(result.stdout).toContain('EXIT_B:0')
    expect(result.stdout).toContain('SINK_A:[]')
    expect(result.stdout).toContain(
      'SINK_B:["ce-review-validator: internal error in prepare"]',
    )
  })
})

describe('a run at full scale through the CLI stdin path', () => {
  const REVIEWERS = 64
  const FINDINGS_PER_REVIEWER = 32
  // Sized so one admitted finding's JSON is about 1.2 KB, the figure a real
  // persona return averages once evidence and a fix are filled in.
  const WHY_IT_MATTERS = 'The example path fails under load. '.repeat(23)

  function reviewerSpecs() {
    return Array.from({ length: REVIEWERS }, (_, reviewerIndex) => ({
      reviewer: `reviewer-${reviewerIndex}`,
      findings: Array.from({ length: FINDINGS_PER_REVIEWER }, (_, index) => ({
        file: `src/area-${reviewerIndex}/file-${index}.ts`,
        whyItMatters: WHY_IT_MATTERS,
      })),
    }))
  }

  function timed<T>(run: () => T): { readonly value: T; readonly ms: number } {
    const start = performance.now()
    const value = run()
    return { value, ms: Math.round(performance.now() - start) }
  }

  function cli(
    phase: string,
    envelope: unknown,
  ): {
    readonly stdin: number
    readonly stdout: number
    readonly ms: number
    readonly output: unknown
  } {
    const input = JSON.stringify(envelope)
    const { value: result, ms } = timed(() =>
      runValidator([phase], { input, timeout: 120_000 }),
    )
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    return {
      stdin: Buffer.byteLength(input),
      stdout: Buffer.byteLength(result.stdout),
      ms,
      output: JSON.parse(result.stdout) as unknown,
    }
  }

  test('prepare, merge and finalize complete for 64 reviewers with 32 findings each, and the finalize envelope stays under half the byte cap', () => {
    const specs = reviewerSpecs()
    const dispatches = specs.map((spec) => ({
      persona: spec.reviewer,
      dispatch_outcome: 'findings',
    }))
    const screenResults = specs.map((spec) => ({
      reviewer: spec.reviewer,
      result: screenReviewReturn({
        raw_return: JSON.stringify(buildScreenReturn(spec)),
        expected_reviewer: spec.reviewer,
        invoking_harness: 'opencode',
      }),
    }))

    const prepare = cli('prepare', {
      screen_results: screenResults,
      selected_dispatches: dispatches,
    })
    const prepared = prepare.output as {
      readonly surviving_findings: readonly unknown[]
    }
    expect(prepared.surviving_findings).toHaveLength(
      REVIEWERS * FINDINGS_PER_REVIEWER,
    )

    const merge = cli('merge', {
      prepared: prepare.output,
      adjudication: { decisions: [] },
    })
    const merged = merge.output as {
      readonly merged_findings: readonly unknown[]
    }
    expect(merged.merged_findings).toHaveLength(
      REVIEWERS * FINDINGS_PER_REVIEWER,
    )

    const finalize = cli('finalize', {
      merge: merge.output,
      prepared: prepare.output,
      screen_results: screenResults,
      dispatch_records: dispatches,
      validator_lifecycle_results: [],
      plan_assessment: { verdict: 'All requirements met.', results: [] },
      parent_run_metadata: {
        run_id: 'run-scale',
        mode: 'interactive',
        harness: 'opencode',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        selected_dispatches: dispatches,
        timestamps: {
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:05:00.000Z',
        },
        validation: { status: 'not_attempted', reason: 'no autofix applied' },
        applied_fixes: [],
      },
    })
    const finalized = finalize.output as { readonly kind: string }
    expect(finalized.kind).toBe('writing')

    const share = (bytes: number) =>
      `${((bytes / AGGREGATE_STDIN_BYTE_CAP) * 100).toFixed(1)}%`
    console.log(
      [
        `prepare  in ${prepare.stdin} (${share(prepare.stdin)} of cap) out ${prepare.stdout} in ${prepare.ms} ms`,
        `merge    in ${merge.stdin} (${share(merge.stdin)} of cap) out ${merge.stdout} in ${merge.ms} ms`,
        `finalize in ${finalize.stdin} (${share(finalize.stdin)} of cap) out ${finalize.stdout} in ${finalize.ms} ms`,
      ].join('\n'),
    )
    expect(finalize.stdin).toBeLessThan(AGGREGATE_STDIN_BYTE_CAP / 2)
  }, 60_000)

  test('the same run completes in process', () => {
    const { value: run, ms } = timed(() =>
      runPipeline({ reviewers: reviewerSpecs() }),
    )

    console.log(`in-process pipeline: ${ms} ms`)
    expect(run.prepare.ok).toBe(true)
    expect(run.merge?.ok).toBe(true)
    expect(run.finalize?.ok).toBe(true)
    expect(run.parsed).toEqual({ artifactOk: true, outputOk: true })
  }, 60_000)
})

describe('schema rejection rendering across the aggregate phases', () => {
  const CAP_TEXT = `the aggregate byte cap (${AGGREGATE_STDIN_BYTE_CAP} bytes)`
  const bad = (count: number) => Array.from({ length: count }, () => 5)

  function expectIssueBlock(stderr: string, header: string): void {
    const lines = stderr.trimEnd().split('\n')
    expect(lines[0]).toBe(header)
    expect(lines.slice(1, 9)).toHaveLength(8)
    for (const line of lines.slice(1, 9)) {
      expect(line).toMatch(/^\S+ [a-z_]+$/)
    }
    expect(lines[9]).toMatch(/^… and \d+ more$/)
    expect(lines).toHaveLength(10)
  }

  test('prepare lists at most eight issues, then the count of the rest', () => {
    const result = runValidator([...PREPARE_ARGS], {
      input: JSON.stringify({
        screen_results: [],
        selected_dispatches: bad(12),
      }),
    })

    expect(result.exitCode).toBe(1)
    expectIssueBlock(
      result.stderr,
      'prepare rejected the aggregate envelope: schema validation',
    )
  })

  test('merge lists at most eight input issues, then the count of the rest', () => {
    const result = runValidator([...MERGE_ARGS], {
      input: JSON.stringify({
        prepared: { candidate_groups: bad(12) },
        adjudication: { decisions: [] },
      }),
    })

    expect(result.exitCode).toBe(1)
    expectIssueBlock(
      result.stderr,
      'merge rejected the aggregate envelope: schema validation',
    )
  })

  test('finalize lists at most eight input issues, then the count of the rest', () => {
    const result = runValidator([...FINALIZE_ARGS], {
      input: JSON.stringify({ dispatch_records: bad(12) }),
    })

    expect(result.exitCode).toBe(1)
    expectIssueBlock(
      result.stderr,
      'finalize rejected the aggregate envelope: schema validation',
    )
  })

  test.each([
    ['prepare', PREPARE_ARGS],
    ['merge', MERGE_ARGS],
    ['finalize', FINALIZE_ARGS],
  ] as const)(
    '%s never prints a payload value or an unknown key name',
    (_phase, args) => {
      const result = runValidator([...args], {
        input: JSON.stringify({
          KEY_CANARY_unknown: 'VALUE_CANARY',
          screen_results: 'VALUE_CANARY',
          selected_dispatches: 'VALUE_CANARY',
          prepared: 'VALUE_CANARY',
          adjudication: 'VALUE_CANARY',
          dispatch_records: 'VALUE_CANARY',
        }),
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('CANARY')
      expect(result.stderr).not.toContain('internal error')
    },
  )

  test('a domain rejection keeps the reason-at-path form', () => {
    const result = runValidator([...MERGE_ARGS], {
      input: JSON.stringify(MERGE_REJECTED_INPUT),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(
      /^merge rejected the aggregate envelope: omitted eligible input id at \S+\n?$/,
    )
  })

  test('a merge output-schema rejection renders the context line and the first bad path, never an internal error', () => {
    const singletons = Array.from(
      { length: MAX_RUN_FINDINGS + 1 },
      (_, index) => `reviewer-x#${index}`,
    )
    const survivors = singletons.map((inputId) => ({
      ...survivingFindingFixture(inputId),
    }))
    const oversized = {
      candidate_groups: [],
      confidence_dispositions: [],
      coverage_union: [],
      singletons,
      surviving_findings: survivors,
    } as unknown as PrepareOutput

    const result = applyReviewAdjudication({
      prepared: oversized,
      decisions: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return

    const rendered = formatAggregateRejection(
      'merge rejected the aggregate envelope',
      result.rejection,
    )
    const lines = rendered.split('\n')
    expect(lines[0]).toBe(
      'merge rejected the aggregate envelope: merge output failed schema validation',
    )
    expect(lines).toContain('merged_findings too_big')
    expect(rendered).not.toContain('internal error')
  })

  test.each([
    ['prepare', PREPARE_ARGS],
    ['merge', MERGE_ARGS],
    ['finalize', FINALIZE_ARGS],
  ] as const)(
    '%s states the cap in bytes when the input is over it',
    (phase, args) => {
      const oversized = Buffer.alloc(AGGREGATE_STDIN_BYTE_CAP + 1, 0x20)

      const result = runValidator([...args], { input: oversized })

      expect(result.exitCode).toBe(1)
      expect(result.stderr.trim()).toBe(`${phase} input exceeds ${CAP_TEXT}`)
      expect(result.stderr).toContain('16842752')
    },
  )

  test('a run of very large findings is stopped at finalize by the named byte-cap rejection', () => {
    const reviewers = 64
    const perReviewer = 32
    const huge = {
      whyItMatters: 'The example path fails under load. '
        .repeat(58)
        .slice(0, 2040),
      evidence: Array.from(
        { length: 5 },
        (_, index) => `src/example.ts:${index + 1} ${'e'.repeat(470)}`,
      ),
    }
    const specs = Array.from({ length: reviewers }, (_, reviewerIndex) => ({
      reviewer: `reviewer-${reviewerIndex}`,
      findings: Array.from({ length: perReviewer }, (_, index) => ({
        file: `src/area-${reviewerIndex}/file-${index}.ts`,
        title: 'T'.repeat(250),
        ...huge,
      })),
    }))
    const dispatches = specs.map((spec) => ({
      persona: spec.reviewer,
      dispatch_outcome: 'findings',
    }))
    const screenResults = specs.map((spec) => ({
      reviewer: spec.reviewer,
      result: screenReviewReturn({
        raw_return: JSON.stringify(buildScreenReturn(spec)),
        expected_reviewer: spec.reviewer,
        invoking_harness: 'opencode',
      }),
    }))
    const prepare = runValidator([...PREPARE_ARGS], {
      input: JSON.stringify({
        screen_results: screenResults,
        selected_dispatches: dispatches,
      }),
      timeout: 120_000,
    })
    expect(prepare.exitCode).toBe(0)
    const prepared = JSON.parse(prepare.stdout) as unknown
    const merge = runValidator([...MERGE_ARGS], {
      input: JSON.stringify({ prepared, adjudication: { decisions: [] } }),
      timeout: 120_000,
    })
    expect(merge.exitCode).toBe(0)

    const finalize = runValidator([...FINALIZE_ARGS], {
      input: JSON.stringify({
        merge: JSON.parse(merge.stdout) as unknown,
        prepared,
        screen_results: screenResults,
        dispatch_records: dispatches,
        validator_lifecycle_results: [],
        plan_assessment: { verdict: 'All requirements met.', results: [] },
        parent_run_metadata: {
          run_id: 'run-big',
          mode: 'interactive',
          harness: 'opencode',
          branch: 'main',
          head_sha: 'a'.repeat(40),
          selected_dispatches: dispatches,
          timestamps: {
            started_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:05:00.000Z',
          },
          validation: { status: 'not_attempted', reason: 'no autofix applied' },
          applied_fixes: [],
        },
      }),
      timeout: 120_000,
    })

    expect(finalize.exitCode).toBe(1)
    expect(finalize.stderr.trim()).toBe(`finalize input exceeds ${CAP_TEXT}`)
    expect(finalize.stdout).toBe('')
  }, 300_000)
})
