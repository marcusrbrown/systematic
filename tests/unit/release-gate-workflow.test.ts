import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Locks the shape of .github/workflows/release-gate.yaml: a deterministic gate
 * (no LLM) that approves the pending release PR as fro-bot on schedule or on
 * Marcus's dispatch, then attests that approval. Each credential lives in
 * exactly one job: decide reads, approve holds the PAT, attest holds OIDC.
 */

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/release-gate.yaml',
)
const SETTINGS_PATH = path.resolve(process.cwd(), '.github/settings.yml')

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

function readSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8')
}

function readWorkflow(): RecordValue {
  const { JSON_SCHEMA } = yaml
  return asRecord(yaml.load(readSource(), { schema: JSON_SCHEMA }), 'workflow')
}

function getJob(id: string): RecordValue {
  return asRecord(asRecord(readWorkflow().jobs, 'jobs')[id], `job ${id}`)
}

function getSteps(jobId: string): readonly RecordValue[] {
  return asArray(getJob(jobId).steps, `${jobId} steps`).map((step, i) =>
    asRecord(step, `${jobId} step ${i}`),
  )
}

function findStep(jobId: string, name: string): RecordValue {
  const step = getSteps(jobId).find((candidate) => candidate.name === name)
  if (!step) throw new Error(`step not found: ${jobId}/${name}`)
  return step
}

function runOf(step: RecordValue): string {
  return String(step.run ?? '')
}

function serialized(jobId: string): string {
  return JSON.stringify(getJob(jobId))
}

const HAS_JQ = spawnSync('jq', ['--version']).status === 0

const SCHEDULE_AND_DISPATCH = ['schedule', 'workflow_dispatch']
const PREDICATE_TYPE =
  'https://github.com/marcusrbrown/systematic/attestations/release-gate-approval/v1'

// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const GITHUB_TOKEN_EXPR = '${{ github.token }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const FRO_BOT_PAT_EXPR = '${{ secrets.FRO_BOT_PAT }}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal workflow expression
const RELEASE_HOLD_EXPR = '${{ vars.RELEASE_HOLD }}'

describe('release-gate workflow triggers', () => {
  test('triggers are exactly schedule and workflow_dispatch', () => {
    const on = asRecord(readWorkflow().on, 'on')
    expect(Object.keys(on).sort()).toEqual(SCHEDULE_AND_DISPATCH)
  })

  test('schedule fires Wednesday and Sunday only', () => {
    const on = asRecord(readWorkflow().on, 'on')
    const schedule = asArray(on.schedule, 'schedule')
    expect(schedule).toEqual([{ cron: '0 15 * * 0,3' }])
  })

  test('workflow_dispatch takes no inputs', () => {
    const on = asRecord(readWorkflow().on, 'on')
    const dispatch = on.workflow_dispatch
    if (dispatch === null || dispatch === undefined) return
    expect(asRecord(dispatch, 'workflow_dispatch')).not.toHaveProperty('inputs')
  })

  test('top-level permissions are empty', () => {
    expect(readWorkflow().permissions).toEqual({})
  })

  test('concurrency is a single non-cancelling release-gate group', () => {
    expect(readWorkflow().concurrency).toEqual({
      group: 'release-gate',
      'cancel-in-progress': false,
    })
  })

  test('the workflow has exactly decide, approve and attest jobs', () => {
    expect(Object.keys(asRecord(readWorkflow().jobs, 'jobs')).sort()).toEqual([
      'approve',
      'attest',
      'decide',
    ])
  })
})

