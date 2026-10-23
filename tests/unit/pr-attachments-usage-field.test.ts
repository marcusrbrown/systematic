import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A usage error names the input field that failed, so a caller can fix that
// one field and retry. The name is a fixed literal from the schema; caller
// text is never echoed back.

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const CANARY = 'SECRET-CANARY-7c41d9e2'
const SHA = 'a'.repeat(40)
const EVIDENCE_PATH = 'docs/evidence/demo/a.png'
const RAW_URL = `https://raw.githubusercontent.com/octo/repo/${SHA}/${EVIDENCE_PATH}`

interface UsageReport {
  readonly operation: string
  readonly result: string
  readonly error?: string
  readonly field?: string
  readonly usage?: string
}

function cli(operation: string, input: unknown, raw = false) {
  const result = spawnSync('node', [SCRIPT_PATH, operation], {
    input: raw ? String(input) : JSON.stringify(input),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout,
    report: JSON.parse(result.stdout) as UsageReport,
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-attachments-field-'))
const NOT_A_DEMO = path.join(scratch, 'not-a-demo.md')
const MISSING_DEMO = path.join(scratch, 'missing.md')
const OUT_FILE = path.join(scratch, 'out.md')
fs.writeFileSync(NOT_A_DEMO, 'just text, no heading\n')

type Case = readonly [
  name: string,
  input: unknown,
  error: string,
  field: string,
]

const CASES: Record<string, readonly Case[]> = {
  classify: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    ['no paths', {}, 'empty-paths', 'paths'],
    ['an empty path list', { paths: [] }, 'empty-paths', 'paths'],
    ['a path that is not a string', { paths: [7] }, 'invalid-input', 'paths'],
    [
      'a branch that is not a string',
      { paths: ['a.png'], branch: 5 },
      'invalid-input',
      'branch',
    ],
    [
      'a topic that is not a string',
      { paths: ['a.png'], branch: 'x', topic: 5 },
      'invalid-input',
      'topic',
    ],
    ['no topic source', { paths: ['a.png'] }, 'missing-topic-source', 'branch'],
    [
      'an existing map that is not an object',
      { paths: ['a.png'], branch: 'x', existing: [] },
      'invalid-input',
      'existing',
    ],
    [
      'an existing map with a non-string value',
      { paths: ['a.png'], branch: 'x', existing: { [EVIDENCE_PATH]: 1 } },
      'invalid-input',
      'existing',
    ],
    [
      'a max_bytes of zero',
      { paths: ['a.png'], branch: 'x', max_bytes: 0 },
      'invalid-input',
      'max_bytes',
    ],
  ],
  splice: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a body that is not a string',
      { body: 1, demo_file: NOT_A_DEMO, out_file: OUT_FILE },
      'invalid-input',
      'body',
    ],
    [
      'no demo_file',
      { body: 'x', out_file: OUT_FILE },
      'invalid-input',
      'demo_file',
    ],
    [
      'no out_file',
      { body: 'x', demo_file: NOT_A_DEMO },
      'invalid-input',
      'out_file',
    ],
    [
      'a demo_file that does not exist',
      { body: 'x', demo_file: MISSING_DEMO, out_file: OUT_FILE },
      'demo-file-unreadable',
      'demo_file',
    ],
    [
      'a demo_file that holds no Demo section',
      { body: 'x', demo_file: NOT_A_DEMO, out_file: OUT_FILE },
      'invalid-demo',
      'demo_file',
    ],
  ],
  extract: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a body that is not a string',
      { out_file: OUT_FILE },
      'invalid-input',
      'body',
    ],
    ['no out_file', { body: 'x' }, 'invalid-input', 'out_file'],
  ],
  urls: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a body that is not a string',
      { head_repo: 'o/r' },
      'invalid-input',
      'body',
    ],
    ['no head_repo', { body: 'x' }, 'invalid-input', 'head_repo'],
    [
      'a malformed head_repo',
      { body: 'x', head_repo: 'octo' },
      'invalid-input',
      'head_repo',
    ],
  ],
  'repin-rewrite': [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a body that is not a string',
      { head_repo: 'o/r', pins: {}, out_file: OUT_FILE },
      'invalid-input',
      'body',
    ],
    [
      'a malformed head_repo',
      { body: 'x', head_repo: 'octo', pins: {}, out_file: OUT_FILE },
      'invalid-input',
      'head_repo',
    ],
    [
      'a pins map with a bad SHA',
      {
        body: 'x',
        head_repo: 'o/r',
        pins: { [EVIDENCE_PATH]: 'nope' },
        out_file: OUT_FILE,
      },
      'invalid-input',
      'pins',
    ],
    [
      'a pins map keyed by an unmanaged path',
      {
        body: 'x',
        head_repo: 'o/r',
        pins: { 'README.md': SHA },
        out_file: OUT_FILE,
      },
      'invalid-input',
      'pins',
    ],
    [
      'no out_file',
      { body: 'x', head_repo: 'o/r', pins: {} },
      'invalid-input',
      'out_file',
    ],
  ],
  pins: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a head_ref_oid that is not a commit SHA',
      { head_ref_oid: 'main', urls: [] },
      'invalid-input',
      'head_ref_oid',
    ],
    [
      'urls that is not an array',
      { head_ref_oid: SHA, urls: 'x' },
      'invalid-input',
      'urls',
    ],
    [
      'a git_timeout_ms of zero',
      { head_ref_oid: SHA, urls: [], git_timeout_ms: 0 },
      'invalid-input',
      'git_timeout_ms',
    ],
    [
      'an empty urls array',
      { head_ref_oid: SHA, urls: [] },
      'empty-paths',
      'urls',
    ],
    [
      'a urls entry with an unmanaged path',
      { head_ref_oid: SHA, urls: [{ path: 'README.md', sha: SHA }] },
      'invalid-input',
      'urls',
    ],
    [
      'a urls entry with a bad sha',
      { head_ref_oid: SHA, urls: [{ path: EVIDENCE_PATH, sha: 'nope' }] },
      'invalid-input',
      'urls',
    ],
  ],
  'cleanup-set': [
    ['input that is not an object', [], 'invalid-input', 'input'],
    [
      'a head_ref_oid that is not a commit SHA',
      { head_ref_oid: 'main', base_ref_name: 'main', remote: 'origin' },
      'invalid-input',
      'head_ref_oid',
    ],
    [
      'a git_timeout_ms of zero',
      {
        head_ref_oid: SHA,
        base_ref_name: 'main',
        remote: 'origin',
        git_timeout_ms: 0,
      },
      'invalid-input',
      'git_timeout_ms',
    ],
    [
      'a remove_digest that is not a digest',
      {
        head_ref_oid: SHA,
        base_ref_name: 'main',
        remote: 'origin',
        remove_digest: 'nope',
      },
      'invalid-input',
      'remove_digest',
    ],
    ['no base at all', { head_ref_oid: SHA }, 'invalid-input', 'base_ref'],
    [
      'a malformed base_ref_name',
      { head_ref_oid: SHA, base_ref_name: '-x', remote: 'origin' },
      'invalid-input',
      'base_ref_name',
    ],
    [
      'a malformed remote',
      { head_ref_oid: SHA, base_ref_name: 'main', remote: '-x' },
      'invalid-input',
      'remote',
    ],
    [
      'a base_ref that is not fully qualified',
      { head_ref_oid: SHA, base_ref: 'main' },
      'invalid-input',
      'base_ref',
    ],
  ],
  verify: [
    ['input that is not an object', [], 'invalid-input', 'input'],
    ['no urls', {}, 'invalid-input', 'urls'],
    ['an empty urls array', { urls: [] }, 'empty-urls', 'urls'],
    [
      'more urls than the limit',
      { urls: Array.from({ length: 51 }, () => RAW_URL) },
      'too-many-urls',
      'urls',
    ],
    ['a url that is not a string', { urls: [7] }, 'invalid-url', 'urls'],
    [
      'a blob url',
      {
        urls: [
          `https://github.com/octo/repo/blob/${SHA}/${EVIDENCE_PATH}?raw=true`,
        ],
      },
      'blob-url',
      'urls',
    ],
    [
      'a url on another host',
      { urls: ['https://example.com/x.png'] },
      'invalid-url',
      'urls',
    ],
    [
      'a max_wait_s of zero',
      { urls: [RAW_URL], max_wait_s: 0 },
      'invalid-input',
      'max_wait_s',
    ],
    [
      'a request_timeout_s of zero',
      { urls: [RAW_URL], request_timeout_s: 0 },
      'invalid-input',
      'request_timeout_s',
    ],
    [
      'a negative waited_s',
      { urls: [RAW_URL], waited_s: -1 },
      'invalid-input',
      'waited_s',
    ],
    [
      'a malformed head_repo',
      { urls: [RAW_URL], head_repo: 'octo' },
      'invalid-input',
      'head_repo',
    ],
  ],
}

