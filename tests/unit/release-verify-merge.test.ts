import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHANGELOG_HEADER,
  CHANGELOG_SENTINEL,
} from '../../scripts/release/changelog.ts'
import type { Api } from '../../scripts/release/gather-publish-facts.ts'
import {
  approvalSubject,
  PREDICATE_TYPE,
  runVerifyMerge,
} from '../../scripts/release/verify-merge.ts'

const REPO = 'marcusrbrown/systematic'
const X = 'c'.repeat(40)
const PARENT = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const PR_NUMBER = 42
const SCRIPT = path.resolve(
  import.meta.dir,
  '../../scripts/release/verify-merge.ts',
)

const RELEASERC_YAML = `branches:
  - main
tagFormat: 'v\${version}'
plugins:
  - '@semantic-release/commit-analyzer'
`

function notFound(p: string): Error {
  return Object.assign(new Error(`GET ${p} failed: 404`), { status: 404 })
}

function entry(version: string): string {
  return `## [${version}](https://example.com/compare/v0...v${version}) (2026-10-12)\n\n### Features\n\n- ship ${version}`
}

function changelog(...versions: string[]): string {
  return `${CHANGELOG_HEADER}\n\n${CHANGELOG_SENTINEL}\n\n${versions.map(entry).join('\n\n')}\n`
}

function b64(text: string): { content: string; encoding: 'base64' } {
  const raw = Buffer.from(text, 'utf8').toString('base64')
  return { content: raw.replace(/(.{60})/g, '$1\n'), encoding: 'base64' }
}

interface FakeOptions {
  prList?: unknown[]
  headChangelog?: string
  xChangelog?: string
  reviews?: unknown[]
  mainTip?: string
  tags?: string[]
  release?: boolean
}

function fakeResponses(options: FakeOptions = {}): Map<string, unknown> {
  const responses = new Map<string, unknown>()
  const set = (p: string, value: unknown) => responses.set(p, value)
  const headChangelog = options.headChangelog ?? changelog('3.22.0', '3.21.8')

  set(`repos/${REPO}/commits/${X}`, { parents: [{ sha: PARENT }] })
  set(`repos/${REPO}/git/ref/heads/main`, {
    object: { sha: options.mainTip ?? X },
  })
  set(
    `repos/${REPO}/commits/${X}/pulls`,
    options.prList ?? [
      {
        number: PR_NUMBER,
        merged_at: '2026-10-12T11:00:00Z',
        merge_commit_sha: X,
      },
    ],
  )
  set(`repos/${REPO}/pulls/${PR_NUMBER}`, {
    head: {
      ref: 'release/pending',
      sha: HEAD,
      repo: { full_name: REPO },
    },
    base: { repo: { full_name: REPO } },
    user: { login: 'systematic-release[bot]' },
    merged_at: '2026-10-12T11:00:00Z',
    merge_commit_sha: X,
  })
  set(`repos/${REPO}/commits/${HEAD}`, { parents: [{ sha: PARENT }] })
  set(`repos/${REPO}/compare/${PARENT}...${HEAD}`, {
    files: [{ filename: 'CHANGELOG.md' }],
  })
  set(
    `repos/${REPO}/contents/CHANGELOG.md?ref=${PARENT}`,
    b64(changelog('3.21.8')),
  )
  set(`repos/${REPO}/contents/CHANGELOG.md?ref=${HEAD}`, b64(headChangelog))
  set(
    `repos/${REPO}/contents/CHANGELOG.md?ref=${X}`,
    b64(options.xChangelog ?? headChangelog),
  )
  set(
    `repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`,
    options.reviews ?? [review(1, 'marcusrbrown')],
  )
  set(
    `repos/${REPO}/git/matching-refs/tags/v`,
    (options.tags ?? ['v3.21.8']).map((name) => ({ ref: `refs/tags/${name}` })),
  )
  if (options.release === true) {
    set(`repos/${REPO}/releases/tags/v3.22.0`, { tag_name: 'v3.22.0' })
  }
  return responses
}

function fakeApi(options: FakeOptions = {}): Api {
  const responses = fakeResponses(options)
  return async (p) => {
    if (!responses.has(p)) throw notFound(p)
    return responses.get(p)
  }
}

function review(id: number, user: string) {
  return {
    id,
    user: { login: user },
    state: 'APPROVED',
    commit_id: HEAD,
    submitted_at: '2026-10-12T10:00:00Z',
  }
}

interface ExecCall {
  cmd: string
  args: string[]
  fileContent: string | null
}