describe('release-gate decide job', () => {
  test('on dispatch both actor and triggering_actor must be marcusrbrown', () => {
    expect(getJob('decide').if).toBe(
      "github.event_name == 'schedule' || (github.actor == 'marcusrbrown' && github.triggering_actor == 'marcusrbrown')",
    )
  })

  test('permissions are read-only', () => {
    expect(getJob('decide').permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      checks: 'read',
    })
  })

  test('checkout drops credentials, then installs frozen and runs gate-decide', () => {
    const steps = getSteps('decide')
    const checkout = steps.find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout@'),
    )
    expect(
      asRecord(checkout?.with, 'checkout with')['persist-credentials'],
    ).toBe(false)
    expect(
      steps.some((s) => String(s.uses ?? '').startsWith('oven-sh/setup-bun@')),
    ).toBe(true)
    expect(
      steps.some((s) => runOf(s).includes('bun install --frozen-lockfile')),
    ).toBe(true)
  })

  test('gate-decide gets the read-only workflow token and the hold variable', () => {
    const step = findStep('decide', 'Decide')
    expect(runOf(step)).toContain(
      'bun scripts/release/gate-decide.ts --out "$RUNNER_TEMP/gate"',
    )
    const env = asRecord(step.env, 'decide env')
    expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_EXPR)
    expect(env.RELEASE_HOLD).toBe(RELEASE_HOLD_EXPR)
  })

  test('outputs kind, pr, head-sha and version are exposed', () => {
    expect(
      Object.keys(asRecord(getJob('decide').outputs, 'outputs')).sort(),
    ).toEqual(['head-sha', 'kind', 'pr', 'version'])
  })

  test('has no write permission and no secrets', () => {
    expect(
      Object.values(asRecord(getJob('decide').permissions, 'p')),
    ).not.toContain('write')
    expect(serialized('decide')).not.toContain('secrets.')
  })
})

describe('release-gate approve job', () => {
  test('runs only when decide asked to approve, with empty permissions', () => {
    const job = getJob('approve')
    expect(job.needs).toBe('decide')
    expect(job.if).toBe("needs.decide.outputs.kind == 'approve'")
    expect(job.permissions).toEqual({})
  })

  test('the fro-bot PAT reaches the approve step through env, without the hold', () => {
    const env = asRecord(findStep('approve', 'Approve').env, 'approve env')
    expect(env.GH_TOKEN).toBe(FRO_BOT_PAT_EXPR)
    expect(env).toHaveProperty('PR')
    expect(env).toHaveProperty('HEAD_SHA')
    expect(env).not.toHaveProperty('RELEASE_HOLD')
    expect(serialized('approve')).not.toContain('RELEASE_HOLD')
  })

  test('never reads repository variables (hold is enforced by decide and publish)', () => {
    expect(serialized('approve')).not.toContain('actions/variables')
  })

  test('exposes the approved output', () => {
    expect(asRecord(getJob('approve').outputs, 'outputs')).toHaveProperty(
      'approved',
    )
  })

  test('uploads the subject file as release-approval', () => {
    const upload = getSteps('approve').find((s) =>
      String(s.uses ?? '').startsWith('actions/upload-artifact@'),
    )
    expect(asRecord(upload?.with, 'upload with').name).toBe('release-approval')
  })
})

describe('release-gate attest job', () => {
  test('runs only after an approval, with just OIDC and attestation write', () => {
    const job = getJob('attest')
    expect(job.needs).toBe('approve')
    expect(job.if).toBe("needs.approve.outputs.approved == 'true'")
    expect(job.permissions).toEqual({
      'id-token': 'write',
      attestations: 'write',
    })
  })

  test('is exactly download then attest, with the approval predicate', () => {
    const steps = getSteps('attest')
    expect(steps).toHaveLength(2)

    const [download, attest] = steps
    expect(String(download?.uses)).toStartWith('actions/download-artifact@')
    expect(asRecord(download?.with, 'download with').name).toBe(
      'release-approval',
    )

    expect(String(attest?.uses)).toStartWith('actions/attest@')
    const withBlock = asRecord(attest?.with, 'attest with')
    expect(String(withBlock['subject-path'])).toEndWith('approval.json')
    expect(withBlock['predicate-type']).toBe(PREDICATE_TYPE)
    expect(withBlock.predicate).toBe('{}')
  })
})