describe('pr-attachments helper -- a usage error names the failing field', () => {
  for (const [operation, cases] of Object.entries(CASES)) {
    describe(operation, () => {
      test.each(cases)('%s', (_name, input, error, field) => {
        const { status, report } = cli(operation, input)

        expect(status).toBe(2)
        expect(report.operation).toBe(operation)
        expect(report.result).toBe('usage-error')
        expect(report.error).toBe(error)
        expect(report.field).toBe(field)
      })
    })
  }

  test('covers every operation the helper has', () => {
    expect(Object.keys(CASES).sort()).toEqual(
      [
        'classify',
        'splice',
        'extract',
        'urls',
        'pins',
        'repin-rewrite',
        'cleanup-set',
        'verify',
      ].sort(),
    )
  })

  test('input that is not JSON names the input as the field', () => {
    const { status, report } = cli('classify', '{not json', true)

    expect(status).toBe(2)
    expect(report.error).toBe('invalid-json')
    expect(report.field).toBe('input')
  })

  test('an unknown operation names the operation as the field', () => {
    const { status, report } = cli('frobnicate', {})

    expect(status).toBe(2)
    expect(report.error).toBe('unknown-operation')
    expect(report.field).toBe('operation')
  })

  test('the field is a fixed schema name and never echoes caller text', () => {
    const attempts: Array<[string, unknown]> = [
      ['urls', { body: 'x', head_repo: CANARY }],
      ['classify', { paths: ['a.png'], branch: CANARY, max_bytes: CANARY }],
      ['verify', { urls: [RAW_URL], head_repo: CANARY }],
      ['pins', { head_ref_oid: CANARY, urls: [] }],
      [
        'repin-rewrite',
        {
          body: 'x',
          head_repo: 'o/r',
          pins: { [CANARY]: SHA },
          out_file: OUT_FILE,
        },
      ],
    ]
    for (const [operation, input] of attempts) {
      const { stdout, report } = cli(operation, input)
      expect(report.result).toBe('usage-error')
      expect(report.field).toMatch(/^[a-z_]+$/)
      expect(stdout).not.toContain(CANARY)
    }
  })
})