function fakeExec(code: number) {
  const calls: ExecCall[] = []
  const exec = async (cmd: string, args: string[]) => {
    // The subject file is args[2]; capture its bytes while it still exists.
    const file = args[2]
    calls.push({
      cmd,
      args,
      fileContent:
        file !== undefined && fs.existsSync(file)
          ? fs.readFileSync(file, 'utf8')
          : null,
    })
    return { code, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

let workDir: string
let cwd: string
let outDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-merge-'))
  cwd = path.join(workDir, 'repo')
  outDir = path.join(workDir, 'out', 'nested')
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, '.releaserc.yaml'), RELEASERC_YAML)
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

function opts(api: Api, exec = fakeExec(1).exec, hold = false) {
  return {
    sha: X,
    outDir,
    repo: REPO,
    hold,
    cwd,
    api,
    exec,
    releaseAppLogin: 'systematic-release[bot]',
  }
}

describe('approvalSubject', () => {
  test('is the compact sorted-key JSON with no trailing newline', () => {
    expect(
      approvalSubject({
        repo: REPO,
        pr: 42,
        headSha: 'a'.repeat(40),
        reviewId: 123,
      }),
    ).toBe(
      `{"headSha":"${'a'.repeat(40)}","pr":42,"repo":"marcusrbrown/systematic","reviewId":123}`,
    )
  })

  test('PREDICATE_TYPE matches the contract', () => {
    expect(PREDICATE_TYPE).toBe(
      'https://github.com/marcusrbrown/systematic/attestations/release-gate-approval/v1',
    )
  })

  test('literal example from the contract', () => {
    expect(
      approvalSubject({
        repo: REPO,
        pr: 42,
        headSha: '<sha>',
        reviewId: 123,
      }),
    ).toBe(
      '{"headSha":"<sha>","pr":42,"repo":"marcusrbrown/systematic","reviewId":123}',
    )
  })
})

describe('runVerifyMerge', () => {
  test('maintainer approval publishes and writes notes + releaserc', async () => {
    const { exec, calls } = fakeExec(1)
    const decision = await runVerifyMerge(opts(fakeApi(), exec))

    expect(decision).toEqual({
      kind: 'publish',
      version: '3.22.0',
      reviewId: 1,
    })
    expect(
      JSON.parse(fs.readFileSync(path.join(outDir, 'decision.json'), 'utf8')),
    ).toEqual({ kind: 'publish', version: '3.22.0', reviewId: 1 })
    expect(fs.readFileSync(path.join(outDir, 'notes.md'), 'utf8')).toBe(
      entry('3.22.0'),
    )

    const raw = fs.readFileSync(path.join(outDir, 'releaserc.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const config = JSON.parse(raw) as { plugins: unknown[] }
    const execPlugin = config.plugins.find(
      (plugin): plugin is [string, { generateNotesCmd: string }] =>
        Array.isArray(plugin) && plugin[0] === '@semantic-release/exec',
    )
    expect(execPlugin?.[1].generateNotesCmd).toBe("cat '.release/notes.md'")
    // No gate approval exists, so no attestation call is made.
    expect(calls).toEqual([])
  })

  test('gate approval with a valid attestation publishes', async () => {
    const { exec, calls } = fakeExec(0)
    const api = fakeApi({ reviews: [review(123, 'fro-bot')] })
    const decision = await runVerifyMerge(opts(api, exec))

    expect(decision).toEqual({
      kind: 'publish',
      version: '3.22.0',
      reviewId: 123,
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.cmd).toBe('gh')
    const file = call?.args[2] as string
    expect(call?.args).toEqual([
      'attestation',
      'verify',
      file,
      '--repo',
      REPO,
      '--signer-workflow',
      `${REPO}/.github/workflows/release-gate.yaml`,
      '--source-ref',
      'refs/heads/main',
      '--predicate-type',
      PREDICATE_TYPE,
      '--format',
      'json',
    ])
    expect(call?.fileContent).toBe(
      `{"headSha":"${HEAD}","pr":${PR_NUMBER},"repo":"${REPO}","reviewId":123}`,
    )
    // Temp file is deleted afterwards.
    expect(fs.existsSync(file)).toBe(false)
  })

  test('gate approval with a failing attestation is refused', async () => {
    const { exec } = fakeExec(1)
    const api = fakeApi({ reviews: [review(123, 'fro-bot')] })
    const decision = await runVerifyMerge(opts(api, exec))

    expect(decision.kind).toBe('refused')
    const decisionFile = JSON.parse(
      fs.readFileSync(path.join(outDir, 'decision.json'), 'utf8'),
    ) as { kind: string; reason?: string }
    expect(decisionFile.kind).toBe('refused')
    expect(decisionFile.reason).toContain('attestation')
    expect(fs.existsSync(path.join(outDir, 'notes.md'))).toBe(false)
    expect(fs.existsSync(path.join(outDir, 'releaserc.json'))).toBe(false)
  })

  test('an already-published release skips and writes only decision.json', async () => {
    const api = fakeApi({ tags: ['v3.22.0', 'v3.21.8'], release: true })
    const decision = await runVerifyMerge(opts(api))

    expect(decision).toEqual({
      kind: 'skip',
      reason: 'v3.22.0 is already published.',
    })
    expect(fs.readdirSync(outDir)).toEqual(['decision.json'])
  })

  test('a tag without a release is still refused (partial publish)', async () => {
    const api = fakeApi({ tags: ['v3.22.0', 'v3.21.8'] })
    const decision = await runVerifyMerge(opts(api))

    expect(decision.kind).toBe('refused')
  })

  test('no merged PR skips and writes only decision.json', async () => {
    const decision = await runVerifyMerge(opts(fakeApi({ prList: [] })))

    expect(decision.kind).toBe('skip')
    expect(fs.readdirSync(outDir)).toEqual(['decision.json'])
  })

  test('a publish version with no changelog entry at the sha throws', async () => {
    const api = fakeApi({ xChangelog: changelog('3.21.8') })
    await expect(runVerifyMerge(opts(api))).rejects.toThrow('3.22.0')
  })
})

describe('verify-merge CLI', () => {
  interface CliResult {
    code: number
    output: string
    decision: { kind: string; reason?: string } | null
  }

  /**
   * Runs the real CLI. GitHub's REST API is served from a preloaded fetch stub
   * and `gh` is a stub that fails attestation verification.
   */
  async function runCli(
    options: FakeOptions,
    env: Record<string, string>,
  ): Promise<CliResult> {
    const bin = path.join(workDir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    })
    const responsesFile = path.join(workDir, 'responses.json')
    fs.writeFileSync(
      responsesFile,
      JSON.stringify(Object.fromEntries(fakeResponses(options))),
    )
    const preload = path.join(workDir, 'preload.ts')
    fs.writeFileSync(
      preload,
      [
        "import fs from 'node:fs'",
        "const responses = JSON.parse(fs.readFileSync(process.env.FAKE_API_RESPONSES ?? '', 'utf8'))",
        'globalThis.fetch = (async (input: unknown) => {',
        "  const p = String(input).replace('https://api.github.com/', '')",
        "  if (!(p in responses)) return new Response('{}', { status: 404, statusText: 'Not Found' })",
        '  return Response.json(responses[p])',
        '}) as unknown as typeof fetch',
        '',
      ].join('\n'),
    )
    const proc = Bun.spawn(
      ['bun', '--preload', preload, SCRIPT, '--sha', X, '--out', outDir],
      {
        cwd,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: workDir,
          GITHUB_REPOSITORY: REPO,
          GH_TOKEN: 'token',
          FAKE_API_RESPONSES: responsesFile,
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const decisionFile = path.join(outDir, 'decision.json')
    return {
      code,
      output: `${stdout}${stderr}`,
      decision: fs.existsSync(decisionFile)
        ? JSON.parse(fs.readFileSync(decisionFile, 'utf8'))
        : null,
    }
  }

  test('exits 1 with ::error:: when GH_TOKEN is missing', async () => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'GH_TOKEN') env[key] = value
    }
    env.GITHUB_REPOSITORY = REPO
    const proc = Bun.spawn(['bun', SCRIPT, '--sha', X, '--out', outDir], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).toBe(1)
    expect(`${stdout}${stderr}`).toContain('::error::')
  })

  test('a refused decision exits 1 and prints ::error:: with the reason', async () => {
    // Gate approval whose attestation fails verification (stub gh exits 1).
    const result = await runCli({ reviews: [review(123, 'fro-bot')] }, {})
    expect(result.decision?.kind).toBe('refused')
    expect(result.code).toBe(1)
    expect(result.output).toContain(`::error::${result.decision?.reason}`)
  })

  test('a superseded decision exits 1 and prints ::error:: with the reason', async () => {
    const result = await runCli({ mainTip: 'd'.repeat(40) }, {})
    expect(result.decision?.kind).toBe('superseded')
    expect(result.code).toBe(1)
    expect(result.output).toContain(`::error::${result.decision?.reason}`)
  })

  test('an already-published release exits 0 without ::error::', async () => {
    const result = await runCli(
      { tags: ['v3.22.0', 'v3.21.8'], release: true },
      {},
    )
    expect(result.decision?.kind).toBe('skip')
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('::error::')
  })

  test('a skip decision exits 0 without ::error::', async () => {
    const result = await runCli({ prList: [] }, {})
    expect(result.decision?.kind).toBe('skip')
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('::error::')
  })
})