describe('release-gate credential isolation', () => {
  test('only approve references FRO_BOT_PAT', () => {
    expect(serialized('approve')).toContain('FRO_BOT_PAT')
    expect(serialized('decide')).not.toContain('FRO_BOT_PAT')
    expect(serialized('attest')).not.toContain('FRO_BOT_PAT')
    expect(readSource().match(/FRO_BOT_PAT/g)).toHaveLength(1)
  })

  test('only attest has id-token or attestations write', () => {
    for (const id of ['decide', 'approve']) {
      const permissions = JSON.stringify(getJob(id).permissions)
      expect(permissions).not.toContain('id-token')
      expect(permissions).not.toContain('attestations')
    }
    expect(JSON.stringify(readWorkflow().permissions)).not.toContain('write')
  })

  test.each(['approve', 'attest'])(
    '%s runs no checkout, no bun and no repository scripts',
    (id) => {
      const text = serialized(id)
      expect(text).not.toContain('actions/checkout')
      expect(text).not.toMatch(/\bbun\b/)
      expect(text).not.toContain('scripts/')
    },
  )

  test('untrusted values reach `run:` only through env, never inline expressions', () => {
    for (const id of ['decide', 'approve', 'attest']) {
      for (const step of getSteps(id)) {
        expect(runOf(step)).not.toContain('${{')
      }
    }
  })

  test('every `uses:` is pinned to a 40-hex commit SHA', () => {
    let seen = 0
    for (const id of ['decide', 'approve', 'attest']) {
      for (const step of getSteps(id)) {
        if (step.uses === undefined) continue
        seen += 1
        expect(String(step.uses)).toMatch(/@[0-9a-f]{40}(\s|$)/)
      }
    }
    expect(seen).toBeGreaterThan(0)
  })
})

