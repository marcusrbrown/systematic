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

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGGREGATE_STDIN_BYTE_CAP } from '../../src/lib/review-pipeline-contract.js'

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
  } = {},
): RunResult {
  const result = spawnSync('bun', [VALIDATOR_ENTRY, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? SAFE_ENV,
    input: options.input,
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function makeCwd(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-validator-routing-')),
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

  test.each(['opencode', 'pi', 'claude-code'] as const)(
    'a valid --harness value of %s exits 0',
    (harness) => {
      const result = runValidator(
        ['screen', '--reviewer', 'correctness', '--harness', harness],
        { input: JSON.stringify(VALID_RETURN) },
      )
      expect(result.exitCode, result.stderr).toBe(0)
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
})

describe('prepare: rejection outcomes', () => {
  test('a malformed envelope exits 1', () => {
    const result = runValidator([...PREPARE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
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
})

describe('merge: rejection outcomes', () => {
  test('a malformed envelope exits 1', () => {
    const result = runValidator([...MERGE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('rejected the aggregate envelope')
    expect(result.stdout).toBe('')
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
})

describe('finalize: rejection outcomes', () => {
  test('malformed JSON exits 1 with the fixed rejected message and empty stdout', () => {
    const result = runValidator([...FINALIZE_ARGS], { input: '{ not json' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('finalize rejected the aggregate envelope')
    expect(result.stdout).toBe('')
  })

  test('a schema-invalid envelope exits 1 with a path and code but not the offending value', () => {
    const result = runValidator([...FINALIZE_ARGS], {
      input: JSON.stringify(FINALIZE_SCHEMA_INVALID_INPUT),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('parent_run_metadata.mode')
    expect(result.stderr).not.toContain('not-a-real-mode')
    expect(result.stderr).not.toContain('rejected the aggregate envelope')
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