describe('release-gate required checks', () => {
  // Fro Bot skips bot PRs; CodeQL/Renovate checks do not run on release/**.
  const EXCLUDED = ['Fro Bot', 'CodeQL', 'Renovate / Renovate']

  function workflowChecks(): string[] {
    const run = runOf(findStep('decide', 'Decide'))
    return [...run.matchAll(/--required-check "([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    )
  }

  test('equals branch-protection contexts minus bot-skipped checks', () => {
    const settings = asRecord(
      yaml.load(fs.readFileSync(SETTINGS_PATH, 'utf8')),
      'settings',
    )
    const main = asArray(settings.branches, 'branches')
      .map((b) => asRecord(b, 'branch'))
      .find((b) => b.name === 'main')
    const protection = asRecord(main?.protection, 'protection')
    const contexts = asArray(
      asRecord(protection.required_status_checks, 'checks').contexts,
      'contexts',
    ).map(String)

    expect(workflowChecks()).toEqual(
      contexts.filter((name) => !EXCLUDED.includes(name)),
    )
    expect(workflowChecks()).toHaveLength(8)
  })
})

describe('release-gate approval subject', () => {
  const HEAD = 'a'.repeat(40)

  function approveRun(): string {
    return runOf(findStep('approve', 'Approve'))
  }

  test.skipIf(!HAS_JQ)(
    'jq emits compact sorted-key JSON with no trailing newline',
    () => {
      const match = approveRun().match(/^\s*(jq -cjnS .*)$/m)
      expect(match).not.toBeNull()
      const command = match?.[1] ?? ''

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'))
      try {
        fs.mkdirSync(path.join(dir, 'approval'))
        const result = spawnSync('bash', ['-e', '-c', command], {
          cwd: dir,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            RUNNER_TEMP: dir,
            HEAD_SHA: HEAD,
            PR: '42',
            GITHUB_REPOSITORY: 'marcusrbrown/systematic',
            REVIEW_ID: '123',
          },
        })
        expect(result.status).toBe(0)
        expect(
          fs.readFileSync(path.join(dir, 'approval', 'approval.json'), 'utf8'),
        ).toBe(
          `{"headSha":"${HEAD}","pr":42,"repo":"marcusrbrown/systematic","reviewId":123}`,
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('release-gate approve step (executed)', () => {
  const HEAD = 'a'.repeat(40)
  const OTHER = 'b'.repeat(40)

  // Answers from env: STUB_HEAD_BEFORE / STUB_HEAD_AFTER for the first and
  // later head reads, STUB_REVIEW_ID for the approval POST, STUB_DISMISS_FAIL to fail the dismissal PUT.
  const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$*" in
  *"-X POST"*/reviews*) printf '%s\\n' "$STUB_REVIEW_ID"; exit 0 ;;
  *"-X PUT"*/dismissals*) [ -z "\${STUB_DISMISS_FAIL:-}" ] || { echo "HTTP 403" >&2; exit 1; }; echo '{}'; exit 0 ;;
  *"/pulls/"*"--jq .head.sha"*)
    n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STUB_COUNT"
    if [ "$n" -eq 0 ]; then printf '%s\\n' "$STUB_HEAD_BEFORE"; else printf '%s\\n' "$STUB_HEAD_AFTER"; fi
    exit 0 ;;
esac
echo "unexpected gh call: $*" >&2
exit 1
`

  interface Scenario {
    headBefore?: string
    headAfter?: string
    dismissFails?: boolean
  }

  function runApprove(scenario: Scenario) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'))
    try {
      const bin = path.join(cwd, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 })
      const log = path.join(cwd, 'stub.log')
      const output = path.join(cwd, 'github-output')
      fs.writeFileSync(log, '')
      fs.writeFileSync(output, '')

      const result = spawnSync(
        'bash',
        ['-e', '-c', runOf(findStep('approve', 'Approve'))],
        {
          cwd,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HOME: cwd,
            RUNNER_TEMP: cwd,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: 'marcusrbrown/systematic',
            GH_TOKEN: 'token',
            PR: '42',
            HEAD_SHA: HEAD,
            STUB_LOG: log,
            STUB_COUNT: path.join(cwd, 'count'),
            STUB_HEAD_BEFORE: scenario.headBefore ?? HEAD,
            STUB_HEAD_AFTER: scenario.headAfter ?? HEAD,
            STUB_REVIEW_ID: '123',
            ...(scenario.dismissFails ? { STUB_DISMISS_FAIL: '1' } : {}),
          },
        },
      )

      const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      const subjectPath = path.join(cwd, 'approval', 'approval.json')
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        outputs: fs.readFileSync(output, 'utf8'),
        posts: calls.filter((c) => c.includes('-X POST')),
        dismissals: calls.filter((c) => c.includes('-X PUT')),
        subject: fs.existsSync(subjectPath)
          ? fs.readFileSync(subjectPath, 'utf8')
          : undefined,
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  test.skipIf(!HAS_JQ)(
    'head unchanged: approves once and writes the subject',
    () => {
      const r = runApprove({})

      expect(r.status).toBe(0)
      expect(r.posts).toHaveLength(1)
      expect(r.posts[0]).toContain(
        'repos/marcusrbrown/systematic/pulls/42/reviews',
      )
      expect(r.posts[0]).toContain(`commit_id=${HEAD}`)
      expect(r.posts[0]).toContain('event=APPROVE')
      expect(r.posts[0]).toContain(
        `body=Scheduled release approval for ${HEAD}.`,
      )
      expect(r.dismissals).toEqual([])
      expect(r.subject).toBe(
        `{"headSha":"${HEAD}","pr":42,"repo":"marcusrbrown/systematic","reviewId":123}`,
      )
      expect(r.outputs).toContain('approved=true')
    },
  )

  test('head changed before approval: no POST and approved=false', () => {
    const r = runApprove({ headBefore: OTHER })

    expect(r.status).toBe(0)
    expect(r.posts).toEqual([])
    expect(r.dismissals).toEqual([])
    expect(r.subject).toBeUndefined()
    expect(r.output).toContain('::notice::')
    expect(r.outputs).toContain('approved=false')
    expect(r.outputs).not.toContain('approved=true')
  })

  test('head changed after approval: dismisses the review and approved=false', () => {
    const r = runApprove({ headAfter: OTHER })

    expect(r.status).toBe(0)
    expect(r.posts).toHaveLength(1)
    expect(r.dismissals).toHaveLength(1)
    expect(r.dismissals[0]).toContain('pulls/42/reviews/123/dismissals')
    expect(r.dismissals[0]).toContain('event=DISMISS')
    expect(r.subject).toBeUndefined()
    expect(r.outputs).toContain('approved=false')
    expect(r.outputs).not.toContain('approved=true')
  })

  test('a failed dismissal warns but still exits 0 with approved=false', () => {
    const r = runApprove({ headAfter: OTHER, dismissFails: true })

    expect(r.status).toBe(0)
    expect(r.dismissals).toHaveLength(1)
    expect(r.output).toContain('::warning::')
    expect(r.outputs).toContain('approved=false')
  })
})
